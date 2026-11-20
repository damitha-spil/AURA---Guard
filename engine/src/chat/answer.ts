// The chat answer pipeline: find sources, ask the model once, keep only real citations.
// Every model call goes through the injected `complete` (createBrain), which masks the text,
// blocks secrets and audits. This module never talks to a model by itself.

import { PRODUCT_SHORT } from "../brand.ts";
import type { Db } from "../index/db.ts";
import { getDoc, search } from "../index/search.ts";
import { coChanged } from "../index/cochange.ts";
import { historyFor } from "../index/history.ts";
import { blastRadius } from "../index/graph.ts";
import type { GuardConfig } from "../types.ts";
import type { CompleteFn } from "../brain/client.ts";
import { ApiError, BlockedError, MissingKeyError } from "../brain/client.ts";
import { CliError } from "../brain/backends.ts";
import { NoBackendError } from "../brain/select.ts";

// Token budget (about 4 characters per token): the sources block stays under roughly 5,000 tokens
// and the conversation under 2,000, so one answer is cheap and the stable rules stay cached.
export const MAX_NOTE_SOURCES = 5;
export const MAX_OTHER_SOURCES = 3;
export const MAX_DOC_CHARS = 2500;
export const MAX_SNIPPET_CHARS = 1000;
export const MAX_SOURCES_CHARS = 20_000;
export const MAX_HISTORY_TURNS = 6;
export const MAX_TURN_CHARS = 1500;
export const MAX_QUESTION_CHARS = 4000;
export const MAX_CONTEXT_PATHS = 2;
export const MAX_CONTEXT_ROWS = 8;
export const ANSWER_MAX_TOKENS = 900;

export const RULES = [
  "You are SPIL Quality Support Bot's chat, an internal engineering assistant for the Aura product.",
  "Rules:",
  "- Answer only from the sources provided below. Do not use outside knowledge about this codebase.",
  "- Cite sources as [ref], using the exact ref shown for each source. Never invent a ref.",
  "- If the sources do not answer the question, say plainly that you do not know. Do not guess.",
  "- A source marked UNAPPROVED is a proposed note that the owner has not approved yet. Say so when you rely on it.",
  "- Never suggest writing to the ERP or giving the AI an ERP create tool.",
  "- Use plain words. Keep the answer short.",
].join("\n");

/** The rules text for a department. The plain default config keeps the original first line. */
export function rulesFor(cfg: GuardConfig): string {
  if (!cfg.departmentName || cfg.departmentId === "default") return RULES;
  const first = `You are ${PRODUCT_SHORT}, an internal assistant for the ${cfg.departmentName} department. Use only this department's knowledge.`;
  return first + RULES.slice(RULES.indexOf("\n"));
}

export interface ChatTurn { role: "user" | "assistant"; text: string }

export interface ChatSource {
  ref: string;
  kind: "note" | "commit" | "file" | "context";
  title: string;
  status: string | null;
  /** Only for kind "context": the text itself, because it has no stored document. */
  text?: string;
}

export interface AnswerResult {
  ok: boolean;
  text: string;
  sources: ChatSource[];
  /** Set when ok is false: which kind of failure, for the screen. */
  error?: "blocked" | "no-key" | "no-backend" | "api" | "cli";
  blockedKinds?: { kind: string; count: number }[];
}

export interface AnswerInput { history: ChatTurn[]; question: string; /** Only vault notes may be used as sources. */ notesOnly?: boolean }

/** One real thing the pipeline did. The screen shows these live; nothing here is a timer or a guess. */
export type StepKind = "search" | "found" | "context" | "model" | "verify" | "done";
export interface Step {
  /** Same id again updates the same row (running, then done). */
  id: StepKind;
  kind: StepKind;
  status: "running" | "done" | "error";
  label: string;
  detail?: string;
  /** Milliseconds since this step started; set when it ends. */
  ms?: number;
}
export interface AnswerDeps {
  complete: CompleteFn;
  /** Called synchronously as each step starts or ends. A throwing callback never breaks the answer. */
  onStep?: (step: Step) => void;
  /** Friendly name of the backend that will be asked, e.g. "Claude plan". */
  backend?: string;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "..." : s);

interface Collected { sources: ChatSource[]; blocks: string[] }

