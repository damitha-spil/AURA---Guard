// Mines stable co-change pairs and small groups from the index. Pure: reads commit_files only.

import type { Db } from "../index/db.ts";

/** A pair must change together in at least this many commits before it can become a proposal. */
export const MIN_SUPPORT = 4;
/** together / max(commits of A, commits of B). Below this the link is not stable enough. */
export const MIN_RATIO = 0.6;
/** Commits touching more files than this are bulk edits (renames, format runs, merges), not links. */
export const MAX_FILES_FOR_RULES = 15;
/** A group of files that all change together is cut at this size to stay readable. */
export const MAX_GROUP_SIZE = 4;

// Files that change with everything: lockfiles, build output, snapshots, activity logs.
const NOISE_PATH = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|Cargo\.lock|composer\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$/i,
  /\.lock$/i,
  /(^|\/)(dist|build|target|node_modules|\.artifacts|coverage|__snapshots__|generated|gen)\//i,
  /\.(min\.js|map|snap)$/i,
  /(^|\/)(ai-log|\.claude|\.cursor)\//i,
  /(^|\/)(AI_HANDOFF\.md|CHANGELOG\.md|CHANGES\.md)$/i,
  /\.generated\./i,
];

export function isNoisePath(path: string): boolean {
  return NOISE_PATH.some((re) => re.test(path));
}

/** A file and its own submodule folder (a.rs and a/tests.rs) are one unit, not a link between two. */
export function trivialPair(a: string, b: string): boolean {
  if (dirOf(a) === dirOf(b)) return true; // files in one folder are trivially coupled
  const stem = (p: string): string => p.replace(/\.[^./]+$/, "");
  const under = (dir: string, s: string): boolean => dir === s || dir.startsWith(s + "/");
  return under(dirOf(b), stem(a)) || under(dirOf(a), stem(b));
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export interface CoChangeFinding {
  /** Sorted file paths; 2 for a pair, up to MAX_GROUP_SIZE for a group. */
  files: string[];
  /** Commits in which all of the files changed together. */
  commits: number;
  /** Lowest pair ratio inside the group. */
  ratio: number;
  /** The most recent commit that changed them together. */
  sha: string;
}

export interface MineOptions {
  minSupport?: number;
  minRatio?: number;
  maxFilesPerCommit?: number;
}

export interface MineResult {
  findings: CoChangeFinding[];
  commitsUsed: number;
  commitsSkipped: number;
}

export function mineCoChange(db: Db, repo: string, opts: MineOptions = {}): MineResult {
  const minSupport = opts.minSupport ?? MIN_SUPPORT;
  const minRatio = opts.minRatio ?? MIN_RATIO;
  const maxFiles = opts.maxFilesPerCommit ?? MAX_FILES_FOR_RULES;

  // Newest first, so the first sha seen for a pair is its latest commit.
  const rows = db
    .prepare(
      `SELECT cf.sha AS sha, cf.path AS path FROM commit_files cf
         LEFT JOIN docs d ON d.ref = cf.repo || '@' || cf.sha
        WHERE cf.repo=? ORDER BY d.date DESC, cf.sha`,
    )
    .all(repo) as { sha: string; path: string }[];
  const byCommit = new Map<string, string[]>();
  for (const r of rows) {
    const l = byCommit.get(r.sha);
    if (l) l.push(r.path);
    else byCommit.set(r.sha, [r.path]);
  }

  const fileCount = new Map<string, number>();
  const pairCount = new Map<string, { n: number; sha: string }>();
  let used = 0;
  let skipped = 0;
  for (const [sha, all] of byCommit) {
    if (all.length > maxFiles) {
      skipped++;
      continue;
    }
    const files = all.filter((p) => !isNoisePath(p)).sort();
    if (files.length < 2) {
      skipped++;
      continue;
    }
    used++;
    for (const f of files) fileCount.set(f, (fileCount.get(f) ?? 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}\0${files[j]}`;
        const cur = pairCount.get(key);
        if (cur) cur.n++;
        else pairCount.set(key, { n: 1, sha });
      }
    }
  }

  interface Pair { a: string; b: string; n: number; ratio: number; sha: string }
  const good: Pair[] = [];
  for (const [key, v] of pairCount) {
    if (v.n < minSupport) continue;
    const [a, b] = key.split("\0") as [string, string];
    if (trivialPair(a, b)) continue;
    const ratio = v.n / Math.max(fileCount.get(a) ?? v.n, fileCount.get(b) ?? v.n);
    if (ratio < minRatio) continue;
    good.push({ a, b, n: v.n, ratio, sha: v.sha });
  }
  good.sort((x, y) => y.n - x.n || y.ratio - x.ratio || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

  // Grow groups: a pair joins a group when every file already in it links to the new file.
  const link = new Map<string, Pair>();
  for (const p of good) link.set(`${p.a}\0${p.b}`, p);
  const linkOf = (x: string, y: string): Pair | undefined => link.get(x < y ? `${x}\0${y}` : `${y}\0${x}`);
  const taken = new Set<string>();
  const findings: CoChangeFinding[] = [];
  for (const p of good) {
    if (taken.has(`${p.a}\0${p.b}`)) continue;
    const members = [p.a, p.b];
    for (const q of good) {
      if (members.length >= MAX_GROUP_SIZE) break;
      for (const cand of [q.a, q.b]) {
        if (members.includes(cand) || members.length >= MAX_GROUP_SIZE) continue;
        if (members.every((m) => linkOf(m, cand))) members.push(cand);
      }
    }
    members.sort();
    let ratio = 1;
    let commits = Infinity;
    let sha = p.sha;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const l = linkOf(members[i]!, members[j]!)!;
        taken.add(`${members[i]}\0${members[j]}`);
        ratio = Math.min(ratio, l.ratio);
        commits = Math.min(commits, l.n);
      }
    }
    findings.push({ files: members, commits, ratio: Math.round(ratio * 100) / 100, sha });
  }
  return { findings, commitsUsed: used, commitsSkipped: skipped };
}
