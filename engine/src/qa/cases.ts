// QA plan shape, validation of a model reply, and the deterministic (no model) plan.

import { z } from "zod";
import type { GuardConfig } from "../types.ts";
import type { QaContext } from "./context.ts";
import type { Target } from "./target.ts";
import { CASE_TYPES, PRIORITIES, categoryOf, evidenceFor, loadQaRole, loadTemplates } from "./templates.ts";
import type { CaseType, Priority } from "./templates.ts";

// Caps (named so a test can name them). Anything longer is cut before validation, never an error.
export const MAX_CASES = 24;
export const MAX_AREAS = 12;
export const MAX_STEPS = 12;
export const MAX_LIST = 10;
export const MAX_CHECKLIST = 15;
export const MAX_NOT_COVERED = 8;
export const MAX_QUESTIONS = 3;
export const MAX_RISK_REASONS = 6;
export const MAX_TEXT = 400;
export const MAX_SUMMARY = 700;
export const MAX_EXTRA_EVIDENCE = 3;

export type RiskLevel = "low" | "medium" | "high";

export interface QaCase {
  id: string;
  title: string;
  type: CaseType;
  priority: Priority;
  /** The changed file or area that motivated the case ("requirement" for a plain requirement). */
  cites: string[];
  preconditions: string[];
  steps: string[];
  expected: string[];
  data?: string;
  automatable: boolean;
  journeyId?: string;
}
export interface QaArea { name: string; why: string; risk: RiskLevel }
export interface QaPlan {
  summary: string;
  riskLevel: RiskLevel;
  riskReasons: string[];
  areas: QaArea[];
  cases: QaCase[];
  regressionChecklist: string[];
  notCovered: string[];
  questions: string[];
  evidence: { uiChange: boolean; needed: string[] };
}

const text = z.string().trim().min(1);
const list = z.array(text).default([]);
export const ModelPlanSchema = z.object({
  summary: text,
  riskLevel: z.enum(["low", "medium", "high"]),
  riskReasons: list,
  areas: z.array(z.object({ name: text, why: text, risk: z.enum(["low", "medium", "high"]) })).default([]),
  cases: z.array(z.object({
    id: z.string().default(""),
    title: text,
    type: z.enum(CASE_TYPES),
    priority: z.enum(PRIORITIES),
    cites: z.array(text).min(1, "cites: name the changed file or area that motivated this case"),
    preconditions: list,
    steps: z.array(text).min(1, "steps: at least one step"),
    expected: z.array(text).min(1, "expected: at least one expected result"),
    data: z.string().optional(),
    automatable: z.boolean().default(false),
    journeyId: z.string().optional(),
  })).min(1, "cases: at least one case"),
  regressionChecklist: list,
  notCovered: list,
  questions: list,
  evidence: z.object({ uiChange: z.boolean().default(false), needed: list }).default({ uiChange: false, needed: [] }),
});

const clip = (s: unknown, n: number): unknown => (typeof s === "string" ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : s);
const clipList = (v: unknown, max: number, n = MAX_TEXT): unknown => (Array.isArray(v) ? v.slice(0, max).map((x) => clip(x, n)) : v);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Cuts sizes down to the caps so a long reply is trimmed, not rejected. */
export function clipReply(raw: unknown): unknown {
  const r = obj(raw);
  if (!r) return raw;
  const out: Record<string, unknown> = { ...r };
  out["summary"] = clip(r["summary"], MAX_SUMMARY);
  out["riskReasons"] = clipList(r["riskReasons"], MAX_RISK_REASONS);
  out["regressionChecklist"] = clipList(r["regressionChecklist"], MAX_CHECKLIST);
  out["notCovered"] = clipList(r["notCovered"], MAX_NOT_COVERED);
  out["questions"] = clipList(r["questions"], MAX_QUESTIONS);
  if (Array.isArray(r["areas"])) {
    out["areas"] = r["areas"].slice(0, MAX_AREAS).map((a) => {
      const o = obj(a);
      return o ? { ...o, name: clip(o["name"], 120), why: clip(o["why"], MAX_TEXT) } : a;
    });
  }
  if (Array.isArray(r["cases"])) {
    out["cases"] = r["cases"].slice(0, MAX_CASES).map((c) => {
      const o = obj(c);
      if (!o) return c;
      return {
        ...o, id: clip(o["id"], 40), title: clip(o["title"], 200), cites: clipList(o["cites"], 4, 200),
        preconditions: clipList(o["preconditions"], MAX_LIST), steps: clipList(o["steps"], MAX_STEPS), expected: clipList(o["expected"], MAX_LIST),
        data: clip(o["data"], MAX_TEXT),
      };
    });
  }
  const ev = obj(r["evidence"]);
  if (ev) out["evidence"] = { ...ev, needed: clipList(ev["needed"], 8) };
  return out;
}

