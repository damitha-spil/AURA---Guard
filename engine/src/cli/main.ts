// AURA Guard command line. Small hand-written argument parser, no extra deps.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath, loadConfig } from "../config.ts";
import { openDb } from "../index/db.ts";
import type { Db } from "../index/db.ts";
import { search } from "../index/search.ts";
import { indexVault } from "../index/notes.ts";
import { ingestRepos } from "../ingest/index.ts";
import { historyFor } from "../index/history.ts";
import { coChanged } from "../index/cochange.ts";
import { findStale } from "../index/stale.ts";
import { blastRadius, importGraphify } from "../index/graph.ts";
import { canRunHeavyWork } from "../guard/resources.ts";
import { loadVault } from "../vault/load.ts";
import type { Audience } from "../types.ts";
import { copy } from "./copy.ts";

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(["max", "audience", "limit"]);

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

function openExisting(): Db | null {
  const file = dbPath(loadConfig());
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
  const cfg = loadConfig();

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
    const notes = indexVault(db, cfg.vaultDir);
    out(copy.indexed(notes.added, notes.updated, notes.removed));
    for (const p of notes.problems) out(copy.problemLine(p.file, p.message));
    const max = num(flags["max"]);
    for (const r of ingestRepos(db, cfg, max ? { max } : undefined)) {
      out(r.skipped ? copy.repoSkipped(r.repo, r.skipped) : copy.repoLine(r.repo, r.commits, r.files));
    }
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
      const db = openExisting();
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
    out(copy.needArgs("graph", "import <repo> <graph.json> | blast <repo> <path>"));
    return 1;
  }

  const db = openExisting();
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
