// Writes review reports as Markdown under data/reviews/<repo>/. Shadow mode: nothing is posted anywhere.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import type { Review } from "./reviewer.ts";
import type { RefactorResult } from "./refactor.ts";
import type { Finding } from "./tier0.ts";
import { countByRule } from "./rank.ts";
import { classifyChange, evaluateEvidence, evidenceMarkdown } from "../qa/evidence_scope.ts";

/** Policy findings listed per rule in the appendix; the rest are only counted. */
export const APPENDIX_POLICY_PER_RULE = 25;

export function reviewsDir(cfg: GuardConfig): string {
  return join(cfg.dataDir, "reviews");
}

function today(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const copy = {
  title: (repo: string, base: string, head: string) => `Review of ${repo}: ${base} to ${head}`,
  shadow: "Shadow mode: this report is only saved here. Nothing was posted or changed in the repository.",
  summary: "Summary",
  nothing: "Nothing to report.",
  fixedChecks: "Fixed checks",
  comments: (n: number) => `Comments (top ${n}, most important first)`,
  lowerPriority: (n: number) => `+${n} lower priority (listed in the appendix).`,
  compliance: "Rule compliance",
  complianceNote: "Aura's written rules (no hard-coding, Tailwind only, copy in copy.ts, and so on). These are not bug predictions; the full list is in the appendix.",
  appendix: "Appendix: lower priority findings",
  modelFindings: "Model review",
  noModel: "The model was not used for this review.",
  modelFailed: (e: string) => `The model answer could not be used: ${e}`,
  skipped: "Skipped files",
  suggestion: "Suggested patch",
  why: "Why",
  evidence: "Evidence",
  notChecked: "The patch was not checked against the file.",
};

/** Review rounds allowed for one change (same repo and base) before the report stops adding comments. Keeps a review from looping. */
export const MAX_REVIEW_ROUNDS = 3;
/** Longest finding text in a report line. Longer text is cut at a word. */
export const MAX_REPORT_TEXT_CHARS = 240;

/**
 * Plain-language rule for report text: short, direct sentences; say what is wrong and what to do;
 * no filler and no unexplained jargon. In code this means one line per finding, whitespace collapsed,
 * and no line longer than MAX_REPORT_TEXT_CHARS.
 */
export const PLAIN_REPORT_RULE = "Write for a busy reader: one short sentence for the problem, one for the fix. No filler, no jargon.";

export function plainText(s: string, max = MAX_REPORT_TEXT_CHARS): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return (at > max / 2 ? cut.slice(0, at) : cut).trimEnd() + "…";
}

/** Owner fixes blockers and risks (the change cannot ship without them); the reviewer judges suggestions. */
export function splitFindings(list: Finding[]): { owner: Finding[]; reviewer: Finding[] } {
  return {
    owner: list.filter((f) => f.severity === "blocker" || f.severity === "risk"),
    reviewer: list.filter((f) => f.severity === "suggestion"),
  };
}

/** Which round this report is: earlier reports for the same repo and base commit, plus this one. */
export function reviewRound(dir: string, titlePrefix: string, headStem: string): number {
  if (!existsSync(dir)) return 1;
  let others = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") || f === `${headStem}.md` || f.includes("-refactor-")) continue;
    try {
      if (readFileSync(join(dir, f), "utf8").split("\n", 1)[0]?.startsWith(`# ${titlePrefix}`)) others++;
    } catch { /* unreadable file: not counted */ }
  }
  return others + 1;
}

/** The line shown wherever a review round is shown. */
export function roundLine(round: number, max: number): string {
  return `Review round ${round} of ${max}.${round > max ? " The round limit is reached: only blockers are listed. Decide with the owner before another round." : ""}`;
}

/** Remembered base commits, so the rounds file cannot grow without end. */
const MAX_ROUND_BASES = 200;

/**
 * Round number for a review that saves no report (the app's repository review). A round is one distinct
 * change against the same base commit; reviewing the same change again keeps its number.
 */
