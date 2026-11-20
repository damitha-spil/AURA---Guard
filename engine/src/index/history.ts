import type { Db } from "./db.ts";

export function likePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, "\\$&") + "%";
}

export function historyFor(
  db: Db, repo: string, pathPrefix: string, limit = 20,
): { sha: string; date: string; subject: string; files: string[] }[] {
  const pat = likePrefix(pathPrefix);
  const rows = db.prepare(
    `SELECT d.date AS date, d.title AS subject, cf.sha AS sha
       FROM (SELECT DISTINCT sha FROM commit_files WHERE repo=? AND path LIKE ? ESCAPE '\\') cf
       JOIN docs d ON d.ref = ? || '@' || cf.sha
      ORDER BY julianday(d.date) DESC LIMIT ?`,
  ).all(repo, pat, repo, limit) as { date: string; subject: string; sha: string }[];
  const filesQ = db.prepare(
    "SELECT path FROM commit_files WHERE repo=? AND sha=? AND path LIKE ? ESCAPE '\\' ORDER BY path",
  );
  return rows.map((r) => ({
    sha: r.sha, date: r.date, subject: r.subject,
    files: (filesQ.all(repo, r.sha, pat) as { path: string }[]).map((f) => f.path),
  }));
}
