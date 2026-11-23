// QA Harness observability & analytics API (read-only over persisted QA runs,
// journey specs, safety rules, egress audit logs, and .artifacts/qa screenshots).

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import type { GuardConfig } from "../types.ts";
import { runsDir } from "./agent.ts";
import type { QaResult } from "./agent.ts";
import { loadJourneys } from "./journeys.ts";
import { loadForbidden } from "./safety.ts";
import { loadTemplates } from "./templates.ts";
import { BLOCKED_CUA_TOOLS, probeCuaDriver } from "./cua_client.ts";
import { BUILTIN_DENY_PROCESSES } from "./cua_harness.ts";

/** Cap on QA run files scanned per request so a large history stays fast. */
export const MAX_QA_RUNS = 100;
/** Cap on egress audit records returned to the Governance view. */
export const MAX_AUDIT_RECORDS = 150;
/** Cap on screenshot size served to the Artifact Viewer / Replay (10 MB). */
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const SAFE_RUN_ID = /^[a-zA-Z0-9_-]{3,80}$/;

export type ReleaseGate = "pass" | "warn" | "block";

export interface Scorecard {
  totalCases: number;
  p0Count: number;
  p1Count: number;
  p2Count: number;
  safetyChecked: number;
  safetyPassed: number;
  runStatus: string;
  defectsCount: number;
  passRate: number | null;
  releaseGate: ReleaseGate;
  gateReason: string;
}

export interface QaRunSummaryItem {
  id: string;
  generatedAt: string;
  request: string;
  summary: string;
  targetLabel: string;
  repos: string[];
  riskLevel: string;
  backend: string | null;
  modelUsed: boolean;
  totalSeconds: number;
  designSeconds: number;
  scorecard: Scorecard;
}

export interface WaterfallSpan {
  id: string;
  parentId: string | null;
  label: string;
  kind: "agent" | "context" | "llm" | "safety" | "runner" | "report";
  status: "done" | "error" | "skipped";
  startMs: number;
  durationMs: number;
  detail: string;
}

export interface QaRunDetail {
  result: QaResult;
  scorecard: Scorecard;
  spans: WaterfallSpan[];
  screenshots: { journey: string; step: string; width: number | null; path: string }[];
}

export interface RunComparison {
  base: QaRunSummaryItem;
  head: QaRunSummaryItem;
  deltas: {
    cases: number;
    p0: number;
    defects: number;
    seconds: number;
    passRate: number | null;
  };
  addedCases: string[];
  removedCases: string[];
  unchangedCases: number;
  addedDefects: { journey: string; step: string; expected: string; actual: string }[];
  resolvedDefects: { journey: string; step: string; expected: string; actual: string }[];
}

export function computeScorecard(r: QaResult): Scorecard {
  const cases = Array.isArray(r.cases) ? r.cases : [];
  let p0Count = 0;
  let p1Count = 0;
  let p2Count = 0;
  for (const c of cases) {
    if (c.priority === "P0") p0Count++;
    else if (c.priority === "P1") p1Count++;
    else p2Count++;
  }
  const safetyChecked = r.journeys?.offer?.safety?.checked ?? 0;
  const safetyPassed = r.journeys?.offer?.safety?.passed ?? 0;
  const defectsCount = r.run?.defects?.length ?? 0;
  const runStatus: string = r.run?.status ?? "planned";
  const totalRuns = r.run?.runs?.length ?? 0;
  const passedRuns = r.run?.runs?.filter((x) => x.status === "passed").length ?? 0;
  const passRate = totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : null;

  let releaseGate: ReleaseGate = "pass";
  let gateReason = "All checked journeys and safety gates passed.";
  if (safetyChecked > 0 && safetyPassed < safetyChecked) {
    releaseGate = "block";
    gateReason = "Safety gate failed on one or more journey specs.";
  } else if (defectsCount > 0 || runStatus === "failed") {
    releaseGate = "block";
    gateReason = `${defectsCount} defect${defectsCount === 1 ? "" : "s"} recorded during journey execution.`;
  } else if (r.risk?.level === "high" && totalRuns === 0) {
    releaseGate = "warn";
    gateReason = "High-risk change has no executed browser journeys yet.";
  } else if (runStatus === "blocked") {
    releaseGate = "warn";
    gateReason = "Journey execution was blocked; manual verification required.";
  } else if (totalRuns === 0) {
    releaseGate = "warn";
    gateReason = `${cases.length} test cases designed; no live journey run recorded.`;
  }

  return {
    totalCases: cases.length,
    p0Count,
    p1Count,
    p2Count,
    safetyChecked,
    safetyPassed,
    runStatus,
    defectsCount,
    passRate,
    releaseGate,
    gateReason,
  };
}

