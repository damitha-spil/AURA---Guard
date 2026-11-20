// Ranks findings and applies the comment cap. Aura's design rule: at most 5 comments per review, no nitpicks.
// Shown: blockers first (any class), then defects by confidence. Everything else goes to the report appendix.
import type { Finding, Severity } from "./tier0.ts";

/** Comments shown in the main part of a report and printed by `review`. */
export const MAX_SHOWN = 5;

const SEVERITY_WEIGHT: Record<Severity, number> = { blocker: 3, risk: 2, suggestion: 1 };

export function classOf(f: Finding): "defect" | "policy" {
  return f.class ?? "defect";
}

/** Model findings carry no confidence unless the model gave one; fall back on severity. */
export function confidenceOf(f: Finding): number {
  return f.confidence ?? (f.severity === "blocker" ? 0.8 : f.severity === "risk" ? 0.5 : 0.3);
}

function byRank(a: Finding, b: Finding): number {
  return (
    (a.severity === "blocker" ? 0 : 1) - (b.severity === "blocker" ? 0 : 1) ||
    confidenceOf(b) - confidenceOf(a) ||
    SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
    a.file.localeCompare(b.file) || a.line - b.line
  );
}

export interface Triage {
  /** The comments to show: at most `cap`, ranked. */
  shown: Finding[];
  /** Defects and blockers that did not make the cap, ranked. They go to the appendix. */
  moreDefects: Finding[];
  /** Policy findings (not blockers) that did not make the cap: rule compliance, not defects. */
  policy: Finding[];
}

export function triage(list: Finding[], cap: number = MAX_SHOWN): Triage {
  const eligible = list.filter((f) => f.severity === "blocker" || classOf(f) === "defect").sort(byRank);
  const policy = list.filter((f) => !(f.severity === "blocker" || classOf(f) === "defect")).sort(byRank);
  return { shown: eligible.slice(0, cap), moreDefects: eligible.slice(cap), policy };
}

/** Counts per rule id, biggest first. */
export function countByRule(list: Finding[]): [string, number][] {
  const m = new Map<string, number>();
  for (const f of list) m.set(f.rule, (m.get(f.rule) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
