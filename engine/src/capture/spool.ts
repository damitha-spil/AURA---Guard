// Developer activity capture, Guard side: the local spool the VS Code extension writes.
// Everything here is read-only against the spool except prune and purge, which only ever
// delete files that match the spool's own file names (never a whole folder by name).

import { createHash } from "node:crypto";
import {
  closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmdirSync, statSync, unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// ---- Safety limits (the files are written by another program; never trust their size) ----
/** One day file is read only up to this many bytes. */
export const MAX_DAY_FILE_BYTES = 16 * 1024 * 1024;
/** A line longer than this is treated as bad (the extension caps its own text well below it). */
export const MAX_LINE_BYTES = 64 * 1024;
/** The consent file is tiny; anything bigger is not ours. */
export const MAX_CONSENT_BYTES = 64 * 1024;
export const MAX_TEXT = 1000;
export const MAX_ANSWER = 4000;
export const MAX_BODY = 600;
export const MAX_FILES_PER_COMMIT = 40;
export const MAX_PATH_CHARS = 500;
export const MAX_REF_CHARS = 200;

export const EVENT_KINDS = ["commit", "save", "task", "terminal", "diagnostics", "idea", "decision", "correction", "chat"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

// ---- Config (roles/capture.json: data a company can edit) ----
export interface CaptureConfig {
  retentionDays: number;
  maxEventsPerDay: number;
  terminalAllowlist: string[];
  capture: Record<string, boolean>;
}

const DEFAULT_CONFIG: CaptureConfig = {
  retentionDays: 30,
  maxEventsPerDay: 5000,
  terminalAllowlist: ["git", "cargo", "npm", "npx", "node", "tsc", "vitest", "playwright", "pytest", "dotnet", "yarn", "pnpm"],
  capture: { commit: true, save: true, task: true, terminal: true, diagnostics: true, chat: true },
};

const ConfigSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).default(DEFAULT_CONFIG.retentionDays),
  maxEventsPerDay: z.number().int().min(1).max(100_000).default(DEFAULT_CONFIG.maxEventsPerDay),
  terminalAllowlist: z.array(z.string()).default(DEFAULT_CONFIG.terminalAllowlist),
  capture: z.record(z.string(), z.boolean()).default(DEFAULT_CONFIG.capture),
});