function summarizeItem(r: QaResult): QaRunSummaryItem {
  return {
    id: r.id,
    generatedAt: r.generatedAt,
    request: r.request,
    summary: r.summary,
    targetLabel: r.target?.label ?? "Unknown target",
    repos: (r.target?.repos ?? []).map((x) => x.repo).filter(Boolean),
    riskLevel: r.risk?.level ?? "low",
    backend: r.backend ?? null,
    modelUsed: Boolean(r.modelUsed),
    totalSeconds: Number(r.timings?.totalSeconds ?? 0),
    designSeconds: Number(r.timings?.designSeconds ?? 0),
    scorecard: computeScorecard(r),
  };
}

function readAllRuns(cfg: GuardConfig): QaResult[] {
  const dir = runsDir(cfg);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, MAX_QA_RUNS);
  const out: QaResult[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as QaResult;
      if (parsed && typeof parsed.id === "string") out.push(parsed);
    } catch {
      /* skip corrupt run file */
    }
  }
  return out;
}

export function listQaRuns(cfg: GuardConfig): {
  runs: QaRunSummaryItem[];
  kpis: {
    totalRuns: number;
    executedRuns: number;
    passRate: number | null;
    totalDefects: number;
    avgSeconds: number;
    modelRuns: number;
  };
} {
  const raw = readAllRuns(cfg);
  const runs = raw.map(summarizeItem);
  const executed = runs.filter((r) => r.scorecard.passRate !== null);
  const passRate = executed.length > 0
    ? Math.round(executed.reduce((s, r) => s + (r.scorecard.passRate ?? 0), 0) / executed.length)
    : null;
  const totalDefects = runs.reduce((s, r) => s + r.scorecard.defectsCount, 0);
  const avgSeconds = runs.length > 0
    ? Number((runs.reduce((s, r) => s + r.totalSeconds, 0) / runs.length).toFixed(2))
    : 0;
  const modelRuns = runs.filter((r) => r.modelUsed).length;
  return {
    runs,
    kpis: {
      totalRuns: runs.length,
      executedRuns: executed.length,
      passRate,
      totalDefects,
      avgSeconds,
      modelRuns,
    },
  };
}

export function buildSpans(r: QaResult): WaterfallSpan[] {
  const totalMs = Math.max(100, Math.round((r.timings?.totalSeconds ?? 0) * 1000));
  const designMs = Math.min(totalMs, Math.max(20, Math.round((r.timings?.designSeconds ?? 0) * 1000)));
  const prepMs = Math.max(20, Math.round((totalMs - designMs) * 0.45));
  const safetyChecked = r.journeys?.offer?.safety?.checked ?? 0;
  const safetyPassed = r.journeys?.offer?.safety?.passed ?? 0;
  const hasSafety = safetyChecked > 0;
  const safetyMs = hasSafety ? Math.max(15, Math.round((totalMs - designMs) * 0.2)) : 0;
  const reportMs = Math.max(15, totalMs - prepMs - designMs - safetyMs);

  const spans: WaterfallSpan[] = [
    {
      id: "root",
      parentId: null,
      label: `QA Pipeline (${r.target?.label ?? "target"})`,
      kind: "agent",
      status: r.run?.status === "failed" ? "error" : "done",
      startMs: 0,
      durationMs: totalMs,
      detail: `${r.cases?.length ?? 0} cases · risk ${r.risk?.level ?? "low"}`,
    },
    {
      id: "context",
      parentId: "root",
      label: "Target & Context Gathering",
      kind: "context",
      status: "done",
      startMs: 0,
      durationMs: prepMs,
      detail: `${r.context?.files ?? 0} files, ${r.context?.commits ?? 0} commits, ${r.context?.dependents ?? 0} dependents`,
    },
    {
      id: "design",
      parentId: "root",
      label: r.modelUsed ? `Test Design (${r.backend ?? "LLM"})` : "Test Design (Templates)",
      kind: "llm",
      status: "done",
      startMs: prepMs,
      durationMs: designMs,
      detail: `${r.cases?.length ?? 0} test cases · ${r.modelNote ?? ""}`.trim(),
    },
    {
      id: "safety",
      parentId: "root",
      label: "Safety Checker",
      kind: "safety",
      status: !hasSafety ? "skipped" : safetyPassed < safetyChecked ? "error" : "done",
      startMs: prepMs + designMs,
      durationMs: safetyMs,
      detail: hasSafety ? `${safetyPassed}/${safetyChecked} specs passed` : "No generated spec to check",
    },
    {
      id: "report",
      parentId: "root",
      label: "Artifact & Report Writer",
      kind: "report",
      status: "done",
      startMs: prepMs + designMs + safetyMs,
      durationMs: reportMs,
      detail: r.artifacts?.markdownPath ? basename(r.artifacts.markdownPath) : "In-memory result",
    },
  ];

  if (r.run) {
    const runStatus = r.run.status === "failed" ? "error" : "done";
    spans.push({
      id: "runner",
      parentId: "root",
      label: `Journey Runner (${r.run.runs.length} journey${r.run.runs.length === 1 ? "" : "s"})`,
      kind: "runner",
      status: runStatus,
      startMs: totalMs,
      durationMs: Math.max(100, r.run.runs.length * 400),
      detail: `status: ${r.run.status} · ${r.run.defects.length} defects`,
    });
  }
  return spans;
}

