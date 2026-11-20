// Data for the review inbox and the reports view. Read only: the status change itself lives in
// rules/manage.ts. Nothing here builds a path from user input except through safeReportPath().

import { lstatSync, openSync, closeSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { GuardConfig, Note } from "../types.ts";
import { loadVault } from "../vault/load.ts";
import { parseCheckBlock } from "../rules/checks.ts";

/** The note-id shape the vault schema allows, plus a length cap so a path-like string is refused early. */
export const NOTE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_ID_CHARS = 120;
export const PREVIEW_CHARS = 400;
/** A report larger than this is cut and marked as cut. */
export const MAX_REPORT_BYTES = 512 * 1024;
const MAX_REPORT_LIST = 200;
const MAX_WALK_DEPTH = 4;

export function isNoteId(s: string): boolean {
  return s.length > 0 && s.length <= MAX_ID_CHARS && NOTE_ID.test(s);
}

export interface InboxItem {
  id: string;
  type: string;
  status: string;
  title: string;
  source: string;
  created: string;
  file: string;
  preview: string;
  anchors: number;
  /** Pattern and rule notes with a valid check block: what approving would switch on. */
  evidence?: { commits: number; ratio: number; repo: string; ifChanged: string[]; thenChanged: string[] };
  /** True when the note carries a check block that is not valid (approve would be refused). */
  checkInvalid?: boolean;
}

export interface InboxGroup { type: string; count: number; items: InboxItem[] }

/** Plain text for a card: no headings marks, comments or fenced check blocks, cut to PREVIEW_CHARS. */
export function previewText(body: string): string {
  const t = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+.*$/gm, " ")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > PREVIEW_CHARS ? t.slice(0, PREVIEW_CHARS).trimEnd() + "..." : t;
}

function toItem(n: Note): InboxItem {
  const item: InboxItem = {
    id: n.meta.id,
    type: n.meta.type,
    status: n.meta.status,
    title: n.meta.title ?? n.meta.id,
    source: n.meta.source,
    created: n.meta.created,
    file: n.file,
    preview: previewText(n.body),
    anchors: n.meta.code_anchors?.length ?? 0,
  };
  if (n.meta.type === "pattern" || n.meta.type === "rule") {
    const c = parseCheckBlock(n.body);
    if (c.state === "ok") {
      item.evidence = {
        commits: c.check.evidence.commits,
        ratio: c.check.evidence.ratio,
        repo: c.check.evidence.repo,
        ifChanged: c.check.if_changed,
        thenChanged: c.check.then_changed,
      };
    } else if (c.state === "invalid") item.checkInvalid = true;
  }
  return item;
}

export function buildInbox(cfg: GuardConfig): { total: number; groups: InboxGroup[] } {
  const items = loadVault(cfg.vaultDir)
    .notes.filter((n) => n.meta.status === "proposed" || n.meta.status === "shadow")
    .map(toItem);
  const by = new Map<string, InboxItem[]>();
  for (const it of items) (by.get(it.type) ?? by.set(it.type, []).get(it.type)!).push(it);
  const groups = [...by.entries()]
    .map(([type, list]) => ({ type, count: list.length, items: list.sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id)) }))
    .sort((a, b) => a.type.localeCompare(b.type));
  return { total: items.length, groups };
}

/** The full note for the side panel, from the vault (not the index), so a proposed note always shows. */
export function inboxNote(cfg: GuardConfig, id: string): { id: string; title: string; type: string; status: string; body: string } | null {
  const n = loadVault(cfg.vaultDir).notes.find((x) => x.meta.id === id);
  return n ? { id: n.meta.id, title: n.meta.title ?? n.meta.id, type: n.meta.type, status: n.meta.status, body: n.body } : null;
}

/* ---------------- reports ---------------- */

/** Folders under the data folder that may be listed and read, with the kind each one shows as. */
export const REPORT_DIRS: { dir: string; kind: string }[] = [
  { dir: "reviews", kind: "review" },
  { dir: "qa/plans", kind: "qa-plan" },
  { dir: "qa/runs", kind: "qa-run" },
  { dir: "daily", kind: "daily" },
  { dir: "quiz", kind: "quiz" },
  { dir: "logcheck", kind: "logcheck" },
  { dir: "support-export", kind: "support-export" },
];

export interface ReportEntry { path: string; name: string; kind: string; mtime: string; size: number }

function walk(root: string, rel: string, depth: number, kind: string, out: ReportEntry[]): void {
  if (depth > MAX_WALK_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue; // never follow a link out of the folder
    if (e.isDirectory()) walk(root, r, depth + 1, kind, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      const st = statSync(join(root, r));
      out.push({ path: r, name: e.name, kind, mtime: st.mtime.toISOString(), size: st.size });
    }
  }
}

export function listReports(cfg: GuardConfig): ReportEntry[] {
  const out: ReportEntry[] = [];
  for (const { dir, kind } of REPORT_DIRS) {
    const found: ReportEntry[] = [];
    walk(resolve(cfg.dataDir), dir, 0, kind, found);
    out.push(...found);
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.path.localeCompare(b.path));
  return out.slice(0, MAX_REPORT_LIST);
}

/**
 * Turns the `path` parameter into a real file path, or null. The text is only ever compared with the
 * allowlist; the resolved real path must stay inside an allowed folder, so links cannot lead out.
 */
export function safeReportPath(cfg: GuardConfig, p: string): { file: string; kind: string; rel: string } | null {
  if (!p || p.length > 300 || /[\0\\:*?"<>|]/.test(p) || p.startsWith("/")) return null;
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return null;
  if (!p.toLowerCase().endsWith(".md")) return null;
  const allowed = REPORT_DIRS.find((d) => p.startsWith(d.dir + "/"));
  if (!allowed) return null;
  try {
    const base = realpathSync(join(resolve(cfg.dataDir), allowed.dir));
    const file = realpathSync(join(resolve(cfg.dataDir), ...parts));
    if (!file.startsWith(base + sep)) return null;
    if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) return null;
    return { file, kind: allowed.kind, rel: p };
  } catch {
    return null;
  }
}

export function readReport(file: string): { text: string; truncated: boolean } {
  const size = statSync(file).size;
  const len = Math.min(size, MAX_REPORT_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, len, 0);
  } finally {
    closeSync(fd);
  }
  return { text: buf.toString("utf8"), truncated: size > MAX_REPORT_BYTES };
}
