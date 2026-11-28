// PR Readiness Manager & Developer Suggestions Engine:
// Aggregates git diff, Tier 0 defect/policy findings, code-graph blast radius,
// latest QA scorecard, PR evidence checklist, and AI activity log coverage.

import { existsSync } from "node:fs";
import type { Db } from "../index/db.ts";
import { blastRadius } from "../index/graph.ts";
import { isLogged, readLoggedShas } from "../logcheck/logcheck.ts";
import { listQaRuns } from "../qa/harness_api.ts";
import type { ReleaseGate } from "../qa/harness_api.ts";
import { maskDeep } from "../qa/safe-out.ts";
import { classifyChange, evaluateEvidence, evidenceMarkdown } from "../qa/evidence_scope.ts";
import type { EvidenceStatus } from "../qa/evidence_scope.ts";
import { readDiff } from "../review/diff.ts";
import type { DiffResult } from "../review/diff.ts";
import { gitTry, pathExistsAt } from "../review/git.ts";
import { loadRules, loadTier0ActiveChecks, runTier0 } from "../review/tier0.ts";
import type { Finding } from "../review/tier0.ts";
import type { GuardConfig } from "../types.ts";

export interface DeveloperSuggestion {
  priority: "high" | "medium" | "low";
  category: "defect" | "policy" | "evidence" | "blast-radius" | "ai-log";
  file?: string;
  line?: number;
  title: string;
  action: string;
}

export interface PrReadinessReport {
  generatedAt: string;
  repo: string;
  baseSha: string;
  headSha: string;
  releaseGate: ReleaseGate;
  gateReasons: string[];
  changedFiles: { path: string; status: string; added: number; removed: number }[];
  defectFindings: Finding[];
  policyFindings: Finding[];
  blastRadius: { file: string; dependents: string[] }[];
  aiLog: { headLogged: boolean; readmeExists: boolean };
  evidenceChecklist: {
    uiChange: boolean;
    serviceChange: boolean;
    required: string[];
    latestQaRunId: string | null;
    latestQaGate: ReleaseGate | null;
  };
  developerSuggestions: DeveloperSuggestion[];
  /** No saved evidence is tied to a commit, so nothing is credited here. */
  evidenceScope: EvidenceStatus;
  prSummaryMarkdown: string;
}

function resolveTargetRepo(cfg: GuardConfig, repoId?: string) {
  if (repoId) {
    const found = cfg.repos.find((r) => r.id === repoId);
    if (found) return found;
  }
  return cfg.repos.find((r) => r.id === "spil-aura") ?? cfg.repos[0] ?? null;
}

