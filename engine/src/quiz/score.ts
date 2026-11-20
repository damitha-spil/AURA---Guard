// Pure scoring for the quiz. No model, no files.

import type { Db } from "../index/db.ts";
import { search } from "../index/search.ts";
import type { QuizQuestion } from "./questions.ts";

/** The pass mark for the quiz (ARCHITECTURE section 11). */
export const QUIZ_GATE = 0.9;
/** Retrieval looks at this many top hits (recall@5). */
export const RECALL_K = 5;
/** Model mode never runs more questions than this unless asked, so a run stays cheap. */
export const DEFAULT_MODEL_CAP = 10;
/** The judge grades at most this many answers per run. */
export const JUDGE_CAP = 10;

export interface QuestionResult {
  id: string;
  area: string;
  question: string;
  unknown: boolean;
  /** Retrieval: expected ref was in the top K. Negative questions are not scored (null). */
  retrieved: boolean | null;
  topRefs: string[];
  pass: boolean | null; // null = not scored in this mode
  reasons: string[];
  judge?: { verdict: "pass" | "fail"; reason: string };
}

export function scoreRetrieval(db: Db, q: QuizQuestion): QuestionResult {
  const unknown = q.expect.unknown === true;
  const hits = search(db, q.question, { limit: RECALL_K, audience: "internal_dev" });
  const topRefs = hits.map((h) => h.ref);
  if (unknown) {
    return { id: q.id, area: q.area, question: q.question, unknown, retrieved: null, topRefs, pass: null, reasons: [] };
  }
  const found = q.expect.cite.some((r) => topRefs.includes(r));
  return {
    id: q.id, area: q.area, question: q.question, unknown, retrieved: found, topRefs, pass: found,
    reasons: found ? [] : [`none of ${q.expect.cite.join(", ")} in the top ${RECALL_K}`],
  };
}

export interface AnswerLike { ok: boolean; text: string; sources: { ref: string }[]; error?: string }

// Phrases that mean "I do not know". Kept broad on purpose; the judge can overrule.
const DECLINE =
  /\b(do not know|don't know|cannot find|could not find|can't find|no information|not (?:covered|documented|in the (?:sources|vault|knowledge))|sources (?:do not|don't) (?:say|answer|cover|mention|contain))/i;

export function declined(a: AnswerLike): boolean {
  return a.sources.length === 0 || DECLINE.test(a.text);
}

/** `[ref]` citations in an answer. */
export function citedRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[([^\[\]\n]{1,200})\](?!\()/g)) out.push(m[1]!);
  return out;
}

export function scoreAnswer(q: QuizQuestion, a: AnswerLike, refExists: (ref: string) => boolean): QuestionResult {
  const unknown = q.expect.unknown === true;
  const reasons: string[] = [];
  const sourceRefs = a.sources.map((s) => s.ref);
  const base = { id: q.id, area: q.area, question: q.question, unknown, retrieved: null, topRefs: sourceRefs };
  if (!a.ok) return { ...base, pass: false, reasons: [`model failed: ${a.error ?? "error"}`] };
  if (unknown) {
    if (!declined(a)) reasons.push("answered a question that is not in the knowledge");
    return { ...base, pass: reasons.length === 0, reasons };
  }
  const bad = citedRefs(a.text).filter((r) => !refExists(r) && !r.startsWith("context:"));
  if (bad.length) reasons.push(`cited refs that do not exist: ${bad.join(", ")}`);
  if (!q.expect.cite.some((r) => sourceRefs.includes(r))) {
    reasons.push(`no expected ref among the sources (${q.expect.cite.join(", ")})`);
  }
  const lower = a.text.toLowerCase();
  const missing = q.expect.mention.filter((k) => !lower.includes(k.toLowerCase()));
  if (missing.length) reasons.push(`answer does not mention: ${missing.join(", ")}`);
  return { ...base, pass: reasons.length === 0, reasons };
}

export interface Summary {
  total: number;
  scored: number;
  passed: number;
  rate: number; // 0..1, passed / scored
  gate: number;
  meetsGate: boolean;
  byArea: Record<string, { scored: number; passed: number }>;
}

export function summarize(results: QuestionResult[]): Summary {
  const scoredR = results.filter((r) => r.pass !== null);
  const passed = scoredR.filter((r) => r.pass === true).length;
  const byArea: Summary["byArea"] = {};
  for (const r of scoredR) {
    const a = (byArea[r.area] ??= { scored: 0, passed: 0 });
    a.scored++;
    if (r.pass) a.passed++;
  }
  const rate = scoredR.length ? passed / scoredR.length : 0;
  return { total: results.length, scored: scoredR.length, passed, rate, gate: QUIZ_GATE, meetsGate: rate >= QUIZ_GATE, byArea };
}

/** Ids that passed last time and fail now, and the reverse. */
export function diffRuns(
  prev: { id: string; pass: boolean | null }[],
  cur: QuestionResult[],
): { regressed: string[]; fixed: string[]; newlyScored: number } {
  const before = new Map(prev.map((p) => [p.id, p.pass]));
  const regressed: string[] = [];
  const fixed: string[] = [];
  let newlyScored = 0;
  for (const c of cur) {
    if (c.pass === null) continue;
    const p = before.get(c.id);
    if (p === undefined || p === null) newlyScored++;
    else if (p && !c.pass) regressed.push(c.id);
    else if (!p && c.pass) fixed.push(c.id);
  }
  return { regressed, fixed, newlyScored };
}
