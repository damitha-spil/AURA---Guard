// The QA sub-agent: one pipeline for the chat and the CLI.
//   understand -> target -> context -> design -> (safety) -> report, and `run` only when confirmed.
// READ-ONLY on every source repo. The only files it writes are the two artifacts in
// data/qa/runs/ (plus, after an explicit run, the existing runner's
// evidence in Guard's .artifacts and proposed incident notes in the vault inbox).

import { PROJECT } from "../brand.ts";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { QA_NEEDS_INPUT_HEAD, stripSlash } from "../chat/intent.ts";
import type { ChatTurn, Step } from "../chat/answer.ts";
import type { CompleteFn } from "../brain/client.ts";
import type { Db } from "../index/db.ts";
import { maskOutgoing } from "../mask/mask.ts";
import type { GuardConfig } from "../types.ts";
import { evidenceBlock } from "./cases.ts";
import type { QaArea, QaCase, RiskLevel } from "./cases.ts";
import { buildContext } from "./context.ts";
import type { CheckCommand, QaContext } from "./context.ts";
import { designPlan } from "./design.ts";
import { qaMarkdown } from "./report-md.ts";
import { findRunnable, runConfirmed } from "./run.ts";
import type { QaRunSummary, RunOffer, RunProbe } from "./run.ts";
import type { RunDeps } from "./runner.ts";
import { maskDeep } from "./safe-out.ts";
import { resolveTarget, subjectOf } from "./target.ts";
import type { NeedsInputOption, Target } from "./target.ts";

export const AGENT_ID = "qa";
export const AGENT_LABEL = "QA agent";
/** Files listed in the stored result, so a long change does not make a huge chat file. */
export const MAX_RESULT_FILES = 60;

export interface QaResult {
  version: 1;
  id: string;
  generatedAt: string;
  /** The project name (always SPIL AURA); kept as `department` for the UI. */
  department: { id: string; name: string };
  request: string;
  summary: string;
  assumption: string | null;
  correction: string | null;
  target: {
    kind: Target["kind"]; label: string; fromConversation: boolean; description: string | null;
    pr: { id: number; title: string; status: string; repo: string } | null;
    repos: { repo: string; range: string; commits: number; firstCommit: string | null; baseSha: string | null; headSha: string | null }[];
    skipped: string[];
  };
  risk: { level: RiskLevel; reasons: string[] };
  areas: QaArea[];
  cases: QaCase[];
  regressionChecklist: string[];
  notCovered: string[];
  questions: string[];
  evidence: { uiChange: boolean; needed: string[] };
  checkCommands: CheckCommand[];
  journeys: { available: number; offer: RunOffer };
  run: QaRunSummary | null;
  context: { files: number; areas: number; commits: number; dependents: number; coChange: number; notes: number; journeys: number; hasDiff: boolean; hasGraph: boolean; changedFiles: { repo: string; path: string; category: string }[] };
  artifacts: { markdownPath: string | null; jsonPath: string | null };
  modelUsed: boolean;
  modelNote: string;
  backend: string | null;
  timings: { designSeconds: number; totalSeconds: number };
}

/** A step on the wire: the chat Step shape plus the agent that did it. */
export type QaStep = Step & { agent: "qa" };

export interface AgentDeps {
  cfg: GuardConfig;
  db: Db | null;
  /** Omit for the offline plan. */
  complete?: CompleteFn | undefined;
  /** Friendly backend name ("Claude plan"), for the step label and the result. */
  backend?: string | null;
  onStep?: (step: QaStep) => void;
  now?: () => Date;
  probe?: RunProbe["probe"];
  runDeps?: RunDeps;
  /** false in tests that must prove nothing is written. Default true. */
  writeArtifacts?: boolean;
}

export interface AgentInput {
  message: string;
  history?: ChatTurn[];
  noModel?: boolean;
  /** Set only after the person confirmed running the offered journeys. */
  confirmRun?: boolean;
  /** The result whose journeys are to be run (confirmRun), from the chat file. */
  prior?: QaResult | null;
}

export type AgentOutcome =
  | { kind: "result"; result: QaResult; markdown: string }
  | { kind: "needs-input"; question: string; options: NeedsInputOption[]; text: string }
  | { kind: "blocked"; text: string; blocked: { kind: string; count: number }[] }
  | { kind: "run-unavailable"; text: string };

export const blockedText = (kinds: { kind: string; count: number }[]): string =>
  `Your message looks like it contains a secret (${kinds.map((b) => `${b.kind} x${b.count}`).join(", ")}). Nothing was sent. Remove it and ask again.`;

function shortId(): string { return randomBytes(3).toString("hex"); }

/** data/qa/runs, inside the data folder. Throws if it would leave it. */
export function runsDir(cfg: GuardConfig): string {
  const dir = resolve(join(cfg.dataDir, "qa", "runs"));
  if (!dir.startsWith(resolve(cfg.dataDir) + sep)) throw new Error("Refusing to write outside the data folder.");
  return dir;
}

