// Rebuild one repo's code graph with graphify (local tree-sitter mode, no LLM)
// and load it into the index. The repo HEAD is exported with `git archive`
// into a plain folder; no worktree is created.

import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Db } from "../index/db.ts";
import { ensureGraphTables, importGraphify } from "../index/graph.ts";
import { canRunHeavyWork } from "../guard/resources.ts";
import { headSha } from "../ingest/git.ts";
import type { GuardConfig } from "../types.ts";

const execFileP = promisify(execFile);
// graphify needs about 45 s for a repo of Aura's size; stop a hung run after this long.
const GRAPHIFY_TIMEOUT_MS = 15 * 60 * 1000;

export interface RefreshResult {
  repo: string;
  status: "refreshed" | "unchanged" | "skipped";
  /** Plain-language reason when skipped. */
  reason?: string;
  nodes?: number;
  edges?: number;
  sha?: string;
}

export function graphifyBinary(root: string): string | undefined {
  const candidates = [
    join(root, ".venv", "Scripts", "graphify.exe"),
    join(root, ".venv", "Scripts", "graphify"),
    join(root, ".venv", "bin", "graphify"),
  ];
  return candidates.find((c) => existsSync(c));
}

export function storedGraphSha(db: Db, repo: string): string | undefined {
  ensureGraphTables(db);
  const r = db.prepare("SELECT sha FROM graph_state WHERE repo=?").get(repo) as { sha: string } | undefined;
  return r?.sha;
}

/** git archive HEAD | tar -x -C dest, with no shell in between. */
function exportHead(repoPath: string, dest: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    const archive = spawn("git", ["archive", "--format=tar", "HEAD"], {
      cwd: repoPath, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const tar = spawn("tar", ["-x", "-C", dest], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let err = "";
    archive.stderr.on("data", (d) => (err += String(d)));
    tar.stderr.on("data", (d) => (err += String(d)));
    archive.stdout.pipe(tar.stdin);
    let codes = 0;
    let failed = false;
    const done = (code: number | null) => {
      if (code !== 0) failed = true;
      if (++codes === 2) failed ? reject(new Error(`export failed: ${err.trim()}`)) : resolveP();
    };
    archive.on("error", reject);
    tar.on("error", reject);
    archive.on("close", done);
    tar.on("close", done);
  });
}

export async function refreshGraph(
  cfg: GuardConfig,
  db: Db,
  repoId: string,
  opts: { force?: boolean; ignoreBusy?: boolean } = {},
): Promise<RefreshResult> {
  const skip = (reason: string): RefreshResult => ({ repo: repoId, status: "skipped", reason });
  const repo = cfg.repos.find((r) => r.id === repoId);
  if (!repo) return skip("no such repo in the config");
  if (!existsSync(repo.path)) return skip("repo path not found");
  const bin = graphifyBinary(cfg.root);
  if (!bin) return skip("graphify is not installed (expected in .venv); see AI_HANDOFF.md");
  const head = headSha(repo.path);
  if (!head) return skip("not a git repo or no commits");
  if (!opts.force && storedGraphSha(db, repoId) === head) {
    return { repo: repoId, status: "unchanged", sha: head };
  }
  const gate = opts.ignoreBusy ? { ok: true, reasons: [] } : await canRunHeavyWork(cfg);
  if (!gate.ok) return skip(`busy: ${gate.reasons.join("; ")}`);

  const dir = join(cfg.dataDir, "graphify", `src-${repoId}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await exportHead(repo.path, dir);
  await execFileP(bin, ["update", dir, "--no-cluster", "--force"], {
    env: { ...process.env, GRAPHIFY_BACKEND: "none" },
    timeout: GRAPHIFY_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const graph = join(dir, "graphify-out", "graph.json");
  if (!existsSync(graph)) return skip("graphify wrote no graph.json");
  const c = importGraphify(db, repoId, graph);
  db.prepare("INSERT OR REPLACE INTO graph_state(repo, sha) VALUES (?,?)").run(repoId, head);
  return { repo: repoId, status: "refreshed", nodes: c.nodes, edges: c.edges, sha: head };
}
