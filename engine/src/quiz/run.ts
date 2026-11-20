// Runs the quiz and writes the report (data/quiz/<date>.md, plus a .json twin used for the next diff).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompleteFn } from "../brain/client.ts";
import type { Db } from "../index/db.ts";
import { localToday } from "../rules/util.ts";
import type { QuizQuestion } from "./questions.ts";
import {
  DEFAULT_MODEL_CAP, JUDGE_CAP, QUIZ_GATE, RECALL_K, diffRuns, scoreAnswer, scoreRetrieval, summarize,
} from "./score.ts";
import type { AnswerLike, QuestionResult, Summary } from "./score.ts";

export type QuizMode = "retrieval" | "model";

export interface QuizRun {
  mode: QuizMode;
  date: string;
  results: QuestionResult[];
  summary: Summary;
  skipped: number; // questions left out by the model cap
}

export interface RunOptions {
  mode: QuizMode;
  date?: string;
  /** Model mode: answers one question (the chat answer pipeline). */
  ask?: (question: string) => Promise<AnswerLike>;
  /** Judge mode: grades short answers. */
  judge?: CompleteFn;
  cap?: number;
}

const JUDGE_RULES = [
  "You grade answers from an internal assistant. Reply with JSON only: {\"verdict\":\"pass\"|\"fail\",\"reason\":\"<one short sentence>\"}.",
  "pass = the answer is correct for the question and uses the expected facts. fail = wrong, missing the point, or it guessed.",
  "For a question marked NOT IN KNOWLEDGE the only correct answer is a plain statement that it is not known.",
].join("\n");

export async function judgeAnswer(
  complete: CompleteFn, q: QuizQuestion, text: string,
): Promise<{ verdict: "pass" | "fail"; reason: string }> {
  const expect = q.expect.unknown ? "NOT IN KNOWLEDGE" : `should mention: ${q.expect.mention.join(", ")}`;
  const r = await complete({
    role: "quiz-judge",
    system: [JUDGE_RULES],
    user: `Question: ${q.question}\nExpectation: ${expect}\nAnswer:\n${text.slice(0, 2000)}`,
    maxTokens: 150,
  });
  const m = /\{[\s\S]*\}/.exec(r.text);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { verdict?: string; reason?: string };
      if (j.verdict === "pass" || j.verdict === "fail") return { verdict: j.verdict, reason: String(j.reason ?? "").slice(0, 200) };
    } catch { /* fall through */ }
  }
  return { verdict: "fail", reason: "judge reply was not valid JSON" };
}

export async function runQuiz(db: Db, questions: QuizQuestion[], opts: RunOptions): Promise<QuizRun> {
  const date = opts.date ?? localToday();
  const results: QuestionResult[] = [];
  let skipped = 0;
  if (opts.mode === "retrieval") {
    for (const q of questions) results.push(scoreRetrieval(db, q));
  } else {
    if (!opts.ask) throw new Error("model mode needs an answer function");
    const cap = opts.cap ?? DEFAULT_MODEL_CAP;
    // A cap on questions run, but keep at least one negative one in the sample when there is room.
    const picked = pickSample(questions, cap);
    skipped = questions.length - picked.length;
    const exists = db.prepare("SELECT 1 FROM docs WHERE ref=?");
    let judged = 0;
    for (const q of picked) {
      const a = await opts.ask(q.question);
      const r = scoreAnswer(q, a, (ref) => exists.get(ref) !== undefined);
      if (opts.judge && a.ok && judged < JUDGE_CAP) {
        judged++;
        r.judge = await judgeAnswer(opts.judge, q, a.text);
      }
      results.push(r);
    }
  }
  return { mode: opts.mode, date, results, summary: summarize(results), skipped };
}

