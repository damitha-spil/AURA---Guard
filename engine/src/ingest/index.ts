import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Db } from "../index/db.ts";
import { upsertDoc, deleteDoc } from "../index/db.ts";
import type { GuardConfig } from "../types.ts";
import { headSha, readCommits } from "./git.ts";
import { readFolderDocs, readRepoDocs } from "./files.ts";

export interface DocChanges { added: number; changed: number; removed: number }

/** commits and files stay as before (new commits, total file docs); the rest is new. */
export interface IngestResult {
  repo: string;
  commits: number;
  files: number;
  commitDocs: DocChanges;
  fileDocs: DocChanges;
  skipped?: string;
}

const none = (): DocChanges => ({ added: 0, changed: 0, removed: 0 });

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function ingestRepos(db: Db, cfg: GuardConfig, opts: { max?: number } = {}): IngestResult[] {
  const results: IngestResult[] = [];
  for (const repo of cfg.repos) {
    if (!existsSync(repo.path)) {
      results.push({ repo: repo.id, commits: 0, files: 0, commitDocs: none(), fileDocs: none(), skipped: "path not found" });
      continue;
    }
    const head = headSha(repo.path);
    if (head === undefined) {
      results.push({ repo: repo.id, commits: 0, files: 0, commitDocs: none(), fileDocs: none(), skipped: "not a git repo or no commits" });
      continue;
    }
    const state = db.prepare("SELECT last_sha FROM repo_state WHERE repo=?").get(repo.id) as
      | { last_sha: string } | undefined;
    const commits = readCommits(repo.path, repo.id, state?.last_sha, opts.max);
    const docs = readRepoDocs(repo.path, repo.id);

    const commitDocs = none();
    const fileDocs = none();
    const exists = db.prepare("SELECT 1 FROM docs WHERE ref=?");
    const track = (c: DocChanges, doc: Parameters<typeof upsertDoc>[1]) => {
      const had = exists.get(doc.ref) !== undefined;
      if (upsertDoc(db, doc)) c[had ? "changed" : "added"]++;
    };

    db.exec("BEGIN");
    try {
      const insFile = db.prepare(
        "INSERT OR REPLACE INTO commit_files(repo, sha, path, added, removed) VALUES (?,?,?,?,?)",
      );
      for (const c of commits) {
        const paths = c.files.map((f) => f.path);
        const body = [c.subject, c.body, paths.join("\n")].filter(Boolean).join("\n\n");
        track(commitDocs, {
          kind: "commit", ref: `${repo.id}@${c.sha}`, title: c.subject, body, hash: sha256(body),
          audience: "internal_dev", repo: repo.id, date: c.date,
        });
        for (const f of c.files) insFile.run(repo.id, c.sha, f.path, f.added, f.removed);
      }
      const keep = new Set<string>();
      for (const d of docs) {
        const ref = `${repo.id}:${d.path}`;
        keep.add(ref);
        track(fileDocs, {
          kind: "file", ref, title: d.path, body: d.text, hash: d.hash,
          audience: "internal_dev", repo: repo.id,
        });
      }
      const existing = db.prepare("SELECT ref FROM docs WHERE kind='file' AND repo=?").all(repo.id) as { ref: string }[];
      for (const e of existing) if (!keep.has(e.ref)) {
        deleteDoc(db, e.ref);
        fileDocs.removed++;
      }
      db.prepare("INSERT OR REPLACE INTO repo_state(repo, last_sha) VALUES (?,?)").run(repo.id, head);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    results.push({ repo: repo.id, commits: commits.length, files: docs.length, commitDocs, fileDocs });
  }
  return results;
}

/** Reads each plain-folder source into the index (kind "file", ref `<sourceId>:<path>`). Deleted files leave the index. */
export function ingestDocSources(db: Db, cfg: GuardConfig): IngestResult[] {
  const results: IngestResult[] = [];
  for (const src of cfg.docSources ?? []) {
    if (!existsSync(src.path) || !statSync(src.path).isDirectory()) {
      results.push({ repo: src.id, commits: 0, files: 0, commitDocs: none(), fileDocs: none(), skipped: "folder not found" });
      continue;
    }
    const docs = readFolderDocs(src.path);
    const fileDocs = none();
    const exists = db.prepare("SELECT 1 FROM docs WHERE ref=?");
    db.exec("BEGIN");
    try {
      const keep = new Set<string>();
      for (const d of docs) {
        const ref = `${src.id}:${d.path}`;
        keep.add(ref);
        const had = exists.get(ref) !== undefined;
        if (upsertDoc(db, { kind: "file", ref, title: d.path, body: d.text, hash: d.hash, audience: "internal_dev", repo: src.id })) {
          fileDocs[had ? "changed" : "added"]++;
        }
      }
      const existing = db.prepare("SELECT ref FROM docs WHERE kind='file' AND repo=?").all(src.id) as { ref: string }[];
      for (const e of existing) if (!keep.has(e.ref)) {
        deleteDoc(db, e.ref);
        fileDocs.removed++;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    results.push({ repo: src.id, commits: 0, files: docs.length, commitDocs: none(), fileDocs });
  }
  return results;
}