export interface ValidateInput { ctx: QaContext; target: Target; journeyIds: Set<string> }

/** Does a cite name something that really changed (a file, a folder, an area, the requirement)? */
export function citeIsReal(cite: string, input: ValidateInput): boolean {
  const c = cite.toLowerCase().replace(/\\/g, "/").trim();
  if (c.length < 3) return false;
  if (input.target.description && /\b(requirement|description|feature|brief|request)\b/.test(c)) return true;
  if (/^requirement\b/.test(c)) return true;
  for (const f of input.ctx.files) {
    const p = f.path.toLowerCase();
    if (c.includes(p) || p.includes(c) || c.includes(`${f.repo}:${p}`)) return true;
    const base = p.split("/").pop() ?? "";
    if (base.length >= 3 && c.includes(base)) return true;
  }
  for (const a of input.ctx.areas) if (c.includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(c)) return true;
  return false;
}

export type Validated = { ok: true; plan: QaPlan; dropped: string[] } | { ok: false; errors: string[] };

const flags = (ctx: QaContext): { ui: boolean; service: boolean } => ({ ui: ctx.files.some((f) => f.ui), service: ctx.files.some((f) => f.service) });

/** The fixed evidence block (from the role file) merged with up to a few model extras. */
export function evidenceBlock(cfg: GuardConfig, ctx: QaContext, extra: string[] = []): QaPlan["evidence"] {
  const f = flags(ctx);
  const fixed = evidenceFor(loadQaRole(cfg), f);
  const more = extra.filter((e) => !fixed.some((x) => x.toLowerCase() === e.toLowerCase())).slice(0, MAX_EXTRA_EVIDENCE);
  return { uiChange: f.ui, needed: [...fixed, ...more] };
}

