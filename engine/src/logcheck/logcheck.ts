// Compares a repo's commits with its AI activity log (ai-log/**/*.md, entries with `**Commit:** <sha>`).
// Read-only. Reports by day; author names are never read or printed.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitRead } from "../rules/util.ts";

/** A logged sha shorter than this is too ambiguous to match a commit. */
export const MIN_SHA_LEN = 7;

export interface LogCommit { sha: string; day: string; subject: string }

export interface DayReport {
  day: string;
  commits: number;
  logged: number;
  missing: { sha: string; subject: string }[];
}

export interface LogCheckResult {
  repo: string;
  since: string | undefined;
  days: DayReport[];
  commits: number;
  logged: number;
  coverage: number; // 0..1; 1 when there are no commits
  readmeExists: boolean;
}

/** Hex shas written after `**Commit:**` in log text ("not committed" gives none). */
export function parseLoggedShas(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\*\*Commit:\*\*([^\n]*)/gi)) {
    for (const t of m[1]!.matchAll(/\b[0-9a-f]{7,40}\b/gi)) out.push(t[0].toLowerCase());
  }
  return out;
}

function walkMd(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.isFile() && e.name.endsWith(".md") && e.name.toLowerCase() !== "readme.md") out.push(p);
  }
}

export function readLoggedShas(repoPath: string): { shas: string[]; readmeExists: boolean; files: number } {
  const dir = join(repoPath, "ai-log");
  const readmeExists = existsSync(join(dir, "README.md"));
  if (!existsSync(dir)) return { shas: [], readmeExists, files: 0 };
  const files: string[] = [];
  walkMd(dir, files);
  const shas: string[] = [];
  for (const f of files) shas.push(...parseLoggedShas(readFileSync(f, "utf8")));
  return { shas, readmeExists, files: files.length };
}

/** A commit is logged when a logged sha and the commit sha share a prefix of at least MIN_SHA_LEN. */
export function isLogged(commitSha: string, logged: string[]): boolean {
  const c = commitSha.toLowerCase();
  return logged.some((l) => l.length >= MIN_SHA_LEN && (c.startsWith(l) || l.startsWith(c)));
}

export function compare(
  repo: string, commits: LogCommit[], logged: string[], readmeExists: boolean, since?: string,
): LogCheckResult {
  const byDay = new Map<string, DayReport>();
  let loggedCount = 0;
  for (const c of commits) {
    const d = byDay.get(c.day) ?? { day: c.day, commits: 0, logged: 0, missing: [] };
    d.commits++;
    if (isLogged(c.sha, logged)) {
      d.logged++;
      loggedCount++;
    } else d.missing.push({ sha: c.sha.slice(0, 10), subject: c.subject });
    byDay.set(c.day, d);
  }
  const days = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
  return {
    repo, since, days, commits: commits.length, logged: loggedCount,
    coverage: commits.length ? loggedCount / commits.length : 1, readmeExists,
  };
}

/** Non-merge commits, newest first. Only sha, date and subject are read. */
export async function readCommits(repoPath: string, since?: string): Promise<LogCommit[]> {
  const args = ["log", "--no-merges", "--format=%H%x09%cs%x09%s"];
  if (since) args.push(`--since=${since}`);
  const out = await gitRead(repoPath, args);
  const list: LogCommit[] = [];
  for (const line of out.split("\n")) {
    const [sha, day, ...rest] = line.replace(/\r$/, "").split("\t");
    if (sha && day) list.push({ sha, day, subject: rest.join("\t") });
  }
  return list;
}

export async function runLogCheck(repo: { id: string; path: string }, since?: string): Promise<LogCheckResult> {
  const commits = await readCommits(repo.path, since);
  const log = readLoggedShas(repo.path);
  return compare(repo.id, commits, log.shas, log.readmeExists, since);
}

export function renderLogCheck(r: LogCheckResult, date: string, maxMissingPerDay = 50): string {
  const pct = `${(r.coverage * 100).toFixed(1)}%`;
  const lines = [
    `# Log check: ${r.repo}, ${date}`, "",
    `Commits: ${r.commits}${r.since ? ` since ${r.since}` : ""}. With a log entry: ${r.logged}. Coverage: ${pct}.`,
    `ai-log/README.md: ${r.readmeExists ? "present" : "MISSING"}.`, "",
    "| Day | Commits | Logged | Missing |", "|---|---|---|---|",
  ];
  for (const d of r.days) lines.push(`| ${d.day} | ${d.commits} | ${d.logged} | ${d.missing.length} |`);
  lines.push("", "## Commits without a log entry", "");
  const withMissing = r.days.filter((d) => d.missing.length > 0);
  if (withMissing.length === 0) lines.push("None.");
  for (const d of withMissing) {
    lines.push(`### ${d.day}`, "");
    for (const m of d.missing.slice(0, maxMissingPerDay)) lines.push(`- ${m.sha} ${m.subject}`);
    if (d.missing.length > maxMissingPerDay) lines.push(`- ... and ${d.missing.length - maxMissingPerDay} more`);
    lines.push("");
  }
  return lines.join("\n");
}

export function writeLogCheck(dataDir: string, r: LogCheckResult, date: string): { file: string; text: string } {
  const dir = join(dataDir, "logcheck");
  mkdirSync(dir, { recursive: true });
  const text = renderLogCheck(r, date);
  const file = join(dir, `${r.repo}-${date}.md`);
  writeFileSync(file, text);
  return { file, text };
}
