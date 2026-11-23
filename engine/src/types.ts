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
  /** Where the source sits in the project, for display. Optional. */
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

export interface CuaDriverConfig {
  /** Path or binary name for cua-driver (defaults to "cua-driver" on PATH). */
  command?: string;
  /** Optional process names (lowercase, e.g. "personal-agent.exe", "chrome.exe") allowed for background QA. */
  allowedApps?: string[];
  /** Extra process names to always refuse in addition to built-in shell/admin/ERP denylists. */
  denyApps?: string[];
  /** Per-call timeout in ms (capped by safety limits). */
  timeoutMs?: number;
}

export interface GuardConfig {
  dataDir: string;
  vaultDir: string;
  repos: RepoConfig[];
  busyProcesses: string[];
  /** Which model backend roles use. Optional; default is auto. */
  brain?: { backend?: string; models?: Record<string, string> };
  root: string; // absolute repo root of SPIL AURA QA Bot, filled in by loadConfig
  /** Plain Markdown/text folders of the project. */
  docSources?: DocSourceConfig[];
  /** Optional Cua Driver configuration (for background desktop/UI QA). */
  cuaDriver?: CuaDriverConfig;
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
