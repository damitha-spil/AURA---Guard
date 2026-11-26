// Stage B evaluation & triage:
// 1. VLM/LLM-as-a-Judge 4-rubric scoring (masked, with deterministic fallback when offline)
// 2. Trajectory efficiency evaluation (loops, stale-token recovery, safety blocks)
// 3. 1-Click Triage actions (real_bug -> proposed incident + PR comment, update_baseline, flaky_hint)

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { stringify } from "yaml";
import type { CompleteFn } from "../brain/client.ts";
import { maskOutgoing } from "../mask/mask.ts";
import type { GuardConfig } from "../types.ts";
import type { StepRecord } from "./harness.ts";
import { safeQaScreenshotPath } from "./harness_api.ts";
import type { OracleReport } from "./oracles.ts";
import { maskDeep } from "./safe-out.ts";

/** Safety cap on stored journey triage hints to prevent unbounded file growth. */
export const MAX_QA_HINTS = 200;

export type RubricId = "visual_layout" | "copy_clarity" | "data_accuracy" | "safety_compliance";

export interface RubricScore {
  id: RubricId;
  label: string;
  score: number; // 1..5
  evidence: string;
}

export interface JudgeEvaluation {
  modelUsed: boolean;
  overallScore: number; // 1..5
  verdict: "pass" | "warn" | "fail";
  rubrics: RubricScore[];
  summary: string;
}

export interface TrajectoryStep {
  action: string;
  target: string;
  status: "passed" | "failed" | "blocked";
  staleRecovery?: boolean;
  ms?: number;
}

export interface TrajectoryEvaluation {
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  safetyBlocks: number;
  repeatedLoops: number;
  staleRecoveries: number;
  efficiencyScore: number; // 0..100
  summary: string;
}

export type TriageAction = "real_bug" | "update_baseline" | "flaky_hint";

export interface QaHint {
  id: string;
  journey: string;
  step: string;
  hint: string;
  createdAt: string;
}

export interface TriageInput {
  action: TriageAction;
  runId: string;
  journey: string;
  step: string;
  expected?: string;
  actual?: string;
  width?: number | null;
  screenshotPath?: string | null;
  hint?: string;
  now?: Date;
}

export interface TriageResult {
  ok: boolean;
  action: TriageAction;
  message: string;
  incidentPath?: string;
  baselinePath?: string;
  prCommentMarkdown?: string;
  regressionAssertion?: string;
  hintRecord?: QaHint;
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "item";

function clampScore(n: unknown, fallback = 3): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(5, Math.round(v)));
}

function deterministicRubrics(oracleReport?: OracleReport, safetyBlockedCount = 0): RubricScore[] {
  const layoutFails = oracleReport ? oracleReport.byOracle.layout.findingsCount : 0;
  const protoFails = oracleReport ? oracleReport.byOracle.protocol.findingsCount : 0;
  const consoleFails = oracleReport ? oracleReport.byOracle.console.findingsCount : 0;
  const formFails = oracleReport ? oracleReport.byOracle.form.findingsCount : 0;

  const visual = layoutFails === 0 ? 5 : Math.max(1, 5 - layoutFails * 2);
  const copy = protoFails === 0 ? 5 : 1;
  const data = consoleFails === 0 && formFails === 0 ? 5 : Math.max(1, 5 - (consoleFails + formFails));
  const safety = safetyBlockedCount === 0 ? 5 : Math.max(2, 5 - safetyBlockedCount);

  return [
    {
      id: "visual_layout",
      label: "Visual Layout & Alignment",
      score: visual,
      evidence: layoutFails === 0 ? "No overflow, clipping, or pane squeeze detected." : `${layoutFails} layout oracle finding(s).`,
    },
    {
      id: "copy_clarity",
      label: "Copy & Plain-Words Clarity",
      score: copy,
      evidence: protoFails === 0 ? "No raw JSON, control tags, or secret leaks in rendered text." : `${protoFails} protocol/copy leak finding(s).`,
    },
    {
      id: "data_accuracy",
      label: "Task & Runtime Accuracy",
      score: data,
      evidence: consoleFails + formFails === 0 ? "No console/IPC/form semantic errors observed." : `${consoleFails} runtime and ${formFails} form finding(s).`,
    },
    {
      id: "safety_compliance",
      label: "Safety Boundary Compliance",
      score: safety,
      evidence: safetyBlockedCount === 0 ? "All actions remained within read/sandbox safety tier." : `${safetyBlockedCount} blocked action attempt(s) intercepted.`,
    },
  ];
}

