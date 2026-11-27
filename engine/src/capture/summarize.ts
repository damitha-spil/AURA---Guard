// Turns one developer's day (spool events + their Claude Code turns) into DRAFT ai-log entries.
// Guard only returns text. It never writes into the repository it summarises: the developer's
// editor applies the draft after the developer confirms. The only thing written here is a
// proposed note in this machine's vault inbox (see notes.ts).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { CompleteFn } from "../brain/client.ts";
import { maskOutgoing } from "../mask/mask.ts";
import { findSessionDir, readSessions } from "../sessions/read.ts";
import type { Turn } from "../sessions/read.ts";
import type { GuardConfig } from "../types.ts";
import { proposeChoiceNotes } from "./notes.ts";
import {
  hasConsentFor, isRealDate, loadCaptureConfig, localDate, localHM, pruneRetention, readConsent, readDay, repoKeyFor, spoolDir,
} from "./spool.ts";
import type { CaptureEvent } from "./spool.ts";

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

// ---- Token budget (about 4 characters per token) ----
// One model call per summary: the stable rules (about 400 tokens) come first so they stay cached;
// the user block is capped at 30,000 characters (about 7,500 tokens) and the reply at max_tokens.
export const MAX_PROMPT_CHARS = 30_000;
/** Longest text of one item in the prompt. */
export const MAX_ITEM_CHARS = 400;
export const MAX_TURNS = 40;
export const MAX_OWNER_TURN_CHARS = 500;
export const MAX_ASSISTANT_TURN_CHARS = 400;
/** All transcript text together: 12,000 characters is about 3,000 tokens. */
export const MAX_TURN_BUDGET_CHARS = 12_000;
export const MAX_FILES_PER_ENTRY = 8;
export const MAX_CHECKS_PER_ENTRY = 5;
/** An existing ai-log file is read only this far. */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
const FALLBACK = { maxEntries: 8, maxIdeas: 10, maxQuestions: 3, maxTokens: 2500 };
const FALLBACK_TOOLS = { events: "VS Code", transcript: "Claude Code", both: "VS Code + Claude Code" };

interface Role {
  limits: typeof FALLBACK;
  tools: typeof FALLBACK_TOOLS;
  rules: string[];
}

function loadRole(root: string): Role {
  try {
    const y = parse(readFileSync(join(root, "roles", "capture-summarizer.yaml"), "utf8")) as {
      limits?: { max_entries?: number; max_ideas?: number; max_questions?: number; max_tokens?: number };
      tools?: Partial<typeof FALLBACK_TOOLS>;
      rules?: string[];
    };
    return {
      limits: {
        maxEntries: y.limits?.max_entries ?? FALLBACK.maxEntries,
        maxIdeas: y.limits?.max_ideas ?? FALLBACK.maxIdeas,
        maxQuestions: y.limits?.max_questions ?? FALLBACK.maxQuestions,
        maxTokens: y.limits?.max_tokens ?? FALLBACK.maxTokens,
      },
      tools: { ...FALLBACK_TOOLS, ...(y.tools ?? {}) },
      rules: y.rules ?? [],
    };
  } catch {
    return { limits: FALLBACK, tools: FALLBACK_TOOLS, rules: [] };
  }
}

// ---- Small text helpers ----
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clipText = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** One line, masked. undefined when a secret-like value is found: that text is dropped, never shown. */
function safe(s: string | undefined, max = 600): string | undefined {
  if (!s) return undefined;
  const t = oneLine(s);
  if (!t) return undefined;
  const m = maskOutgoing(t);
  return m.ok ? clipText(m.text, max) : undefined;
}

// ---- The existing ai-log file (read-only) ----
export interface ExistingLog { exists: boolean; hashes: Set<string>; ids: Set<string>; shas: string[] }

export function parseExistingLog(text: string | null): ExistingLog {
  const out: ExistingLog = { exists: text !== null, hashes: new Set(), ids: new Set(), shas: [] };
  if (text === null) return out;
  for (const m of text.matchAll(/<!--\s*guard-capture:\s*([0-9a-f]+)(?:\s+ids:(\S*))?\s*-->/g)) {
    out.hashes.add(m[1] as string);
    for (const id of (m[2] ?? "").split(",")) if (id) out.ids.add(id);
  }
  // A commit hook may have logged the commit already.
  for (const m of text.matchAll(/\*\*Commit:\*\*([^\n]*)/g)) {
    for (const s of (m[1] as string).matchAll(/\b[0-9a-f]{7,40}\b/gi)) out.shas.push(s[0].toLowerCase());
  }
  return out;
}

