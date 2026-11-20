// QA Planner: from a code change, which user journeys to test, in what order, with what evidence.
//
// HARD RULES: read-only. Only read-only git commands run in the product repo (diff, merge-base,
// rev-parse). The plan only names tests; it never runs one. No code is sent to the model, only file
// paths and line counts. See roles/qa-planner.yaml.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { CompleteFn } from "../brain/client.ts";
import type { Db } from "../index/db.ts";
import { blastRadius } from "../index/graph.ts";
import { git } from "../ingest/git.ts";
import type { GuardConfig } from "../types.ts";
import { loadJourneys } from "./journeys.ts";
import type { Journey } from "./journeys.ts";

export type Risk = "high" | "medium" | "low";

export interface ChangedFile { path: string; added: number; removed: number }

export interface PlanItem {
  journey: string;
  title: string;
  risk: Risk;
  why: string;
  /** What proof the owner must keep, following Aura's evidence rules. */
  evidence: string[];
  score: number;
  directFiles: string[];
  indirectFiles: string[];
}

export interface Gap { area: string; files: string[]; suggestion: string }

export interface TestPlan {
  repo: string;
  base: string;
  head: string;
  files: ChangedFile[];
  items: PlanItem[];
  gaps: Gap[];
  uiChanged: boolean;
  nativeChanged: boolean;
  generalEvidence: string[];
  extraChecks: string[];
  usedModel: boolean;
  modelNote: string;
}

/** A journey whose anchor sits on a changed file counts this much; wider "shared words" files count less. */
const DIRECT_WEIGHT = 3;
const SHARED_WEIGHT = 1;
const INDIRECT_WEIGHT = 1;
/** Churn adds up to this much to a score (about one point per 100 changed lines). */
const MAX_CHURN_POINTS = 3;
const HIGH_SCORE = 4;
const MEDIUM_SCORE = 2;
/** The plan lists at most this many journeys, so it stays a plan and not a catalogue. */
const MAX_PLAN_ITEMS = 8;
/** Blast radius is read for at most this many changed files, to keep one plan quick. */
const MAX_GRAPH_FILES = 40;
/** A reply with no tokens left to spare costs money; the role file may override this. */
const FALLBACK_MAX_TOKENS = 3000;
/** Files sent to the model are cut here. Paths only, so this is small. */
const MAX_PROMPT_FILES = 80;