export function buildPrReadinessReport(
  cfg: GuardConfig,
  db: Db | null,
  opts: { repo?: string; base?: string; head?: string } = {},
): PrReadinessReport {
  const repo = resolveTargetRepo(cfg, opts.repo);
  let diff: DiffResult = { base: "HEAD~1", head: "HEAD", baseSha: "", headSha: "", files: [], skipped: [] };
  let repoName = repo?.id ?? "none";

  if (repo && existsSync(repo.path)) {
    try {
      diff = readDiff(repo.path, {
        ...(opts.base ? { base: opts.base } : {}),
        ...(opts.head ? { head: opts.head } : {}),
      });
    } catch {
      /* non-git folder or single-commit repo */
    }
  }

  const tier0 = repo && diff.files.length > 0
    ? runTier0(diff, {
        rules: loadRules(cfg.root),
        db,
        repoId: repo.id,
        exists: (p) => pathExistsAt(repo.path, diff.headSha, p),
        readFile: (p) => gitTry(repo.path, ["show", `${diff.headSha}:${p}`]),
        activeChecks: loadTier0ActiveChecks(cfg),
      })
    : [];

  const defectFindings = tier0.filter((f) => (f.class ?? "policy") === "defect");
  const policyFindings = tier0.filter((f) => f.class === "policy");

  const blast: { file: string; dependents: string[] }[] = [];
  if (db && repo) {
    for (const f of diff.files.slice(0, 12)) {
      try {
        const deps = blastRadius(db, repo.id, f.path).map((b) => b.path || b.id).filter(Boolean);
        if (deps.length > 0) blast.push({ file: f.path, dependents: [...new Set(deps)].slice(0, 8) });
      } catch {
        /* graph table empty */
      }
    }
  }

  let headLogged = false;
  let readmeExists = false;
  if (repo && existsSync(repo.path)) {
    const logs = readLoggedShas(repo.path);
    readmeExists = logs.readmeExists;
    headLogged = diff.headSha ? isLogged(diff.headSha, logs.shas) : false;
  }

  const uiChange = diff.files.some((f) => /\.(tsx|jsx|css|html)$/i.test(f.path));
  const serviceChange = diff.files.some((f) => /\.(rs|cs|sql)$/i.test(f.path) || /(mcp|erp|api|server)/i.test(f.path));

  const evidenceScope = evaluateEvidence(
    classifyChange(diff.files.map((f) => f.path)), [],
    diff.files.length ? [] : ["No changed files could be read for this repository."],
  );
  const required = evidenceScope.requirements.map((x) => x.label);

  const qaRuns = listQaRuns(cfg);
  const latest = qaRuns.runs[0] ?? null;

  const suggestions: DeveloperSuggestion[] = [];
  for (const f of defectFindings.slice(0, 6)) {
    suggestions.push({
      priority: f.severity === "blocker" ? "high" : "medium",
      category: "defect",
      file: f.file,
      line: f.line,
      title: `Fix ${f.rule} in ${f.file}:${f.line}`,
      action: f.message,
    });
  }
  for (const f of policyFindings.slice(0, 4)) {
    suggestions.push({
      priority: f.severity === "blocker" ? "high" : "low",
      category: "policy",
      file: f.file,
      line: f.line,
      title: `Policy ${f.rule} in ${f.file}:${f.line}`,
      action: f.message,
    });
  }
  if (blast.length > 0) {
    const top = blast[0]!;
    suggestions.push({
      priority: "medium",
      category: "blast-radius",
      file: top.file,
      title: `Check ${top.dependents.length} dependent file(s) of ${top.file}`,
      action: `Verify callers/dependents: ${top.dependents.slice(0, 4).join(", ")}`,
    });
  }
  if (uiChange && (!latest || latest.scorecard.releaseGate !== "pass")) {
    suggestions.push({
      priority: "high",
      category: "evidence",
      title: "Capture 800 / 1100 / 1440 px UI evidence before PR ready",
      action: "Run AURA QA on the running app and export a PR Evidence Packet.",
    });
  }
  if (readmeExists && diff.headSha && !headLogged) {
    suggestions.push({
      priority: "low",
      category: "ai-log",
      title: "Add AI activity log entry for HEAD commit",
      action: `Record commit ${diff.headSha.slice(0, 7)} in ai-log/ before handoff.`,
    });
  }

  const gateReasons: string[] = [];
  let releaseGate: ReleaseGate = "pass";
  if (tier0.some((f) => f.severity === "blocker") || latest?.scorecard.releaseGate === "block") {
    releaseGate = "block";
    if (tier0.some((f) => f.severity === "blocker")) gateReasons.push("Blocker finding(s) reported by Tier 0 checks.");
    if (latest?.scorecard.releaseGate === "block") gateReasons.push("Latest QA run release gate is BLOCK.");
  } else if (defectFindings.length > 0 || (uiChange && (!latest || latest.scorecard.releaseGate !== "pass"))) {
    releaseGate = "warn";
    if (defectFindings.length > 0) gateReasons.push(`${defectFindings.length} Tier 0 defect finding(s) need review.`);
    if (uiChange && (!latest || latest.scorecard.releaseGate !== "pass")) gateReasons.push("UI changed without a passing QA evidence run.");
  } else {
    gateReasons.push("No Tier 0 blockers or failed QA gates detected.");
  }

  const mdLines = [
    `## PR Readiness Summary (${repoName})`,
    "",
    `- **Release Gate:** **${releaseGate.toUpperCase()}** — ${gateReasons.join(" ")}`,
    `- **Changed files:** ${diff.files.length} (${uiChange ? "UI" : "non-UI"}${serviceChange ? " + service" : ""})`,
    `- **Tier 0 findings:** ${defectFindings.length} defect(s), ${policyFindings.length} policy note(s)`,
    `- **Latest QA run:** ${latest ? `\`${latest.id}\` (${latest.scorecard.releaseGate.toUpperCase()})` : "none recorded"}`,
    `- **AI log:** ${readmeExists ? (headLogged ? "HEAD logged" : "HEAD missing from ai-log") : "no ai-log folder"}`,
    "",
    ...evidenceMarkdown(evidenceScope, "###"),
    "Saved proof is checked per QA run with `qa evidence <run-id>`; none is credited to this commit here.",
    "",
    "### Developer Suggestions",
    ...(suggestions.length
      ? suggestions.map((s) => `- **[${s.priority.toUpperCase()}]** ${s.title}: ${s.action}`)
      : ["- No suggestions; change looks clean."]),
    "",
  ];

  return maskDeep({
    generatedAt: new Date().toISOString(),
    repo: repoName,
    baseSha: diff.baseSha,
    headSha: diff.headSha,
    releaseGate,
    gateReasons,
    changedFiles: diff.files.map((f) => ({ path: f.path, status: f.status, added: f.added.length, removed: f.removed.length })),
    defectFindings,
    policyFindings,
    blastRadius: blast,
    aiLog: { headLogged, readmeExists },
    evidenceChecklist: {
      uiChange,
      serviceChange,
      required,
      latestQaRunId: latest?.id ?? null,
      latestQaGate: latest?.scorecard.releaseGate ?? null,
    },
    developerSuggestions: suggestions,
    evidenceScope,
    prSummaryMarkdown: mdLines.join("\n"),
  });
}
