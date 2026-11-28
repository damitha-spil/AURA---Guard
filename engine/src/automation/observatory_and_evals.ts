// Wave 3 Platform Features (Execution Observatory, Promptfoo-Style Evaluation Lab, Self-Improving Skill Proposals):
// 1. OpenTelemetry-compatible JSON Trace Spans emitted by runAgenticMission
// 2. Side-by-side multi-provider Evaluation Lab benchmarks (with live + heuristic dry-run modes)
// 3. Hermes / Goose style Self-Improving Skill & Rule Proposal Loop (strictly proposed, never auto-active)

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBackends } from "../brain/select.ts";
import { listProductionDefects } from "../defects/store.ts";
import { detectSecrets } from "../mask/detectors.ts";
import { maskOutgoing } from "../mask/mask.ts";
import { maskDeep } from "../qa/safe-out.ts";
import type { GuardConfig } from "../types.ts";
import type { QualityVerdict } from "./harness.ts";

/** Cap stored mission traces on disk. */
export const MAX_STORED_TRACES = 60;
/** Cap stored evaluation lab benchmarks on disk. */
export const MAX_BENCHMARKS = 40;
/** Cap stored skill proposals on disk. */
export const MAX_SKILL_PROPOSALS = 80;
/** Minimum recurrence or similar defect cluster threshold before auto-proposing a skill/rule patch. */
export const PROPOSAL_RECURRENCE_THRESHOLD = 2;

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "AGENT" | "TOOL" | "GATE";
  agent?: string;
  tool?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationMs: number;
  status: "OK" | "ERROR";
  attributes: Record<string, string | number | boolean>;
}

export interface MissionTrace {
  traceId: string;
  missionId: string;
  prompt: string;
  agents: string[];
  startedAt: string;
  totalDurationMs: number;
  verdict: QualityVerdict;
  spanCount: number;
  spans: OtelSpan[];
}

export interface BenchmarkCaseResult {
  providerId: string;
  model: string;
  mode: "live" | "heuristic_dry_run";
  latencyMs: number;
  estimatedCostUsd: number;
  citationScore: number;
  secretSafetyPass: boolean;
  completenessScore: number;
  overallScore: number;
  excerpt: string;
  error?: string;
}

export interface ModelBenchmarkRun {
  id: string;
  createdAt: string;
  prompt: string;
  expectedKeywords: string[];
  winner: string;
  results: BenchmarkCaseResult[];
}

export type SkillProposalStatus = "proposed" | "approved" | "dismissed";

export interface SkillProposal {
  id: string;
  patternKey: string;
  targetKind: "skill" | "vault_rule";
  targetName: string;
  title: string;
  rationale: string;
  occurrences: number;
  proposedPatchMarkdown: string;
  status: SkillProposalStatus;
  sourceMissionId?: string;
  createdAt: string;
  reviewedAt?: string;
  vaultDraftPath?: string;
}

function readJsonArray<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeJsonArray<T>(dataDir: string, file: string, items: T[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(items, null, 2), "utf8");
}

function tracesFile(dataDir: string): string {
  return join(dataDir, "mission-traces.json");
}

function benchmarksFile(dataDir: string): string {
  return join(dataDir, "benchmarks.json");
}

function proposalsFile(dataDir: string): string {
  return join(dataDir, "skill-proposals.json");
}

/** Generate OpenTelemetry-compatible timestamps in nanosecond strings from epoch ms. */
export function msToUnixNanoString(epochMs: number): string {
  return (BigInt(Math.max(0, Math.round(epochMs))) * 1_000_000n).toString();
}

export function listMissionTraces(dataDir: string, limit = 25): MissionTrace[] {
  return readJsonArray<MissionTrace>(tracesFile(dataDir)).slice(0, Math.max(1, limit));
}

export function recordMissionTrace(dataDir: string, trace: MissionTrace): MissionTrace {
  const safe = maskDeep(trace);
  const next = [safe, ...listMissionTraces(dataDir, MAX_STORED_TRACES - 1)];
  writeJsonArray(dataDir, tracesFile(dataDir), next);
  return safe;
}

export function listModelBenchmarks(dataDir: string, limit = 20): ModelBenchmarkRun[] {
  return readJsonArray<ModelBenchmarkRun>(benchmarksFile(dataDir)).slice(0, Math.max(1, limit));
}

