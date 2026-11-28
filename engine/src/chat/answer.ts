// The chat answer pipeline: decide whether project sources are needed, ask the model once, keep only
// real citations. Every model call goes through the injected `complete` (createBrain), which masks the
// text, blocks secrets and audits. This module never talks to a model by itself.

import type { Db } from "../index/db.ts";
import { getDoc, search } from "../index/search.ts";
import { coChanged } from "../index/cochange.ts";
import { historyFor } from "../index/history.ts";
import { blastRadius } from "../index/graph.ts";
import type { GuardConfig } from "../types.ts";
import type { CompleteFn } from "../brain/client.ts";
import { ApiError, BlockedError, CancelledError, MissingKeyError } from "../brain/client.ts";
import { CliError } from "../brain/backends.ts";
import { NoBackendError } from "../brain/select.ts";
import { maskOutgoing } from "../mask/mask.ts";
import { markThreats } from "./threat-scan.ts";
import {
  buildPrompt, generalRules, identityBlock, isRelevant, meaningfulWords, mentionsProject, MAX_HISTORY_TURNS, MAX_SOURCES_CHARS, MAX_TURN_CHARS,
  NOTES_RULES, shouldRetrieve, UNTRUSTED_MARK, UNTRUSTED_RULE,
} from "./prompt.ts";
import type { AttachmentsInput, ChatTurn } from "./prompt.ts";
import type { CreatedItem } from "./follow-through.ts";

// Retrieval limits. Prompt sizes (per backend) live in prompt.ts.
export const MAX_NOTE_SOURCES = 5;
export const MAX_OTHER_SOURCES = 3;
export const MAX_DOC_CHARS = 2500;
export const MAX_SNIPPET_CHARS = 1000;
export { MAX_SOURCES_CHARS, MAX_HISTORY_TURNS, MAX_TURN_CHARS, UNTRUSTED_MARK, UNTRUSTED_RULE };
export type { ChatTurn };
export const MAX_QUESTION_CHARS = 4000;
export const MAX_CONTEXT_PATHS = 2;
export const MAX_CONTEXT_ROWS = 8;
/**
 * The most a model may write in one answer. A ceiling, not a target: only tokens used are paid for.
 * 900 cut longer explanations off mid-sentence; 3,000 fits a long answer and still bounds the worst case.
 */
export const ANSWER_MAX_TOKENS = 3000;

/** Strict rules, used by Notes only. */
export const RULES = NOTES_RULES;

/** The rules text for the one project (strict, Notes only). */
export function rulesFor(_cfg: GuardConfig): string {
  return NOTES_RULES;
}

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
  error?: "blocked" | "no-key" | "no-backend" | "api" | "cli" | "cancelled";
  blockedKinds?: { kind: string; count: number }[];
  /** Items agent mode created in REO's own data for this answer (follow-ups, notes, defect drafts). */
  created?: CreatedItem[];
  /** A clarifying question with clickable choices; the answer text is the question. */
  needsInput?: { question: string; options: { id: string; label: string; value: string }[] };
}

export interface AnswerInput {
  history: ChatTurn[];
  question: string;
  /** Only vault notes may be used as sources. */
  notesOnly?: boolean;
  /** Files attached to this message and to earlier ones in the chat. */
  attachments?: AttachmentsInput;
}

/** One real thing the pipeline did. The screen shows these live; nothing here is a timer or a guess. */
export type StepKind = "search" | "found" | "context" | "model" | "verify" | "done"
  // Steps of a sub-agent (the QA agent): see engine/src/qa/agent.ts.
  | "understand" | "target" | "design" | "safety" | "run" | "report";
export interface Step {
  /** Same id again updates the same row (running, then done). */
  id: StepKind | `a${number}`;
  kind: StepKind;
  status: "running" | "done" | "error";
  label: string;
  detail?: string;
  /** Milliseconds since this step started; set when it ends. */
  ms?: number;
  /** Which sub-agent did this step ("qa"); absent for the normal answer pipeline. */
  agent?: string;
}
export interface AnswerDeps {
  complete: CompleteFn;
  /** Called synchronously as each step starts or ends. A throwing callback never breaks the answer. */
  onStep?: (step: Step) => void;
  /** Friendly name of the backend that will be asked, e.g. "Claude plan". */
  backend?: string;
  /** Id of the picked backend (for example "antigravity-cli"); it sets the prompt size. */
  backendId?: string | null;
  /**
   * Agent mode: when set, this runs instead of the single model call, with the prompt built here (rules,
   * identity, files, history, sources). See agent-loop.ts. Never used by Notes only.
   */
  agent?: (a: { system: string[]; user: string; sources: ChatSource[] }) => Promise<AnswerResult>;
  /** The Memory block for the system prompt (chat/memory.ts). Never used by Notes only. */
  memory?: string;
  /** The picked skill's instructions (agent mode only). */
  skill?: string;
  /** Aborts the model call in flight (the Stop button). */
  signal?: AbortSignal;
  /** Streams answer text (already unmasked, never half a placeholder) while the model writes it. The final result still carries the whole checked text. */
  onText?: (delta: string) => void;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "..." : s);

