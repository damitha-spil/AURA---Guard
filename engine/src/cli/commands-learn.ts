// Commands for the quiz, the rules pipeline, the log check and the support writer.
// Merge into EXTRA_COMMANDS in main.ts:  Object.assign(EXTRA_COMMANDS, learnCommands)
// main.ts VALUE_FLAGS may also list "status"; until then these commands read it from argv.

import { existsSync } from "node:fs";
import { dbPath } from "../config.ts";
import { openDb } from "../index/db.ts";
import type { Db } from "../index/db.ts";
import { ApiError, BlockedError, MissingKeyError } from "../brain/client.ts";
import { CliError } from "../brain/backends.ts";
import { createBrain, NoBackendError } from "../brain/select.ts";
import { answer } from "../chat/answer.ts";
import { loadQuestions } from "../quiz/questions.ts";
import { runQuiz, writeReport } from "../quiz/run.ts";
import { DEFAULT_MODEL_CAP, JUDGE_CAP, QUIZ_GATE, RECALL_K } from "../quiz/score.ts";
import { exportActiveChecks, parseCheckBlock } from "../rules/checks.ts";
import { approveRule, dismissRule, ruleNotes } from "../rules/manage.ts";
import { proposeRules, DEFAULT_PROPOSE_MAX } from "../rules/propose.ts";
import { flagString } from "../rules/util.ts";
import { localToday } from "../rules/util.ts";
import { runLogCheck, writeLogCheck } from "../logcheck/logcheck.ts";
import { draftSupport, exportSupport, gatherSources, supportNotes } from "../support/draft.ts";
import { loadVault } from "../vault/load.ts";
import type { CommandContext } from "./main.ts";

const copy = {
  usageQuiz: "quiz run|list [--no-model] [--judge] [--max N]",
  usageRules: "rules propose [repo] [--dry-run] [--max N] | list [--status S] | show <id> | approve <id> | dismiss <id> | export",
  usageLogcheck: "logcheck [repo] [--since YYYY-MM-DD]",
  usageSupport: 'support draft "<topic>" [--no-model] | list | export <id>',
  needArgs: (cmd: string, usage: string) => `Usage: aura-guard ${cmd}. Expected: ${usage}`,
  noRepo: "No repo is configured. Add one to guard.config.local.json.",
  unknownRepo: (id: string) => `Unknown repo "${id}".`,
  noIndex: "No index found. Run `index` first.",
  questions: (n: number, neg: number) => `${n} questions (${neg} negative). All are drafts until the owner approves them.`,
  quizLine: (id: string, area: string, q: string, kind: string) => `${id} [${area}] ${kind}${q}`,
  scoreRetrieval: (p: number, s: number, rate: string, gate: string, ok: boolean) =>
    `Recall@${RECALL_K}: ${p} of ${s} = ${rate} (gate ${gate}): ${ok ? "meets the gate" : "below the gate"}`,
  scoreModel: (p: number, s: number, rate: string, gate: string, ok: boolean) =>
    `Model answers: ${p} of ${s} = ${rate} (gate ${gate}): ${ok ? "meets the gate" : "below the gate"}`,
  failed: (id: string, why: string) => `  FAIL ${id}: ${why}`,
  report: (f: string) => `Report: ${f}`,
  backend: (b: string) => `Model backend: ${b}`,
  rulesNone: "No notes match.",
  rulesProposed: (n: number, cand: number, dup: number, over: number, dry: boolean) =>
    `${dry ? "Would propose" : "Proposed"} ${n} rule(s) from ${cand} stable co-change finding(s); ${dup} already known, ${over} over the limit of one run.`,
  rulesCommits: (used: number, skipped: number) => `Commits used: ${used}. Skipped as bulk or noise: ${skipped}.`,
  rulesNotReviewed: "Nothing is active. Review the notes in vault/inbox/ and approve the ones you agree with.",
  notFound: (id: string) => `No valid note with id "${id}".`,
  refused: (why: string) => `Refused: ${why}`,
  changed: (id: string, c: string) => `${id}: ${c}`,
  nothingChanged: (id: string) => `${id}: already in that state, nothing changed.`,
  exported: (n: number, f: string) => `Exported ${n} active check(s) to ${f}`,
  logHead: (repo: string, c: number, l: number, pct: string) => `${repo}: ${c} commit(s), ${l} with a log entry, coverage ${pct}.`,
  logReadme: (ok: boolean) => `ai-log/README.md: ${ok ? "present" : "MISSING"}`,
  logDay: (d: string, c: number, l: number, m: number) => `  ${d}: ${c} commit(s), ${l} logged, ${m} missing`,
  logWritten: (f: string) => `Report: ${f}`,
  noSources: "No internal note covers this topic, so nothing was drafted.",
  sourcesFound: (n: number) => `${n} internal note(s) would be used:`,
  supportWritten: (id: string, f: string) => `Draft written (proposed, not reviewed): ${id}\n${f}`,
  leakPassed: (a: number) => `Leak check: passed (attempt ${a}).`,
  leakFailed: (a: number) => `Leak check: FAILED after ${a} attempt(s). Nothing was written.`,
  headings: "Headings:",
  supportExported: (f: string, s: string) => `Exported: ${f}${s === "active" ? "" : `\nNote: this draft is ${s}. Have it reviewed before it goes into Aura's docs.`}`,
  badDate: "--since must look like YYYY-MM-DD.",
};

