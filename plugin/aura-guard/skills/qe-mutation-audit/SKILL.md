---
name: qe-mutation-audit
description: Scoped Stryker-style mutation testing audit via qe_mutation_score on high-churn files to verify unit tests catch logic bugs, not just line coverage.
---

# QE: Scoped Mutation Adequacy Audit

1. Identify churn hotspots using `qe_commit_trajectory` so mutation checks focus on volatile business logic rather than stable boilerplate.
2. Run `qe_mutation_score` on those hotspot files to inspect relational (`<`, `<=`, `===`), logical (`&&`, `||`), and early-return mutant sites.
3. Compare surviving risk sites against test assertions (`assert.*`, `expect(...)`).
4. Recommend concrete edge-case unit tests specifically targeting uncovered boundary branches rather than generic test padding.
