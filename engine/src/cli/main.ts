// SPIL Quality Support Bot command line. Small hand-written argument parser, no extra deps.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath, envValue, loadConfig } from "../config.ts";
import { openDb } from "../index/db.ts";
import type { Db } from "../index/db.ts";
import { search } from "../index/search.ts";
import { indexVault } from "../index/notes.ts";
import { ingestDocSources, ingestRepos, pruneRemovedSources } from "../ingest/index.ts";
import { historyFor } from "../index/history.ts";
import { coChanged } from "../index/cochange.ts";
import { findStale } from "../index/stale.ts";
import { blastRadius, importGraphify } from "../index/graph.ts";
import { refreshGraph } from "../graph/refresh.ts";
import type { RefreshResult } from "../graph/refresh.ts";
import { canRunHeavyWork } from "../guard/resources.ts";
import { loadVault } from "../vault/load.ts";
import type { Audience, GuardConfig } from "../types.ts";
import { ApiError, BlockedError, MissingKeyError } from "../brain/client.ts";
import { CliError } from "../brain/backends.ts";
import { createBrain, describeBackends, NoBackendError } from "../brain/select.ts";
import { draftDiary } from "../roles/scribe.ts";
import { mineSessions } from "../sessions/mine.ts";
import { captureCommands } from "./commands-capture.ts";
import { dailyCommands } from "./commands-daily.ts";
import { DeptSelectionError, deptCommands, indexAll, selectConfig } from "./commands-dept.ts";
import { learnCommands } from "./commands-learn.ts";
import { prCommands } from "./commands-prs.ts";
import { qaCommands } from "./commands-qa.ts";
import { reviewCommands } from "./commands-review.ts";
import { uiCommands } from "./commands-ui.ts";
import { copy } from "./copy.ts";

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(["dept", "name", "template", "description", "owner", "color", "path", "kind", "module", "sub", "label", "max", "audience", "limit", "since", "min-score", "port", "base", "head", "widths", "status", "skip", "repo", "date", "before"]);

/** What an extra command receives. */
export interface CommandContext {
  rest: string[];
  flags: Record<string, string | true>;
  out: (s: string) => void;
  /** The selected department's config (see --dept). */
  cfg: GuardConfig;
  /** The machine config the department registry hangs on. Set by the main entry point. */
  base?: GuardConfig;
}

/**
 * EXTENSION POINT: add a command here, keyed by its name. It runs before the
 * built-in commands and returns the exit code. Add its line to copy.help, and
 * add any flag that takes a value to VALUE_FLAGS above.
 */
export const EXTRA_COMMANDS: Record<string, (ctx: CommandContext) => Promise<number> | number> = {
  diary: async ({ rest, out, cfg }) => {
    const date = rest[0] ?? localToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      out(copy.needArgs("diary", "[YYYY-MM-DD]"));
      return 2;
    }
    try {
      const brain = createBrain(cfg);
      const path = await draftDiary(cfg, date, brain);
      out(path ? copy.diaryWritten(path) : copy.diaryNothing(date));
      const used = brain.backendUsed();
      if (used) out(copy.brainUsed(used));
      return 0;
    } catch (e) {
      if (e instanceof MissingKeyError || e instanceof BlockedError || e instanceof ApiError || e instanceof NoBackendError || e instanceof CliError) {
        out(e.message);
        return 1;
      }
      throw e;
    }
  },
};

const isOk = (s: string): boolean => /\bok\b/i.test(s);

EXTRA_COMMANDS.brain = async ({ rest, out, cfg }) => {
  const sub = rest[0];
  if (sub === "status") {
    const d = await describeBackends(cfg);
    out(copy.brainWanted(d.wanted));
    for (const r of d.rows) out(copy.brainRow(r.id, r.kind, r.status.ok, r.status.detail));
    out(d.picked ? copy.brainPicked(d.picked) : copy.brainNone);
    return d.picked ? 0 : 1;
  }
  if (sub === "test") {
    const brain = createBrain(cfg);
    const t0 = Date.now();
    try {
      const r = await brain.complete({ role: "brain-test", system: ["You are a connectivity check. Reply with exactly one word."], user: "Reply with the word OK", maxTokens: 20 });
      out(copy.brainTest(brain.backendUsed() ?? "?", isOk(r.text), Date.now() - t0));
      return isOk(r.text) ? 0 : 1;
    } catch (e) {
      if (e instanceof MissingKeyError || e instanceof BlockedError || e instanceof ApiError || e instanceof NoBackendError || e instanceof CliError) {
        out(copy.brainTestFailed(brain.backendUsed(), e.message));
        return 1;
      }
      throw e;
    }
  }
  out(copy.needArgs("brain", "status | test"));
  return 2;
};