/** `withheld` lists sources left out of the prompt because their text looked like a secret. */
interface Collected { sources: ChatSource[]; blocks: string[]; withheld: string[] }

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

/**
 * Finds project sources. With `relevantOnly`, a hit is kept only when it shares topic words with the
 * question (see isRelevant): the search itself returns the closest documents even when none is close.
 */
export function collect(db: Db, question: string, notesOnly = false, relevantOnly = false): Collected {
  const sources: ChatSource[] = [];
  const blocks: string[] = [];
  const withheld: string[] = [];
  let used = 0;
  const seen = new Set<string>();
  const words = meaningfulWords(question);
  const named = mentionsProject(question);
  const add = (s: ChatSource, text: string, haystack: string): void => {
    if (seen.has(s.ref) || used + text.length > MAX_SOURCES_CHARS) return;
    if (relevantOnly && !isRelevant(words, named, `${s.title} ${haystack}`)) return;
    // A retrieved source that looks like it holds a secret is left out of the prompt. The question
    // must still be answerable from the rest; one odd note must never block the whole call.
    if (!maskOutgoing(text).ok) {
      seen.add(s.ref);
      withheld.push(s.ref);
      return;
    }
    seen.add(s.ref);
    used += text.length;
    sources.push(s);
    // A source that tries to instruct the model is marked as data, not dropped.
    blocks.push(markThreats(text, `the source ${s.ref}`).text);
  };

  for (const h of search(db, question, { audience: "internal_dev", limit: MAX_NOTE_SOURCES, kinds: ["note"] })) {
    const doc = getDoc(db, h.ref, "internal_dev");
    const body = clip(doc?.body ?? h.snippet, MAX_DOC_CHARS);
    const label = h.status && h.status !== "active" ? `note, status ${h.status}${h.status === "proposed" ? ", UNAPPROVED" : ""}` : "note";
    add({ ref: h.ref, kind: "note", title: h.title, status: h.status ?? null }, `[${h.ref}] (${label}) ${h.title}\n${body}`, body);
  }
  if (notesOnly) return { sources, blocks, withheld };
  for (const h of search(db, question, { audience: "internal_dev", limit: MAX_OTHER_SOURCES, kinds: ["commit", "file"] })) {
    add({ ref: h.ref, kind: h.kind, title: h.title, status: null }, `[${h.ref}] (${h.kind}) ${h.title}\n${clip(h.snippet, MAX_SNIPPET_CHARS)}`, h.snippet);
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
    // A path the person typed is relevant by definition.
    if (seen.has(ref) || used + text.length > MAX_SOURCES_CHARS) continue;
    if (!maskOutgoing(text).ok) { seen.add(ref); withheld.push(ref); continue; }
    seen.add(ref);
    used += text.length;
    sources.push({ ref, kind: "context", title: `History and links for ${repo}:${path}`, status: null, text });
    blocks.push(`[${ref}] (context) ${repo}:${path}\n${text}`);
  }
  return { sources, blocks, withheld };
}

