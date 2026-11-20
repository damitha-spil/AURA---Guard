import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import { git } from "../ingest/git.ts";

// Size caps: everything here goes to a paid model, so the token budget decides.
export const MAX_COMMITS_PER_REPO = 40;
export const MAX_FILES_PER_REPO = 60;
export const MAX_BODY_CHARS = 1500;
export const MAX_HANDOFF_DIFF_CHARS = 6000;

export interface DayCommit { sha: string; subject: string; body: string }
export interface DayRepo {
  repo: string;
  commits: DayCommit[];
  files: { path: string; added: number; removed: number }[];
  handoffDiff: string;
}
export interface DayInput { date: string; repos: DayRepo[] }

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n[cut]" : s;
}

/** Read-only: git log only. Local-time day boundaries. */
export function gatherDay(cfg: GuardConfig, date: string): DayInput {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Date must be YYYY-MM-DD, got "${date}"`);
  const since = `${date}T00:00:00`;
  const until = `${date}T23:59:59`;
  const repos: DayRepo[] = [];
  for (const r of cfg.repos) {
    if (!existsSync(r.path)) continue;
    let out: string;
    try {
      out = git(r.path, [
        "log", "--all", "--since", since, "--until", until, "--no-merges", "--numstat", "--no-renames",
        `--max-count=${MAX_COMMITS_PER_REPO}`, "--format=%x1e%H%x00%s%x00%b%x00",
      ]);
    } catch { continue; }
    const commits: DayCommit[] = [];
    const totals = new Map<string, { added: number; removed: number }>();
    for (const rec of out.split("\x1e")) {
      if (!rec.trim()) continue;
      const p = rec.split("\0");
      if (p.length < 4) continue;
      commits.push({ sha: p[0]!.trim(), subject: p[1]!, body: clip(p[2]!.trim(), MAX_BODY_CHARS) });
      for (const line of p[3]!.split("\n")) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
        if (!m) continue;
        const t = totals.get(m[3]!) ?? { added: 0, removed: 0 };
        t.added += m[1] === "-" ? 0 : Number(m[1]);
        t.removed += m[2] === "-" ? 0 : Number(m[2]);
        totals.set(m[3]!, t);
      }
    }
    if (commits.length === 0) continue;
    const files = [...totals.entries()]
      .map(([path, t]) => ({ path, ...t }))
      .sort((a, b) => b.added + b.removed - (a.added + a.removed))
      .slice(0, MAX_FILES_PER_REPO);
    let handoffDiff = "";
    if (existsSync(join(r.path, "AI_HANDOFF.md"))) {
      try {
        handoffDiff = clip(
          git(r.path, ["log", "--all", "--since", since, "--until", until, "--no-merges", "-p", "--format=", "--", "AI_HANDOFF.md"]),
          MAX_HANDOFF_DIFF_CHARS,
        );
      } catch { /* no handoff history */ }
    }
    repos.push({ repo: r.id, commits, files, handoffDiff });
  }
  return { date, repos };
}
