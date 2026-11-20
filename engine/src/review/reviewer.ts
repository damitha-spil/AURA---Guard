// Code reviewer and defect finder. Diff -> fixed checks -> context -> ONE model call -> checked findings.
import { z } from "zod";
import type { GuardConfig } from "../types.ts";
import type { Db } from "../index/db.ts";
import type { CompleteFn } from "../brain/client.ts";
import { MAX_TOTAL_PATCH_CHARS, readDiff } from "./diff.ts";
import type { DiffFile, DiffResult, SkippedFile } from "./diff.ts";
import { gitTry, pathExistsAt } from "./git.ts";
import { loadRules, runTier0 } from "./tier0.ts";
import type { Finding } from "./tier0.ts";
import { confidenceOf, triage } from "./rank.ts";
import type { Triage } from "./rank.ts";
import {
  BLAST_FILES, blastFor, extractJson, formatNotes, limitOf, loadRoleFile, relevantNotes, resolveRepo, ruleTitles,
} from "./context.ts";

/** Used if reviewer.yaml omits the limits. The architecture says at most 5 comments a review. */
const FALLBACK_MAX_FINDINGS = 5;
const FALLBACK_MAX_TOKENS = 3000;
const FALLBACK_MAX_NOTES = 4;
const FALLBACK_NOTE_CHARS = 500;
/** A model finding this close (in lines) to a fixed-check finding in the same file is a repeat. */
export const DEDUPE_LINE_WINDOW = 2;

const SeveritySchema = z.enum(["blocker", "risk", "suggestion"]);
const ModelFindingSchema = z.object({
  file: z.string().min(1),
  line: z.coerce.number().int().positive(),
  severity: SeveritySchema,
  issue: z.string().min(1),
  why: z.string().default(""),
  suggestion: z.string().optional(),
  /** 0 to 1. Optional: used only to rank. Out-of-range values are clamped. */
  confidence: z.coerce.number().optional(),
});
const ReplySchema = z.object({ findings: z.array(z.unknown()) });

export interface ReviewRequest {
  repo: string;
  base?: string;
  head?: string;
  /** Replay runs leave the co-change check out: today's history already knows the later fix. */
  skipCochange?: boolean;
}

export interface ReviewDeps {
  /** Left out (or undefined) means fixed checks only. */
  complete?: CompleteFn;
  backendUsed?: () => string | null;
}

