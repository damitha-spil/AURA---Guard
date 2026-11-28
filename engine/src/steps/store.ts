// Repeated steps: a named list of fixed steps that a QA run finished well, saved so they can be
// run again. A step is an action name, plain-data arguments and the outcome expected.
// Replay goes only through the read-only chat tool lines on ALLOWED_ACTIONS. It never calls a model.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import type { QaRunDetail } from "../qa/harness_api.ts";
import { parseToolLine, runToolLine } from "../tools/native/chat.ts";

/** The only actions a saved step may use. All are read-only; none reach the web or a model. */
export const ALLOWED_ACTIONS: readonly string[] = ["/ls", "/read", "/find", "/system", "/time"];
export const MAX_STEPS_PER_LIST = 30;
export const MAX_SAVED_LISTS = 100;
const MAX_ARG_CHARS = 500;
const MAX_NAME_CHARS = 80;

export interface StepExpectation { ok: boolean; contains?: string }
export interface SavedStep { action: string; args: string[]; expected: StepExpectation }
export interface StepList {
  id: string;
  name: string;
  createdAt: string;
  sourceRunId: string | null;
  steps: SavedStep[];
}

export type StepOutcome = "pass" | "fail" | "refused" | "dry";
export interface ReplayStepResult { index: number; action: string; outcome: StepOutcome; detail: string }
export interface ReplayResult { id: string; dryRun: boolean; modelCalls: 0; ok: boolean; steps: ReplayStepResult[] }

const SAFE_ID = /^st_[a-f0-9]{12}$/;
export const isStepListId = (s: string): boolean => SAFE_ID.test(s);

function storeFile(dataDir: string): string {
  const dir = join(dataDir, "steps");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "steps.json");
}

function readAll(dataDir: string): StepList[] {
  const file = storeFile(dataDir);
  if (!existsSync(file)) return [];
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(v) ? (v as StepList[]) : [];
  } catch {
    return [];
  }
}

function writeAll(dataDir: string, lists: StepList[]): void {
  const file = storeFile(dataDir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(lists, null, 2), "utf8");
  renameSync(tmp, file);
}

export function listStepLists(dataDir: string): StepList[] {
  return readAll(dataDir);
}

export function getStepList(dataDir: string, id: string): StepList | null {
  return readAll(dataDir).find((l) => l.id === id) ?? null;
}

/** Returns the reason a step is not acceptable, or null. */
export function checkStep(s: SavedStep): string | null {
  if (!ALLOWED_ACTIONS.includes(s.action)) return `Action "${s.action}" is not allowed.`;
  if (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string" || /[\r\n]/.test(a) || a.length > MAX_ARG_CHARS)) return "Arguments must be short single-line text.";
  if (!s.expected || typeof s.expected.ok !== "boolean") return "Each step needs an expected outcome.";
  return null;
}

/** Steps a passed run can repeat: reading each file it changed. Only a passed run qualifies. */
export function stepsFromRun(detail: QaRunDetail): SavedStep[] {
  if (detail.result.run?.status !== "passed") return [];
  const seen = new Set<string>();
  const steps: SavedStep[] = [];
  for (const f of detail.result.context.changedFiles) {
    const p = `${f.repo}/${f.path}`;
    if (seen.has(p) || /[\r\n]/.test(p) || p.length > MAX_ARG_CHARS) continue;
    seen.add(p);
    steps.push({ action: "/read", args: [p], expected: { ok: true } });
    if (steps.length >= MAX_STEPS_PER_LIST) break;
  }
  return steps;
}

export function saveStepList(dataDir: string, input: { name: string; sourceRunId: string | null; steps: SavedStep[] }, now: Date = new Date()): StepList {
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
  if (!name) throw new Error("Give the step list a name.");
  if (!input.steps.length) throw new Error("There are no steps to save.");
  if (input.steps.length > MAX_STEPS_PER_LIST) throw new Error(`A list holds at most ${MAX_STEPS_PER_LIST} steps.`);
  for (const s of input.steps) {
    const bad = checkStep(s);
    if (bad) throw new Error(bad);
  }
  const all = readAll(dataDir);
  if (all.length >= MAX_SAVED_LISTS) throw new Error("Too many saved step lists. Remove old ones first.");
  const list: StepList = {
    id: `st_${randomBytes(6).toString("hex")}`,
    name,
    createdAt: now.toISOString(),
    sourceRunId: input.sourceRunId,
    steps: input.steps.map((s) => ({ action: s.action, args: [...s.args], expected: { ...s.expected } })),
  };
  writeAll(dataDir, [...all, list]);
  return list;
}

/** Dry run only checks each step against the allow list. A real run goes through the read-only tool lines. */
export async function replayStepList(cfg: GuardConfig, list: StepList, opts: { dryRun: boolean }): Promise<ReplayResult> {
  const steps: ReplayStepResult[] = [];
  for (let i = 0; i < list.steps.length; i++) {
    const s = list.steps[i] as SavedStep;
    const bad = checkStep(s);
    if (bad) { steps.push({ index: i, action: s.action, outcome: "refused", detail: bad }); continue; }
    if (opts.dryRun) { steps.push({ index: i, action: s.action, outcome: "dry", detail: "Allowed. Not run." }); continue; }
    const line = parseToolLine([s.action, ...s.args].join(" "));
    if (!line || !ALLOWED_ACTIONS.includes(line.name)) { steps.push({ index: i, action: s.action, outcome: "refused", detail: "Not a known read-only action." }); continue; }
    const r = await runToolLine(cfg, line, {}, () => undefined);
    const matches = r.ok === s.expected.ok && (!s.expected.contains || r.text.includes(s.expected.contains));
    steps.push({ index: i, action: s.action, outcome: matches ? "pass" : "fail", detail: matches ? "As expected." : r.ok ? "The result did not match what was expected." : "The step failed." });
  }
  return { id: list.id, dryRun: opts.dryRun, modelCalls: 0, ok: steps.every((s) => s.outcome === "pass" || s.outcome === "dry"), steps };
}
