// Shared contracts. Every module builds against these; change them only with
// a note in AI_HANDOFF.md.

export type NoteType =
  | "adr" | "rule" | "pattern" | "incident" | "domain" | "diary" | "choice" | "journey";
export type NoteStatus = "proposed" | "shadow" | "active" | "stale" | "deprecated";
export type Audience = "internal_dev" | "qa_internal" | "customer_support";
export type NoteSource =
  | "owner-answer" | "commit" | "pr-comment" | "session" | "evidence" | "import";

export interface CodeAnchor {
  repo: string;
  path: string;
  symbol?: string;
  verified_sha?: string;
}

export interface NoteMeta {
  id: string;
  type: NoteType;
  status: NoteStatus;
  audience: Audience[];
  department: string;
  source: NoteSource;
  code_anchors?: CodeAnchor[];
  created: string; // YYYY-MM-DD
  reviewed?: string;
  title?: string;
}

export interface Note {
  meta: NoteMeta;
  body: string;
  file: string; // path relative to the vault root, forward slashes
  hash: string; // sha256 of the whole file text
}

export interface NoteProblem {
  file: string;
  message: string;
}

export interface RepoConfig {
  id: string;
  path: string;
  /** Where the source sits in its department, for display. Optional. */
  module?: string;
  sub?: string;
}

/** A plain folder of Markdown/text read into the index (no git needed). */
export interface DocSourceConfig {
  id: string;
  path: string;
  label?: string;
  module?: string;
  sub?: string;
}

export interface GuardConfig {
  department: string;
  dataDir: string;
  vaultDir: string;
  repos: RepoConfig[];
  busyProcesses: string[];
  /** Which model backend roles use. Optional; default is auto. */
  brain?: { backend?: string; models?: Record<string, string> };
  root: string; // absolute repo root of SPIL Quality Support Bot, filled in by loadConfig
  /** Set when the config was derived from a department (see departments/registry.ts). */
  departmentId?: string;
  departmentName?: string;
  productName?: string;
  /** Plain Markdown/text folders of the department. */
  docSources?: DocSourceConfig[];
  /** Which helpers the department has switched on (departments/model.ts RoleKey). */
  roles?: Record<string, boolean>;
}

export interface CommitRecord {
  repo: string;
  sha: string;
  author: string;
  date: string; // ISO
  subject: string;
  body: string;
  files: { path: string; added: number; removed: number }[];
}

export type DocKind = "note" | "commit" | "file";

export interface SearchHit {
  kind: DocKind;
  ref: string; // note id, "repo@sha", or "repo:path"
  title: string;
  snippet: string;
  score: number;
  status?: NoteStatus;
}

export interface SearchOptions {
  limit?: number;
  audience?: Audience; // filter notes to this audience; commits/files are internal_dev only
  kinds?: DocKind[];
  includeStale?: boolean; // default false: stale/deprecated notes are left out
}