/** Ensures a screenshot path resolves strictly inside `<root>/.artifacts/qa` and is an image. */
export function safeQaScreenshotPath(cfg: GuardConfig, rawPath: string): string | null {
  if (!rawPath || rawPath.includes("\0")) return null;
  const qaArtifactsRoot = resolve(join(cfg.root, ".artifacts", "qa"));
  const candidate = resolve(rawPath.startsWith(".artifacts") ? join(cfg.root, rawPath) : rawPath);
  if (!candidate.startsWith(qaArtifactsRoot + sep)) return null;
  const ext = extname(candidate).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return null;
  try {
    const st = lstatSync(candidate);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_ARTIFACT_BYTES) return null;
    const real = realpathSync(candidate);
    if (!real.startsWith(qaArtifactsRoot + sep)) return null;
    return real;
  } catch {
    return null;
  }
}

export function getQaRun(cfg: GuardConfig, id: string): QaRunDetail | null {
  if (!SAFE_RUN_ID.test(id)) return null;
  const file = join(runsDir(cfg), `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    const result = JSON.parse(readFileSync(file, "utf8")) as QaResult;
    const screenshots: { journey: string; step: string; width: number | null; path: string }[] = [];
    for (const d of result.run?.defects ?? []) {
      if (d.screenshot && safeQaScreenshotPath(cfg, d.screenshot)) {
        screenshots.push({ journey: d.journeyId, step: d.step, width: d.width, path: d.screenshot });
      }
    }
    return {
      result,
      scorecard: computeScorecard(result),
      spans: buildSpans(result),
      screenshots,
    };
  } catch {
    return null;
  }
}

export function compareQaRuns(cfg: GuardConfig, baseId: string, headId: string): RunComparison | null {
  const baseDetail = getQaRun(cfg, baseId);
  const headDetail = getQaRun(cfg, headId);
  if (!baseDetail || !headDetail) return null;
  const base = summarizeItem(baseDetail.result);
  const head = summarizeItem(headDetail.result);

  const baseTitles = new Set((baseDetail.result.cases ?? []).map((c) => c.title));
  const headTitles = new Set((headDetail.result.cases ?? []).map((c) => c.title));
  const addedCases = [...headTitles].filter((t) => !baseTitles.has(t));
  const removedCases = [...baseTitles].filter((t) => !headTitles.has(t));
  const unchangedCases = [...headTitles].filter((t) => baseTitles.has(t)).length;

  const defectKey = (d: { journeyId: string; step: string; actual: string }) => `${d.journeyId}::${d.step}::${d.actual}`;
  const baseDefects = baseDetail.result.run?.defects ?? [];
  const headDefects = headDetail.result.run?.defects ?? [];
  const baseDefKeys = new Set(baseDefects.map(defectKey));
  const headDefKeys = new Set(headDefects.map(defectKey));

  const addedDefects = headDefects.filter((d) => !baseDefKeys.has(defectKey(d)))
    .map((d) => ({ journey: d.journeyId, step: d.step, expected: d.expected, actual: d.actual }));
  const resolvedDefects = baseDefects.filter((d) => !headDefKeys.has(defectKey(d)))
    .map((d) => ({ journey: d.journeyId, step: d.step, expected: d.expected, actual: d.actual }));

  return {
    base,
    head,
    deltas: {
      cases: head.scorecard.totalCases - base.scorecard.totalCases,
      p0: head.scorecard.p0Count - base.scorecard.p0Count,
      defects: head.scorecard.defectsCount - base.scorecard.defectsCount,
      seconds: Number((head.totalSeconds - base.totalSeconds).toFixed(2)),
      passRate: head.scorecard.passRate !== null && base.scorecard.passRate !== null
        ? head.scorecard.passRate - base.scorecard.passRate
        : null,
    },
    addedCases,
    removedCases,
    unchangedCases,
    addedDefects,
    resolvedDefects,
  };
}

export function listQaSuite(cfg: GuardConfig): {
  journeys: { id: string; title: string; area: string; status: string; stepsCount: number; hasSpec: boolean }[];
  templates: { id: string; title: string; priority: string; type: string; area: string }[];
  recentCases: { runId: string; id: string; title: string; priority: string; type: string; area: string; journeyId: string | null }[];
} {
  const journeys = loadJourneys(cfg).map((j) => ({
    id: j.id,
    title: j.title,
    area: j.area,
    status: j.status,
    stepsCount: j.steps.length,
    hasSpec: existsSync(join(cfg.root, "qa", "generated", `${j.id}.spec.ts`)),
  }));
  const tpl = loadTemplates(cfg);
  const templates = tpl.categories.flatMap((cat) =>
    cat.cases.map((c, idx) => ({
      id: `${cat.id}-${idx + 1}`,
      title: c.title,
      priority: c.priority,
      type: c.type,
      area: cat.label,
    })),
  );
  const recentCases: { runId: string; id: string; title: string; priority: string; type: string; area: string; journeyId: string | null }[] = [];
  for (const r of readAllRuns(cfg).slice(0, 15)) {
    for (const c of r.cases ?? []) {
      recentCases.push({
        runId: r.id,
        id: c.id,
        title: c.title,
        priority: c.priority,
        type: c.type,
        area: c.cites?.[0] ?? "",
        journeyId: c.journeyId ?? null,
      });
    }
  }
  return { journeys, templates, recentCases };
}

export function listGovernanceAndCost(cfg: GuardConfig): {
  forbidden: { names: number; selectors: number; keys: number; allowedHosts: string[]; allowedUploadDirs: string[] };
  egress: { totalCalls: number; blockedSecrets: number; maskedSecrets: number; byModel: { model: string; calls: number }[]; recent: { ts: string; role: string; model: string; blockedCount: number; replacedCount: number }[] };
} {
  const f = loadForbidden(cfg.root);
  const logDir = join(cfg.dataDir, "logs");
  const recent: { ts: string; role: string; model: string; blockedCount: number; replacedCount: number }[] = [];
  const byModelMap = new Map<string, number>();
  let blockedSecrets = 0;
  let maskedSecrets = 0;

  if (existsSync(logDir)) {
    const files = readdirSync(logDir)
      .filter((name) => /^egress-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse()
      .slice(0, 14);
    for (const file of files) {
      try {
        const lines = readFileSync(join(logDir, file), "utf8").split(/\r?\n/).filter(Boolean).reverse();
        for (const line of lines) {
          if (recent.length >= MAX_AUDIT_RECORDS) break;
          const rec = JSON.parse(line) as { ts?: string; role?: string; model?: string; blocked?: { count?: number }[]; replaced?: { count?: number }[] };
          const b = (rec.blocked ?? []).reduce((s, x) => s + (Number(x.count) || 0), 0);
          const rep = (rec.replaced ?? []).reduce((s, x) => s + (Number(x.count) || 0), 0);
          blockedSecrets += b;
          maskedSecrets += rep;
          const model = String(rec.model ?? "unknown");
          byModelMap.set(model, (byModelMap.get(model) ?? 0) + 1);
          recent.push({
            ts: String(rec.ts ?? ""),
            role: String(rec.role ?? ""),
            model,
            blockedCount: b,
            replacedCount: rep,
          });
        }
      } catch {
        /* skip damaged audit file */
      }
    }
  }

  return {
    forbidden: {
      names: f.names.length,
      selectors: f.selectors.length,
      keys: f.keys.length,
      allowedHosts: f.allowedHosts,
      allowedUploadDirs: f.allowedUploadDirs,
    },
    egress: {
      totalCalls: recent.length,
      blockedSecrets,
      maskedSecrets,
      byModel: [...byModelMap.entries()].map(([model, calls]) => ({ model, calls })).sort((a, b) => b.calls - a.calls),
      recent: recent.slice(0, 50),
    },
  };
}

export async function cuaDriverStatus(cfg: GuardConfig): Promise<{
  available: boolean;
  command: string;
  version: string | null;
  error?: string;
  deliveryMode: "background";
  blockedTools: string[];
  deniedProcesses: string[];
  allowedApps: string[];
}> {
  const probe = await probeCuaDriver(cfg);
  return {
    ...probe,
    deliveryMode: "background",
    blockedTools: [...BLOCKED_CUA_TOOLS],
    deniedProcesses: [...BUILTIN_DENY_PROCESSES, ...(cfg.cuaDriver?.denyApps ?? [])],
    allowedApps: cfg.cuaDriver?.allowedApps ?? [],
  };
}