/** Paths in a question that the index really knows, as {repo, path}. */
export function pathsInQuestion(db: Db, question: string): { repo: string; path: string }[] {
  const cands = new Set((question.match(/[\w@.-]+(?:[\\/][\w@.-]+)+|[\w-]+\.[a-z]{1,5}\b/gi) ?? []).map((p) => p.replace(/\\/g, "/")));
  const found: { repo: string; path: string }[] = [];
  const q = db.prepare("SELECT repo, path FROM commit_files WHERE path=? LIMIT 1");
  for (const c of cands) {
    const r = q.get(c) as { repo: string; path: string } | undefined;
    if (r) found.push(r);
    if (found.length >= MAX_CONTEXT_PATHS) break;
  }
  return found;
}

export function collect(db: Db, question: string, notesOnly = false): Collected {
  const sources: ChatSource[] = [];
  const blocks: string[] = [];
  let used = 0;
  const seen = new Set<string>();
  const add = (s: ChatSource, text: string): void => {
    if (seen.has(s.ref) || used + text.length > MAX_SOURCES_CHARS) return;
    seen.add(s.ref);
    used += text.length;
    sources.push(s);
    blocks.push(text);
  };

  for (const h of search(db, question, { audience: "internal_dev", limit: MAX_NOTE_SOURCES, kinds: ["note"] })) {
    const doc = getDoc(db, h.ref, "internal_dev");
    const body = clip(doc?.body ?? h.snippet, MAX_DOC_CHARS);
    const label = h.status && h.status !== "active" ? `note, status ${h.status}${h.status === "proposed" ? ", UNAPPROVED" : ""}` : "note";
    add({ ref: h.ref, kind: "note", title: h.title, status: h.status ?? null }, `[${h.ref}] (${label}) ${h.title}\n${body}`);
  }
  if (notesOnly) return { sources, blocks };
  for (const h of search(db, question, { audience: "internal_dev", limit: MAX_OTHER_SOURCES, kinds: ["commit", "file"] })) {
    add({ ref: h.ref, kind: h.kind, title: h.title, status: null }, `[${h.ref}] (${h.kind}) ${h.title}\n${clip(h.snippet, MAX_SNIPPET_CHARS)}`);
  }
  for (const { repo, path } of pathsInQuestion(db, question)) {
    const lines: string[] = [];
    const co = coChanged(db, repo, path, MAX_CONTEXT_ROWS);
    if (co.length) lines.push("Often changed together:", ...co.map((r) => `  ${r.path} (${r.together}x, ${Math.round(r.ratio * 100)}%)`));
    const hist = historyFor(db, repo, path, MAX_CONTEXT_ROWS);
    if (hist.length) lines.push("Recent commits:", ...hist.map((r) => `  ${repo}@${r.sha} ${r.date.slice(0, 10)} ${r.subject}`));
    try {
      const blast = blastRadius(db, repo, path).slice(0, MAX_CONTEXT_ROWS);
      if (blast.length) lines.push("Code that depends on it:", ...blast.map((r) => `  ${r.path || r.id} (${r.label})`));
    } catch { /* the graph tables may not exist yet */ }
    if (!lines.length) continue;
    const ref = `context:${repo}:${path}`;
    const text = lines.join("\n");
    add({ ref, kind: "context", title: `History and links for ${repo}:${path}`, status: null, text }, `[${ref}] (context) ${repo}:${path}\n${text}`);
  }
  return { sources, blocks };
}