export async function runQaAgent(deps: AgentDeps, input: AgentInput): Promise<AgentOutcome> {
  const { cfg } = deps;
  const now = deps.now ?? (() => new Date());
  const t0 = Date.now();
  const emit = (id: Step["id"], status: Step["status"], label: string, since: number, detail?: string): void => {
    try {
      deps.onStep?.({ id, kind: id as Step["kind"], status, label, ...(detail ? { detail } : {}), ...(status === "running" ? {} : { ms: Date.now() - since }), agent: "qa" });
    } catch { /* a broken listener must not break the agent */ }
  };

  // A secret typed by the user stops everything: nothing is read, nothing is sent.
  const message = stripSlash(input.message).slice(0, 4000);
  const m = maskOutgoing(message);
  if (!m.ok) return { kind: "blocked", text: blockedText(m.blocked), blocked: m.blocked };

  // 0. Run only what was offered and only when confirmed.
  if (input.confirmRun === true) return runOffered(deps, input, emit);

  // 1. understand
  const tu = Date.now();
  const subject = subjectOf(message);
  emit("understand", "done", "Understood: you want QA on a change", tu, subject ? `Reading your request as: ${subject.slice(0, 160)}` : "No target named; I will look at the chat and the project's code");

  // 2. target
  const tt = Date.now();
  emit("target", "running", "Working out what to QA", tt);
  const resolved = resolveTarget(cfg, { message, history: input.history ?? [] });
  if (!resolved.ok) {
    emit("target", "done", "Need to know what to QA", tt, resolved.question);
    const text = `${QA_NEEDS_INPUT_HEAD}\n\n${resolved.question}\n\n${resolved.options.map((o) => `- ${o.label}`).join("\n")}`;
    return { kind: "needs-input", question: resolved.question, options: resolved.options, text };
  }
  const target = resolved.target;
  emit("target", "done", target.assumption ? `Assumed: ${target.label}` : `Target: ${target.label}`, tt, target.assumption ?? target.repos.map((r) => `${r.repo} ${r.rangeLabel}`).join("; "));

  // 3. context
  const tc = Date.now();
  emit("context", "running", "Reading the change", tc);
  const ctx = buildContext(cfg, deps.db, target);
  const dependents = ctx.blast.reduce((s, b) => s + b.dependents.length, 0);
  emit("context", "done", `Read ${ctx.filesTotal} changed file${ctx.filesTotal === 1 ? "" : "s"} in ${ctx.areas.length} area${ctx.areas.length === 1 ? "" : "s"}`, tc,
    `${ctx.commits.length} commits, ${dependents} dependents, ${ctx.coChange.length} co-change gaps, ${ctx.notes.length} notes, ${ctx.journeysAvailable} journeys in this project`);

  // 4. design
  const td = Date.now();
  const useModel = !input.noModel && !!deps.complete;
  emit("design", "running", useModel ? `Asking ${deps.backend ?? "the model"} to design the tests` : "Designing the tests from templates", td);
  const design = await designPlan(cfg, ctx, target, message, { complete: deps.complete, noModel: input.noModel === true });
  emit("design", "done",
    design.modelUsed ? `${deps.backend ?? "The model"} designed ${design.plan.cases.length} cases in ${design.seconds.toFixed(1)} s` : `Designed ${design.plan.cases.length} cases from templates (model not used)`,
    td, design.modelNote);

  // 5. safety: only when a case is linked to a journey with a generated spec (nothing is generated here).
  let offer = emptyOffer();
  if (design.plan.cases.some((c) => c.journeyId)) {
    const ts = Date.now();
    emit("safety", "running", "Checking journey specs with the safety checker", ts);
    offer = await findRunnable(cfg, design.plan, { probe: deps.probe });
    emit("safety", "done", offer.safety.checked ? `Safety check: ${offer.safety.passed} of ${offer.safety.checked} spec${offer.safety.checked === 1 ? "" : "s"} passed` : "No generated spec to check", ts, offer.note || undefined);
  }

  // 6. report
  const tr = Date.now();
  emit("report", "running", "Writing the QA result", tr);
  const id = `${now().toISOString().slice(0, 10)}-${shortId()}`;
  const result = assemble({ cfg, request: message, target, ctx, design, offer, id, at: now(), backend: deps.backend ?? null, totalMs: Date.now() - t0 });
  const safe = maskDeep(result);
  let markdown = qaMarkdown(safe);
  if (deps.writeArtifacts !== false) {
    const dir = runsDir(cfg);
    mkdirSync(dir, { recursive: true });
    const md = join(dir, `${id}.md`);
    const js = join(dir, `${id}.json`);
    safe.artifacts = { markdownPath: md, jsonPath: js };
    markdown = qaMarkdown(safe);
    writeFileSync(md, markdown, { flag: "wx" });
    writeFileSync(js, JSON.stringify(safe, null, 2), { flag: "wx" });
  }
  emit("report", "done", deps.writeArtifacts === false ? "QA result ready" : "QA result saved", tr, safe.artifacts.markdownPath ?? undefined);
  return { kind: "result", result: safe, markdown };
}

