// Commands for the Code Reviewer, defect finder and refactor advisor.
// Merge into EXTRA_COMMANDS in main.ts:  Object.assign(EXTRA_COMMANDS, reviewCommands)
// main.ts VALUE_FLAGS should also list "base" and "head"; until then these commands read them from argv.

import { existsSync } from "node:fs";
import { dbPath } from "../config.ts";
import { openDb } from "../index/db.ts";
import type { Db } from "../index/db.ts";
import { ApiError, BlockedError, MissingKeyError } from "../brain/client.ts";
import { CliError } from "../brain/backends.ts";
import { createBrain, NoBackendError } from "../brain/select.ts";
import { reviewChange } from "../review/reviewer.ts";
import type { ReviewDeps } from "../review/reviewer.ts";
import { suggestRefactor } from "../review/refactor.ts";
import { countsLine, writeRefactorReport, writeReviewReport } from "../review/report.ts";
import { classifyChange, evaluateEvidence, SCOPE_LABEL } from "../qa/evidence_scope.ts";
import { DEFAULT_MODEL_CAP, runReplay } from "../review/replay.ts";
import type { CommandContext } from "./main.ts";

const copy = {
  usageReview: "review [repo] [--base ref] [--head ref] [--no-model]",
  usageRefactor: "refactor <repo> <path> [--no-model]",
  usageReplay: "replay [repo] [--limit N] [--model [--model-cap N]]",
  needArgs: (cmd: string, usage: string) => `Usage: aura-guard ${cmd}. Expected: ${usage}`,
  noRepo: "No repo is configured. Add one to guard.config.local.json.",
  proof: (scope: string, status: string, needed: string) => `Proof ${status}: ${scope}. Needed: ${needed || "unknown"}. This review is not proof.`,
  noIndexNote: "No index found: history and notes are not used. Run `index` first for the full review.",
  emptyChange: "Nothing to review: the change has no reviewable files.",
  reviewDone: (path: string) => `Review report: ${path}`,
  refactorDone: (path: string) => `Refactor report: ${path}`,
  replayDone: (path: string) => `Replay report: ${path}`,
  top: (sev: string, file: string, line: number, rule: string, msg: string) => `  [${sev}] ${file}:${line} (${rule}) ${msg}`,
  noComments: "No comments: nothing in this change needs a person's attention.",
  lowerPriority: (n: number) => `+${n} lower priority (in the report appendix).`,
  compliance: (n: number) => `${n} rule-compliance findings (Aura's written rules), listed in the report.`,
  fullReport: (p: string) => `Full report with the appendix: ${p}`,
  fixed: (c: string) => `Fixed checks: ${c}`,
  model: (c: string) => `Model review: ${c}`,
  modelOff: "Model review: not used",
  modelFailed: (e: string) => `Model review: failed (${e})`,
  backend: (b: string) => `Model backend: ${b}`,
  modelUnavailable: (why: string) => `The model could not be used, so only the fixed checks ran. ${why}`,
  shadow: "Shadow mode: nothing was posted anywhere.",
  files: (n: number, a: number, r: number) => `Files reviewed: ${n} (+${a} -${r} lines)`,
  refactors: (n: number, ok: number) => `Refactor ideas: ${n}, patches that apply: ${ok}`,
  replaySummary: (fixes: number, intro: number, found: number, cases: number, prec: string) =>
    `Replay: ${fixes} fix commits, ${intro} introducing changes. Defect checks found ${found} of ${cases} later-fixed lines; precision ${prec}. Policy findings are not scored.`,
  replayModel: (found: number, cases: number, runs: number) => `Model found ${found} of ${cases} later-fixed lines on ${runs} changes.`,
  unknownRepo: (id: string) => `Unknown repo "${id}".`,
};

/** A flag's value. Reads argv when main.ts did not know the flag takes a value. */
function flagValue(ctx: CommandContext, name: string): { value: string | undefined; consumed: string | undefined } {
  const f = ctx.flags[name];
  if (typeof f === "string") return { value: f, consumed: undefined };
  if (f !== true) return { value: undefined, consumed: undefined };
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (v !== undefined && !v.startsWith("--")) return { value: v, consumed: v };
  return { value: undefined, consumed: undefined };
}

function positionals(ctx: CommandContext, consumed: (string | undefined)[]): string[] {
  const rest = [...ctx.rest];
  for (const c of consumed) {
    const i = c === undefined ? -1 : rest.indexOf(c);
    if (i >= 0) rest.splice(i, 1);
  }
  return rest;
}

function openIndex(ctx: CommandContext): Db | null {
  const file = dbPath(ctx.cfg);
  return existsSync(file) ? openDb(file) : null;
}

function isModelError(e: unknown): e is Error {
  return e instanceof MissingKeyError || e instanceof BlockedError || e instanceof ApiError ||
    e instanceof NoBackendError || e instanceof CliError;
}

function modelDeps(ctx: CommandContext, wantModel: boolean): ReviewDeps {
  if (!wantModel) return {};
  const brain = createBrain(ctx.cfg);
  return { complete: brain.complete, backendUsed: brain.backendUsed };
}