export interface ReviewStats {
  files: number;
  addedLines: number;
  removedLines: number;
  filesWithoutPatchInPrompt: number;
  modelFindingsRaw: number;
  modelDroppedInvalid: number;
  modelDroppedDuplicate: number;
  modelDroppedOutsideDiff: number;
  modelDroppedOverLimit: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Review {
  repo: string;
  repoPath: string;
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  /** Findings the model made that passed the checks. */
  findings: Finding[];
  /** Findings from the fixed checks. */
  tier0: Finding[];
  /** Fixed-check and model findings ranked and capped for the report (max 5 shown). */
  triage: Triage;
  model: { used: boolean; error?: string };
  backend: string | null;
  skipped: SkippedFile[];
  stats: ReviewStats;
}

/** The patch with the new-file line number in front of each added and unchanged line. */
export function numberedPatch(f: DiffFile): string {
  const out: string[] = [`FILE ${f.path} (${f.status})`];
  let n = 0;
  let inHunk = false;
  for (const l of f.patch.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { n = Number(h[1]); inHunk = true; out.push(l); continue; }
    if (!inHunk) continue;
    if (l.startsWith("+")) out.push(`L${n}+ ${l.slice(1)}`), n++;
    else if (l.startsWith(" ")) out.push(`L${n}  ${l.slice(1)}`), n++;
    else if (l.startsWith("-")) out.push(`    - ${l.slice(1)}`);
    else if (l.startsWith("...")) out.push(l);
  }
  return out.join("\n");
}

function normFile(p: string): string {
  return p.replace(/\\/g, "/").replace(/^(a|b)\//, "").replace(/^\.\//, "");
}

function lineInDiff(f: DiffFile, line: number): boolean {
  return f.hunks.some((h) => line >= h.newStart && line < h.newStart + Math.max(h.newLines, 1));
}

export function buildReviewPrompt(
  cfg: GuardConfig, db: Db | null, repoId: string, diff: DiffResult, tier0: Finding[],
): { system: string[]; user: string; maxFindings: number; maxTokens: number; omitted: number } {
  const role = loadRoleFile(cfg, "reviewer");
  const maxFindings = limitOf(role, "max_findings", FALLBACK_MAX_FINDINGS);
  const maxTokens = limitOf(role, "max_tokens", FALLBACK_MAX_TOKENS);
  const rules = (role.rules ?? []).map((r) => `- ${r}`).join("\n");
  const stable =
    `You are the Code Reviewer and defect finder for AURA Guard. You read one change to Aura (a Windows desktop app) and report problems.\n\nRules:\n${rules}\n\n` +
    `Reply with JSON: {"findings": [{"file": string, "line": number, "severity": "blocker"|"risk"|"suggestion", ` +
    `"issue": string, "why": string, "confidence": number 0 to 1 (how sure you are this is a real bug), "suggestion": string (optional, a minimal unified diff)}]}. ` +
    `At most ${maxFindings} findings. Use {"findings": []} when the change is fine.`;
  const titles = ruleTitles(cfg).join("\n");
  const rulesBlock = `Rules of the team (for context):\n${titles || "(none)"}`;

  const paths = diff.files.map((f) => f.path);
  const notes = relevantNotes(db, paths, limitOf(role, "max_context_notes", FALLBACK_MAX_NOTES), limitOf(role, "note_chars", FALLBACK_NOTE_CHARS));
  const lines: string[] = [`Change: ${diff.baseSha.slice(0, 10)}..${diff.headSha.slice(0, 10)}`, "Changed files:"];
  for (const f of diff.files) lines.push(`- ${f.path} (${f.status}) +${f.added.length} -${f.removed.length}`);
  if (tier0.length > 0) {
    lines.push("\nFixed checks already reported (do not repeat):");
    for (const t of tier0.slice(0, 30)) lines.push(`- ${t.file}:${t.line} ${t.rule}`);
  }
  const blast: string[] = [];
  for (const f of diff.files.slice(0, BLAST_FILES)) {
    const b = blastFor(db, repoId, f.path);
    if (b.length) blast.push(`- ${f.path} is used by: ${b.join(", ")}`);
  }
  if (blast.length) lines.push("\nWhat uses the changed files (code graph):", ...blast);
  lines.push("\nRelated notes:", formatNotes(notes));
  lines.push("\nThe change. L<n> is the line number in the new file; '-' lines were removed:");
  let used = 0;
  let omitted = 0;
  for (const f of diff.files) {
    const text = numberedPatch(f);
    if (used + text.length > MAX_TOTAL_PATCH_CHARS) { omitted++; continue; }
    used += text.length;
    lines.push(text);
  }
  if (omitted) lines.push(`(${omitted} more changed files are not shown; the budget is used up.)`);
  return { system: [stable, rulesBlock], user: lines.join("\n"), maxFindings, maxTokens, omitted };
}

/** Comments shown in a report: reviewer.yaml max_findings (5 by design). */
function shownCap(cfg: GuardConfig): number {
  return limitOf(loadRoleFile(cfg, "reviewer"), "max_findings", FALLBACK_MAX_FINDINGS);
}

export function validateModelFindings(
  raw: unknown[], diff: DiffResult, tier0: Finding[], maxFindings: number,
): { kept: Finding[]; invalid: number; duplicate: number; outside: number; overLimit: number } {
  let invalid = 0;
  let duplicate = 0;
  let outside = 0;
  const kept: Finding[] = [];
  for (const item of raw) {
    const p = ModelFindingSchema.safeParse(item);
    if (!p.success) { invalid++; continue; }
    const m = p.data;
    const path = normFile(m.file);
    const f = diff.files.find((x) => x.path === path);
    if (!f || !lineInDiff(f, m.line)) { outside++; continue; }
    const near = (o: Finding) => o.file === f.path && Math.abs(o.line - m.line) <= DEDUPE_LINE_WINDOW;
    if (tier0.some(near) || kept.some((o) => near(o) && o.message === m.issue)) { duplicate++; continue; }
    const text = f.addedLines.find((a) => a.line === m.line)?.text.trim() ?? "";
    const finding: Finding = {
      rule: "model-review", severity: m.severity, file: f.path, line: m.line,
      message: m.issue, evidence: text.slice(0, 140), why: m.why, class: "defect",
    };
    if (m.confidence !== undefined && Number.isFinite(m.confidence)) finding.confidence = Math.min(1, Math.max(0, m.confidence));
    if (m.suggestion?.trim()) finding.suggestion = m.suggestion;
    kept.push(finding);
  }
  const sorted = [...kept].sort((a, b) => confidenceOf(b) - confidenceOf(a)).sort((a, b) => (a.severity === "blocker" ? 0 : 1) - (b.severity === "blocker" ? 0 : 1));
  return { kept: sorted.slice(0, maxFindings), invalid, duplicate, outside, overLimit: Math.max(0, sorted.length - maxFindings) };
}

export async function reviewChange(
  cfg: GuardConfig, db: Db | null, req: ReviewRequest, deps: ReviewDeps = {},
): Promise<Review> {
  const repo = resolveRepo(cfg, req.repo);
  const diff = readDiff(repo.path, {
    ...(req.base ? { base: req.base } : {}), ...(req.head ? { head: req.head } : {}),
  });
  const tier0 = runTier0(diff, {
    rules: loadRules(cfg.root), db, repoId: repo.id,
    exists: (p) => pathExistsAt(repo.path, diff.headSha, p),
    readFile: (p) => gitTry(repo.path, ["show", `${diff.headSha}:${p}`]),
    ...(req.skipCochange ? { skipCochange: true } : {}),
  });
  const stats: ReviewStats = {
    files: diff.files.length,
    addedLines: diff.files.reduce((n, f) => n + f.added.length, 0),
    removedLines: diff.files.reduce((n, f) => n + f.removed.length, 0),
    filesWithoutPatchInPrompt: 0,
    modelFindingsRaw: 0, modelDroppedInvalid: 0, modelDroppedDuplicate: 0,
    modelDroppedOutsideDiff: 0, modelDroppedOverLimit: 0, inputTokens: 0, outputTokens: 0,
  };
  const review: Review = {
    repo: repo.id, repoPath: repo.path, base: diff.base, head: diff.head,
    baseSha: diff.baseSha, headSha: diff.headSha, findings: [], tier0, triage: triage(tier0, shownCap(cfg)),
    model: { used: false }, backend: null, skipped: diff.skipped, stats,
  };
  if (!deps.complete || diff.files.length === 0) return review;

  const p = buildReviewPrompt(cfg, db, repo.id, diff, tier0);
  stats.filesWithoutPatchInPrompt = p.omitted;
  const res = await deps.complete({ role: "reviewer", system: p.system, user: p.user, maxTokens: p.maxTokens });
  review.model = { used: true };
  review.backend = deps.backendUsed?.() ?? null;
  stats.inputTokens = res.usage.input_tokens;
  stats.outputTokens = res.usage.output_tokens;
  try {
    const reply = ReplySchema.parse(extractJson(res.text, "Reviewer"));
    stats.modelFindingsRaw = reply.findings.length;
    const v = validateModelFindings(reply.findings, diff, tier0, p.maxFindings);
    review.findings = v.kept;
    stats.modelDroppedInvalid = v.invalid;
    stats.modelDroppedDuplicate = v.duplicate;
    stats.modelDroppedOutsideDiff = v.outside;
    stats.modelDroppedOverLimit = v.overLimit;
  } catch (e) {
    // The fixed checks still stand; say plainly that the model part failed.
    review.model = { used: true, error: e instanceof Error ? e.message : String(e) };
  }
  review.triage = triage([...tier0, ...review.findings], shownCap(cfg));
  return review;
}