export function noteReviewRound(dir: string, baseSha: string, changeKey: string): number {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rounds.json");
  let all: Record<string, string[]> = {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) all = v as Record<string, string[]>;
  } catch { /* no file yet, or unreadable: start again */ }
  const seen = Array.isArray(all[baseSha]) ? (all[baseSha] as string[]) : [];
  const at = seen.indexOf(changeKey);
  if (at >= 0) return at + 1;
  all[baseSha] = [...seen, changeKey];
  const bases = Object.keys(all);
  for (const old of bases.slice(0, Math.max(0, bases.length - MAX_ROUND_BASES))) delete all[old];
  writeFileSync(file, JSON.stringify(all));
  return seen.length + 1;
}

function findingBlock(f: Finding, patchFile?: string): string[] {
  const out = [`- **${f.severity}** \`${f.file}:${f.line}\` (${f.rule}): ${plainText(f.message)}`];
  if (f.why) out.push(`  - ${copy.why}: ${plainText(f.why)}`);
  if (f.evidence) out.push(`  - ${copy.evidence}: ${f.evidence.replace(/\n/g, " ")}`);
  if (patchFile) out.push(`  - ${copy.suggestion}: \`${patchFile}\` (${copy.notChecked})`);
  return out;
}

function counts(list: Finding[]): string {
  const c = { blocker: 0, risk: 0, suggestion: 0 };
  for (const f of list) c[f.severity]++;
  return `${c.blocker} blocker, ${c.risk} risk, ${c.suggestion} suggestion`;
}

export function countsLine(list: Finding[]): string {
  return counts(list);
}

export interface WrittenReport {
  reportPath: string;
  patchPaths: string[];
  /** Set for change reviews: the round, and the comments the report lists as its top ones. */
  round?: { n: number; max: number; capped: boolean };
  shown?: Finding[];
}

export function writeReviewReport(cfg: GuardConfig, r: Review, now: Date = new Date(), maxRounds: number = MAX_REVIEW_ROUNDS): WrittenReport {
  const dir = join(reviewsDir(cfg), r.repo);
  mkdirSync(dir, { recursive: true });
  const stem = `${today(now)}-${r.headSha.slice(0, 8)}`;
  const reportPath = join(dir, `${stem}.md`);
  const patchPaths: string[] = [];
  // Earlier reports for the same repo and base are earlier rounds. Past the cap only blockers are listed.
  const round = reviewRound(dir, `Review of ${r.repo}: ${r.baseSha.slice(0, 8)} to `, stem);
  const capped = round > maxRounds;
  const lines: string[] = [
    `# ${copy.title(r.repo, r.baseSha.slice(0, 8), r.headSha.slice(0, 8))}`, "", copy.shadow, "",
    roundLine(round, maxRounds), "",
    `## ${copy.summary}`, "",
    `- Files reviewed: ${r.stats.files} (+${r.stats.addedLines} -${r.stats.removedLines} lines)`,
    `- ${copy.fixedChecks}: ${counts(r.tier0)}`,
    `- ${copy.modelFindings}: ${r.model.used ? (r.model.error ? "failed" : counts(r.findings)) : "not used"}${r.backend ? ` (backend: ${r.backend})` : ""}`,
  ];
  if (r.model.used && !r.model.error) {
    const s = r.stats;
    lines.push(`- Model findings dropped: ${s.modelDroppedDuplicate} repeats, ${s.modelDroppedOutsideDiff} outside the change, ${s.modelDroppedInvalid} badly shaped, ${s.modelDroppedOverLimit} over the limit`);
  }
  const t = r.triage;
  let patchNo = 0;
  const block = (f: Finding): string[] => {
    let patchFile: string | undefined;
    if (f.suggestion) {
      patchFile = `${stem}-${++patchNo}.patch`;
      const p = join(dir, patchFile);
      writeFileSync(p, f.suggestion.endsWith("\n") ? f.suggestion : f.suggestion + "\n");
      patchPaths.push(p);
    }
    return findingBlock(f, patchFile);
  };
  const shown = capped ? t.shown.filter((f) => f.severity === "blocker") : t.shown;
  const split = splitFindings(shown);
  lines.push("", `## ${copy.comments(shown.length)}`, "");
  if (shown.length === 0) lines.push(copy.nothing);
  if (split.owner.length) lines.push("### For the owner to fix", "");
  for (const f of split.owner) lines.push(...block(f));
  if (split.reviewer.length) lines.push("", "### For the reviewer to judge", "");
  for (const f of split.reviewer) lines.push(...block(f));
  // Past the cap nothing but blockers is listed anywhere in the report.
  const onlyBlockers = (list: Finding[]): Finding[] => (capped ? list.filter((f) => f.severity === "blocker") : list);
  const more = onlyBlockers(t.moreDefects);
  const policy = onlyBlockers(t.policy);
  if (more.length > 0) lines.push("", copy.lowerPriority(more.length));
  if (r.model.used && r.model.error) lines.push("", copy.modelFailed(r.model.error));
  if (!r.model.used) lines.push("", copy.noModel);

  lines.push("", `## ${copy.compliance}`, "", copy.complianceNote);
  if (policy.length === 0) lines.push("", copy.nothing);
  else {
    lines.push("", "| Rule | Findings |", "|---|---|");
    for (const [rule, n] of countByRule(policy)) lines.push(`| ${rule} | ${n} |`);
  }

  if (more.length > 0 || policy.length > 0) {
    lines.push("", `## ${copy.appendix}`, "");
    for (const f of more) lines.push(...block(f));
    const seen = new Map<string, number>();
    for (const f of policy) {
      const n = seen.get(f.rule) ?? 0;
      seen.set(f.rule, n + 1);
      if (n < APPENDIX_POLICY_PER_RULE) lines.push(...block(f));
    }
    for (const [rule, n] of seen) if (n > APPENDIX_POLICY_PER_RULE) lines.push(`- ${rule}: ${n - APPENDIX_POLICY_PER_RULE} more not listed.`);
  }
  if (r.skipped.length) {
    lines.push("", `## ${copy.skipped}`, "");
    for (const s of r.skipped.slice(0, 40)) lines.push(`- \`${s.path}\`: ${s.reason}`);
  }
  lines.push("", ...evidenceMarkdown(evaluateEvidence(classifyChange(r.changedPaths), [])), "This code review is not proof. Check saved proof per QA run with `qa evidence <run-id>`.");
  writeFileSync(reportPath, lines.join("\n") + "\n");
  return { reportPath, patchPaths, round: { n: round, max: maxRounds, capped }, shown };
}