const SHARED_FILE = /(^|\/)copy\.ts$/;
const NOT_UI = /^apps\/aura-ui\/src\/assets\//;
const TEST_FILE = /(^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[tj]sx?$/;
const UI_FILE = /^apps\/aura-ui\/(?:src\/|[^/]+\.(?:css|js|html)$)/;
const NATIVE_FILE = /^apps\/personal-agent\//;

export const isUiFile = (p: string): boolean => UI_FILE.test(p) && !TEST_FILE.test(p) && !NOT_UI.test(p);
export const isNativeFile = (p: string): boolean => NATIVE_FILE.test(p) && !TEST_FILE.test(p) && !/\/tests?\//.test(p);

/** "apps/aura-ui/src/areas/tools/x.tsx" -> "areas/tools"; "apps/aura-ui/src/orders/x.tsx" -> "orders". */
export function uiArea(p: string): string {
  const m = /^apps\/aura-ui\/src\/([^/]+)(?:\/([^/]+))?/.exec(p);
  if (!m) return "aura-ui (root)";
  const sub = m[2] && !m[2].includes(".") ? m[2] : "";
  if (sub && (m[1] === "areas" || m[1] === "components")) return `${m[1]}/${sub}`;
  return (m[1] as string).replace(/\.[a-z]+$/, "");
}

export function anchorMatches(anchorPath: string, file: string): boolean {
  const a = anchorPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return a.endsWith("/") ? file.startsWith(a) : file === a || file.startsWith(a + "/");
}

// ---------- git (read-only) ----------

export interface Range { base: string; head: string }

/** head defaults to HEAD; base to the merge-base with origin/development, then origin/main, origin/master. */
export function resolveRange(repoPath: string, opts: { base?: string; head?: string }): Range {
  const sha = (ref: string): string => git(repoPath, ["rev-parse", "--verify", ref]).trim();
  const head = sha(opts.head ?? "HEAD");
  if (opts.base) return { base: sha(opts.base), head };
  for (const ref of ["origin/development", "origin/main", "origin/master"]) {
    try {
      git(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
      return { base: git(repoPath, ["merge-base", head, ref]).trim(), head };
    } catch { /* try the next ref */ }
  }
  throw new Error("Could not find a base to compare with (no origin/development, origin/main or origin/master). Pass --base <ref>.");
}

export function changedFiles(repoPath: string, range: Range): ChangedFile[] {
  const out = git(repoPath, ["diff", "--numstat", "--no-renames", range.base, range.head]);
  const files: ChangedFile[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m) files.push({ path: (m[3] as string).replace(/\\/g, "/"), added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return files;
}

// ---------- the rule-based plan ----------

const UI_EVIDENCE = [
  "Screenshots of the real desktop app at 800, 1100 and 1440 px width, after each step",
  "A walkthrough video of the real desktop app (not a browser mock)",
  "The environment used (local or QA), the app build and the ERP/MCP versions, with no secrets",
];
const NATIVE_EVIDENCE = [
  "A real request, result and readback against the configured test environment (no production writes)",
  "If an app screen or flow changes with it, the screenshots and video above as well",
];

export function ruleScore(direct: ChangedFile[], indirect: string[], churn: number): number {
  const d = direct.reduce((s, f) => s + (SHARED_FILE.test(f.path) ? SHARED_WEIGHT : DIRECT_WEIGHT), 0);
  return d + indirect.length * INDIRECT_WEIGHT + Math.min(MAX_CHURN_POINTS, churn / 100);
}
export const riskOf = (score: number): Risk => (score >= HIGH_SCORE ? "high" : score >= MEDIUM_SCORE ? "medium" : "low");

export function rulePlan(
  journeys: Journey[], allFiles: ChangedFile[], repo: string, db: Db | null,
): { items: PlanItem[]; gaps: Gap[]; uiChanged: boolean; nativeChanged: boolean } {
  const files = allFiles.filter((f) => !TEST_FILE.test(f.path)); // a changed test does not change what a person sees
  const uiFiles = files.filter((f) => isUiFile(f.path));
  const nativeChanged = files.some((f) => isNativeFile(f.path));
  // Blast radius: which other files depend on each changed file.
  const dependents = new Map<string, Set<string>>();
  if (db) {
    for (const f of files.slice(0, MAX_GRAPH_FILES)) {
      try {
        for (const h of blastRadius(db, repo, f.path)) {
          if (!h.path) continue;
          if (!dependents.has(h.path)) dependents.set(h.path, new Set());
          dependents.get(h.path)?.add(f.path);
        }
      } catch { /* a repo without a graph just has no blast radius */ }
    }
  }
  const covered = new Set<string>();
  const items: PlanItem[] = [];
  for (const j of journeys) {
    const anchors = j.anchors.filter((a) => a.repo === repo);
    const direct = files.filter((f) => anchors.some((a) => anchorMatches(a.path, f.path)));
    const indirectSet = new Set<string>();
    for (const [depPath, because] of dependents) {
      if (direct.some((d) => d.path === depPath)) continue;
      if (anchors.some((a) => anchorMatches(a.path, depPath))) for (const b of because) indirectSet.add(b);
    }
    const indirect = [...indirectSet].filter((p) => !direct.some((d) => d.path === p));
    if (direct.length === 0 && indirect.length === 0) continue;
    for (const f of direct) covered.add(f.path);
    for (const [depPath, because] of dependents) {
      if (anchors.some((a) => anchorMatches(a.path, depPath))) for (const b of because) covered.add(b);
    }
    const churn = direct.reduce((s, f) => s + f.added + f.removed, 0);
    const score = ruleScore(direct, indirect, churn);
    const why = direct.length
      ? `Changed ${direct.slice(0, 3).map((f) => f.path.split("/").pop()).join(", ")}${direct.length > 3 ? ` and ${direct.length - 3} more` : ""}, which this journey covers.`
      : `${indirect.slice(0, 3).map((p) => p.split("/").pop()).join(", ")} changed and code this journey covers depends on it.`;
    items.push({
      journey: j.id, title: j.title, risk: riskOf(score), why,
      evidence: nativeChanged ? [...UI_EVIDENCE, NATIVE_EVIDENCE[0] as string] : UI_EVIDENCE, // a journey is a screen path: it always needs screen proof
      score, directFiles: direct.map((f) => f.path), indirectFiles: indirect,
    });
  }
  items.sort((a, b) => b.score - a.score || a.journey.localeCompare(b.journey));

  const byArea = new Map<string, string[]>();
  for (const f of uiFiles) {
    if (covered.has(f.path)) continue;
    const area = uiArea(f.path);
    byArea.set(area, [...(byArea.get(area) ?? []), f.path]);
  }
  const gaps: Gap[] = [...byArea].map(([area, fs]) => ({
    area, files: fs, suggestion: `No journey covers ${area}. Write one (qa journey note) before this change is released.`,
  }));
  return { items: items.slice(0, MAX_PLAN_ITEMS), gaps, uiChanged: uiFiles.length > 0, nativeChanged };
}

// ---------- the model step (optional) ----------

const ModelReply = z.object({
  ranked: z.array(z.object({ journey: z.string(), risk: z.enum(["high", "medium", "low"]), why: z.string().min(1) })),
  extra_checks: z.array(z.string()).default([]),
});

interface RoleCfg { limits?: { max_tokens?: number }; rules?: string[]; plan_json_shape?: unknown }

function loadRole(cfg: GuardConfig): RoleCfg {
  return parse(readFileSync(join(cfg.root, "roles", "qa-planner.yaml"), "utf8")) as RoleCfg;
}

export function buildPlanPrompt(
  cfg: GuardConfig, repo: string, range: Range, files: ChangedFile[], base: ReturnType<typeof rulePlan>,
): { system: string[]; user: string; maxTokens: number } {
  const role = loadRole(cfg);
  const rules = (role.rules ?? []).map((r) => `- ${r}`).join("\n");
  const stable =
    `You are the QA Planner for SPIL Quality Support Bot. You rank which user journeys of a desktop app to test after a code change.\n\nRules:\n${rules}\n\n` +
    `Reply with JSON: {"ranked": [{"journey": string, "risk": "high"|"medium"|"low", "why": string}], "extra_checks": string[]}.`;
  const lines = [`Repo ${repo}, change ${range.base.slice(0, 8)}..${range.head.slice(0, 8)}`, "Changed files (path +added -removed):"];
  for (const f of files.slice(0, MAX_PROMPT_FILES)) lines.push(`- ${f.path} +${f.added} -${f.removed}`);
  if (files.length > MAX_PROMPT_FILES) lines.push(`- ... and ${files.length - MAX_PROMPT_FILES} more`);
  lines.push("", "Candidate journeys (rule-based score, files that touch them):");
  for (const i of base.items) {
    lines.push(`- ${i.journey} | ${i.title} | rule risk ${i.risk} (${i.score.toFixed(1)}) | direct: ${i.directFiles.slice(0, 5).join(", ") || "none"} | via dependents: ${i.indirectFiles.slice(0, 3).join(", ") || "none"}`);
  }
  if (base.gaps.length) {
    lines.push("", "Changed UI areas with no journey:");
    for (const g of base.gaps) lines.push(`- ${g.area}: ${g.files.slice(0, 4).join(", ")}`);
  }
  return { system: [stable], user: lines.join("\n"), maxTokens: role.limits?.max_tokens ?? FALLBACK_MAX_TOKENS };
}

function extractJson(text: string): unknown {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error("the model reply had no JSON object");
  try { return JSON.parse(text.slice(s, e + 1)); } catch { throw new Error("the model reply was not valid JSON"); }
}

/** Merge the model's ranking into the rule-based items. Unknown ids are dropped; unranked ones go last. */
export function applyModelRanking(items: PlanItem[], reply: z.infer<typeof ModelReply>): PlanItem[] {
  const byId = new Map(items.map((i) => [i.journey, i]));
  const out: PlanItem[] = [];
  for (const r of reply.ranked) {
    const base = byId.get(r.journey);
    if (!base || out.some((o) => o.journey === r.journey)) continue;
    out.push({ ...base, risk: r.risk, why: r.why.trim() });
  }
  for (const i of items) if (!out.some((o) => o.journey === i.journey)) out.push({ ...i, why: `${i.why} (not ranked by the model)` });
  return out.slice(0, MAX_PLAN_ITEMS);
}

// ---------- entry point ----------

export interface PlanDeps {
  /** Omit for a rule-based plan (`--no-model`). */
  complete?: CompleteFn;
  now?: () => Date;
}

export async function planTests(
  cfg: GuardConfig, db: Db | null, input: { repo: string; base?: string; head?: string }, deps: PlanDeps = {},
): Promise<TestPlan> {
  const repoCfg = cfg.repos.find((r) => r.id === input.repo);
  if (!repoCfg) throw new Error(`Unknown repo "${input.repo}". Known: ${cfg.repos.map((r) => r.id).join(", ") || "(none)"}.`);
  const range = resolveRange(repoCfg.path, input);
  const files = changedFiles(repoCfg.path, range);
  const journeys = loadJourneys(cfg);
  const rules = rulePlan(journeys, files, input.repo, db);
  let items = rules.items;
  let extra: string[] = [];
  let usedModel = false;
  let modelNote = deps.complete ? "" : "Rule-based ranking (no model call).";
  if (deps.complete && items.length > 0) {
    try {
      const p = buildPlanPrompt(cfg, input.repo, range, files, rules);
      const res = await deps.complete({ role: "qa-planner", system: p.system, user: p.user, maxTokens: p.maxTokens });
      const parsed = ModelReply.safeParse(extractJson(res.text));
      if (!parsed.success) throw new Error("the reply did not match the plan shape: " + parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
      items = applyModelRanking(items, parsed.data);
      extra = parsed.data.extra_checks;
      usedModel = true;
      modelNote = "Ranked and explained by the model; evidence needs come from fixed rules.";
    } catch (e) {
      modelNote = `The model step failed (${(e as Error).message}); rule-based ranking used.`;
    }
  } else if (deps.complete) {
    modelNote = "No journey is affected, so the model was not called.";
  }
  const generalEvidence = rules.uiChanged ? UI_EVIDENCE : rules.nativeChanged ? NATIVE_EVIDENCE : [];
  return {
    repo: input.repo, base: range.base, head: range.head, files, items, gaps: rules.gaps,
    uiChanged: rules.uiChanged, nativeChanged: rules.nativeChanged, generalEvidence, extraChecks: extra, usedModel, modelNote,
  };
}

// ---------- output ----------

export function planMarkdown(plan: TestPlan, when: Date): string {
  const L: string[] = [];
  L.push(`# QA plan for ${plan.repo}`, "", `- Compared: \`${plan.base.slice(0, 10)}\` to \`${plan.head.slice(0, 10)}\``, `- Changed files: ${plan.files.length}`, `- Made: ${when.toISOString()}`, `- Ranking: ${plan.modelNote}`, "");
  L.push("Status: proposed. Guard suggests; people decide. Tests only read: nothing is saved, created, sent or deleted.", "");
  L.push("## Journeys to run, most important first", "");
  if (plan.items.length === 0) L.push("No journey is affected by this change.", "");
  plan.items.forEach((i, n) => {
    L.push(`${n + 1}. **${i.title}** (\`${i.journey}\`), risk ${i.risk}`, `   - Why: ${i.why}`, `   - Evidence needed:`);
    for (const e of i.evidence) L.push(`     - ${e}`);
  });
  L.push("", "## Gaps: changed screens with no journey", "");
  if (plan.gaps.length === 0) L.push("None.");
  for (const g of plan.gaps) L.push(`- **${g.area}**: ${g.files.slice(0, 6).map((f) => `\`${f}\``).join(", ")}. ${g.suggestion}`);
  if (plan.extraChecks.length) { L.push("", "## Extra checks suggested"); for (const x of plan.extraChecks) L.push(`- ${x}`); }
  L.push("", "## Evidence rules for this change", "");
  if (plan.generalEvidence.length === 0) L.push("No app screen or service code changed; keep the applicable command output and a reason no app path changed.");
  for (const e of plan.generalEvidence) L.push(`- ${e}`);
  L.push("", "## Changed files", "");
  for (const f of plan.files.slice(0, 200)) L.push(`- \`${f.path}\` +${f.added} -${f.removed}`);
  return L.join("\n") + "\n";
}

/** Write the plan to data/qa/plans/ and return the file path. */
export function writePlan(cfg: GuardConfig, plan: TestPlan, when: Date = new Date()): string {
  const dir = join(cfg.dataDir, "qa", "plans");
  mkdirSync(dir, { recursive: true });
  const stamp = when.toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
  const file = join(dir, `${plan.repo}-${plan.head.slice(0, 7)}-${stamp}.md`);
  writeFileSync(file, planMarkdown(plan, when));
  return file;
}