function num(v: string | true | undefined): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function openExisting(ctx: CommandContext): Db | null {
  const file = dbPath(ctx.cfg);
  return existsSync(file) ? openDb(file) : null;
}

function modelError(e: unknown): string | null {
  if (e instanceof MissingKeyError || e instanceof BlockedError || e instanceof ApiError || e instanceof NoBackendError || e instanceof CliError) {
    return e.message;
  }
  return null;
}

async function quiz(ctx: CommandContext): Promise<number> {
  const { out, flags, cfg, rest } = ctx;
  const sub = rest[0];
  if (sub !== "run" && sub !== "list") {
    out(copy.needArgs("quiz", copy.usageQuiz));
    return 2;
  }
  const questions = loadQuestions(cfg.root);
  if (sub === "list") {
    out(copy.questions(questions.length, questions.filter((q) => q.expect.unknown).length));
    for (const q of questions) out(copy.quizLine(q.id, q.area, q.question, q.expect.unknown ? "(not in knowledge) " : ""));
    return 0;
  }
  const db = openExisting(ctx);
  if (!db) {
    out(copy.noIndex);
    return 1;
  }
  const noModel = flags["no-model"] === true;
  const date = localToday();
  try {
    if (noModel) {
      const run = await runQuiz(db, questions, { mode: "retrieval", date });
      const w = writeReport(cfg.dataDir, run);
      const s = run.summary;
      out(copy.scoreRetrieval(s.passed, s.scored, pct(s.rate), pct(QUIZ_GATE), s.meetsGate));
      for (const f of run.results.filter((r) => r.pass === false)) out(copy.failed(f.id, f.reasons.join("; ")));
      out(copy.report(w.file));
      return 0;
    }
    const brain = createBrain(cfg);
    const cap = num(flagString(flags, rest, "max").value) ?? DEFAULT_MODEL_CAP;
    const run = await runQuiz(db, questions, {
      mode: "model", date, cap,
      ask: (question) => answer(cfg, db, { history: [], question }, { complete: brain.complete }),
      ...(flags.judge === true ? { judge: brain.complete } : {}),
    });
    const w = writeReport(cfg.dataDir, run);
    const s = run.summary;
    out(copy.scoreModel(s.passed, s.scored, pct(s.rate), pct(QUIZ_GATE), s.meetsGate));
    if (flags.judge === true) out(`Judge graded up to ${JUDGE_CAP} answers.`);
    for (const f of run.results.filter((r) => r.pass === false)) out(copy.failed(f.id, f.reasons.join("; ")));
    out(copy.report(w.file));
    const used = brain.backendUsed();
    if (used) out(copy.backend(used));
    return 0;
  } catch (e) {
    const m = modelError(e);
    if (m) {
      out(m);
      return 1;
    }
    throw e;
  }
}

async function rules(ctx: CommandContext): Promise<number> {
  const { out, flags, cfg } = ctx;
  const sub = ctx.rest[0];
  if (sub === "propose") {
    const st = flagString(flags, ctx.rest, "max");
    const repoId = st.rest[1] ?? cfg.repos[0]?.id;
    if (!repoId) {
      out(copy.noRepo);
      return 1;
    }
    if (!cfg.repos.some((r) => r.id === repoId)) {
      out(copy.unknownRepo(repoId));
      return 1;
    }
    const db = openExisting(ctx);
    if (!db) {
      out(copy.noIndex);
      return 1;
    }
    const dry = flags["dry-run"] === true;
    const r = proposeRules(db, cfg.vaultDir, repoId, { dryRun: dry, max: num(st.value) ?? DEFAULT_PROPOSE_MAX });
    out(copy.rulesProposed(r.proposals.length, r.candidates, r.duplicates, r.overMax, dry));
    out(copy.rulesCommits(r.commitsUsed, r.commitsSkipped));
    for (const p of r.proposals) {
      out(`${p.id}`);
      out(`  if changed: ${p.check.if_changed.join(", ")}`);
      out(`  then also:  ${p.check.then_changed.join(", ")}`);
      out(`  evidence:   ${p.check.evidence.commits} commits, ratio ${p.check.evidence.ratio}`);
    }
    if (!dry && r.proposals.length) out(copy.rulesNotReviewed);
    return 0;
  }
  if (sub === "list") {
    const status = flagString(flags, ctx.rest, "status").value;
    const notes = ruleNotes(cfg.vaultDir, status);
    if (notes.length === 0) out(copy.rulesNone);
    for (const n of notes) {
      const c = parseCheckBlock(n.body);
      out(`${n.meta.id}  ${n.meta.status}  ${c.state === "ok" ? "check" : c.state === "invalid" ? "bad-check" : "no-check"}  ${n.meta.title ?? ""}`);
    }
    return 0;
  }
  if (sub === "show" || sub === "approve" || sub === "dismiss") {
    const id = ctx.rest[1];
    if (!id) {
      out(copy.needArgs(`rules ${sub}`, "<id>"));
      return 2;
    }
    if (sub === "show") {
      const n = loadVault(cfg.vaultDir).notes.find((x) => x.meta.id === id);
      if (!n) {
        out(copy.notFound(id));
        return 1;
      }
      out(`${n.meta.id}  ${n.meta.type}  ${n.meta.status}  file: ${n.file}`);
      out(n.body);
      return 0;
    }
    const r = sub === "approve" ? approveRule(cfg.vaultDir, id, undefined, cfg.dataDir) : dismissRule(cfg.vaultDir, id, cfg.dataDir);
    if (!r.ok) {
      out(copy.refused(r.reason ?? "unknown"));
      return 1;
    }
    if (r.changes.length === 0) out(copy.nothingChanged(id));
    else out(copy.changed(id, r.changes.map((c) => `${c.field}: ${c.from} -> ${c.to}`).join("; ")));
    return 0;
  }
  if (sub === "export") {
    const r = exportActiveChecks(cfg);
    out(copy.exported(r.checks.length, r.file));
    return 0;
  }
  out(copy.needArgs("rules", copy.usageRules));
  return 2;
}

