// Shapes, search, sort and saved views for GET /api/pulls. Read-only.

export type PullState = "open" | "merged" | "closed";

export interface Pull {
  id: string | number;
  repoId: string;
  host: string;
  number: number;
  title: string;
  author: string;
  state: PullState;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  createdAt: string;
  updatedAt: string | null;
  labels: string[];
  url: string | null;
}

export interface PullSource {
  repoId: string;
  host: "azure-devops" | "github" | "unknown";
  ok: boolean;
  error: string | null;
}

export interface PullsReply {
  checkedAt: string;
  sources: PullSource[];
  pulls: Pull[];
}

export const SORTS = [
  ["updated-new", "Updated: newest"],
  ["updated-old", "Updated: oldest"],
  ["created-new", "Created: newest"],
  ["created-old", "Created: oldest"],
  ["title", "Title"],
] as const;
export type Sort = (typeof SORTS)[number][0];

/** What a saved view holds. An empty author or target means any. */
export interface ViewSet {
  query: string;
  sort: Sort;
  state: PullState | "all";
  draft: "any" | "only" | "hide";
  author: string;
  target: string;
}

export const DEFAULT_SET: ViewSet = { query: "", sort: "updated-new", state: "open", draft: "any", author: "", target: "" };

export const BUILT_IN: { name: string; set: ViewSet }[] = [
  { name: "All open", set: DEFAULT_SET },
  { name: "Drafts", set: { ...DEFAULT_SET, draft: "only" } },
];

export interface SavedView {
  name: string;
  set: ViewSet;
}

const KEY = "pull-views";

export function readViews(): SavedView[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return (raw as SavedView[])
      .filter((v) => v && typeof v.name === "string" && typeof v.set?.query === "string")
      .map((v) => ({ name: v.name, set: { ...DEFAULT_SET, ...v.set } }));
  } catch {
    return [];
  }
}

/** False when the browser refused to store them. */
export function writeViews(views: SavedView[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(views));
    return true;
  } catch {
    return false;
  }
}

const changed = (p: Pull) => p.updatedAt ?? p.createdAt;

/** Free words must all appear; label:name (or label:"two words") must match a label. */
export function selectPulls(pulls: Pull[], v: ViewSet, source: string): Pull[] {
  const labels: string[] = [];
  const rest = v.query.toLowerCase().replace(/\blabel:(?:"([^"]*)"?|(\S*))/g, (_m, quoted?: string, plain?: string) => {
    const label = quoted ?? plain ?? "";
    if (label) labels.push(label);
    return " ";
  });
  const words = rest.split(/\s+/).filter(Boolean);
  const out = pulls.filter((p) => {
    if (source && p.repoId !== source) return false;
    if (v.state !== "all" && p.state !== v.state) return false;
    if (v.draft !== "any" && p.draft !== (v.draft === "only")) return false;
    if (v.author && p.author !== v.author) return false;
    if (v.target && p.targetBranch !== v.target) return false;
    const own = p.labels.map((l) => l.toLowerCase());
    if (!labels.every((l) => own.includes(l))) return false;
    const text = `${p.title} ${p.repoId} #${p.number} ${p.author} ${p.sourceBranch} ${p.targetBranch}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  return out.sort((a, b) => {
    if (v.sort === "title") return a.title.localeCompare(b.title);
    const [field, direction] = v.sort.split("-");
    const x = Date.parse(field === "created" ? a.createdAt : changed(a)) || 0;
    const y = Date.parse(field === "created" ? b.createdAt : changed(b)) || 0;
    return direction === "new" ? y - x : x - y;
  });
}

/** Only https links may be opened or copied. */
export function safeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}
