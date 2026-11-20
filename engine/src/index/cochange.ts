import type { Db } from "./db.ts";

// A commit touching more files than this is a mass rename or format run, not a
// real relationship between files, so it is left out of the counts.
export const MAX_FILES_PER_COMMIT = 50;

export function coChanged(
  db: Db, repo: string, path: string, limit = 10,
): { path: string; together: number; ratio: number }[] {
  const big = "(SELECT sha FROM commit_files WHERE repo=? GROUP BY sha HAVING COUNT(*) > ?)";
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM commit_files WHERE repo=? AND path=? AND sha NOT IN ${big}`,
  ).get(repo, path, repo, MAX_FILES_PER_COMMIT) as { n: number };
  if (!total.n) return [];
  const rows = db.prepare(
    `SELECT o.path AS path, COUNT(*) AS together
       FROM commit_files s JOIN commit_files o ON o.repo=s.repo AND o.sha=s.sha AND o.path<>s.path
      WHERE s.repo=? AND s.path=? AND s.sha NOT IN ${big}
      GROUP BY o.path ORDER BY together DESC, o.path ASC LIMIT ?`,
  ).all(repo, path, repo, MAX_FILES_PER_COMMIT, limit) as { path: string; together: number }[];
  return rows.map((r) => ({ path: r.path, together: r.together, ratio: r.together / total.n }));
}