/** First `cap` questions, but the last slot goes to a negative question when none is in the sample. */
export function pickSample(questions: QuizQuestion[], cap: number): QuizQuestion[] {
  if (questions.length <= cap) return questions;
  const picked = questions.slice(0, cap);
  if (!picked.some((q) => q.expect.unknown)) {
    const neg = questions.find((q) => q.expect.unknown);
    if (neg && cap > 0) picked[cap - 1] = neg;
  }
  return picked;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function quizDir(dataDir: string): string {
  return join(dataDir, "quiz");
}

interface StoredRun { mode: QuizMode; date: string; results: { id: string; pass: boolean | null }[]; rate: number }

/** The newest earlier stored run of the same mode (strictly before this file name). */
export function previousRun(dir: string, mode: QuizMode, currentName: string): StoredRun | undefined {
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f.includes(mode) && f < currentName)
    .sort();
  const last = names[names.length - 1];
  if (!last) return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, last), "utf8")) as StoredRun;
  } catch {
    return undefined;
  }
}

export function renderReport(run: QuizRun, prev: StoredRun | undefined): string {
  const s = run.summary;
  const label = run.mode === "retrieval" ? `recall@${RECALL_K} (no model)` : "model answers";
  const lines: string[] = [];
  lines.push(`# Quiz ${run.date}, ${label}`, "");
  lines.push(`Score: ${s.passed} of ${s.scored} = ${pct(s.rate)} (gate ${pct(QUIZ_GATE)}): ${s.meetsGate ? "MEETS the gate" : "BELOW the gate"}`);
  lines.push(`Questions in file: ${s.total}${run.skipped ? `; ${run.skipped} not run (model cap)` : ""}.`);
  if (run.mode === "retrieval") {
    const neg = run.results.filter((r) => r.unknown).length;
    lines.push(`${neg} negative question(s) are not scored in this mode.`);
  }
  lines.push("", "## By area", "", "| Area | Passed | Scored |", "|---|---|---|");
  for (const [a, v] of Object.entries(s.byArea)) lines.push(`| ${a} | ${v.passed} | ${v.scored} |`);
  const fails = run.results.filter((r) => r.pass === false);
  lines.push("", `## Failures (${fails.length})`, "");
  if (fails.length === 0) lines.push("None.");
  for (const f of fails) {
    lines.push(`- ${f.id} (${f.area}): ${f.question}`);
    for (const r of f.reasons) lines.push(`  - ${r}`);
    if (f.topRefs.length) lines.push(`  - got: ${f.topRefs.join(", ")}`);
  }
  const judged = run.results.filter((r) => r.judge);
  if (judged.length) {
    lines.push("", `## Judge (${judged.length} graded)`, "");
    for (const j of judged) lines.push(`- ${j.id}: ${j.judge!.verdict}. ${j.judge!.reason}`);
  }
  lines.push("", "## Against the previous run", "");
  if (!prev) lines.push("No earlier run of this mode.");
  else {
    const d = diffRuns(prev.results, run.results);
    lines.push(`Previous: ${prev.date}, ${pct(prev.rate)}. Now: ${pct(s.rate)}.`);
    lines.push(`Regressed: ${d.regressed.join(", ") || "none"}. Fixed: ${d.fixed.join(", ") || "none"}. New: ${d.newlyScored}.`);
  }
  lines.push("", "All questions are drafts until the owner approves them.", "");
  return lines.join("\n");
}

/** Writes the .md report and the .json twin; returns the report path and the previous-run info. */
export function writeReport(dataDir: string, run: QuizRun): { file: string; text: string } {
  const dir = quizDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const base = run.mode === "retrieval" ? run.date : `${run.date}-model`;
  const jsonName = `${base}-${run.mode}.json`;
  const text = renderReport(run, previousRun(dir, run.mode, jsonName));
  const file = join(dir, `${base}.md`);
  writeFileSync(file, text);
  writeFileSync(
    join(dir, jsonName),
    JSON.stringify({ mode: run.mode, date: run.date, rate: run.summary.rate, results: run.results.map((r) => ({ id: r.id, pass: r.pass })) }, null, 2),
  );
  return { file, text };
}