async function logcheck(ctx: CommandContext): Promise<number> {
  const { out, flags, cfg } = ctx;
  const since = flagString(flags, ctx.rest, "since");
  if (since.value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since.value)) {
    out(copy.badDate);
    return 2;
  }
  const repoId = since.rest[0] ?? cfg.repos[0]?.id;
  if (!repoId) {
    out(copy.noRepo);
    return 1;
  }
  const repo = cfg.repos.find((r) => r.id === repoId);
  if (!repo) {
    out(copy.unknownRepo(repoId));
    return 1;
  }
  const r = await runLogCheck(repo, since.value);
  const w = writeLogCheck(cfg.dataDir, r, localToday());
  out(copy.logHead(r.repo, r.commits, r.logged, pct(r.coverage)));
  out(copy.logReadme(r.readmeExists));
  for (const d of r.days.slice(0, 14)) out(copy.logDay(d.day, d.commits, d.logged, d.missing.length));
  if (r.days.length > 14) out(`  ... ${r.days.length - 14} more day(s) in the report`);
  out(copy.logWritten(w.file));
  return 0;
}

async function support(ctx: CommandContext): Promise<number> {
  const { out, flags, cfg, rest } = ctx;
  const sub = rest[0];
  if (sub === "list") {
    const list = supportNotes(cfg.vaultDir);
    if (list.length === 0) out(copy.rulesNone);
    for (const n of list) out(`${n.id}  ${n.status}  ${n.title}`);
    return 0;
  }
  if (sub === "export") {
    const id = rest[1];
    if (!id) {
      out(copy.needArgs("support export", "<id>"));
      return 2;
    }
    const r = exportSupport(cfg.vaultDir, cfg.dataDir, id);
    if (!r.ok) {
      out(copy.refused(r.reason));
      for (const x of r.reasons ?? []) out(`  ${x}`);
      return 1;
    }
    out(copy.supportExported(r.file, r.status));
    return 0;
  }
  if (sub === "draft") {
    const topic = rest.slice(1).join(" ").trim();
    if (!topic) {
      out(copy.needArgs("support draft", '"<topic>"'));
      return 2;
    }
    const db = openExisting(ctx);
    if (!db) {
      out(copy.noIndex);
      return 1;
    }
    if (flags["no-model"] === true) {
      const s = gatherSources(db, topic);
      if (s.length === 0) {
        out(copy.noSources);
        return 0;
      }
      out(copy.sourcesFound(s.length));
      for (const x of s) out(`  ${x.id}  ${x.title}`);
      return 0;
    }
    try {
      const brain = createBrain(cfg);
      const r = await draftSupport(db, cfg.vaultDir, topic, brain.complete);
      const used = brain.backendUsed();
      if (used) out(copy.backend(used));
      if (!r.ok) {
        if (r.reason === "no-sources") {
          out(copy.noSources);
          return 0;
        }
        out(copy.leakFailed(r.attempts));
        for (const x of r.reasons) out(`  ${x}`);
        return 1;
      }
      out(copy.leakPassed(r.attempts));
      out(copy.supportWritten(r.id, r.file));
      out(copy.headings);
      for (const h of r.headings) out(`  ${h}`);
      return 0;
    } catch (e) {
      const m = modelError(e);
      if (m) {
        out(m);
        return 1;
      }
      throw e;
    }
  }
  out(copy.needArgs("support", copy.usageSupport));
  return 2;
}

export const learnCommands: Record<string, (ctx: CommandContext) => Promise<number> | number> = {
  quiz,
  rules,
  logcheck,
  support,
};