function commitLogged(log: ExistingLog, full: string): boolean {
  const s = full.toLowerCase();
  return log.shas.some((x) => s.startsWith(x) || x.startsWith(s));
}

export function logPath(date: string, developer: string): string {
  return `ai-log/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}-${developer}.md`;
}

// ---- Entries ----
export interface Entry {
  ts: string;
  tool: string;
  branch: string;
  what: string;
  why?: string;
  files: string[];
  commit?: string;
  decided?: string;
  correction?: string;
  checks?: string;
  notVerified?: string;
  ideas: string[];
  /** Spool event ids and transcript turn ids this entry rests on. */
  ids: string[];
}

export function entryHash(ids: string[]): string {
  return sha([...ids].sort().join(",")).slice(0, 12);
}

export function renderEntry(e: Entry): string {
  const lines = [`## ${localHM(e.ts)} · ${e.tool} · ${e.branch}`, ""];
  lines.push(`- **What:** ${e.what}`);
  if (e.why) lines.push(`- **Why:** ${e.why}`);
  if (e.files.length) lines.push(`- **Files:** ${e.files.join(", ")}`);
  if (e.commit) lines.push(`- **Commit:** ${e.commit}`);
  if (e.decided) lines.push(`- **Decided:** ${e.decided}`);
  if (e.correction) lines.push(`- **Correction:** ${e.correction}`);
  if (e.checks) lines.push(`- **Checks:** ${e.checks}`);
  if (e.notVerified) lines.push(`- **Not verified:** ${e.notVerified}`);
  if (e.ideas.length) lines.push(`- **Ideas:** ${e.ideas.join("; ")}`);
  lines.push("", `<!-- guard-capture: ${entryHash(e.ids)} ids:${[...e.ids].sort().join(",")} -->`);
  return lines.join("\n");
}

function mostCommon(xs: string[], fallback: string): string {
  const n = new Map<string, number>();
  for (const x of xs) if (x) n.set(x, (n.get(x) ?? 0) + 1);
  let best = fallback;
  let top = 0;
  for (const [k, v] of n) if (v > top) { best = k; top = v; }
  return best;
}

function checksLine(events: CaptureEvent[]): string | undefined {
  const byLabel = new Map<string, string[]>();
  for (const ev of events) {
    let label: string;
    let res: string;
    if (ev.kind === "task") { label = ev.data.name; res = String(ev.data.exitCode); }
    else if (ev.kind === "terminal") { label = ev.data.command; res = String(ev.data.exitCode); }
    else if (ev.kind === "diagnostics") { label = "editor problems"; res = `${ev.data.errors} errors, ${ev.data.warnings} warnings`; }
    else continue;
    const l = safe(label, 80);
    if (!l) continue;
    const arr = byLabel.get(l) ?? [];
    arr.push(res);
    byLabel.set(l, arr);
  }
  const parts: string[] = [];
  for (const [label, res] of byLabel) {
    if (parts.length >= MAX_CHECKS_PER_ENTRY) break;
    const isDiag = label === "editor problems";
    parts.push(`\`${label}\` ${isDiag ? res.join(", then ") : `exit ${res.join(", then ")}`}`);
  }
  return parts.length ? parts.join("; ") : undefined;
}