/** Reads <root>/roles/capture.json; a missing or broken file gives the defaults. */
export function loadCaptureConfig(root: string): CaptureConfig {
  try {
    return ConfigSchema.parse(JSON.parse(readFileSync(join(root, "roles", "capture.json"), "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ---- Where the spool lives ----
export function spoolDir(env: Record<string, string | undefined> = process.env): string {
  const e = env.AURA_GUARD_SPOOL;
  return e && e.trim() ? e : join(homedir(), ".aura-guard", "spool");
}

// ---- repoKey: must be identical on the extension side ----
/** Lower-case, forward slashes, no trailing slash (a bare drive root "c:/" keeps its slash). */
export function normalizeWorkspacePath(p: string): string {
  let s = p.replace(/\\/g, "/").toLowerCase();
  while (s.length > 1 && s.endsWith("/") && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** sanitized basename of the workspace root + "-" + first 6 hex of sha256 of the normalized path. */
export function repoKeyFor(absPath: string): string {
  const norm = normalizeWorkspacePath(absPath);
  const base = norm.split("/").filter(Boolean).pop() ?? "";
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return `${slug}-${createHash("sha256").update(norm).digest("hex").slice(0, 6)}`;
}

export const REPO_KEY_RE = /^[a-z0-9-]+$/;
export const DAY_FILE_RE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

const p2 = (n: number): string => String(n).padStart(2, "0");
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
export function localHM(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "00:00" : `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** An absolute workspace path, Windows or POSIX style. */
export function isAbsoluteWorkspacePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

// ---- Consent ----
const ConsentSchema = z.object({
  version: z.literal(1),
  acceptedAt: z.string(),
  developer: z.string().regex(/^[a-z0-9-]{1,40}$/),
  repos: z.record(z.string(), z.boolean()).default({}),
});
export type Consent = z.infer<typeof ConsentSchema>;

export function readConsent(dir: string): Consent | null {
  const file = join(dir, "consent.json");
  try {
    if (!existsSync(file) || statSync(file).size > MAX_CONSENT_BYTES) return null;
    const r = ConsentSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function hasConsentFor(consent: Consent | null, repoKey: string): boolean {
  return consent !== null && consent.repos[repoKey] === true;
}

// ---- Events ----
const clip = (n: number) => z.string().transform((s) => (s.length > n ? s.slice(0, n) : s));
const count = z.number().int().min(0).max(1_000_000_000);
const isoTs = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "bad timestamp");
const ctx = z.object({ path: clip(MAX_PATH_CHARS), line: count }).optional();

const base = {
  v: z.literal(1),
  id: z.string().regex(/^[0-9a-f]{16}$/),
  ts: isoTs,
  repo: z.string().max(120),
  branch: clip(200),
  dev: z.string().max(40),
};
const textData = z.object({ text: clip(MAX_TEXT), context: ctx });

export const EventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base, kind: z.literal("commit"),
    data: z.object({
      sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
      subject: clip(300),
      body: clip(MAX_BODY).optional(),
      files: z.array(z.object({ path: clip(MAX_PATH_CHARS), added: count, removed: count }))
        .transform((a) => a.slice(0, MAX_FILES_PER_COMMIT)),
    }),
  }),
  z.object({
    ...base, kind: z.literal("save"),
    data: z.object({ path: clip(MAX_PATH_CHARS), language: clip(40), count, windowStart: isoTs, windowEnd: isoTs }),
  }),
  z.object({ ...base, kind: z.literal("task"), data: z.object({ name: clip(200), exitCode: z.number().int(), ms: count }) }),
  z.object({ ...base, kind: z.literal("terminal"), data: z.object({ command: clip(300), exitCode: z.number().int(), ms: count }) }),
  z.object({ ...base, kind: z.literal("diagnostics"), data: z.object({ errors: count, warnings: count, files: count }) }),
  z.object({ ...base, kind: z.literal("idea"), data: textData }),
  z.object({ ...base, kind: z.literal("decision"), data: textData }),
  z.object({ ...base, kind: z.literal("correction"), data: textData }),
  z.object({
    ...base, kind: z.literal("chat"),
    data: z.object({
      participant: z.literal("guard"),
      question: clip(MAX_TEXT),
      answer: clip(MAX_ANSWER),
      sources: z.array(clip(MAX_REF_CHARS)).transform((a) => a.slice(0, 20)),
    }),
  }),
]);
export type CaptureEvent = z.infer<typeof EventSchema>;

/** First word of a terminal command, lower case, without folder or .exe/.cmd/.bat. */
export function terminalBinary(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const name = first.replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? "";
  return name.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

export function kindEnabled(cfg: CaptureConfig, kind: EventKind): boolean {
  return cfg.capture[kind] !== false;
}

export interface DayRead { events: CaptureEvent[]; skipped: number }

function readCapped(file: string): string {
  const size = statSync(file).size;
  if (size <= MAX_DAY_FILE_BYTES) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(MAX_DAY_FILE_BYTES);
    const n = readSync(fd, buf, 0, MAX_DAY_FILE_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Pure: parse the text of one day file. Bad lines are counted, not thrown. */
export function parseDayText(text: string, cfg: CaptureConfig): DayRead {
  const events: CaptureEvent[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (events.length >= cfg.maxEventsPerDay) { skipped++; continue; }
    if (line.length > MAX_LINE_BYTES) { skipped++; continue; }
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { skipped++; continue; }
    const r = EventSchema.safeParse(obj);
    if (!r.success) { skipped++; continue; }
    const ev = r.data;
    if (seen.has(ev.id) || !kindEnabled(cfg, ev.kind)) { skipped++; continue; }
    // Defence in depth: the extension already allowlists terminal commands.
    if (ev.kind === "terminal" && !cfg.terminalAllowlist.includes(terminalBinary(ev.data.command))) { skipped++; continue; }
    seen.add(ev.id);
    events.push(ev);
  }
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { events, skipped };
}

export function readDay(dir: string, repoKey: string, date: string, cfg: CaptureConfig): DayRead {
  if (!REPO_KEY_RE.test(repoKey) || !isRealDate(date)) return { events: [], skipped: 0 };
  const file = join(dir, repoKey, `events-${date}.jsonl`);
  if (!existsSync(file)) return { events: [], skipped: 0 };
  return parseDayText(readCapped(file), cfg);
}

// ---- Listing, retention, purge ----
export function dayFiles(dir: string, repoKey: string): { date: string; file: string }[] {
  const d = join(dir, repoKey);
  if (!REPO_KEY_RE.test(repoKey) || !existsSync(d)) return [];
  const rows: { date: string; file: string }[] = [];
  for (const f of readdirSync(d)) {
    const m = DAY_FILE_RE.exec(f);
    const date = m?.[1];
    if (date && isRealDate(date)) rows.push({ date, file: join(d, f) });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export function listRepoKeys(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && REPO_KEY_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

function dropIfEmpty(d: string): void {
  try { rmdirSync(d); } catch { /* not empty or already gone */ }
}

/** Deletes day files older than the cut-off date (exclusive). Returns how many files were removed. */
export function removeBefore(dir: string, repoKey: string, before: string): number {
  let removed = 0;
  for (const f of dayFiles(dir, repoKey)) {
    if (f.date < before) {
      try { unlinkSync(f.file); removed++; } catch { /* leave it */ }
    }
  }
  dropIfEmpty(join(dir, repoKey));
  return removed;
}

export function retentionCutoff(retentionDays: number, now: Date = new Date()): string {
  return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - retentionDays));
}

/** Prunes every repo's days older than retentionDays. */
export function pruneRetention(dir: string, cfg: CaptureConfig, now: Date = new Date()): number {
  const cutoff = retentionCutoff(cfg.retentionDays, now);
  let n = 0;
  for (const k of listRepoKeys(dir)) n += removeBefore(dir, k, cutoff);
  return n;
}

/** Removes every day file of a repo (not its consent entry). */
export function removeRepo(dir: string, repoKey: string): number {
  return removeBefore(dir, repoKey, "9999-12-31");
}

/** Removes every day file of every repo and the consent file. Only files with the spool's own names. */
export function removeAll(dir: string): number {
  let n = 0;
  for (const k of listRepoKeys(dir)) n += removeRepo(dir, k);
  const c = join(dir, "consent.json");
  if (existsSync(c)) {
    try { unlinkSync(c); n++; } catch { /* leave it */ }
  }
  return n;
}

export interface RepoStatus { repoKey: string; days: number; events: number; oldest: string; newest: string }

export function repoStatuses(dir: string, cfg: CaptureConfig): RepoStatus[] {
  const rows: RepoStatus[] = [];
  for (const k of listRepoKeys(dir)) {
    const days = dayFiles(dir, k);
    const first = days[0];
    const last = days[days.length - 1];
    if (!first || !last) continue;
    let events = 0;
    for (const d of days) events += parseDayText(readCapped(d.file), cfg).events.length;
    rows.push({ repoKey: k, days: days.length, events, oldest: first.date, newest: last.date });
  }
  return rows;
}
