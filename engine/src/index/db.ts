// The SQLite index. It is disposable: delete data/guard.db and run
// `aura-guard index` to rebuild it from the vault and the repos.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Bump when the schema changes; an older index is dropped and rebuilt.
export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- One row per indexed thing: a vault note, a commit, or a repo file.
CREATE TABLE IF NOT EXISTS docs (
  rowid    INTEGER PRIMARY KEY,
  kind     TEXT NOT NULL,          -- note | commit | file
  ref      TEXT NOT NULL UNIQUE,   -- note id | repo@sha | repo:path
  title    TEXT NOT NULL,
  body     TEXT NOT NULL,
  hash     TEXT NOT NULL,          -- content hash; unchanged hash = skip
  status   TEXT,                   -- notes only
  note_type TEXT,                  -- notes only: rule | adr | pattern | ...
  audience TEXT NOT NULL,          -- comma list, e.g. "internal_dev,qa_internal"
  repo     TEXT,
  date     TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, body, content='docs', content_rowid='rowid', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO docs_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- Files touched by each commit; feeds the co-change graph later.
CREATE TABLE IF NOT EXISTS commit_files (
  repo TEXT NOT NULL, sha TEXT NOT NULL, path TEXT NOT NULL,
  added INTEGER NOT NULL, removed INTEGER NOT NULL,
  PRIMARY KEY (repo, sha, path)
);

-- Code anchors of each note; feeds stale-note detection.
CREATE TABLE IF NOT EXISTS anchors (
  note_id TEXT NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL,
  symbol TEXT, verified_sha TEXT
);
CREATE INDEX IF NOT EXISTS anchors_path ON anchors(repo, path);

-- Last commit ingested per repo, for incremental ingest.
CREATE TABLE IF NOT EXISTS repo_state (repo TEXT PRIMARY KEY, last_sha TEXT NOT NULL);
`;

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const row = tableExists(db, "meta")
    ? (db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined)
    : undefined;
  if (row && Number(row.value) !== SCHEMA_VERSION) {
    for (const t of ["docs_fts", "docs", "commit_files", "anchors", "repo_state", "meta"]) {
      db.exec(`DROP TABLE IF EXISTS ${t}`);
    }
  }
  db.exec(SCHEMA);
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
  return db;
}

function tableExists(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

export interface DocRow {
  kind: "note" | "commit" | "file";
  ref: string;
  title: string;
  body: string;
  hash: string;
  status?: string | null;
  noteType?: string | null;
  audience: string;
  repo?: string | null;
  date?: string | null;
}

/** Insert or update a doc. Returns false when the stored hash already matches. */
export function upsertDoc(db: Db, d: DocRow): boolean {
  const cur = db.prepare("SELECT hash FROM docs WHERE ref=?").get(d.ref) as { hash: string } | undefined;
  if (cur?.hash === d.hash) return false;
  if (cur) {
    db.prepare(
      "UPDATE docs SET kind=?, title=?, body=?, hash=?, status=?, note_type=?, audience=?, repo=?, date=? WHERE ref=?",
    ).run(d.kind, d.title, d.body, d.hash, d.status ?? null, d.noteType ?? null, d.audience, d.repo ?? null, d.date ?? null, d.ref);
  } else {
    db.prepare(
      "INSERT INTO docs(kind, ref, title, body, hash, status, note_type, audience, repo, date) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(d.kind, d.ref, d.title, d.body, d.hash, d.status ?? null, d.noteType ?? null, d.audience, d.repo ?? null, d.date ?? null);
  }
  return true;
}

export function deleteDoc(db: Db, ref: string): void {
  db.prepare("DELETE FROM docs WHERE ref=?").run(ref);
}
