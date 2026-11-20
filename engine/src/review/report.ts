// Writes review reports as Markdown under data/reviews/<repo>/. Shadow mode: nothing is posted anywhere.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import type { Review } from "./reviewer.ts";
import type { RefactorResult } from "./refactor.ts";
import type { Finding } from "./tier0.ts";
import { countByRule } from "./rank.ts";

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

function findingBlock(f: Finding, patchFile?: string): string[] {
  const out = [`- **${f.severity}** \`${f.file}:${f.line}\` (${f.rule}): ${f.message}`];
  if (f.why) out.push(`  - ${copy.why}: ${f.why}`);
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

export interface WrittenReport { reportPath: string; patchPaths: string[] }

export function writeReviewReport(cfg: GuardConfig, r: Review, now: Date = new Date()): WrittenReport {
  const dir = join(reviewsDir(cfg), r.repo);
  mkdirSync(dir, { recursive: true });
  const stem = `${today(now)}-${r.headSha.slice(0, 8)}`;
  const reportPath = join(dir, `${stem}.md`);
  const patchPaths: string[] = [];
  const lines: string[] = [
    `# ${copy.title(r.repo, r.baseSha.slice(0, 8), r.headSha.slice(0, 8))}`, "", copy.shadow, "",
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
  lines.push("", `## ${copy.comments(t.shown.length)}`, "");
  if (t.shown.length === 0) lines.push(copy.nothing);
  for (const f of t.shown) lines.push(...block(f));
  if (t.moreDefects.length > 0) lines.push("", copy.lowerPriority(t.moreDefects.length));
  if (r.model.used && r.model.error) lines.push("", copy.modelFailed(r.model.error));
  if (!r.model.used) lines.push("", copy.noModel);

  lines.push("", `## ${copy.compliance}`, "", copy.complianceNote);
  if (t.policy.length === 0) lines.push("", copy.nothing);
  else {
    lines.push("", "| Rule | Findings |", "|---|---|");
    for (const [rule, n] of countByRule(t.policy)) lines.push(`| ${rule} | ${n} |`);
  }

  if (t.moreDefects.length > 0 || t.policy.length > 0) {
    lines.push("", `## ${copy.appendix}`, "");
    for (const f of t.moreDefects) lines.push(...block(f));
    const seen = new Map<string, number>();
    for (const f of t.policy) {
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
  writeFileSync(reportPath, lines.join("\n") + "\n");
  return { reportPath, patchPaths };
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