// A citation is [ref] not glued to a word or bracket before it, so code such as a[-1] or list[0:5] stays.
const CITATION = /([ \t]*)(?<![\w\])])\[([^\[\]\n]{1,200})\](?!\()/g;

/** Removes [ref]-shaped citations that are not in the provided sources. */
export function stripInvented(text: string, refs: Set<string>): string {
  return text
    .replace(CITATION, (m, space: string, inner: string) => {
      if (refs.has(inner)) return m;
      const refLike = !/\s/.test(inner) && /[-@:/.]/.test(inner);
      return refLike ? "" : m;
    })
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
  if (e instanceof CancelledError) return { text: "Stopped.", error: "cancelled" };
  if (e instanceof MissingKeyError) return { text: e.message, error: "no-key" };
  if (e instanceof NoBackendError) return { text: e.message, error: "no-backend" };
  if (e instanceof ApiError) return { text: e.message, error: "api" };
  if (e instanceof CliError) return { text: e.message, error: "cli" };
  return null;
}

export const NOTHING_FOUND = "I could not find anything about that in the vault or the indexed code, so I do not know. Try other words, or run /index if the index is old.";

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

/** Asked when the person attaches files and types nothing. */
export const DEFAULT_FILE_QUESTION = "Please read the attached file(s) and tell me what they are and what they contain.";

export async function answer(_cfg: GuardConfig, db: Db, input: AnswerInput, deps: AnswerDeps): Promise<AnswerResult> {
  const typed = input.question.trim().slice(0, MAX_QUESTION_CHARS);
  const question = typed || DEFAULT_FILE_QUESTION;
  const notesOnly = input.notesOnly === true;
  const emit = (step: Step): void => {
    try { deps.onStep?.(step); } catch { /* a broken listener must not break the answer */ }
  };
  const t0 = Date.now();
  // Notes only is strict: attached files are not sent, and the user is told.
  const attachments = notesOnly ? undefined : input.attachments;
  const notes: string[] = [];
  if (notesOnly && (input.attachments?.current.length ?? 0) > 0) notes.push("Notes only is on, so the attached files were not sent to the model.");
  const hasCurrent = (attachments?.current.length ?? 0) > 0;

  // Sources are looked up when the message has a topic of its own (see shouldRetrieve). Notes only always looks.
  const retrieve = notesOnly || shouldRetrieve(typed, hasCurrent);
  let found: Collected = { sources: [], blocks: [], withheld: [] };
  if (retrieve) {
    emit({ id: "search", kind: "search", status: "running", label: notesOnly ? "Searching vault notes" : "Searching notes, commits and files" });
    found = collect(db, typed, notesOnly, !notesOnly);
    emit({ id: "search", kind: "search", status: "done", label: notesOnly ? "Searched vault notes" : "Searched notes, commits and files", ms: Date.now() - t0 });
  }
  emit({
    id: "found", kind: "found", status: "done", ms: 0,
    label: retrieve ? describeFound(found.sources) : hasCurrent ? "Using the attached files; no project search" : "No project search needed",
    ...(found.withheld.length ? { detail: `${found.withheld.length} left out because ${found.withheld.length === 1 ? "it looked" : "they looked"} like a secret: ${found.withheld.join(", ")}` } : {}),
  });
  if (notesOnly && found.sources.length === 0) {
    emit({ id: "done", kind: "done", status: "done", label: "Nothing found", ms: Date.now() - t0 });
    return { ok: true, text: NOTHING_FOUND, sources: [] };
  }

  const prompt = buildPrompt({
    rules: notesOnly ? NOTES_RULES : generalRules({ hasIndex: true, web: false, hasSources: found.sources.length > 0, hasAttachments: !!attachments }),
    ...(notesOnly ? {} : { identity: identityBlock(deps.backend) }),
    ...(!notesOnly && deps.memory ? { memory: deps.memory } : {}),
    ...(!notesOnly && deps.skill ? { skill: deps.skill } : {}),
    question,
    history: input.history,
    ...(attachments ? { attachments } : {}),
    backendId: deps.backendId ?? null,
    sourceBlocks: found.blocks,
  });
  const sources = found.sources.slice(0, prompt.sourcesUsed);
  notes.push(...prompt.attachments.notes);
  if (prompt.attachments.detail) emit({ id: "context", kind: "context", status: "done", label: "Read the attached files", detail: prompt.attachments.detail, ms: 0 });
  const ctx = sources.filter((s) => s.kind === "context");
  if (ctx.length) {
    emit({ id: "context", kind: "context", status: "done", label: `Read history and links for ${ctx.length} ${ctx.length === 1 ? "path" : "paths"}`, detail: ctx.map((c) => c.title).join("; "), ms: 0 });
  }

  if (deps.agent && !notesOnly) {
    const r = await deps.agent({ system: prompt.system, user: prompt.user, sources });
    emit({ id: "done", kind: "done", status: r.ok ? "done" : "error", label: r.ok ? "Done" : "Stopped", ms: Date.now() - t0 });
    return r.ok && notes.length ? { ...r, text: `${r.text}\n\n${notes.join("\n")}` } : r;
  }
  const backend = deps.backend ?? "the model";
  const tm = Date.now();
  emit({ id: "model", kind: "model", status: "running", label: `Asking ${backend}` });
  try {
    const r = await deps.complete({
      role: "chat", system: prompt.system, user: prompt.user, maxTokens: ANSWER_MAX_TOKENS,
      ...(deps.signal ? { signal: deps.signal } : {}), ...(deps.onText ? { onText: deps.onText } : {}),
    });
    emit({ id: "model", kind: "model", status: "done", label: `${backend} answered in ${((Date.now() - tm) / 1000).toFixed(1)} s`, ms: Date.now() - tm });
    const raw = r.text.trim();
    const text = stripInvented(raw, new Set(sources.map((s) => s.ref)));
    const dropped = Math.max(0, countCitations(raw) - countCitations(text));
    // Only sources the answer actually cites are shown as chips.
    const cited = sources.filter((s) => text.includes(`[${s.ref}]`));
    emit({ id: "verify", kind: "verify", status: "done", label: `Checked citations: ${cited.length} kept, ${dropped} dropped`, ms: 0 });
    emit({ id: "done", kind: "done", status: "done", label: "Done", ms: Date.now() - t0 });
    return { ok: true, text: notes.length ? `${text}\n\n${notes.join("\n")}` : text, sources: cited };
  } catch (e) {
    const d = describeError(e);
    // Say what was actually blocked: the user's own words, or text around them (earlier turns).
    const blamesQuestion = !maskOutgoing(question).ok;
    const blockedText = blamesQuestion
      ? "Your message looks like it contains a secret"
      : "Something in this chat (an earlier message or a source) looked like a secret";
    if (d?.error === "blocked") d.text = d.text.replace("Your message looks like it contains a secret", blockedText);
    emit({ id: "model", kind: "model", status: "error", label: d?.error === "blocked" ? (blamesQuestion ? "Stopped: the message looked like a secret" : "Stopped: something in the chat looked like a secret") : "Could not get an answer", ms: Date.now() - tm });
    if (!d) throw e;
    return { ok: false, sources: [], ...d };
  }
}