EXTRA_COMMANDS.mine = ({ rest, flags, out, cfg }) => {
  const repo = cfg.repos.find((r) => r.id === (rest[0] ?? cfg.repos[0]?.id));
  if (!repo) {
    out(copy.needArgs("mine", "[repo] [--since YYYY-MM-DD] [--min-score 0.7] [--max 15] [--dry-run]"));
    return 2;
  }
  const r = mineSessions(cfg, {
    repoPath: repo.path,
    since: typeof flags.since === "string" ? flags.since : undefined,
    minScore: typeof flags["min-score"] === "string" ? Number(flags["min-score"]) : 0.7,
    max: typeof flags.max === "string" ? Number(flags.max) : 15,
    dryRun: flags["dry-run"] === true,
  });
  out(copy.mined(repo.id, r.sessions, r.turns, r.candidates.length, r.blocked, r.written.length, r.skippedDuplicate, flags["dry-run"] === true));
  return 0;
};

// Command sets from the feature modules. Each one exports a name -> handler map.
Object.assign(EXTRA_COMMANDS, uiCommands, qaCommands, prCommands, reviewCommands, dailyCommands, learnCommands, deptCommands, captureCommands);

function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function printGraph(out: (s: string) => void, r: RefreshResult, secs: number): void {
  if (r.status === "refreshed") out(copy.graphRefreshed(r.repo, r.nodes ?? 0, r.edges ?? 0, secs));
  else if (r.status === "unchanged") out(copy.graphUnchanged(r.repo));
  else out(copy.graphSkipped(r.repo, r.reason ?? "unknown"));
}

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(name) && next !== undefined) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const AUDIENCES: Audience[] = ["internal_dev", "qa_internal", "customer_support"];

