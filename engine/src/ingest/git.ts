import { execFileSync } from "node:child_process";
import type { CommitRecord } from "../types.ts";

const MAX_BUFFER = 256 * 1024 * 1024;
const DEFAULT_MAX_COMMITS = 5000;

export function git(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: repoPath,
    maxBuffer: MAX_BUFFER,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** SHA of HEAD, or undefined for a repo with no commits (or not a repo). */
export function headSha(repoPath: string): string | undefined {
  try {
    return git(repoPath, ["rev-parse", "--verify", "HEAD"]).trim();
  } catch {
    return undefined;
  }
}

function isAncestor(repoPath: string, sha: string): boolean {
  try {
    git(repoPath, ["merge-base", "--is-ancestor", sha, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Commits reachable from HEAD, newest first. Incremental when sinceSha is still an ancestor. */
export function readCommits(
  repoPath: string,
  repoId: string,
  sinceSha?: string,
  max: number = DEFAULT_MAX_COMMITS,
): CommitRecord[] {
  if (!headSha(repoPath)) return [];
  const range = sinceSha && isAncestor(repoPath, sinceSha) ? [`${sinceSha}..HEAD`] : ["HEAD"];
  // Merge commits list their files against the first parent (otherwise git shows no diff for them).
  // A record starts with \x1e; fields are NUL separated; numstat lines follow the last NUL.
  const out = git(repoPath, [
    "log", "--diff-merges=first-parent", ...range, `--max-count=${max}`, "--numstat", "--no-renames",
    "--format=%x1e%H%x00%an%x00%aI%x00%s%x00%b%x00",
  ]);
  const commits: CommitRecord[] = [];
  for (const rec of out.split("\x1e")) {
    if (!rec.trim()) continue;
    const parts = rec.split("\0");
    if (parts.length < 6) continue;
    const [sha, author, date, subject, body, stats] = parts as [string, string, string, string, string, string];
    const files: CommitRecord["files"] = [];
    for (const line of stats.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      files.push({
        path: m[3]!,
        added: m[1] === "-" ? 0 : Number(m[1]),
        removed: m[2] === "-" ? 0 : Number(m[2]),
      });
    }
    commits.push({ repo: repoId, sha: sha.trim(), author, date, subject, body: body.trim(), files });
  }
  return commits;
}