export function writeRefactorReport(cfg: GuardConfig, r: RefactorResult, now: Date = new Date()): WrittenReport {
  const dir = join(reviewsDir(cfg), r.repo);
  mkdirSync(dir, { recursive: true });
  const slug = r.path.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-60);
  const stem = `${today(now)}-${r.headSha.slice(0, 8)}-refactor-${slug}`;
  const reportPath = join(dir, `${stem}.md`);
  const patchPaths: string[] = [];
  const lines: string[] = [
    `# Refactor ideas for ${r.path}`, "", copy.shadow, "",
    `- Repo: ${r.repo} at ${r.headSha.slice(0, 8)}`,
    `- Model: ${r.model.used ? (r.model.error ? "failed" : "used") : "not used"}${r.backend ? ` (backend: ${r.backend})` : ""}`,
  ];
  if (r.fileTruncatedForPrompt) lines.push("- The file is long; the model saw only the start of it.");
  lines.push(`- Used by (code graph): ${r.callers.length ? r.callers.join(", ") : "no graph data"}`, "");
  if (!r.model.used) lines.push(copy.noModel);
  else if (r.model.error) lines.push(copy.modelFailed(r.model.error));
  else if (r.refactors.length === 0) lines.push(copy.nothing);
  r.refactors.forEach((x, i) => {
    lines.push(`## ${i + 1}. ${x.title}`, "", `- ${copy.why}: ${x.why}`, `- Risk: ${x.risk}`);
    lines.push(`- Callers that may be affected: ${x.affected.length ? x.affected.join(", ") : "none listed"}`);
    if (x.patch) {
      const patchFile = `${stem}-${i + 1}.patch`;
      writeFileSync(join(dir, patchFile), x.patch);
      patchPaths.push(join(dir, patchFile));
      lines.push(`- Patch: \`${patchFile}\` (${x.applies ? "checked: it applies to the file at HEAD" : `DOES NOT APPLY: ${x.applyError ?? "unknown reason"}`})`);
    } else lines.push("- Patch: none given");
    lines.push("");
  });
  writeFileSync(reportPath, lines.join("\n") + "\n");
  return { reportPath, patchPaths };
}
