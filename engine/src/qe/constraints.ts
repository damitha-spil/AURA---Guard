// Lauren Poteto Rules 5 & 7:
// - Turn repeated corrections into the smallest effective durable constraint
//   (architecture -> mechanical_check -> vault_rule -> skill)
// - Evaluate rules/skills by comparing before/after run metrics and tool evidence.

export type ConstraintMechanism = "architecture" | "mechanical_check" | "vault_rule" | "skill";

export interface CorrectionInput {
  pattern: string;
  occurrences: number;
  mechanicallyDetectable: boolean;
  canDesignOutInTypesOrApi: boolean;
  isMultiStepProcedure: boolean;
}

export interface ConstraintRecommendation {
  mechanism: ConstraintMechanism;
  rationale: string;
  action: string;
}

export function recommendDurableConstraint(input: CorrectionInput): ConstraintRecommendation {
  if (input.canDesignOutInTypesOrApi) {
    return {
      mechanism: "architecture",
      rationale: "Designing invalid states out in types, schemas, or APIs prevents recurrence completely.",
      action: `Constrain the type/API contract for "${input.pattern}" instead of relying on review reminders.`,
    };
  }
  if (input.mechanicallyDetectable) {
    return {
      mechanism: "mechanical_check",
      rationale: "A deterministic Tier 0 rule, lint check, or oracle catches this at $0 cost with zero drift.",
      action: `Add a Tier 0 rule in roles/review-rules.json or a deterministic oracle in engine/src/qa/oracles.ts for "${input.pattern}".`,
    };
  }
  if (input.isMultiStepProcedure) {
    return {
      mechanism: "skill",
      rationale: "Recurring multi-step workflows belong in a reusable, evaluated SKILL.md procedure.",
      action: `Capture the workflow for "${input.pattern}" as a skill under plugin/aura-guard/skills/ and evaluate it.`,
    };
  }
  return {
    mechanism: "vault_rule",
    rationale: "Context-dependent judgment calls belong in concise, owner-approved Vault rules.",
    action: `Draft a proposed rule note in vault/inbox/ for "${input.pattern}" (owner promotes to active).`,
  };
}

export interface EvalRunMetrics {
  inspectedCodeFirst: boolean;
  exercisedRuntimeFlow: boolean;
  validEvidenceProvided: boolean;
  stayedInScope: boolean;
}

export interface SkillEvalComparison {
  beforeScore: number; // 0..100
  afterScore: number;  // 0..100
  delta: number;
  improved: boolean;
  summary: string;
}

function scoreRuns(runs: EvalRunMetrics[]): number {
  if (runs.length === 0) return 0;
  let total = 0;
  for (const r of runs) {
    const pts =
      (r.inspectedCodeFirst ? 25 : 0) +
      (r.exercisedRuntimeFlow ? 30 : 0) +
      (r.validEvidenceProvided ? 30 : 0) +
      (r.stayedInScope ? 15 : 0);
    total += pts;
  }
  return Math.round(total / runs.length);
}

export function evaluateSkillEffectiveness(before: EvalRunMetrics[], after: EvalRunMetrics[]): SkillEvalComparison {
  const beforeScore = scoreRuns(before);
  const afterScore = scoreRuns(after);
  const delta = afterScore - beforeScore;
  return {
    beforeScore,
    afterScore,
    delta,
    improved: delta > 0,
    summary: `Skill eval: ${beforeScore}/100 -> ${afterScore}/100 (${delta >= 0 ? "+" : ""}${delta} pts across ${after.length} run(s)).`,
  };
}