/** Removes [ref]-shaped citations that are not in the provided sources. */
export function stripInvented(text: string, refs: Set<string>): string {
  return text
    .replace(/\[([^\[\]\n]{1,200})\](?!\()/g, (m, inner: string) => {
      if (refs.has(inner)) return m;
      const refLike = !/\s/.test(inner) && /[-@:/.]/.test(inner);
      return refLike ? "" : m;
    })
    .replace(/[ \t]+([.,;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "");
}

export function describeError(e: unknown): Pick<AnswerResult, "text" | "error" | "blockedKinds"> | null {
  if (e instanceof BlockedError) {
    const kinds = e.blocked.map((b) => `${b.kind} x${b.count}`).join(", ");
    return {
      text: `Your message looks like it contains a secret (${kinds}). Nothing was sent. Remove it and ask again.`,
      error: "blocked",
      blockedKinds: e.blocked,
    };
  }
  if (e instanceof MissingKeyError) return { text: e.message, error: "no-key" };
  if (e instanceof NoBackendError) return { text: e.message, error: "no-backend" };
  if (e instanceof ApiError) return { text: e.message, error: "api" };
  if (e instanceof CliError) return { text: e.message, error: "cli" };
  return null;
}

export const NOTHING_FOUND = "I could not find anything about that in the vault or the indexed code, so I do not know. Try other words, or run /index if the index is old.";

const CITATION = /\[([^\[\]\n]{1,200})\](?!\()/g;
/** How many [ref]-shaped citations a text holds. */
export function countCitations(text: string): number {
  return [...text.matchAll(CITATION)].length;
}

const KIND_WORD: Record<string, [string, string]> = { note: ["note", "notes"], commit: ["commit", "commits"], file: ["file", "files"] };
/** "6 sources: 3 notes, 2 commits, 1 file". Context blocks are counted in their own step. */
export function describeFound(sources: ChatSource[]): string {
  const n = sources.filter((s) => s.kind !== "context").length;
  const parts: string[] = [];
  for (const kind of ["note", "commit", "file"]) {
    const c = sources.filter((s) => s.kind === kind).length;
    const w = KIND_WORD[kind] as [string, string];
    if (c) parts.push(`${c} ${c === 1 ? w[0] : w[1]}`);
  }
  return n ? `${n} ${n === 1 ? "source" : "sources"}: ${parts.join(", ")}` : "No sources";
}

export async function answer(_cfg: GuardConfig, db: Db, input: AnswerInput, deps: AnswerDeps): Promise<AnswerResult> {
  const question = input.question.trim().slice(0, MAX_QUESTION_CHARS);
  const emit = (step: Step): void => {
    try { deps.onStep?.(step); } catch { /* a broken listener must not break the answer */ }
  };
  const t0 = Date.now();
  emit({ id: "search", kind: "search", status: "running", label: input.notesOnly ? "Searching vault notes" : "Searching notes, commits and files" });
  const { sources, blocks } = collect(db, question, input.notesOnly === true);
  emit({ id: "search", kind: "search", status: "done", label: input.notesOnly ? "Searched vault notes" : "Searched notes, commits and files", ms: Date.now() - t0 });
  emit({ id: "found", kind: "found", status: "done", label: describeFound(sources), ms: 0 });
  if (sources.length === 0) {
    emit({ id: "done", kind: "done", status: "done", label: "Nothing found", ms: Date.now() - t0 });
    return { ok: true, text: NOTHING_FOUND, sources: [] };
  }
  const ctx = sources.filter((s) => s.kind === "context");
  if (ctx.length) {
    emit({ id: "context", kind: "context", status: "done", label: `Read history and links for ${ctx.length} ${ctx.length === 1 ? "path" : "paths"}`, detail: ctx.map((c) => c.title).join("; "), ms: 0 });
  }

  const turns = input.history.slice(-MAX_HISTORY_TURNS)
    .map((t) => `${t.role === "user" ? "User" : "Guard"}: ${clip(t.text, MAX_TURN_CHARS)}`);
  const user = (turns.length ? `Earlier in this chat:\n${turns.join("\n")}\n\n` : "") + `Question: ${question}`;
  const backend = deps.backend ?? "the model";
  const tm = Date.now();
  emit({ id: "model", kind: "model", status: "running", label: `Asking ${backend}` });
  try {
    const r = await deps.complete({
      role: "chat",
      system: [rulesFor(_cfg), "Sources:\n\n" + blocks.join("\n\n---\n\n")],
      user,
      maxTokens: ANSWER_MAX_TOKENS,
    });
    emit({ id: "model", kind: "model", status: "done", label: `${backend} answered in ${((Date.now() - tm) / 1000).toFixed(1)} s`, ms: Date.now() - tm });
    const raw = r.text.trim();
    const text = stripInvented(raw, new Set(sources.map((s) => s.ref)));
    const dropped = Math.max(0, countCitations(raw) - countCitations(text));
    const keptRefs = sources.filter((s) => text.includes(`[${s.ref}]`)).length;
    emit({ id: "verify", kind: "verify", status: "done", label: `Checked citations: ${keptRefs} kept, ${dropped} dropped`, ms: 0 });
    emit({ id: "done", kind: "done", status: "done", label: "Done", ms: Date.now() - t0 });
    // Only sources the answer actually cites are shown as chips; if none are cited, show all that were given.
    const cited = sources.filter((s) => text.includes(`[${s.ref}]`));
    return { ok: true, text, sources: cited.length ? cited : sources };
  } catch (e) {
    const d = describeError(e);
    emit({ id: "model", kind: "model", status: "error", label: d?.error === "blocked" ? "Stopped: the message looked like a secret" : "Could not get an answer", ms: Date.now() - tm });
    if (!d) throw e;
    return { ok: false, sources: [], ...d };
  }
}
