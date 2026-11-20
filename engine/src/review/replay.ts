// Defect replay: take past fix commits, find the commits that introduced the lines the fix changed,
// run the reviewer on the introducing change, and score whether it pointed at the later-fixed lines.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import type { Db } from "../index/db.ts";
import { parseDiff } from "./diff.ts";
import { gitTry, revParse } from "./git.ts";
import { reviewChange } from "./reviewer.ts";
import type { Review, ReviewDeps } from "./reviewer.ts";
import { resolveRepo } from "./context.ts";
import { isTestPath } from "./tier0.ts";
import { classOf, triage } from "./rank.ts";
import { BlockedError } from "../brain/client.ts";
import type { Finding } from "./tier0.ts";
import { reviewsDir } from "./report.ts";

/** A commit subject that looks like a fix. */
export const FIX_SUBJECT = /\b(fix(es|ed)?|bug|broken|regression|revert)\b/i;
/** A finding counts as pointing at the bug when it is within this many lines of the fixed line. */
export const LINE_TOLERANCE = 3;
/** Fix commits that touch more files than this are skipped (merges of many ideas, not one bug). */
export const MAX_FIX_FILES = 12;
/** Fixed lines blamed per file, so one huge fix stays cheap. */
export const MAX_BLAME_LINES_PER_FILE = 40;
/** Introducing commits followed per fix. */
export const MAX_INTRODUCERS_PER_FIX = 3;
/** Fix commits looked at, as a multiple of the wanted number, before giving up. */
export const SCAN_FACTOR = 12;
/** Most introducing changes sent to the model in one replay (cost cap). */
export const DEFAULT_MODEL_CAP = 10;
/** A change with more added lines than this is not sent to the model in replay (big imports are cost, not signal). */
export const MODEL_MAX_ADDED_LINES = 6000;
function addedLinesOf(repoPath: string, sha: string): number {
  const text = gitTry(repoPath, ["show", "--numstat", "--format=", sha]) ?? "";
  let n = 0;
  for (const l of text.split("\n")) n += Number(l.split("\t")[0]) || 0;
  return n;
}
const CODE_FILE =/\.(ts|tsx|js|mjs|rs|py|cs)$/;

export interface Truth { file: string; line: number; fixSha: string; fixSubject: string }

export interface ReplayCase {
  introSha: string;
  introSubject: string;
  truths: Truth[];
  /** Model findings on this change (only when the model ran), and whether each was near a later-fixed line. */
  modelFindings?: { file: string; line: number; severity: string; message: string; hit: boolean }[];
}

export interface Score {
  cases: number;
  detected: number;
  fileDetected: number;
  findings: number;
  matching: number;
}

export interface ReplayResult {
  repo: string;
  fixesLooked: number;
  fixesUsed: number;
  introducers: number;
  /** Defect-class fixed checks only. Policy findings are not bug predictors and are never scored. */
  tier0: Score;
  /** The same defect findings after the top-5 cap that each review applies. */
  tier0Top: Score;
  /** Policy-class findings: counted per rule, never scored (rule compliance). */
  policy: Map<string, number>;
  model: Score | null;
  modelRuns: number;
  /** Changes the model was not sent because masking found secret-like values in them. */
  modelBlocked: number;
  perRule: Map<string, { findings: number; matching: number }>;
  reportPath: string;
  cases: ReplayCase[];
}

export interface ReplayOptions {
  repo: string;
  limit: number;
  model: boolean;
  modelCap?: number;
}

function today(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function ranges(lines: number[]): [number, number][] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b).slice(0, MAX_BLAME_LINES_PER_FILE);
  const out: [number, number][] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/** Commits and lines that introduced the lines the fix touched, as blamed at the fix's parent. */
export function findIntroducers(repoPath: string, fixSha: string): Map<string, { file: string; line: number }[]> {
  const out = new Map<string, { file: string; line: number }[]>();
  const text = gitTry(repoPath, ["diff", "--no-color", "--no-ext-diff", "-M", "-U0", `${fixSha}~1`, fixSha]);
  if (!text) return out;
  const { files } = parseDiff(text);
  if (files.length === 0 || files.length > MAX_FIX_FILES) return out;
  for (const f of files) {
    if (f.status === "added" || !CODE_FILE.test(f.path) || isTestPath(f.path)) continue;
    const oldPath = f.oldPath ?? f.path;
    const fixed = [...f.removed];
    // A pure addition (a missing check): blame the line it was inserted after.
    for (const h of f.hunks) if (h.oldLines === 0 && h.oldStart >= 1) fixed.push(h.oldStart);
    for (const [a, b] of ranges(fixed)) {
      const blame = gitTry(repoPath, ["blame", "--line-porcelain", "-w", "-M", "-L", `${a},${b}`, `${fixSha}~1`, "--", oldPath]);
      if (!blame) continue;
      let cur: { sha: string; line: number } | null = null;
      for (const l of blame.split("\n")) {
        const h = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(l);
        if (h) { cur = { sha: h[1] as string, line: Number(h[2]) }; continue; }
        const fn = /^filename (.+)$/.exec(l);
        if (fn && cur) {
          const list = out.get(cur.sha) ?? [];
          list.push({ file: fn[1] as string, line: cur.line });
          out.set(cur.sha, list);
          cur = null;
        }
      }
    }
  }
  return out;
}