function scoreBenchmarkText(text: string, expectedKeywords: string[]): {
  citationScore: number;
  secretSafetyPass: boolean;
  completenessScore: number;
  overallScore: number;
} {
  const lower = text.toLowerCase();
  const matchedKeywords = expectedKeywords.filter((kw) => kw.trim() && lower.includes(kw.trim().toLowerCase())).length;
  const keywordPct = expectedKeywords.length > 0 ? Math.round((matchedKeywords / expectedKeywords.length) * 60) : 45;
  const hasFileOrNoteCitation = /(?:[a-z0-9_-]+\.[a-z]{1,4}(?::\d+)?|vault\/|engine\/|web\/|@qa|@qe|@security)/i.test(text);
  const citationScore = Math.min(100, keywordPct + (hasFileOrNoteCitation ? 40 : 10));

  const secretHits = detectSecrets(text).filter((s) => s.severity === "secret");
  const secretSafetyPass = secretHits.length === 0;

  const hasStepsOrBullets = /(?:^|\n)\s*(?:\d+\.|[-*]|\*\*)/m.test(text) && text.length >= 60;
  const completenessScore = Math.min(100, (hasStepsOrBullets ? 70 : 40) + Math.min(30, Math.round(text.length / 25)));

  const rawOverall = Math.round(citationScore * 0.45 + completenessScore * 0.35 + (secretSafetyPass ? 20 : 0));
  const overallScore = secretSafetyPass ? rawOverall : Math.min(35, rawOverall);
  return { citationScore, secretSafetyPass, completenessScore, overallScore };
}

function synthesizeDryRunOutput(providerId: string, prompt: string, expectedKeywords: string[]): {
  text: string;
  latencyMs: number;
  estimatedCostUsd: number;
} {
  const kwHint = expectedKeywords.length ? `Focus areas: ${expectedKeywords.join(", ")}.` : "Focus areas: regression coverage, security hygiene, evidence.";
  if (providerId === "claude-cli") {
    return {
      text: [
        `## ${providerId} QA Plan`,
        `1. Run Tier 0 \`review_ast_grep\` and \`qe_arch_boundaries\` on changed files.`,
        `2. Execute \`sec_semgrep_scan\` + \`sec_dependency_cves\` targeting vault/rules/security.md policies.`,
        `3. Verify local routes via \`qa_axe_audit\` & \`api_schemathesis_fuzz\`. ${kwHint}`,
      ].join("\n"),
      latencyMs: 620,
      estimatedCostUsd: 0.0042,
    };
  }
  if (providerId === "antigravity-cli") {
    return {
      text: [
        `## ${providerId} Multi-Agent Verification`,
        `- Route request (${prompt.slice(0, 80)}) across @qa, @qe, and @security.`,
        `- Ground findings in \`engine/src/qa/security_probes.ts\` and indexed Vault rules.`,
        `- Emit OpenTelemetry spans and evaluate Quality Gate (\`PASS\` / \`BLOCK_RELEASE\`). ${kwHint}`,
      ].join("\n"),
      latencyMs: 480,
      estimatedCostUsd: 0.0028,
    };
  }
  return {
    text: [
      `## ${providerId} Evaluation Response`,
      `- Inspect repository diff and run Tier 0 checks.`,
      `- Summarize defects for triage. ${kwHint}`,
    ].join("\n"),
    latencyMs: 540,
    estimatedCostUsd: 0.0019,
  };
}

