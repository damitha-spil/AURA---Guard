// Read-only numbers and checks for the department screens. Everything here reads ONE
// department's own folders (its db, vault and data dir); nothing runs git writes or heavy work.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadVault } from "../vault/load.ts";
import { countFolderDocs } from "../ingest/files.ts";
import { allSources, pathProblem } from "./model.ts";
import type { Department } from "./model.ts";
import type { DepartmentPaths } from "./registry.ts";

export interface Health {
  indexedAt: string | null;
  commits: number;
  files: number;
  notes: number;
  active: number;
  proposed: number;
  inbox: number;
  stale: number;
  lastDaily: string | null;
  reviews: number;
  qaPlans: number;
  problems: number;
  needsSources: boolean;
}

export interface SourceStatus {
  exists: boolean;
  isGit: boolean;
  branch?: string;
  lastCommitAt?: string;
  docFiles?: number;
  error?: string;
}

const GIT_TIMEOUT_MS = 4000;

function mtimeIso(file: string): string | null {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

function countMd(dir: string, depth = 0): number {
  if (depth > 3 || !existsSync(dir)) return 0;
  let n = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) n += countMd(join(dir, e.name), depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) n++;
    }
  } catch {
    // unreadable folder counts as empty
  }
  return n;
}

function newestMd(dir: string): string | null {
  let best: string | null = null;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
      const t = mtimeIso(join(dir, e.name));
      if (t && (best === null || t > best)) best = t;
    }
  } catch {
    // no daily folder yet
  }
  return best;
}

/** Counts from the department's own index, opened read-only; zeros when there is no index yet. */
function indexCounts(dbFile: string): Record<string, number> {
  if (!existsSync(dbFile)) return {};
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare("SELECT kind, COUNT(*) AS n FROM docs GROUP BY kind").all() as { kind: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.kind] = r.n;
    return out;
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

export function departmentHealth(dept: Department, paths: DepartmentPaths): Health {
  const counts = indexCounts(paths.dbFile);
  const dbTime = mtimeIso(paths.dbFile);
  const walTime = mtimeIso(paths.dbFile + "-wal");
  const indexedAt = dbTime && walTime ? (walTime > dbTime ? walTime : dbTime) : dbTime;
  let notes = 0, active = 0, proposed = 0, inbox = 0, stale = 0, problems = 0;
  if (existsSync(paths.vaultDir)) {
    const v = loadVault(paths.vaultDir);
    notes = v.notes.length;
    problems = v.problems.length;
    for (const n of v.notes) {
      if (n.meta.status === "active") active++;
      else if (n.meta.status === "proposed") { proposed++; inbox++; }
      else if (n.meta.status === "shadow") inbox++;
      else if (n.meta.status === "stale") stale++;
    }
  }
  return {
    indexedAt,
    commits: counts["commit"] ?? 0,
    files: counts["file"] ?? 0,
    notes,
    active,
    proposed,
    inbox,
    stale,
    lastDaily: newestMd(join(paths.dataDir, "daily")),
    reviews: countMd(join(paths.dataDir, "reviews")),
    qaPlans: countMd(join(paths.dataDir, "qa", "plans")),
    problems,
    needsSources: allSources(dept).length === 0,
  };
}

function gitOut(path: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: path, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  }).trim();
}

/**
 * Checks a folder with read-only commands. Only absolute local paths are looked at. Never returns
 * file contents: only booleans, a branch name, a date and a count.
 */
export function checkSource(path: string, kind: "git" | "docs"): SourceStatus {
  const bad = pathProblem(path);
  if (bad) return { exists: false, isGit: false, error: bad };
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    return { exists: false, isGit: false, error: "That folder does not exist on this computer." };
  }
  if (!isDir) return { exists: true, isGit: false, error: "That is a file, not a folder." };
  const out: SourceStatus = { exists: true, isGit: false };
  try {
    out.isGit = gitOut(path, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    out.isGit = false;
  }
  if (out.isGit) {
    try { out.branch = gitOut(path, ["rev-parse", "--abbrev-ref", "HEAD"]); } catch { /* no commits yet */ }
    try { out.lastCommitAt = gitOut(path, ["log", "-1", "--format=%aI"]) || undefined; } catch { /* no commits yet */ }
    if (out.lastCommitAt === undefined) delete out.lastCommitAt;
  } else if (kind === "git") out.error = "That folder is not a git repository.";
  if (kind === "docs") out.docFiles = countFolderDocs(path);
  return out;
}