function filesOf(events: CaptureEvent[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    const paths = ev.kind === "commit" ? ev.data.files.map((f) => f.path) : ev.kind === "save" ? [ev.data.path] : [];
    for (const p of paths) {
      const s = safe(p, 120);
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out.slice(0, MAX_FILES_PER_ENTRY);
}

const WORK_KINDS = new Set(["commit", "save", "task", "terminal", "diagnostics"]);
const isCheck = (ev: CaptureEvent): boolean => ev.kind === "task" || ev.kind === "terminal" || ev.kind === "diagnostics";

// ---- Deterministic draft (no model) ----
export function deterministicEntries(events: CaptureEvent[], tool: string, dayBranch: string): Entry[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const out: Entry[] = [];
  const used = new Set<string>();
  let prev = -Infinity;
  for (const c of sorted.filter((e) => e.kind === "commit")) {
    if (c.kind !== "commit") continue;
    const at = Date.parse(c.ts);
    const checks = sorted.filter((e) => isCheck(e) && !used.has(e.id) && Date.parse(e.ts) > prev && Date.parse(e.ts) <= at);
    for (const k of checks) used.add(k.id);
    used.add(c.id);
    prev = at;
    const what = safe(c.data.subject, 200);
    if (!what) continue;
    const cl = checksLine(checks);
    const body = safe(c.data.body, 240);
    out.push({
      ts: c.ts, tool, branch: c.branch || dayBranch, what, ...(body ? { why: body } : {}),
      files: filesOf([c]), commit: c.data.sha.slice(0, 7).toLowerCase(),
      ...(cl ? { checks: cl } : { notVerified: "No test or build run was recorded before this commit." }),
      ideas: [], ids: [c.id, ...checks.map((k) => k.id)],
    });
  }
  const rest = sorted.filter((e) => isCheck(e) && !used.has(e.id));
  const restLine = checksLine(rest);
  const firstRest = rest[0];
  if (firstRest && restLine) {
    out.push({
      ts: firstRest.ts, tool, branch: firstRest.branch || dayBranch,
      what: `Recorded ${rest.length} build, test or editor ${rest.length === 1 ? "check" : "checks"} (no commit followed).`,
      files: [], checks: restLine, ideas: [], ids: rest.map((e) => e.id),
    });
  }
  for (const ev of sorted) {
    if (ev.kind !== "decision" && ev.kind !== "correction") continue;
    const t = safe(ev.data.text);
    if (!t) continue;
    out.push({
      ts: ev.ts, tool, branch: ev.branch || dayBranch,
      what: ev.kind === "decision" ? "A decision was noted in the editor." : "A correction was noted in the editor.",
      files: [], ...(ev.kind === "decision" ? { decided: t } : { correction: t }), ideas: [], ids: [ev.id],
    });
  }
  const ideas = sorted.filter((e) => e.kind === "idea");
  const firstIdea = ideas[0];
  if (firstIdea) {
    const texts = ideas.map((e) => (e.kind === "idea" ? safe(e.data.text, 200) : undefined)).filter((t): t is string => !!t);
    if (texts.length) {
      out.push({
        ts: firstIdea.ts, tool, branch: firstIdea.branch || dayBranch,
        what: "Ideas for later were noted in the editor.", files: [], ideas: texts, ids: ideas.map((e) => e.id),
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

// ---- Prompt units ----
interface Unit {
  ref: string;
  ids: string[];
  ts: string;
  branch: string;
  origin: "event" | "turn";
  line: string;
  events: CaptureEvent[];
}

function eventLine(ev: CaptureEvent): string {
  const t = localHM(ev.ts);
  switch (ev.kind) {
    case "commit": {
      const files = ev.data.files.slice(0, 8).map((f) => `${f.path} +${f.added}/-${f.removed}`).join(", ");
      const more = ev.data.files.length > 8 ? ` (+${ev.data.files.length - 8} more)` : "";
      return `${t} commit ${ev.data.sha.slice(0, 7)} [${ev.branch}] "${clipText(oneLine(ev.data.subject), MAX_ITEM_CHARS)}"` +
        (ev.data.body ? ` body: "${clipText(oneLine(ev.data.body), MAX_ITEM_CHARS)}"` : "") + ` files: ${files}${more}`;
    }
    case "task": return `${t} task "${ev.data.name}" exit ${ev.data.exitCode} in ${Math.round(ev.data.ms / 1000)} s`;
    case "terminal": return `${t} command \`${ev.data.command}\` exit ${ev.data.exitCode} in ${Math.round(ev.data.ms / 1000)} s`;
    case "diagnostics": return `${t} editor problems: ${ev.data.errors} errors, ${ev.data.warnings} warnings in ${ev.data.files} files`;
    case "idea": return `${t} idea: "${clipText(oneLine(ev.data.text), MAX_ITEM_CHARS)}"`;
    case "decision": return `${t} decision: "${clipText(oneLine(ev.data.text), MAX_ITEM_CHARS)}"`;
    case "correction": return `${t} correction from developer: "${clipText(oneLine(ev.data.text), MAX_ITEM_CHARS)}"`;
    case "chat": return `${t} asked Guard: "${clipText(oneLine(ev.data.question), MAX_ITEM_CHARS)}" (answer: ${clipText(oneLine(ev.data.answer), 200)})`;
    case "save": return `${t} save ${ev.data.path}`;
  }
}

function buildEventUnits(events: CaptureEvent[]): { units: Unit[]; blocked: number } {
  const units: Unit[] = [];
  let blocked = 0;
  const saves = new Map<string, CaptureEvent[]>();
  for (const ev of events) {
    if (ev.kind === "save") {
      const arr = saves.get(ev.data.path) ?? [];
      arr.push(ev);
      saves.set(ev.data.path, arr);
    }
  }
  const doneSave = new Set<string>();
  let n = 0;
  for (const ev of events) {
    let group: CaptureEvent[] = [ev];
    let line = eventLine(ev);
    if (ev.kind === "save") {
      if (doneSave.has(ev.data.path)) continue;
      doneSave.add(ev.data.path);
      group = saves.get(ev.data.path) ?? [ev];
      const total = group.reduce((a, e) => a + (e.kind === "save" ? e.data.count : 0), 0);
      const last = group[group.length - 1] as CaptureEvent;
      line = `${localHM(ev.ts)}-${localHM(last.ts)} saved ${ev.data.path} (${total} saves)`;
    }
    const m = maskOutgoing(line);
    if (!m.ok) { blocked++; continue; }
    units.push({
      ref: `E${++n}`, ids: group.map((e) => e.id), ts: ev.ts, branch: ev.branch, origin: "event", line: m.text, events: group,
    });
  }
  return { units, blocked };
}

/** Owner prompts and assistant final answers for one local day, masked, within the budget. */
export function transcriptTurns(
  repoPath: string, date: string, sessionsRoot?: string,
): { turns: (Turn & { id: string })[]; blocked: number } {
  const dir = findSessionDir(repoPath, sessionsRoot);
  if (!dir) return { turns: [], blocked: 0 };
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const since = new Date(y, m - 1, d).toISOString();
  const all = readSessions(dir, { since }).turns
    .filter((t) => t.ts && localDate(new Date(t.ts)) === date)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  // An assistant final answer is the last assistant text before the next owner turn.
  const kept: Turn[] = [];
  for (let i = 0; i < all.length; i++) {
    const t = all[i] as Turn;
    if (t.role === "assistant" && all[i + 1]?.role === "assistant" && all[i + 1]?.session === t.session) continue;
    kept.push(t);
  }
  const picked: (Turn & { id: string })[] = [];
  let used = 0;
  let blocked = 0;
  for (let i = kept.length - 1; i >= 0 && picked.length < MAX_TURNS; i--) {
    const t = kept[i] as Turn;
    const text = clipText(oneLine(t.text), t.role === "user" ? MAX_OWNER_TURN_CHARS : MAX_ASSISTANT_TURN_CHARS);
    const mk = maskOutgoing(text);
    if (!mk.ok) { blocked++; continue; }
    if (used + mk.text.length > MAX_TURN_BUDGET_CHARS) break;
    used += mk.text.length;
    picked.push({ ...t, text: mk.text, id: `t-${sha(`${t.session}|${t.ts}|${t.role}`).slice(0, 8)}` });
  }
  return { turns: picked.reverse(), blocked };
}

// ---- Model reply ----
const Short = z.string().transform((s) => clipText(oneLine(s), 400));
const ReplySchema = z.object({
  entries: z.array(z.object({
    cites: z.array(z.string()).default([]),
    what: Short,
    why: Short.optional(),
    decided: Short.optional(),
    correction: Short.optional(),
    notVerified: Short.optional(),
    ideas: z.array(Short).optional(),
  })).default([]),
  ideas: z.array(Short).default([]),
  questions: z.array(Short).default([]),
});

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new CaptureError("The model reply had no JSON object.");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new CaptureError("The model reply was not valid JSON.");
  }
}

export function buildPrompt(role: Role, date: string, developer: string, units: Unit[]): { system: string[]; user: string } {
  const rules = role.rules.map((r) => `- ${r}`).join("\n");
  const stable =
    `You are the capture summarizer for SPIL AURA QA Bot. You turn one developer's day into draft ai-log entries.\n\nRules:\n${rules}\n\n` +
    `Reply with JSON: {"entries": [{"cites": string[], "what": string, "why"?: string, "decided"?: string, ` +
    `"correction"?: string, "notVerified"?: string, "ideas"?: string[]}], "ideas": string[], "questions": string[]}. ` +
    `At most ${role.limits.maxEntries} entries, ${role.limits.maxIdeas} ideas and ${role.limits.maxQuestions} questions. ` +
    `Files, commit ids, times and check results are added by code from the cited items; do not write them.`;
  const lines = [`Date: ${date}`, `Developer: ${developer}`];
  const ev = units.filter((u) => u.origin === "event");
  const tu = units.filter((u) => u.origin === "turn");
  lines.push("", "Editor events (cite by ref):", ...(ev.length ? ev.map((u) => `${u.ref} ${u.line}`) : ["(none)"]));
  lines.push("", "Claude Code turns (cite by ref):", ...(tu.length ? tu.map((u) => `${u.ref} ${u.line}`) : ["(none)"]));
  return { system: [stable], user: lines.join("\n") };
}

// ---- The summary ----
export interface SummarizeOptions {
  repoPath: string;
  date?: string;
  noModel?: boolean;
  spoolDir?: string;
  sessionsRoot?: string;
  now?: Date;
}
export interface SummarizeDeps { complete?: CompleteFn; backendUsed?: () => string | null }

export interface SummaryResult {
  date: string;
  file: string;
  draft: string;
  entries: number;
  commits: number;
  ideas: string[];
  questions: string[];
  sources: { events: number; transcriptTurns: number };
  /** The backend id that answered, or "none". */
  backend: string;
  /** Count of proposed vault notes written on this machine. */
  notes: number;
  /** Plain words when the model could not be used and the draft is the no-model one. */
  fallback?: string;
}

function readLog(repoPath: string, rel: string): string | null {
  const file = join(repoPath, ...rel.split("/"));
  try {
    if (!existsSync(file)) return null;
    if (statSync(file).size > MAX_LOG_BYTES) return "";
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function requireConsent(dir: string, repoPath: string): { repoKey: string; developer: string } {
  const repoKey = repoKeyFor(repoPath);
  const consent = readConsent(dir);
  if (!consent || !hasConsentFor(consent, repoKey)) {
    throw new CaptureError("Capture is not switched on for this workspace. Turn it on in the editor first.");
  }
  return { repoKey, developer: consent.developer };
}

export async function summarizeDay(cfg: GuardConfig, opts: SummarizeOptions, deps: SummarizeDeps = {}): Promise<SummaryResult> {
  const now = opts.now ?? new Date();
  const today = localDate(now);
  const date = opts.date ?? today;
  if (!isRealDate(date)) throw new CaptureError("The date must look like 2026-11-20.");
  const dir = opts.spoolDir ?? spoolDir();
  const ccfg = loadCaptureConfig(cfg.root);
  pruneRetention(dir, ccfg, now);
  const { repoKey, developer } = requireConsent(dir, opts.repoPath);
  const role = loadRole(cfg.root);

  const { events: dayEvents } = readDay(dir, repoKey, date, ccfg);
  const file = logPath(date, developer);
  const logText = readLog(opts.repoPath, file);
  const log = parseExistingLog(logText);

  // Side effect, local only: decisions and corrections become proposed notes in this machine's vault.
  const notes = proposeChoiceNotes(cfg.vaultDir, dayEvents, today).written.length;

  const fresh = dayEvents.filter((e) => !log.ids.has(e.id) && !(e.kind === "commit" && commitLogged(log, e.data.sha)));
  // The no-model draft uses editor events only; transcripts are read only when a model will see them.
  const t = opts.noModel ? { turns: [], blocked: 0 } : transcriptTurns(opts.repoPath, date, opts.sessionsRoot);
  const freshTurns = t.turns.filter((x) => !log.ids.has(x.id));
  const dayBranch = mostCommon(dayEvents.map((e) => e.branch), "unknown");

  let entries: Entry[] = [];
  let ideas: string[] = [];
  let questions: string[] = [];
  let backend: SummaryResult["backend"] = "none";
  let fallback: string | undefined;

  const wantModel = !opts.noModel && !!deps.complete && (fresh.length > 0 || freshTurns.length > 0);
  if (wantModel) {
    const { units: evUnits } = buildEventUnits(fresh);
    const turnUnits: Unit[] = freshTurns.map((x, i) => ({
      ref: `T${i + 1}`, ids: [x.id], ts: x.ts, branch: "", origin: "turn", events: [],
      line: `${localHM(x.ts)} ${x.role === "user" ? "owner" : "assistant answer"}: ${x.text}`,
    }));
    // Stay inside the prompt budget: keep units in order until it is full.
    const units: Unit[] = [];
    let size = 0;
    for (const u of [...evUnits, ...turnUnits]) {
      if (size + u.line.length > MAX_PROMPT_CHARS) continue;
      size += u.line.length + 6;
      units.push(u);
    }
    const byRef = new Map(units.map((u) => [u.ref, u]));
    const p = buildPrompt(role, date, developer, units);
    try {
      const res = await (deps.complete as CompleteFn)({
        role: "capture-summarizer", system: p.system, user: p.user, maxTokens: role.limits.maxTokens,
      });
      const used = deps.backendUsed?.();
      backend = used ?? "none";
      const parsed = ReplySchema.safeParse(extractJson(res.text));
      if (!parsed.success) throw new CaptureError("The model reply did not match the expected shape.");
      for (const r of parsed.data.entries.slice(0, role.limits.maxEntries)) {
        const cited = [...new Set(r.cites)].map((c) => byRef.get(c.trim().toUpperCase())).filter((u): u is Unit => !!u);
        if (cited.length === 0) continue; // never invent: no real source, no entry
        const evs = cited.flatMap((u) => u.events);
        const origins = new Set(cited.map((u) => u.origin));
        const tool = origins.size === 2 ? role.tools.both : origins.has("event") ? role.tools.events : role.tools.transcript;
        const what = safe(r.what, 300);
        if (!what) continue;
        const commits = evs.filter((e) => e.kind === "commit");
        const commitText = commits.length
          ? commits.map((c) => (c.kind === "commit" ? c.data.sha.slice(0, 7).toLowerCase() : "")).join(", ")
          : evs.some((e) => WORK_KINDS.has(e.kind)) ? "not committed" : undefined;
        const why = safe(r.why);
        const decided = safe(r.decided);
        const correction = safe(r.correction);
        const nv = safe(r.notVerified);
        const checks = checksLine(evs);
        const eIdeas = (r.ideas ?? []).map((x) => safe(x, 200)).filter((x): x is string => !!x);
        const ts = cited.map((u) => u.ts).sort((a, b) => Date.parse(a) - Date.parse(b))[0] as string;
        entries.push({
          ts, tool, branch: mostCommon(cited.map((u) => u.branch), dayBranch), what,
          ...(why ? { why } : {}), files: filesOf(evs),
          ...(commitText ? { commit: commitText } : {}),
          ...(decided ? { decided } : {}), ...(correction ? { correction } : {}),
          ...(checks ? { checks } : {}), ...(nv ? { notVerified: nv } : {}),
          ideas: eIdeas, ids: cited.flatMap((u) => u.ids),
        });
      }
      ideas = parsed.data.ideas.map((x) => safe(x, 200)).filter((x): x is string => !!x);
      questions = parsed.data.questions.map((x) => safe(x, 200)).filter((x): x is string => !!x).slice(0, role.limits.maxQuestions);
      // Commits, decisions, corrections and ideas the model left out are added without it.
      const covered = new Set(entries.flatMap((e) => e.ids));
      const left = fresh.filter((e) => ["commit", "decision", "correction", "idea"].includes(e.kind) && !covered.has(e.id));
      entries.push(...deterministicEntries(left, role.tools.events, dayBranch));
    } catch (e) {
      if (e instanceof CaptureError) throw e;
      const name = e instanceof Error ? e.name : "";
      if (["MissingKeyError", "NoBackendError", "ApiError", "CliError"].includes(name)) {
        fallback = `The model could not be used (${e instanceof Error ? e.message : name}). This draft was built without it.`;
        entries = [];
        backend = "none";
      } else throw e;
    }
  }
  if (!wantModel || fallback) {
    entries = deterministicEntries(fresh, role.tools.events, dayBranch);
  }

  // Skip what the file already holds, then order oldest first.
  entries = entries
    .filter((e) => !log.hashes.has(entryHash(e.ids)))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const e of entries) ideas.push(...e.ideas);
  for (const ev of fresh) if (ev.kind === "idea") { const s = safe(ev.data.text, 200); if (s) ideas.push(s); }
  ideas = [...new Set(ideas)].slice(0, role.limits.maxIdeas);

  const body = entries.map(renderEntry).join("\n\n");
  const head = log.exists || entries.length === 0 ? "" : `# ${date} · ${developer}\n\n`;
  const draft = entries.length ? `${head}${body}\n` : "";
  const commitIds = new Set(entries.flatMap((e) => e.ids));
  return {
    date, file, draft,
    entries: entries.length,
    commits: fresh.filter((e) => e.kind === "commit" && commitIds.has(e.id)).length,
    ideas, questions,
    sources: { events: fresh.length, transcriptTurns: freshTurns.length },
    backend, notes, ...(fallback ? { fallback } : {}),
  };
}