function emptyOffer(): RunOffer {
  return { runnable: [], blocked: [], targetReachable: null, note: "", safety: { checked: 0, passed: 0 } };
}

interface AssembleIn {
  cfg: GuardConfig; request: string; target: Target; ctx: QaContext;
  design: Awaited<ReturnType<typeof designPlan>>; offer: RunOffer; id: string; at: Date; backend: string | null; totalMs: number;
}

function assemble(a: AssembleIn): QaResult {
  const { plan } = a.design;
  const dependents = a.ctx.blast.reduce((s, b) => s + b.dependents.length, 0);
  const notCovered = [...plan.notCovered];
  for (const n of a.design.notes) notCovered.push(n);
  for (const s of a.target.skipped) notCovered.push(s);
  return {
    version: 1, id: a.id, generatedAt: a.at.toISOString(), department: PROJECT, request: a.request, summary: plan.summary,
    assumption: a.target.assumption, correction: a.target.correction,
    target: {
      kind: a.target.kind, label: a.target.label, fromConversation: a.target.fromConversation, description: a.target.description, pr: a.target.pr,
      repos: a.target.repos.map((r) => ({ repo: r.repo, range: r.rangeLabel, commits: r.commits.length, firstCommit: r.commits[0]?.subject ?? null, baseSha: r.baseSha, headSha: r.headSha })),
      skipped: a.target.skipped,
    },
    risk: { level: plan.riskLevel, reasons: plan.riskReasons }, areas: plan.areas, cases: plan.cases,
    regressionChecklist: plan.regressionChecklist, notCovered, questions: plan.questions,
    evidence: plan.evidence.needed.length ? plan.evidence : evidenceBlock(a.cfg, a.ctx),
    checkCommands: a.ctx.checkCommands,
    journeys: { available: a.ctx.journeysAvailable, offer: a.offer },
    run: null,
    context: {
      files: a.ctx.filesTotal, areas: a.ctx.areas.length, commits: a.ctx.commits.length, dependents, coChange: a.ctx.coChange.length,
      notes: a.ctx.notes.length, journeys: a.ctx.journeys.length, hasDiff: a.ctx.hasDiff, hasGraph: a.ctx.hasGraph,
      changedFiles: a.ctx.files.slice(0, MAX_RESULT_FILES).map((f) => ({ repo: f.repo, path: f.path, category: f.categoryLabel })),
    },
    artifacts: { markdownPath: null, jsonPath: null },
    modelUsed: a.design.modelUsed, modelNote: a.design.modelNote, backend: a.design.modelUsed ? a.backend : null,
    timings: { designSeconds: a.design.seconds, totalSeconds: a.totalMs / 1000 },
  };
}

/** The explicit "run the journeys" step. Only the journeys the earlier result offered can run. */
async function runOffered(deps: AgentDeps, input: AgentInput, emit: (id: Step["id"], status: Step["status"], label: string, since: number, detail?: string) => void): Promise<AgentOutcome> {
  const prior = input.prior;
  if (!prior || prior.journeys.offer.runnable.length === 0 || prior.journeys.offer.targetReachable !== true) {
    return { kind: "run-unavailable", text: "There is no read-only journey run on offer here. Ask me to QA a change first; I only offer a run when a journey with a checked spec exists and the app is already open with a debugging port." };
  }
  const t = Date.now();
  emit("run", "running", `Running ${prior.journeys.offer.runnable.length} read-only journey${prior.journeys.offer.runnable.length === 1 ? "" : "s"}`, t);
  // Re-check the offer against the live state: the spec or the app may have changed since it was made.
  const fresh = await findRunnable(deps.cfg, { cases: prior.cases }, { probe: deps.probe });
  if (fresh.runnable.length === 0 || fresh.targetReachable !== true) {
    emit("run", "error", "The offered run is no longer possible", t, fresh.note);
    return { kind: "run-unavailable", text: fresh.note || "The journeys can no longer run (the app is not reachable or a spec changed)." };
  }
  const run = await runConfirmed(deps.cfg, fresh.runnable, { confirmed: true, proposeIncidents: true }, deps.runDeps);
  emit("run", "done", `Journey run ${run.status}: ${run.runs.length} run, ${run.defects.length} defect${run.defects.length === 1 ? "" : "s"}`, t);
  const result: QaResult = maskDeep({ ...prior, run, journeys: { ...prior.journeys, offer: { ...fresh, note: "Run finished." } } });
  const tr = Date.now();
  emit("report", "running", "Updating the QA result", tr);
  const markdown = qaMarkdown(result);
  if (deps.writeArtifacts !== false && result.artifacts.markdownPath && result.artifacts.jsonPath) {
    const dir = runsDir(deps.cfg);
    const target = (p: string): string => { const r = resolve(p); if (!r.startsWith(dir + sep)) throw new Error("Refusing to write outside the QA folder."); return r; };
    writeFileSync(target(result.artifacts.markdownPath), markdown);
    writeFileSync(target(result.artifacts.jsonPath), JSON.stringify(result, null, 2));
  }
  emit("report", "done", "QA result updated", tr);
  return { kind: "result", result, markdown };
}