function num(v: string | true | undefined): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function openExisting(cfg: GuardConfig): Db | null {
  const file = dbPath(cfg);
  return existsSync(file) ? openDb(file) : null;
}

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0] ?? "help";
  const rest = positional.slice(1);
  const out = (s: string) => console.log(s);

  if (cmd === "help" || cmd === "--help") {
    out(copy.help);
    return 0;
  }
  // QSB_ROOT (or AURA_GUARD_ROOT) points at another config folder; used by tests and copies.
  const base = loadConfig(envValue("ROOT"));
  // The department registry hangs on the machine config; `dept` works on the registry itself.
  if (cmd === "dept") return deptCommands["dept"]!({ rest, flags, out, cfg: base, base });
  if (cmd === "index" && flags["all"] === true) return indexAll(base, flags, out);
  let cfg: GuardConfig;
  try {
    const sel = selectConfig(base, flags);
    cfg = sel.cfg;
    if (sel.archived && (cmd === "index" || cmd === "daily")) {
      out(copy.archived(cfg.departmentId ?? ""));
      return 1;
    }
  } catch (e) {
    if (e instanceof DeptSelectionError) {
      out(e.message);
      return 2;
    }
    throw e;
  }
  const extra = EXTRA_COMMANDS[cmd];
  if (extra) return extra({ rest, flags, out, cfg, base });

  if (cmd === "check") {
    const { notes, problems } = loadVault(cfg.vaultDir);
    for (const p of problems) out(copy.problemLine(p.file, p.message));
    if (problems.length > 0) {
      out(copy.vaultProblems(problems.length));
      return 1;
    }
    out(`${copy.vaultOk} (${notes.length} notes)`);
    return 0;
  }

  if (cmd === "index") {
    if (flags["force"] !== true) {
      const gate = await canRunHeavyWork(cfg);
      if (!gate.ok) {
        out(copy.busy);
        for (const r of gate.reasons) out(`  - ${r}`);
        out(copy.busyHint);
        return 1;
      }
    }
    const db = openDb(dbPath(cfg));
    if (cfg.departmentName && cfg.departmentId !== "default") out(copy.department(cfg.departmentName, cfg.departmentId ?? ""));
    const pruned = pruneRemovedSources(db, cfg);
    if (pruned > 0) out(copy.pruned(pruned));
    const notes = indexVault(db, cfg.vaultDir);
    out(copy.indexed(notes.added, notes.updated, notes.removed));
    for (const p of notes.problems) out(copy.problemLine(p.file, p.message));
    const max = num(flags["max"]);
    for (const r of [...ingestRepos(db, cfg, max ? { max } : undefined), ...ingestDocSources(db, cfg)]) {
      out(
        r.skipped
          ? copy.repoSkipped(r.repo, r.skipped)
          : copy.repoLine(r.repo, r.commits, r.files, r.commitDocs, r.fileDocs),
      );
    }
    if (flags["graph"] === true) {
      for (const repo of cfg.repos) {
        const t0 = Date.now();
        printGraph(out, await refreshGraph(cfg, db, repo.id, { ignoreBusy: flags["force"] === true }), Math.round((Date.now() - t0) / 1000));
      }
    }
    db.close();
    return 0;
  }

  if (cmd === "graph") {
    const [sub, repo, arg] = rest;
    if (sub === "import") {
      if (!repo || !arg) {
        out(copy.needArgs("graph import", "<repo> <graph.json>"));
        return 1;
      }
      const db = openDb(dbPath(cfg));
      try {
        const c = importGraphify(db, repo, resolve(arg));
        out(copy.graphImported(repo, c.nodes, c.edges));
      } finally {
        db.close();
      }
      return 0;
    }
    if (sub === "blast") {
      if (!repo || !arg) {
        out(copy.needArgs("graph blast", "<repo> <path>"));
        return 1;
      }
      const db = openExisting(cfg);
      if (!db) {
        out(copy.noIndex);
        return 1;
      }
      try {
        const rows = blastRadius(db, repo, arg);
        if (rows.length === 0) out(copy.noGraphHits);
        for (const r of rows) out(`${r.depth}  ${r.path || r.id}  (${r.label})`);
      } finally {
        db.close();
      }
      return 0;
    }
    if (sub === "refresh") {
      if (!repo) {
        out(copy.needArgs("graph refresh", "<repo> [--force]"));
        return 1;
      }
      const db = openDb(dbPath(cfg));
      try {
        const t0 = Date.now();
        const r = await refreshGraph(cfg, db, repo, { force: flags["force"] === true, ignoreBusy: flags["force"] === true });
        printGraph(out, r, Math.round((Date.now() - t0) / 1000));
        return r.status === "skipped" ? 1 : 0;
      } finally {
        db.close();
      }
    }
    out(copy.needArgs("graph", "import <repo> <graph.json> | blast <repo> <path> | refresh <repo> [--force]"));
    return 1;
  }

  const db = openExisting(cfg);
  if (!db) {
    out(copy.noIndex);
    return 1;
  }

  switch (cmd) {
    case "ask": {
      if (rest.length === 0) {
        out(copy.needArgs("ask", "<text...>"));
        return 1;
      }
      const opts: { audience?: Audience; limit?: number } = {};
      const aud = flags["audience"];
      if (typeof aud === "string") {
        if (!AUDIENCES.includes(aud as Audience)) {
          out(copy.badAudience);
          return 1;
        }
        opts.audience = aud as Audience;
      }
      const limit = num(flags["limit"]);
      if (limit) opts.limit = limit;
      const hits = search(db, rest.join(" "), opts);
      if (hits.length === 0) out(copy.noHits);
      for (const h of hits) out(`[${h.kind}] ${h.ref}\n  ${h.title}\n  ${h.snippet}`);
      return 0;
    }
    case "stale": {
      const rows = findStale(db);
      if (rows.length === 0) out(copy.noStale);
      for (const r of rows) {
        out(`${r.noteId} (${r.repo}:${r.path})`);
        for (const c of r.commits) out(`  ${r.repo}@${c.sha} ${c.date.slice(0, 10)} ${c.subject}`);
      }
      return 0;
    }
    case "history": {
      const [repo, path] = rest;
      if (!repo || !path) {
        out(copy.needArgs("history", "<repo> <path>"));
        return 1;
      }
      const rows = historyFor(db, repo, path, num(flags["limit"]));
      if (rows.length === 0) out(copy.noHistory);
      for (const r of rows) out(`${repo}@${r.sha} ${r.date.slice(0, 10)} ${r.subject}`);
      return 0;
    }
    case "cochange": {
      const [repo, path] = rest;
      if (!repo || !path) {
        out(copy.needArgs("cochange", "<repo> <path>"));
        return 1;
      }
      const rows = coChanged(db, repo, path, num(flags["limit"]));
      if (rows.length === 0) out(copy.noCochange);
      for (const r of rows) out(`${r.path}  ${r.together}x  ${Math.round(r.ratio * 100)}%`);
      return 0;
    }
    case "status": {
      if (cfg.departmentName && cfg.departmentId !== "default") out(copy.department(cfg.departmentName, cfg.departmentId ?? ""));
      out(`Index: ${dbPath(cfg)}`);
      const kinds = db.prepare("SELECT kind, COUNT(*) AS n FROM docs GROUP BY kind ORDER BY kind").all() as {
        kind: string;
        n: number;
      }[];
      for (const k of kinds) out(`${k.kind}: ${k.n}`);
      const repos = db.prepare("SELECT repo, last_sha FROM repo_state ORDER BY repo").all() as {
        repo: string;
        last_sha: string;
      }[];
      for (const r of repos) out(`${r.repo}: last commit ${r.last_sha.slice(0, 10)}`);
      return 0;
    }
    default:
      out(copy.unknownCommand(cmd));
      return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