/** Promptfoo-style side-by-side provider benchmark on a masked QA/Review prompt. */
export async function runModelBenchmark(
  cfg: GuardConfig,
  opts: {
    prompt: string;
    providers?: string[];
    expectedKeywords?: string[];
    liveCall?: boolean;
    completeOverride?: (providerId: string, maskedPrompt: string) => Promise<{ text: string; model?: string }>;
  },
): Promise<ModelBenchmarkRun> {
  const rawPrompt = opts.prompt.trim();
  if (!rawPrompt) throw new Error("Benchmark prompt is required.");

  const masked = maskOutgoing(rawPrompt);
  if (!masked.ok) {
    throw new Error(`Benchmark prompt blocked by secret gate (${masked.blocked.map((b) => b.kind).join(", ")}).`);
  }

  const expectedKeywords = (opts.expectedKeywords ?? []).map((s) => s.trim()).filter(Boolean);
  const requestedProviders =
    opts.providers && opts.providers.length > 0
      ? opts.providers
      : ["antigravity-cli", "claude-cli", "opencode-cli"];

  const backends = buildBackends(cfg);
  const results: BenchmarkCaseResult[] = [];

  for (const pid of requestedProviders.slice(0, 6)) {
    const t0 = performance.now();
    let mode: BenchmarkCaseResult["mode"] = "heuristic_dry_run";
    let model = pid;
    let text = "";
    let estimatedCostUsd = 0;
    let error: string | undefined;

    if (opts.completeOverride) {
      try {
        const out = await opts.completeOverride(pid, masked.text);
        mode = "live";
        model = out.model || pid;
        text = out.text;
        estimatedCostUsd = Number(((masked.text.length + text.length) / 400_000).toFixed(4));
      } catch (e) {
        error = (e as Error).message;
      }
    } else if (opts.liveCall) {
      const backend = backends.find((b) => b.id === pid);
      if (backend) {
        const avail = await backend.available().catch(() => ({ ok: false, detail: "Unavailable" }));
        if (avail.ok) {
          try {
            const out = await backend.complete({
              role: "qa-benchmark",
              system: ["You are SPIL REO Evaluation Benchmark assistant. Give concise, actionable engineering verification steps citing file paths where relevant."],
              user: masked.text,
              maxTokens: 600,
              audit: () => {},
            });
            mode = "live";
            model = out.model || pid;
            text = out.text;
            const tokIn = out.usage.input_tokens || Math.ceil(masked.text.length / 4);
            const tokOut = out.usage.output_tokens || Math.ceil(text.length / 4);
            estimatedCostUsd = Number(((tokIn * 0.000003) + (tokOut * 0.000015)).toFixed(4));
          } catch (e) {
            error = (e as Error).message;
          }
        }
      }
    }

    if (!text) {
      const dry = synthesizeDryRunOutput(pid, masked.text, expectedKeywords);
      text = dry.text;
      estimatedCostUsd = dry.estimatedCostUsd;
      const scores = scoreBenchmarkText(text, expectedKeywords);
      results.push({
        providerId: pid,
        model,
        mode: "heuristic_dry_run",
        latencyMs: dry.latencyMs,
        estimatedCostUsd,
        ...scores,
        excerpt: text.slice(0, 260),
        ...(error ? { error } : {}),
      });
      continue;
    }

    const latencyMs = Math.max(1, Math.round(performance.now() - t0));
    const scores = scoreBenchmarkText(text, expectedKeywords);
    results.push({
      providerId: pid,
      model,
      mode,
      latencyMs,
      estimatedCostUsd,
      ...scores,
      excerpt: text.slice(0, 260),
      ...(error ? { error } : {}),
    });
  }

  const sorted = [...results].sort((a, b) => b.overallScore - a.overallScore || a.latencyMs - b.latencyMs);
  const winner = sorted[0]?.providerId ?? "none";

  const run: ModelBenchmarkRun = maskDeep({
    id: `bench-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    prompt: masked.text,
    expectedKeywords,
    winner,
    results,
  });

  const next = [run, ...listModelBenchmarks(cfg.dataDir, MAX_BENCHMARKS - 1)];
  writeJsonArray(cfg.dataDir, benchmarksFile(cfg.dataDir), next);
  return run;
}

export function listSkillProposals(dataDir: string, status?: SkillProposalStatus): SkillProposal[] {
  const all = readJsonArray<SkillProposal>(proposalsFile(dataDir));
  return status ? all.filter((p) => p.status === status) : all;
}

/** Create or increment a strictly non-active `status: "proposed"` skill/rule improvement draft. */
export function proposeSkillImprovement(
  dataDir: string,
  input: {
    patternKey: string;
    targetKind?: "skill" | "vault_rule";
    targetName: string;
    title: string;
    rationale: string;
    proposedPatchMarkdown: string;
    occurrences?: number;
    sourceMissionId?: string;
  },
): SkillProposal {
  const all = listSkillProposals(dataDir);
  const now = new Date().toISOString();
  const key = input.patternKey.trim().toLowerCase();
  const existingIdx = all.findIndex((p) => p.patternKey.toLowerCase() === key && p.status !== "dismissed");

  if (existingIdx >= 0) {
    const existing = all[existingIdx]!;
    const updated: SkillProposal = maskDeep({
      ...existing,
      occurrences: existing.occurrences + (input.occurrences ?? 1),
      rationale: input.rationale || existing.rationale,
      ...(input.sourceMissionId ? { sourceMissionId: input.sourceMissionId } : {}),
    });
    all[existingIdx] = updated;
    writeJsonArray(dataDir, proposalsFile(dataDir), all);
    return updated;
  }

  const created: SkillProposal = maskDeep({
    id: `prop-${randomUUID().slice(0, 8)}`,
    patternKey: key,
    targetKind: input.targetKind ?? "skill",
    targetName: input.targetName.trim() || "qe-ast-rules",
    title: input.title.trim().slice(0, 140),
    rationale: input.rationale.trim().slice(0, 500),
    occurrences: Math.max(1, input.occurrences ?? 1),
    proposedPatchMarkdown: input.proposedPatchMarkdown.trim().slice(0, 2000),
    status: "proposed",
    ...(input.sourceMissionId ? { sourceMissionId: input.sourceMissionId } : {}),
    createdAt: now,
  });

  writeJsonArray(dataDir, proposalsFile(dataDir), [created, ...all].slice(0, MAX_SKILL_PROPOSALS));
  return created;
}

/** Human review step for a SkillProposal. Approved rules write only a `status: proposed` inbox note in Vault. */
export function reviewSkillProposal(
  dataDir: string,
  id: string,
  decision: "approved" | "dismissed",
  vaultDir?: string,
): SkillProposal | null {
  const all = listSkillProposals(dataDir);
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) return null;

  const existing = all[idx]!;
  let vaultDraftPath = existing.vaultDraftPath;
  if (decision === "approved" && vaultDir && existsSync(vaultDir)) {
    const inboxDir = join(vaultDir, "inbox");
    mkdirSync(inboxDir, { recursive: true });
    const noteFile = join(inboxDir, `${existing.id}.md`);
    const createdDay = new Date().toISOString().slice(0, 10);
    const noteBody = [
      "---",
      `id: ${existing.id}`,
      "type: rule",
      "status: proposed",
      "audience:",
      "  - internal_dev",
      "  - qa_internal",
      "source: session",
      `created: "${createdDay}"`,
      `title: "${existing.title.replace(/"/g, "'")}"`,
      "---",
      "",
      `# ${existing.title}`,
      "",
      `Target ${existing.targetKind}: \`${existing.targetName}\``,
      "",
      "## Rationale",
      existing.rationale,
      "",
      "## Proposed Addition",
      "",
      existing.proposedPatchMarkdown,
      "",
    ].join("\n");
    writeFileSync(noteFile, noteBody, "utf8");
    vaultDraftPath = `inbox/${existing.id}.md`;
  }

  const updated: SkillProposal = maskDeep({
    ...existing,
    status: decision,
    reviewedAt: new Date().toISOString(),
    ...(vaultDraftPath ? { vaultDraftPath } : {}),
  });
  all[idx] = updated;
  writeJsonArray(dataDir, proposalsFile(dataDir), all);
  return updated;
}

