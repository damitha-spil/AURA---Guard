// Shapes for /api/repos and /api/source-control. Everything here is read-only for the repositories.

export interface Repo {
  id: string;
  path: string;
  exists: boolean;
  isGit: boolean;
  branch: string | null;
  dirtyFiles: number | null;
  ahead: number | null;
  behind: number | null;
  host: string | null;
  lastCommit: { sha: string; subject: string; date: string } | null;
  error: string | null;
}

export interface Branch {
  name: string;
  remote: boolean;
  sha: string;
  date: string;
  subject: string;
}

export interface DiffFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  patch: string | null;
  withheld: boolean | string | null;
}

export interface RepoDiff {
  base: string;
  head: string;
  additions: number;
  deletions: number;
  truncated: boolean;
  files: DiffFile[];
}

export interface Commit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export interface Finding {
  severity: string;
  file: string | null;
  line: number | null;
  title: string;
  detail: string;
}

/** Which proof a change needs and how much of it exists. Made by the engine; nothing here is guessed. */
export interface Evidence {
  status: "complete" | "incomplete" | "blocked";
  kinds: ("app" | "service" | "docs-tool" | "unknown")[];
  items: { id: string; label: string; state: "present" | "missing"; detail: string }[];
  rejected: string[];
  blockers: string[];
}

export type ReportViewName = "simple" | "technical";

export type RenderedReport =
  | { view: "simple"; format: "text"; body: string }
  | { view: "technical"; format: "json"; body: Record<string, unknown> };

export interface Review {
  evidence?: Evidence;
  round?: { n: number; max: number; capped: boolean; hidden: number } | null;
  reportViews?: Record<ReportViewName, RenderedReport>;
  summary: string;
  findings: Finding[];
  ai: unknown;
  note: string | null;
}

export interface SourceControl {
  git: { available: boolean; version: string | null };
  providers: { id: string; label: string; status: "ready" | "not-authenticated" | "not-installed"; detail: string }[];
}

export const WORKTREE = "WORKTREE";
export const refLabel = (ref: string) => (ref === WORKTREE ? "Working changes" : ref);

const ORDER = ["blocker", "risk", "suggestion", "critical", "high", "error", "medium", "warning", "low", "info"];

/** Findings in groups, most serious first. Unknown severities go last. */
export function bySeverity(findings: Finding[]): [string, Finding[]][] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const s = (f.severity || "other").toLowerCase();
    groups.set(s, [...(groups.get(s) ?? []), f]);
  }
  const rank = (s: string) => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length);
  return [...groups].sort((a, b) => rank(a[0]) - rank(b[0]));
}

/** The owner fixes blockers and risks; the reviewer judges the rest. Same split as the saved review report. */
export function byWhoActs(findings: Finding[]): { title: string; list: Finding[] }[] {
  const sorted = bySeverity(findings).flatMap(([, list]) => list);
  const owns = (f: Finding) => f.severity === "blocker" || f.severity === "risk";
  return [
    { title: "For the owner to fix", list: sorted.filter(owns) },
    { title: "For the reviewer to judge", list: sorted.filter((f) => !owns(f)) },
  ].filter((g) => g.list.length > 0);
}

/** GET /api/repos/browse. Folder names only. */
export interface FolderListing {
  path: string | null;
  parent: string | null;
  isGit: boolean;
  added: boolean;
  entries: { name: string; path: string; isGit: boolean; added: boolean }[];
  suggestions: { name: string; path: string; kind: "home" | "projects" | "drive" }[];
  truncated: boolean;
}
