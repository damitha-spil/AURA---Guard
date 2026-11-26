// QE Pillar 1: Daily Commit Trajectory, Churn & Cross-Author Risk Engine.
// Compares branch/daily commit history against the final diff to detect fixup/wip churn,
// mid-branch pivots, scope atomicity drift, and cross-author file overlaps (author names never stored).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Db } from "../index/db.ts";
import { maskDeep } from "../qa/safe-out.ts";
import { defaultBase, readDiff } from "../review/diff.ts";
import { gitTry } from "../review/git.ts";
import type { GuardConfig } from "../types.ts";

/** Minimum commits touching a file in the window to flag a churn hotspot. */
export const CHURN_HOTSPOT_THRESHOLD = 3;
/** Distinct top-level areas above which a PR is flagged for scope/atomicity drift. */
export const SCOPE_AREAS_WARN_THRESHOLD = 4;

export interface TrajectoryCommit {
  sha: string;
  authorHash: string;
  date: string;
  subject: string;
  files: { path: string; added: number; removed: number }[];
}

export interface ChurnHotspot {
  path: string;
  touches: number;
  fixupCommits: number;
  totalChurn: number;
}

export interface CommitTrajectoryReport {
  generatedAt: string;
  repo: string;
  commitsAnalyzed: number;
  riskLevel: "low" | "medium" | "high";
  churnHotspots: ChurnHotspot[];
  pivotSignals: string[];
  scopeAreas: string[];
  scopeAtomicityOk: boolean;
  crossAuthorOverlaps: { path: string; distinctAuthors: number }[];
  recommendations: string[];
}

const FIXUP_SUBJECT_RE = /\b(fix|fixup|wip|try\d*|tmp|oops|revert|debug|undo)\b/i;

function hashAuthor(name: string): string {
  return createHash("sha256").update(name.trim().toLowerCase()).digest("hex").slice(0, 10);
}

function areaOf(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "root";
  return `${parts[0]}/${parts[1]}`;
}

function parseNumstatLog(raw: string): TrajectoryCommit[] {
  const commits: TrajectoryCommit[] = [];
  let current: TrajectoryCommit | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("__C__")) {
      const [, sha = "", author = "", date = "", subject = ""] = line.split("\x00");
      current = { sha, authorHash: hashAuthor(author), date, subject, files: [] };
      commits.push(current);
      continue;
    }
    if (!current || !line.trim()) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m) {
      current.files.push({
        path: m[3]!,
        added: m[1] === "-" ? 0 : Number(m[1]),
        removed: m[2] === "-" ? 0 : Number(m[2]),
      });
    }
  }
  return commits;
}

export function analyzeCommitTrajectory(
  cfg: GuardConfig,
  _db: Db | null,
  opts: {
    repo?: string;
    base?: string;
    head?: string;
    lookbackDays?: number;
    commitsOverride?: TrajectoryCommit[];
    finalFilesOverride?: string[];
  } = {},
): CommitTrajectoryReport {
  const targetRepo = (opts.repo ? cfg.repos.find((r) => r.id === opts.repo) : null) ?? cfg.repos.find((r) => r.id === "spil-aura") ?? cfg.repos[0];
  const repoId = targetRepo?.id ?? opts.repo ?? "none";
  let commits: TrajectoryCommit[] = opts.commitsOverride ?? [];
  let finalFiles = new Set<string>(opts.finalFilesOverride ?? []);

  if (!opts.commitsOverride && targetRepo && existsSync(targetRepo.path)) {
    const head = opts.head ?? "HEAD";
    const base = opts.base ?? defaultBase(targetRepo.path, head);
    const days = Math.max(1, Math.min(30, opts.lookbackDays ?? 7));
    const raw =
      gitTry(targetRepo.path, ["log", `${base}..${head}`, "--numstat", `--format=__C__%x00%H%x00%aN%x00%cI%x00%s`]) ||
      gitTry(targetRepo.path, ["log", `--since=${days}.days`, "-n", "40", "--numstat", `--format=__C__%x00%H%x00%aN%x00%cI%x00%s`]) ||
      "";
    commits = parseNumstatLog(raw);
    if (finalFiles.size === 0) {
      try {
        const diff = readDiff(targetRepo.path, { base, head });
        finalFiles = new Set(diff.files.map((f) => f.path));
      } catch {
        /* ignore single-commit repo */
      }
    }
  }

  const byFile = new Map<string, { touches: number; fixups: number; churn: number; authors: Set<string> }>();
  const areas = new Set<string>();

  for (const c of commits) {
    const isFixup = FIXUP_SUBJECT_RE.test(c.subject);
    for (const f of c.files) {
      areas.add(areaOf(f.path));
      const cur = byFile.get(f.path) ?? { touches: 0, fixups: 0, churn: 0, authors: new Set<string>() };
      cur.touches++;
      if (isFixup) cur.fixups++;
      cur.churn += f.added + f.removed;
      cur.authors.add(c.authorHash);
      byFile.set(f.path, cur);
    }
  }

  const churnHotspots: ChurnHotspot[] = [];
  const crossAuthorOverlaps: { path: string; distinctAuthors: number }[] = [];
  const pivotSignals: string[] = [];

  for (const [path, st] of byFile.entries()) {
    if (st.touches >= CHURN_HOTSPOT_THRESHOLD || st.fixups >= 2) {
      churnHotspots.push({ path, touches: st.touches, fixupCommits: st.fixups, totalChurn: st.churn });
    }
    if (st.authors.size > 1) {
      crossAuthorOverlaps.push({ path, distinctAuthors: st.authors.size });
    }
    if (finalFiles.size > 0 && !finalFiles.has(path) && st.touches >= 1) {
      pivotSignals.push(`${path} was modified in earlier branch commits (${st.touches}x) but is absent from the final diff (possible mid-branch pivot).`);
    }
  }

  churnHotspots.sort((a, b) => b.touches - a.touches || b.totalChurn - a.totalChurn);
  const scopeAreas = [...areas].sort();
  const scopeAtomicityOk = scopeAreas.length < SCOPE_AREAS_WARN_THRESHOLD;

  const riskLevel: CommitTrajectoryReport["riskLevel"] =
    churnHotspots.length >= 2 || crossAuthorOverlaps.length >= 2 || pivotSignals.length >= 2
      ? "high"
      : churnHotspots.length > 0 || !scopeAtomicityOk || crossAuthorOverlaps.length > 0
        ? "medium"
        : "low";

  const recommendations: string[] = [];
  if (churnHotspots.length > 0) {
    recommendations.push(`Focus edge-case testing on high-churn file(s): ${churnHotspots.slice(0, 3).map((h) => h.path).join(", ")}.`);
  }
  if (!scopeAtomicityOk) {
    recommendations.push(`PR spans ${scopeAreas.length} distinct areas; consider splitting unrelated modules.`);
  }
  if (crossAuthorOverlaps.length > 0) {
    recommendations.push(`Verify integration around ${crossAuthorOverlaps.length} file(s) with recent multi-author edits.`);
  }
  if (pivotSignals.length > 0) {
    recommendations.push("Check for orphaned helpers or leftover imports from mid-branch pivots.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Commit trajectory is clean and focused.");
  }

  return maskDeep({
    generatedAt: new Date().toISOString(),
    repo: repoId,
    commitsAnalyzed: commits.length,
    riskLevel,
    churnHotspots: churnHotspots.slice(0, 12),
    pivotSignals: pivotSignals.slice(0, 10),
    scopeAreas,
    scopeAtomicityOk,
    crossAuthorOverlaps: crossAuthorOverlaps.slice(0, 12),
    recommendations,
  });
}