function summarizeEvaluation(rubrics: RubricScore[], modelUsed: boolean): JudgeEvaluation {
  const avg = rubrics.reduce((s, r) => s + r.score, 0) / Math.max(1, rubrics.length);
  const overallScore = Number(avg.toFixed(2));
  const minScore = Math.min(...rubrics.map((r) => r.score));
  const verdict: JudgeEvaluation["verdict"] = minScore <= 2 || overallScore < 3 ? "fail" : overallScore < 4.2 ? "warn" : "pass";
  return {
    modelUsed,
    overallScore,
    verdict,
    rubrics,
    summary: `Overall rubric score ${overallScore}/5 (${verdict.toUpperCase()})${modelUsed ? " via rubric judge" : " via deterministic oracles"}.`,
  };
}

/** Stage B: Evaluates run state against 4 fixed rubrics. Masks all text before calling `complete`. */
export async function evaluateWithRubric(
  input: {
    journey: string;
    summary?: string;
    visibleText?: string;
    ariaSnapshot?: string;
    oracleReport?: OracleReport;
    safetyBlockedCount?: number;
  },
  complete?: CompleteFn,
): Promise<JudgeEvaluation> {
  const fallbackRubrics = deterministicRubrics(input.oracleReport, input.safetyBlockedCount ?? 0);
  if (!complete) return summarizeEvaluation(fallbackRubrics, false);

  const rawContext = [
    `Journey: ${input.journey}`,
    input.summary ? `Summary: ${input.summary}` : "",
    input.oracleReport ? `Oracles: ${input.oracleReport.passed} passed, ${input.oracleReport.failed} failed, ${input.oracleReport.warned} warned` : "",
    input.oracleReport?.findings.length
      ? `Findings:\n${input.oracleReport.findings.slice(0, 10).map((f) => `- [${f.oracle}/${f.severity}] ${f.message}`).join("\n")}`
      : "Findings: none",
    input.ariaSnapshot ? `ARIA Snapshot:\n${input.ariaSnapshot.slice(0, 2000)}` : "",
    input.visibleText ? `Visible Text:\n${input.visibleText.slice(0, 1500)}` : "",
  ].filter(Boolean).join("\n\n");

  const masked = maskOutgoing(rawContext);
  if (!masked.ok) {
    return summarizeEvaluation(fallbackRubrics, false);
  }

  try {
    const reply = await complete({
      role: "qa-judge",
      maxTokens: 700,
      system: [
        "Score the QA run on 4 rubrics from 1 (broken) to 5 (clean): visual_layout, copy_clarity, data_accuracy, safety_compliance.",
        "Return strict JSON: {\"rubrics\":[{\"id\":\"visual_layout\",\"score\":5,\"evidence\":\"...\"}, ...]} with no extra prose.",
      ],
      user: masked.text,
    });
    const parsed = JSON.parse(reply.text.trim().replace(/^```json\s*|\s*```$/g, "")) as {
      rubrics?: { id?: string; score?: number; evidence?: string }[];
    };
    const byId = new Map((parsed.rubrics ?? []).map((r) => [r.id, r]));
    const merged = fallbackRubrics.map((fb) => {
      const hit = byId.get(fb.id);
      if (!hit) return fb;
      return {
        ...fb,
        score: clampScore(hit.score, fb.score),
        evidence: typeof hit.evidence === "string" && hit.evidence.trim() ? hit.evidence.trim().slice(0, 220) : fb.evidence,
      };
    });
    return summarizeEvaluation(merged, true);
  } catch {
    return summarizeEvaluation(fallbackRubrics, false);
  }
}

/** Deterministic trajectory evaluator for journey and exploratory runs. */
export function evaluateTrajectory(steps: (TrajectoryStep | StepRecord)[]): TrajectoryEvaluation {
  const totalSteps = steps.length;
  let passedSteps = 0;
  let failedSteps = 0;
  let safetyBlocks = 0;
  let staleRecoveries = 0;
  let repeatedLoops = 0;
  let prevSig = "";
  let repeatStreak = 0;

  for (const s of steps) {
    const status = s.status;
    if (status === "passed") passedSteps++;
    else if (status === "blocked") safetyBlocks++;
    else failedSteps++;

    if ("staleRecovery" in s && s.staleRecovery) staleRecoveries++;
    const sig = "action" in s ? `${s.action}:${s.target}` : s.title;
    if (sig === prevSig) {
      repeatStreak++;
      if (repeatStreak >= 1) repeatedLoops++;
    } else {
      repeatStreak = 0;
    }
    prevSig = sig;
  }

  let score = 100;
  score -= failedSteps * 15;
  score -= repeatedLoops * 12;
  score -= safetyBlocks * 10;
  score -= staleRecoveries * 3;
  const efficiencyScore = Math.max(0, Math.min(100, score));

  return {
    totalSteps,
    passedSteps,
    failedSteps,
    safetyBlocks,
    repeatedLoops,
    staleRecoveries,
    efficiencyScore,
    summary: `${passedSteps}/${totalSteps} steps passed · ${repeatedLoops} loop(s) · ${safetyBlocks} safety block(s) · efficiency ${efficiencyScore}/100.`,
  };
}

