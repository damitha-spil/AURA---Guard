// One report data model with two renderers. "simple" is plain words: summary, risks, next steps.
// "technical" is JSON with ids, counts and timings. Routes pass ?view=simple|technical (default simple).

import type { QaRunDetail } from "../qa/harness_api.ts";
import type { ReviewResult } from "../repos/review.ts";

export type ReportView = "simple" | "technical";

export interface ReportModel {
  kind: "qa-run" | "review" | "daily-digest";
  title: string;
  summary: string;
  risks: string[];
  nextSteps: string[];
  /** Ids, counts and timings. Shown only in the technical view. */
  technical: Record<string, unknown>;
}

export type RenderedReport =
  | { view: "simple"; format: "text"; body: string }
  | { view: "technical"; format: "json"; body: Record<string, unknown> };

export function parseView(raw: string | null | undefined): ReportView {
  return raw === "technical" ? "technical" : "simple";
}

export function renderReport(m: ReportModel, view: ReportView): RenderedReport {
  if (view === "technical") {
    return { view, format: "json", body: { kind: m.kind, title: m.title, summary: m.summary, risks: m.risks, nextSteps: m.nextSteps, ...m.technical } };
  }
  const L: string[] = [m.title, "", "Summary", m.summary, ""];
  L.push("Risks", ...(m.risks.length ? m.risks.map((r) => `- ${r}`) : ["- None found."]), "");
  L.push("Next steps", ...(m.nextSteps.length ? m.nextSteps.map((r) => `- ${r}`) : ["- Nothing to do."]));
  return { view, format: "text", body: L.join("\n") };
}

export function qaRunModel(d: QaRunDetail): ReportModel {
  const r = d.result;
  const s = d.scorecard;
  const next: string[] = [];
  if (r.run?.status === "failed") next.push("Fix the failed checks, then run again.");
  if (r.run?.status === "blocked") next.push("Clear what blocked the run, then run again.");
  if (!r.run) next.push("No checks were run yet. Run the journeys when you are ready.");
  for (const q of r.questions.slice(0, 3)) next.push(`Answer: ${q}`);
  for (const n of r.notCovered.slice(0, 3)) next.push(`Not covered: ${n}`);
  return {
    kind: "qa-run",
    title: `QA report: ${r.target.label}`,
    summary: r.summary,
    risks: [`Risk level: ${r.risk.level}.`, ...r.risk.reasons],
    nextSteps: next,
    technical: {
      runId: r.id,
      generatedAt: r.generatedAt,
      riskLevel: r.risk.level,
      releaseGate: s.releaseGate,
      gateReason: s.gateReason,
      counts: { cases: s.totalCases, p0: s.p0Count, p1: s.p1Count, p2: s.p2Count, defects: s.defectsCount, safetyChecked: s.safetyChecked, safetyPassed: s.safetyPassed },
      passRate: s.passRate,
      runStatus: s.runStatus,
      timings: { ...r.timings, spans: d.spans.map((x) => ({ id: x.id, label: x.label, status: x.status, startMs: x.startMs, durationMs: x.durationMs })) },
      modelUsed: r.modelUsed,
      backend: r.backend,
    },
  };
}

export function reviewModel(repoId: string, r: ReviewResult): ReportModel {
  const count = (sev: string): number => r.findings.filter((f) => f.severity === sev).length;
  const blockers = count("blocker");
  const next: string[] = [];
  if (blockers) next.push(`Fix the ${blockers} blocking ${blockers === 1 ? "problem" : "problems"} first.`);
  if (r.findings.length > blockers) next.push("Read the other comments and decide which to act on.");
  if (!r.findings.length) next.push("No change needed from this review.");
  if (r.evidence && r.evidence.status !== "complete") next.push("Add the proof this change needs before it goes for approval.");
  return {
    kind: "review",
    title: `Review: ${repoId}`,
    summary: r.summary,
    risks: r.findings.slice(0, 5).map((f) => `${f.severity}: ${f.title} (${f.file}${f.line ? `:${f.line}` : ""})`),
    nextSteps: next,
    technical: {
      repo: repoId,
      counts: { findings: r.findings.length, blockers, risks: count("risk"), suggestions: count("suggestion") },
      ai: r.ai,
      note: r.note,
      findings: r.findings.map((f) => ({ severity: f.severity, file: f.file, line: f.line, title: f.title })),
      evidenceStatus: r.evidence?.status ?? null,
    },
  };
}

export function digestModel(date: string, text: string, counts: { total: number; open: number; acknowledged: number; recurring: number }): ReportModel {
  const unacked = counts.open - counts.acknowledged;
  const risks: string[] = [];
  if (counts.recurring) risks.push(`${counts.recurring} ${counts.recurring === 1 ? "defect has" : "defects have"} come back.`);
  if (unacked > 0) risks.push(`${unacked} open ${unacked === 1 ? "defect has" : "defects have"} not been acknowledged.`);
  return {
    kind: "daily-digest",
    title: `Daily digest: ${date}`,
    summary: text,
    risks,
    nextSteps: counts.open ? ["Acknowledge or fix the open defects."] : [],
    technical: { date, counts },
  };
}
