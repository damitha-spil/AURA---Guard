---
name: lauren-poteto-rules
description: Engineering workflow for evidence-based diagnosis, runtime verification, reusable feature maps, durable constraints, skill evaluation, and safe delegation (adapted from unicodef1wn/lauren-poteto-rules).
---

# Lauren Poteto Rules (AURA Sentinel Edition)

Use these 8 rules for engineering investigation, implementation, review, QA/QE, and delegation.

## 1. Pair with the Human
- State the problem, material assumptions, and observable success criteria before non-trivial work.
- Keep independent changes separable and explain *why* behavior changed.
- Optimize for reviewed, working outcomes over code volume.

## 2. Earn Trust with Evidence
- Inspect the affected implementation and trace calls/data flow before diagnosing a cause. Mark untested explanations as hypotheses.
- Reproduce a bug before fixing it, then repeat the exact steps after the fix.
- Exercise the real interface users depend on (UI, API, CLI, or desktop flow). A passing build or typecheck alone never proves runtime behavior.
- Match evidence to the claim: appearance needs a screenshot; interaction needs an exercised sequence; performance needs traces/timings.
- Check correctness and engineering quality separately.

## 3. Make Verification Repeatable (Feature Map)
- Use the repository's actual run/test/diagnostic tools; never invent commands.
- Consult `qa/feature-map.json` (`qa_feature_map`) connecting each user-visible feature to its entry point, prerequisites, navigation steps, relevant code, and expected result.
- Turn recurring manual checks into declarative `qa-steps` journeys.

## 4. Treat Codebase & History as Memory
- Inspect nearby code, Vault notes (`advise_architecture`), and commit history (`qe_commit_trajectory`) before implementing.
- Validate patterns before copying them; frequency does not make a workaround right.
- Remove temporary scaffolding when done.

## 5. Turn Corrections into Durable Constraints
Choose the smallest effective mechanism when a mistake can recur:
1. **Architecture / Type / Data model** (design the invalid state out).
2. **Mechanical check** (Tier 0 rule, lint, compiler, or CI gate).
3. **Project rule** (concise Vault rule or review criterion).
4. **Skill** (repeatable procedure evaluated on real tasks).

## 6. Keep the Supported Path Healthy
- Use canonical helpers; update obsolete callers and examples together.

## 7. Evaluate Rules & Skills
- Start from an observed failure, define the target behavior, compare before/after on real tasks, and inspect tool calls/diffs/artifacts rather than confidence alone. Label untested revisions honestly.

## 8. Scale Only What You Can Verify
- Prove one representative task end-to-end before expanding unattended runs.
- Preserve existing safety and action boundaries; successful verification never grants extra permission.

## Completion Report
Finish with: result, checks actually performed, accessible evidence, and anything still unverified.
