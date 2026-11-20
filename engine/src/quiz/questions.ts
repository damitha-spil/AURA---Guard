// The knowledge quiz: question file format and loader. Questions are written as `draft`
// until the owner reviews them (evals/quiz/questions.json).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const question = z.object({
  id: z.string().min(1),
  area: z.string().min(1),
  question: z.string().min(1),
  expect: z.object({
    /** Refs of which at least one must be among the sources (note ids or `repo:path` file refs). */
    cite: z.array(z.string()).default([]),
    /** Lower-case keywords the answer should contain. */
    mention: z.array(z.string()).default([]),
    /** True when the right answer is "this is not in the knowledge". */
    unknown: z.boolean().optional(),
  }),
  status: z.enum(["draft", "approved"]),
});

export type QuizQuestion = z.infer<typeof question>;

export function questionsPath(root: string): string {
  return join(root, "evals", "quiz", "questions.json");
}

export function parseQuestions(text: string): QuizQuestion[] {
  const list = z.array(question).parse(JSON.parse(text));
  const seen = new Set<string>();
  for (const q of list) {
    if (seen.has(q.id)) throw new Error(`duplicate question id ${q.id}`);
    seen.add(q.id);
    if (!q.expect.unknown && q.expect.cite.length === 0) throw new Error(`${q.id}: needs expect.cite or expect.unknown`);
  }
  return list;
}

export function loadQuestions(root: string): QuizQuestion[] {
  return parseQuestions(readFileSync(questionsPath(root), "utf8"));
}