async function review(ctx: CommandContext): Promise<number> {
  const base = flagValue(ctx, "base");
  const head = flagValue(ctx, "head");
  const rest = positionals(ctx, [base.consumed, head.consumed]);
  const repo = rest[0] ?? ctx.cfg.repos[0]?.id;
  if (!repo) { ctx.out(copy.noRepo); return 2; }
  const db = openIndex(ctx);
  if (!db) ctx.out(copy.noIndexNote);
  const req = {
    repo, ...(base.value ? { base: base.value } : {}), ...(head.value ? { head: head.value } : {}),
  };
  try {
    let r;
    try {
      r = await reviewChange(ctx.cfg, db, req, modelDeps(ctx, ctx.flags["no-model"] !== true));
    } catch (e) {
      if (!isModelError(e)) throw e;
      ctx.out(copy.modelUnavailable(e.message));
      r = await reviewChange(ctx.cfg, db, req, {});
    }
    const w = writeReviewReport(ctx.cfg, r);
    ctx.out(copy.reviewDone(w.reportPath));
    if (r.stats.files === 0) ctx.out(copy.emptyChange);
    ctx.out(copy.files(r.stats.files, r.stats.addedLines, r.stats.removedLines));
    for (const f of r.triage.shown) ctx.out(copy.top(f.severity, f.file, f.line, f.rule, f.message));
    if (r.triage.shown.length === 0) ctx.out(copy.noComments);
    if (r.triage.moreDefects.length > 0) ctx.out(copy.lowerPriority(r.triage.moreDefects.length));
    if (r.triage.policy.length > 0) ctx.out(copy.compliance(r.triage.policy.length));
    ctx.out(copy.fullReport(w.reportPath));
    ctx.out(copy.fixed(countsLine(r.tier0)));
    ctx.out(r.model.used ? (r.model.error ? copy.modelFailed(r.model.error) : copy.model(countsLine(r.findings))) : copy.modelOff);
    if (r.backend) ctx.out(copy.backend(r.backend));
    const proof = evaluateEvidence(classifyChange(r.changedPaths), []);
    ctx.out(copy.proof(proof.kinds.map((k) => SCOPE_LABEL[k]).join(" + "), proof.status, proof.items.map((i) => i.label).join("; ")));
    ctx.out(copy.shadow);
    return 0;
  } catch (e) {
    if (e instanceof Error && /^Unknown (repo|base|head)/.test(e.message)) { ctx.out(e.message); return 1; }
    throw e;
  } finally {
    db?.close();
  }
}

async function refactor(ctx: CommandContext): Promise<number> {
  const [repo, path] = ctx.rest;
  if (!repo || !path) { ctx.out(copy.needArgs("refactor", copy.usageRefactor)); return 2; }
  const db = openIndex(ctx);
  if (!db) ctx.out(copy.noIndexNote);
  try {
    let r;
    try {
      r = await suggestRefactor(ctx.cfg, db, { repo, path }, modelDeps(ctx, ctx.flags["no-model"] !== true));
    } catch (e) {
      if (!isModelError(e)) throw e;
      ctx.out(copy.modelUnavailable(e.message));
      r = await suggestRefactor(ctx.cfg, db, { repo, path }, {});
    }
    const w = writeRefactorReport(ctx.cfg, r);
    ctx.out(copy.refactorDone(w.reportPath));
    ctx.out(r.model.used ? (r.model.error ? copy.modelFailed(r.model.error) : copy.refactors(r.refactors.length, r.refactors.filter((x) => x.applies).length)) : copy.modelOff);
    if (r.backend) ctx.out(copy.backend(r.backend));
    ctx.out(copy.shadow);
    return 0;
  } catch (e) {
    if (e instanceof Error && /^(Unknown repo|".*" is not in the repo)/.test(e.message)) { ctx.out(e.message); return 1; }
    throw e;
  } finally {
    db?.close();
  }
}

async function replay(ctx: CommandContext): Promise<number> {
  const repo = ctx.rest[0] ?? ctx.cfg.repos[0]?.id;
  if (!repo) { ctx.out(copy.noRepo); return 2; }
  const limitText = ctx.flags["limit"];
  const limit = typeof limitText === "string" && Number(limitText) > 0 ? Math.floor(Number(limitText)) : 10;
  const db = openIndex(ctx);
  if (!db) { ctx.out(copy.noIndexNote); return 1; }
  const wantModel = ctx.flags["model"] === true;
  try {
    const capText = ctx.flags["model-cap"];
    const modelCap = typeof capText === "string" && Number(capText) > 0 ? Math.floor(Number(capText)) : DEFAULT_MODEL_CAP;
    const r = await runReplay(ctx.cfg, db, { repo, limit, model: wantModel, modelCap }, modelDeps(ctx, wantModel));
    ctx.out(copy.replayDone(r.reportPath));
    const prec = r.tier0.findings ? `${Math.round((r.tier0.matching / r.tier0.findings) * 100)}%` : "n/a";
    ctx.out(copy.replaySummary(r.fixesUsed, r.introducers, r.tier0.detected, r.tier0.cases, prec));
    if (r.model) ctx.out(copy.replayModel(r.model.detected, r.model.cases, r.modelRuns));
    ctx.out(copy.shadow);
    return 0;
  } catch (e) {
    if (isModelError(e) || (e instanceof Error && /^Unknown repo/.test(e.message))) { ctx.out(e.message); return 1; }
    throw e;
  } finally {
    db.close();
  }
}

export const reviewCommands: Record<string, (ctx: CommandContext) => Promise<number> | number> = {
  review, refactor, replay,
};
