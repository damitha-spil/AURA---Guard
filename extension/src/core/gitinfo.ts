import { MAX_BODY, MAX_COMMIT_FILES, cap } from "./events.ts";
import type { Runner } from "./cli.ts";

export interface CommitInfo {
  sha: string;
  subject: string;
  body?: string;
  files: { path: string; added: number; removed: number }[];
  isMerge: boolean;
}

/** Parses `git show --numstat --format=%H%x1f%P%x1f%s%x1f%b%x1e`. */
export function parseShow(out: string): CommitInfo | null {
  const end = out.indexOf("\x1e");
  if (end < 0) return null;
  const [sha, parents, subject, body] = out.slice(0, end).split("\x1f");
  if (!sha) return null;
  const files: CommitInfo["files"] = [];
  for (const line of out.slice(end + 1).split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trimEnd());
    if (m) files.push({ path: m[3]!, added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
  }
  const b = (body ?? "").replace(/Co-Authored-By:.*$/gim, "").trim();
  return {
    sha: sha.trim(),
    subject: (subject ?? "").trim(),
    ...(b ? { body: cap(b, MAX_BODY) } : {}),
    files: files.slice(0, MAX_COMMIT_FILES),
    isMerge: (parents ?? "").trim().split(/\s+/).filter(Boolean).length > 1,
  };
}

export async function readCommit(run: Runner, repoRoot: string, sha: string): Promise<CommitInfo | null> {
  const { stdout } = await run("git", ["show", "--numstat", "--format=%H%x1f%P%x1f%s%x1f%b%x1e", sha], { cwd: repoRoot, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  return parseShow(stdout);
}

/** First word of `git config user.name`, lower case, letters digits and dashes only. */
export async function gitFirstName(run: Runner, cwd: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["config", "user.name"], { cwd, timeout: 5_000, maxBuffer: 64 * 1024 });
    const w = (stdout.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    return w || "unknown";
  } catch {
    return "unknown";
  }
}