export function hintsFilePath(cfg: GuardConfig): string {
  return join(cfg.dataDir, "qa", "hints.json");
}

export function loadQaHints(cfg: GuardConfig): QaHint[] {
  const file = hintsFilePath(cfg);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as QaHint[]) : [];
  } catch {
    return [];
  }
}

/** Applies a 1-click triage decision from the Control Room or /qa-triage skill. */
export function applyTriageDecision(cfg: GuardConfig, input: TriageInput): TriageResult {
  const now = input.now ?? new Date();
  const safeJourney = slug(input.journey.replace(/^journey-/, ""));
  const safeStep = slug(input.step);

  if (input.action === "real_bug") {
    const inboxDir = join(cfg.vaultDir, "inbox");
    mkdirSync(inboxDir, { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
    const id = `incident-qa-triage-${safeJourney}-${stamp}`;
    const file = join(inboxDir, `${id}.md`);
    const expected = input.expected ?? "Expected step behavior without error or overflow.";
    const actual = input.actual ?? "Observed failure during QA run.";
    const meta = maskDeep({
      id,
      type: "incident",
      status: "proposed",
      audience: ["qa_internal", "internal_dev"],
      source: "evidence",
      created: now.toISOString().slice(0, 10),
      title: `QA triage bug: ${input.step}`,
    });
    const body = maskDeep([
      `# QA triage bug: ${input.step}`,
      "",
      "## Summary",
      `- Journey: \`${input.journey}\``,
      `- Run: \`${input.runId}\`${input.width ? ` at ${input.width} px` : ""}`,
      `- Expected: ${expected}`,
      `- Actual: ${actual}`,
      input.screenshotPath ? `- Screenshot: \`${input.screenshotPath}\`` : "- Screenshot: none",
      "",
      "## Regression assertion",
      "```json",
      JSON.stringify({ action: "assert_oracles", note: `Regression guard for ${input.step}` }, null, 2),
      "```",
    ].join("\n"));
    writeFileSync(file, `---\n${stringify(meta, { lineWidth: 0 })}---\n\n${body}\n`);
    const prCommentMarkdown = [
      `### QA Defect: ${input.step}`,
      `- **Journey:** \`${input.journey}\`${input.width ? ` (${input.width} px)` : ""}`,
      `- **Expected:** ${expected}`,
      `- **Actual:** ${actual}`,
      `- **Run:** \`${input.runId}\``,
    ].join("\n");
    return {
      ok: true,
      action: "real_bug",
      message: `Proposed incident note written to ${file}`,
      incidentPath: file,
      prCommentMarkdown,
      regressionAssertion: JSON.stringify({ action: "assert_oracles", expected }),
    };
  }

  if (input.action === "update_baseline") {
    const src = input.screenshotPath ? safeQaScreenshotPath(cfg, input.screenshotPath) : null;
    if (!src) {
      return { ok: false, action: "update_baseline", message: "No valid screenshot inside .artifacts/qa/ to promote as baseline." };
    }
    const baseRoot = resolve(join(cfg.root, ".artifacts", "qa", "baselines"));
    const destDir = resolve(join(baseRoot, safeJourney));
    if (!destDir.startsWith(baseRoot + sep)) {
      return { ok: false, action: "update_baseline", message: "Refusing baseline path outside .artifacts/qa/baselines." };
    }
    mkdirSync(destDir, { recursive: true });
    const wLabel = input.width ? `${input.width}px` : "window";
    const dest = join(destDir, `${wLabel}-${safeStep}.png`);
    copyFileSync(src, dest);
    return {
      ok: true,
      action: "update_baseline",
      message: `Baseline updated at ${dest}`,
      baselinePath: dest,
    };
  }

  const hintText = (input.hint ?? "").trim();
  if (!hintText) {
    return { ok: false, action: "flaky_hint", message: "Provide a non-empty hint before saving." };
  }
  const existing = loadQaHints(cfg);
  const record: QaHint = maskDeep({
    id: `hint-${Date.now().toString(36)}`,
    journey: input.journey,
    step: input.step,
    hint: hintText,
    createdAt: now.toISOString(),
  });
  const next = [record, ...existing].slice(0, MAX_QA_HINTS);
  const file = hintsFilePath(cfg);
  mkdirSync(join(cfg.dataDir, "qa"), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return {
    ok: true,
    action: "flaky_hint",
    message: `Saved hint for ${input.journey} (${input.step}).`,
    hintRecord: record,
  };
}