/** Scan recurring defects (>=2 occurrences or repeated rule cluster) and propose durable skill/rule patches. */
export function detectAndProposeFromDefects(dataDir: string, missionId: string): SkillProposal[] {
  const defects = listProductionDefects(dataDir);
  const proposed: SkillProposal[] = [];

  for (const d of defects) {
    const count = d.recurrenceCount ?? 1;
    if (count < PROPOSAL_RECURRENCE_THRESHOLD) continue;
    const slugKey = `recur-${d.fingerprint}`;
    const targetName = d.agentSource === "security" ? "sec-sarif-triage" : d.agentSource === "qe" ? "qe-ast-rules" : "qa-wcag-gate";
    const item = proposeSkillImprovement(dataDir, {
      patternKey: slugKey,
      targetKind: d.agentSource === "qe" ? "vault_rule" : "skill",
      targetName,
      title: `Prevent recurring ${d.agentSource.toUpperCase()} defect: ${d.title.slice(0, 80)}`,
      rationale: `Defect ${d.id} has recurred ${count} time(s). Add a pre-merge Tier 0 check or explicit checklist item.`,
      proposedPatchMarkdown: [
        `- **Pattern:** ${d.title}`,
        `- **Target File:** ${d.fileRef || "n/a"}`,
        `- **Guard Check:** ${d.codeSuggestion || d.expected || "Add automated regression assertion."}`,
      ].join("\n"),
      occurrences: count,
      sourceMissionId: missionId,
    });
    proposed.push(item);
    if (proposed.length >= 5) break;
  }
  return proposed;
}
