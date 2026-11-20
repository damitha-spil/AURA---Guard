import type { Db } from "./db.ts";
import { likePrefix } from "./history.ts";

export interface StaleNote {
  noteId: string;
  repo: string;
  path: string;
  commits: { sha: string; date: string; subject: string }[];
  reason?: string;
}

/** Flags anchors whose code changed after verified_sha. Never edits vault files. */
export function findStale(db: Db): StaleNote[] {
  const anchors = db.prepare(
    "SELECT note_id, repo, path, verified_sha FROM anchors WHERE verified_sha IS NOT NULL AND verified_sha <> ''",
  ).all() as { note_id: string; repo: string; path: string; verified_sha: string }[];
  const out: StaleNote[] = [];
  for (const a of anchors) {
    const base = db.prepare("SELECT date FROM docs WHERE kind='commit' AND ref=?")
      .get(`${a.repo}@${a.verified_sha}`) as { date: string } | undefined;
    if (!base) {
      out.push({
        noteId: a.note_id, repo: a.repo, path: a.path, commits: [],
        reason: `verified_sha ${a.verified_sha} is not in the index`,
      });
      continue;
    }
    const isDir = a.path.endsWith("/");
    const cond = isDir ? "cf.path LIKE ? ESCAPE '\\'" : "cf.path = ?";
    const commits = db.prepare(
      `SELECT DISTINCT cf.sha AS sha, d.date AS date, d.title AS subject
         FROM commit_files cf JOIN docs d ON d.ref = cf.repo || '@' || cf.sha
        WHERE cf.repo=? AND ${cond} AND julianday(d.date) > julianday(?)
        ORDER BY julianday(d.date) DESC`,
    ).all(a.repo, isDir ? likePrefix(a.path) : a.path, base.date) as { sha: string; date: string; subject: string }[];
    if (commits.length) out.push({ noteId: a.note_id, repo: a.repo, path: a.path, commits });
  }
  return out;
}
