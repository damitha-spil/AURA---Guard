import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Db } from "../index/db.ts";
import { upsertDoc, deleteDoc } from "../index/db.ts";
import type { GuardConfig } from "../types.ts";
import { headSha, readCommits } from "./git.ts";
import { readRepoDocs } from "./files.ts";

export interface IngestResult { repo: string; commits: number; files: number; skipped?: string }

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function ingestRepos(db: Db, cfg: GuardConfig, opts: { max?: number } = {}): IngestResult[] {
  const results: IngestResult[] = [];
  for (const repo of cfg.repos) {
    if (!existsSync(repo.path)) {
      results.push({ repo: repo.id, commits: 0, files: 0, skipped: "path not found" });
      continue;
    }
    const head = headSha(repo.path);
    if (head === undefined) {
      results.push({ repo: repo.id, commits: 0, files: 0, skipped: "not a git repo or no commits" });
      continue;
    }
    const state = db.prepare("SELECT last_sha FROM repo_state WHERE repo=?").get(repo.id) as
      | { last_sha: string } | undefined;
    const commits = readCommits(repo.path, repo.id, state?.last_sha, opts.max);
    const docs = readRepoDocs(repo.path, repo.id);

    db.exec("BEGIN");
    try {
      const insFile = db.prepare(
        "INSERT OR REPLACE INTO commit_files(repo, sha, path, added, removed) VALUES (?,?,?,?,?)",
      );
      for (const c of commits) {
        const paths = c.files.map((f) => f.path);
        const body = [c.subject, c.body, paths.join("\n")].filter(Boolean).join("\n\n");
        upsertDoc(db, {
          kind: "commit", ref: `${repo.id}@${c.sha}`, title: c.subject, body, hash: sha256(body),
          audience: "internal_dev", repo: repo.id, date: c.date,
        });
        for (const f of c.files) insFile.run(repo.id, c.sha, f.path, f.added, f.removed);
      }
      const keep = new Set<string>();
      for (const d of docs) {
        const ref = `${repo.id}:${d.path}`;
        keep.add(ref);
        upsertDoc(db, {
          kind: "file", ref, title: d.path, body: d.text, hash: d.hash,
          audience: "internal_dev", repo: repo.id,
        });
      }
      const existing = db.prepare("SELECT ref FROM docs WHERE kind='file' AND repo=?").all(repo.id) as { ref: string }[];
      for (const e of existing) if (!keep.has(e.ref)) deleteDoc(db, e.ref);
      db.prepare("INSERT OR REPLACE INTO repo_state(repo, last_sha) VALUES (?,?)").run(repo.id, head);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    results.push({ repo: repo.id, commits: commits.length, files: docs.length });
  }
  return results;
}