export function validateReply(cfg: GuardConfig, raw: unknown, input: ValidateInput, extra?: unknown): Validated {
  const parsed = ModelPlanSchema.safeParse(clipReply(raw));
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "reply"}: ${i.message}`) };
  }
  void extra;
  const p = parsed.data;
  const errors: string[] = [];
  const dropped: string[] = [];
  p.cases.forEach((c, i) => {
    if (!c.cites.some((x) => citeIsReal(x, input))) {
      errors.push(`cases.${i} ("${c.title.slice(0, 60)}"): cites must name a changed file or area exactly as written in the context, or "requirement"`);
    }
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 8) };
  const cases: QaCase[] = p.cases.map((c, i) => {
    const out: QaCase = {
      id: `TC-${String(i + 1).padStart(3, "0")}`, title: c.title, type: c.type, priority: c.priority, cites: c.cites,
      preconditions: c.preconditions, steps: c.steps, expected: c.expected, automatable: c.automatable,
    };
    if (c.data) out.data = c.data;
    if (c.journeyId) {
      if (input.journeyIds.has(c.journeyId)) out.journeyId = c.journeyId;
      else dropped.push(`${c.journeyId} is not a journey of this project, so case ${out.id} is not linked to one`);
    }
    return out;
  });
  const plan: QaPlan = {
    summary: p.summary, riskLevel: p.riskLevel, riskReasons: p.riskReasons, areas: p.areas, cases,
    regressionChecklist: p.regressionChecklist, notCovered: p.notCovered, questions: p.questions.slice(0, MAX_QUESTIONS),
    evidence: evidenceBlock(cfg, input.ctx, p.evidence.needed),
  };
  return { ok: true, plan, dropped };
}

// ---------- the deterministic plan ----------

const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };
const fill = (s: string, area: string): string => s.replaceAll("{area}", area);

export function deterministicPlan(cfg: GuardConfig, ctx: QaContext, target: Target): QaPlan {
  const tpl = loadTemplates(cfg);
  const cases: QaCase[] = [];
  const reasons: string[] = [];
  let score = 0;

  // Group changed files by category, keeping the order of the template file.
  const byCat = new Map<string, typeof ctx.files>();
  for (const f of ctx.files) byCat.set(f.categoryId, [...(byCat.get(f.categoryId) ?? []), f]);
  for (const cat of tpl.categories) {
    const fs = byCat.get(cat.id);
    if (!fs?.length) continue;
    const areaCounts = new Map<string, number>();
    for (const f of fs) areaCounts.set(f.area, (areaCounts.get(f.area) ?? 0) + 1);
    const topAreas = [...areaCounts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([a]) => a);
    const area = topAreas.join(" and ");
    const cites = fs.slice(0, 3).map((f) => f.path);
    for (const c of cat.cases) {
      cases.push({
        id: "", title: fill(c.title, area), type: c.type, priority: c.priority, cites,
        preconditions: c.preconditions.map((x) => fill(x, area)), steps: c.steps.map((x) => fill(x, area)), expected: c.expected.map((x) => fill(x, area)),
        automatable: c.automatable,
      });
    }
    score += cat.riskWeight * Math.min(fs.length, 3);
    if (cat.riskWeight > 0) reasons.push(`${fs.length} changed file${fs.length === 1 ? "" : "s"} in ${cat.label.toLowerCase()} (${cites.map((p) => p.split("/").pop()).join(", ")})`);
  }

  // A plain requirement with no changed files: the generic requirement cases.
  if (ctx.files.length === 0 && target.description) {
    const area = target.description.slice(0, 60);
    for (const c of tpl.requirementCases) {
      cases.push({
        id: "", title: fill(c.title, area), type: c.type, priority: c.priority, cites: ["requirement"],
        preconditions: c.preconditions, steps: c.steps, expected: c.expected, automatable: c.automatable,
      });
    }
    score += 3;
    reasons.push("A feature described in words only: no changed files were available to focus on");
  }

  // Journeys of this project that touch the change.
  for (const j of ctx.journeys) {
    cases.push({
      id: "", title: `Journey: ${j.title}`, type: "regression", priority: "P1", cites: j.matchedFiles.length ? j.matchedFiles.slice(0, 3) : [j.area || j.id],
      preconditions: ["The real app running against the test environment"], steps: j.steps.length ? j.steps : ["Follow the journey note"], expected: j.expected.length ? j.expected : ["The journey passes"],
      automatable: true, journeyId: j.id,
    });
  }

  score += ctx.churn / tpl.churnPerPoint;
  const dependents = ctx.blast.reduce((s, b) => s + b.dependents.length, 0);
  score += Math.min(3, dependents / 3);
  if (dependents) reasons.push(`${dependents} other file${dependents === 1 ? "" : "s"} depend on the changed code`);
  for (const c of ctx.coChange.slice(0, 2)) reasons.push(`${c.partner} usually changes with ${c.file} (${c.ratioPct}%) but did not change here`);
  score += Math.min(2, ctx.coChange.length * 0.5);
  if (ctx.churn >= 300) reasons.push(`${ctx.churn} changed lines in total`);

  const riskLevel: RiskLevel = score >= tpl.thresholds.high ? "high" : score >= tpl.thresholds.medium ? "medium" : "low";
  if (reasons.length === 0) reasons.push("Only documentation or test files changed, so no behaviour changed");

  // Order, cap and number the cases.
  const ordered = cases.map((c, i) => ({ c, i })).sort((a, b) => RANK[a.c.priority] - RANK[b.c.priority] || a.i - b.i).slice(0, MAX_CASES);
  ordered.forEach(({ c }, i) => { c.id = `TC-${String(i + 1).padStart(3, "0")}`; });
  const finalCases = ordered.map((o) => o.c);

  const areas: QaArea[] = ctx.areas.slice(0, MAX_AREAS).map((a) => {
    const w = Math.max(0, ...ctx.files.filter((f) => (ctx.areas.length > 0 && (target.repos.length > 1 ? `${f.repo}: ${f.area}` : f.area) === a.name)).map((f) => tpl.categories.find((c) => c.id === f.categoryId)?.riskWeight ?? 1));
    return { name: a.name, why: `${a.files} changed file${a.files === 1 ? "" : "s"}: ${a.categories.join(", ").toLowerCase()}`, risk: w >= 4 ? "high" : w >= 2 ? "medium" : "low" };
  });

  const checklist: string[] = [...tpl.regression];
  for (const b of ctx.blast.slice(0, 5)) checklist.push(`${b.dependents.slice(0, 3).join(", ")} still works (it uses ${b.file})`);
  for (const c of ctx.coChange.slice(0, 3)) checklist.push(`Confirm ${c.partner} does not need the same change as ${c.file}`);
  for (const t of ctx.tests.nearby.slice(0, 3)) checklist.push(`Review whether the existing test ${t} still covers the changed behaviour`);

  const notCovered: string[] = [...tpl.notCovered];
  if (!ctx.hasDiff) notCovered.push("No diff text was available (only file names or a description), so exact behaviour changes were not read.");
  if (!ctx.hasGraph) notCovered.push("No code graph or no dependents were found, so the blast radius was not measured.");
  if (ctx.skipped.length) notCovered.push(`${ctx.skipped.length} changed file${ctx.skipped.length === 1 ? " was" : "s were"} too large or generated to read (${ctx.skipped.slice(0, 3).map((s) => s.path).join(", ")}).`);
  if (ctx.patchWithheld.length) notCovered.push(`Diff text for ${ctx.patchWithheld.join(", ")} looked like it held a secret and was left out.`);
  if (ctx.filesTotal > ctx.files.length) notCovered.push(`${ctx.filesTotal - ctx.files.length} more changed files were not listed.`);

  const questions: string[] = [];
  if (!ctx.hasDiff && target.description) questions.push("Which repository, branch or pull request holds this change, if there is one?");
  if (ctx.files.some((f) => f.ui) && ctx.journeysAvailable === 0) questions.push("Is there a recorded user journey for the changed screen? None is stored for this project.");

  const p0 = finalCases.filter((c) => c.priority === "P0").length;
  const p1 = finalCases.filter((c) => c.priority === "P1").length;
  const p2 = finalCases.filter((c) => c.priority === "P2").length;
  const summary = `Plan for ${target.label.charAt(0).toLowerCase()}${target.label.slice(1)}: ${ctx.filesTotal} changed file${ctx.filesTotal === 1 ? "" : "s"} in ${areas.length} area${areas.length === 1 ? "" : "s"}, risk ${riskLevel}. ${finalCases.length} case${finalCases.length === 1 ? "" : "s"} (P0 ${p0}, P1 ${p1}, P2 ${p2}).`;

  return {
    summary, riskLevel, riskReasons: reasons.slice(0, MAX_RISK_REASONS), areas, cases: finalCases,
    regressionChecklist: checklist.slice(0, MAX_CHECKLIST), notCovered: notCovered.slice(0, MAX_NOT_COVERED), questions: questions.slice(0, MAX_QUESTIONS),
    evidence: evidenceBlock(cfg, ctx),
  };
}

/** Category of a path, exposed for tests and the report. */
export const categoryIdOf = (cfg: GuardConfig, path: string): string => categoryOf(cfg, path).id;