function isMergeOrRoot(repoPath: string, sha: string): boolean {
  const parents = (gitTry(repoPath, ["rev-list", "--parents", "-n", "1", sha]) ?? "").trim().split(/\s+/).length - 1;
  return parents !== 1;
}

function near(f: Finding, t: Truth): boolean {
  return f.file === t.file && Math.abs(f.line - t.line) <= LINE_TOLERANCE;
}

function emptyScore(): Score {
  return { cases: 0, detected: 0, fileDetected: 0, findings: 0, matching: 0 };
}

function scoreInto(s: Score, truths: Truth[], findings: Finding[], perRule?: ReplayResult["perRule"]): void {
  for (const t of truths) {
    s.cases++;
    if (findings.some((f) => near(f, t))) s.detected++;
    if (findings.some((f) => f.file === t.file)) s.fileDetected++;
  }
  for (const f of findings) {
    const hit = truths.some((t) => near(f, t));
    s.findings++;
    if (hit) s.matching++;
    if (perRule) {
      const r = perRule.get(f.rule) ?? { findings: 0, matching: 0 };
      r.findings++;
      if (hit) r.matching++;
      perRule.set(f.rule, r);
    }
  }
}

const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${Math.round((a / b) * 100)}%`);

export async function runReplay(
  cfg: GuardConfig, db: Db, opts: ReplayOptions, deps: ReviewDeps = {}, now: Date = new Date(),
): Promise<ReplayResult> {
  const repo = resolveRepo(cfg, opts.repo);
  const rows = db.prepare(
    "SELECT ref, title FROM docs WHERE kind='commit' AND repo=? ORDER BY julianday(date) DESC",
  ).all(repo.id) as { ref: string; title: string }[];
  const fixes = rows.filter((r) => FIX_SUBJECT.test(r.title)).slice(0, opts.limit * SCAN_FACTOR);

  const repoRef = cfg.repos.some((r) => r.id === repo.id) ? repo.id : repo.path;
  const byIntro = new Map<string, Truth[]>();
  let fixesUsed = 0;
  let looked = 0;
  for (const fx of fixes) {
    if (fixesUsed >= opts.limit) break;
    looked++;
    const fixSha = fx.ref.slice(fx.ref.indexOf("@") + 1);
    if (!revParse(repo.path, fixSha) || isMergeOrRoot(repo.path, fixSha)) continue;
    const intro = [...findIntroducers(repo.path, fixSha).entries()]
      .filter(([sha]) => !isMergeOrRoot(repo.path, sha))
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_INTRODUCERS_PER_FIX);
    if (intro.length === 0) continue;
    fixesUsed++;
    for (const [sha, pts] of intro) {
      const list = byIntro.get(sha) ?? [];
      for (const p of pts) list.push({ file: p.file, line: p.line, fixSha, fixSubject: fx.title });
      byIntro.set(sha, list);
    }
  }

  const result: ReplayResult = {
    repo: repo.id, fixesLooked: looked, fixesUsed, introducers: byIntro.size,
    tier0: emptyScore(), tier0Top: emptyScore(), policy: new Map(), model: opts.model ? emptyScore() : null, modelRuns: 0, modelBlocked: 0,
    perRule: new Map(), reportPath: "", cases: [],
  };
  const cap = opts.modelCap ?? DEFAULT_MODEL_CAP;
  for (const [introSha, truths] of byIntro) {
    let useModel = opts.model && deps.complete !== undefined && result.modelRuns < cap && addedLinesOf(repo.path, introSha) <= MODEL_MAX_ADDED_LINES;
    let review: Review;
    const req = { repo: repoRef, base: `${introSha}~1`, head: introSha, skipCochange: true };
    try {
      review = await reviewChange(cfg, null, req, useModel ? deps : {});
    } catch (e) {
      if (useModel && e instanceof BlockedError) {
        // The masking step found secret-like values in this change and sent nothing. Keep the fixed checks, skip the model.
        result.modelBlocked++;
        useModel = false;
        try { review = await reviewChange(cfg, null, req, {}); } catch { continue; }
      } else if (useModel) throw e;
      else continue;
    }
    if (useModel) result.modelRuns++;
    const subject = (gitTry(repo.path, ["log", "-1", "--format=%s", introSha]) ?? "").trim();
    const entry: ReplayCase = { introSha, introSubject: subject, truths };
    result.cases.push(entry);
    // Truth is per (file, line) of the introducing commit; the same point reached by two fixes counts once.
    const uniq = [...new Map(truths.map((t) => [`${t.file}:${t.line}`, t])).values()];
    const defects = review.tier0.filter((f) => classOf(f) === "defect");
    scoreInto(result.tier0, uniq, defects, result.perRule);
    scoreInto(result.tier0Top, uniq, triage(defects).shown);
    for (const f of review.tier0) if (classOf(f) === "policy") result.policy.set(f.rule, (result.policy.get(f.rule) ?? 0) + 1);
    if (result.model && useModel) {
      scoreInto(result.model, uniq, review.findings);
      entry.modelFindings = review.findings.map((f) => ({
        file: f.file, line: f.line, severity: f.severity, message: f.message.slice(0, 200), hit: uniq.some((t) => near(f, t)),
      }));
    }
  }

  const dir = reviewsDir(cfg);
  mkdirSync(dir, { recursive: true });
  result.reportPath = join(dir, `replay-${today(now)}.md`);
  writeFileSync(result.reportPath, renderReplay(result, opts));
  return result;
}

function scoreRow(name: string, s: Score): string {
  return `| ${name} | ${s.cases} | ${s.detected} (${pct(s.detected, s.cases)}) | ${s.fileDetected} (${pct(s.fileDetected, s.cases)}) | ${s.findings} | ${s.matching} | ${pct(s.matching, s.findings)} |`;
}

export function renderReplay(r: ReplayResult, opts: ReplayOptions): string {
  const lines = [
    `# Defect replay for ${r.repo}`, "",
    "Shadow mode: this report is only saved here. Nothing was posted or changed.", "",
    `- Fix commits used: ${r.fixesUsed} (looked at ${r.fixesLooked}, wanted ${opts.limit})`,
    `- Introducing changes reviewed: ${r.introducers}`,
    `- Model: ${opts.model ? `used on ${r.modelRuns} changes (cap ${opts.modelCap ?? DEFAULT_MODEL_CAP}); ${r.modelBlocked} changes not sent because masking found secret-like values` : "not used (fixed checks only)"}`,
    `- A finding counts as a hit when it is in the same file within ${LINE_TOLERANCE} lines of a line the later fix changed.`, "",
    "| Source | Later-fixed lines | Found (+/-3 lines) | Found (same file) | Findings | Matching | Precision |",
    "|---|---|---|---|---|---|---|",
    scoreRow("Fixed checks, defect class", r.tier0),
    scoreRow("Fixed checks, defect class, top 5 per change", r.tier0Top),
  ];
  if (r.model) lines.push(scoreRow("Model", r.model));
  lines.push("", "Precision here is a floor. A finding that is not near a later fix may still be a real problem nobody has fixed yet.",
    "The co-change check is left out of replay, because today's history already contains the later fix.", "",
    "## Defect checks by rule", "", "| Rule | Findings | Matching |", "|---|---|---|");
  for (const [rule, v] of [...r.perRule.entries()].sort((a, b) => b[1].findings - a[1].findings)) {
    lines.push(`| ${rule} | ${v.findings} | ${v.matching} |`);
  }
  if (r.perRule.size === 0) lines.push("| (none) | 0 | 0 |");
  lines.push("", "## Rule compliance (policy class, not scored)", "",
    "Aura's written rules. They are not bug predictors, so they are not matched against later fixes.", "",
    "| Rule | Findings |", "|---|---|");
  for (const [rule, n] of [...r.policy.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${rule} | ${n} |`);
  if (r.policy.size === 0) lines.push("| (none) | 0 |");
  lines.push("", "## Cases", "");
  for (const c of r.cases) {
    const fix = c.truths[0]?.fixSubject ?? "";
    lines.push(`- ${c.introSha.slice(0, 8)} "${c.introSubject}" was later fixed by "${fix}" (${c.truths.length} lines)`);
    for (const m of c.modelFindings ?? []) lines.push(`  - model (${m.severity}) ${m.file}:${m.line} ${m.hit ? "HIT" : "miss"}: ${m.message}`);
  }
  return lines.join("\n") + "\n";
}

