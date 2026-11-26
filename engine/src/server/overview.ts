// GET /api/overview: one read-only summary for the home screen. Everything here is already in the
// index, the vault or the QA run files; nothing is invented. No file contents, no paths, no secrets.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "../index/db.ts";
import { listQaRuns } from "../qa/harness_api.ts";
import type { GuardConfig } from "../types.ts";
import { buildInbox } from "./inbox.ts";

export const OVERVIEW_DAYS = 30;
export const OVERVIEW_RECENT = 6;
export const OVERVIEW_QA_RUNS = 8;

export interface Overview {
  /** Commits per calendar day (UTC date of the commit), oldest first, exactly OVERVIEW_DAYS entries. */
  commitsPerDay: { day: string; n: number }[];
  recentCommits: { ref: string; title: string; repo: string | null; date: string | null }[];
  recentNotes: { ref: string; title: string; status: string | null; type: string | null; date: string | null }[];
  noteTypes: { type: string; n: number }[];
  inbox: { total: number; groups: { type: string; count: number }[] };
  qa: {
    totalRuns: number;
    passRate: number | null;
    totalDefects: number;
    /** Oldest first, only runs that were executed (they have a pass rate). */
    passSeries: number[];
    recent: { id: string; generatedAt: string; request: string; riskLevel: string; passRate: number | null; defects: number; seconds: number }[];
  };
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function buildOverview(cfg: GuardConfig, db: Db | null, now: number = Date.now()): Overview {
  const days: string[] = [];
  for (let i = OVERVIEW_DAYS - 1; i >= 0; i--) days.push(day(now - i * 86400000));
  const perDay = new Map(days.map((d) => [d, 0]));
  let recentCommits: Overview["recentCommits"] = [];
  let recentNotes: Overview["recentNotes"] = [];
  const types: Overview["noteTypes"] = [];
  if (db) {
    for (const r of db.prepare("SELECT substr(date,1,10) AS d, COUNT(*) AS n FROM docs WHERE kind='commit' AND date IS NOT NULL AND substr(date,1,10) >= ? GROUP BY d").all(days[0]!) as { d: string; n: number }[]) {
      if (perDay.has(r.d)) perDay.set(r.d, r.n);
    }
    recentCommits = (db.prepare("SELECT ref, title, repo, date FROM docs WHERE kind='commit' ORDER BY date DESC LIMIT ?").all(OVERVIEW_RECENT) as Overview["recentCommits"]).map((c) => ({ ref: c.ref, title: c.title, repo: c.repo, date: c.date }));
    recentNotes = (db.prepare("SELECT ref, title, status, note_type AS type, date FROM docs WHERE kind='note' ORDER BY date DESC, rowid DESC LIMIT ?").all(OVERVIEW_RECENT) as Overview["recentNotes"]).map((n) => ({ ref: n.ref, title: n.title, status: n.status, type: n.type, date: n.date }));
    for (const r of db.prepare("SELECT COALESCE(note_type,'other') AS t, COUNT(*) AS n FROM docs WHERE kind='note' GROUP BY t ORDER BY n DESC, t").all() as { t: string; n: number }[]) types.push({ type: r.t, n: r.n });
  }
  const inbox = buildInbox(cfg);
  const qa = listQaRuns(cfg);
  const byTime = [...qa.runs].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  return {
    commitsPerDay: days.map((d) => ({ day: d, n: perDay.get(d) ?? 0 })),
    recentCommits,
    recentNotes,
    noteTypes: types,
    inbox: { total: inbox.total, groups: inbox.groups.map((g) => ({ type: g.type, count: g.count })) },
    qa: {
      totalRuns: qa.kpis.totalRuns,
      passRate: qa.kpis.passRate,
      totalDefects: qa.kpis.totalDefects,
      passSeries: byTime.filter((r) => r.scorecard.passRate !== null).slice(-20).map((r) => r.scorecard.passRate as number),
      recent: byTime.slice(-OVERVIEW_QA_RUNS).reverse().map((r) => ({ id: r.id, generatedAt: r.generatedAt, request: r.request.slice(0, 140), riskLevel: r.riskLevel, passRate: r.scorecard.passRate, defects: r.scorecard.defectsCount, seconds: r.totalSeconds })),
    },
  };
}

/** The version in package.json, or null when it cannot be read. Shown in the sidebar footer. */
export function appVersion(): string | null {
  try {
    const p = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")) as { version?: unknown };
    return typeof p.version === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(p.version) ? p.version : null;
  } catch {
    return null;
  }
}
