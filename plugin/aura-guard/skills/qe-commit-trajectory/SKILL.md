---
name: qe-commit-trajectory
description: Analyze daily developer commit trajectories vs. final PR diffs to catch mid-branch pivots, leftover debug/helper code, high-churn fixup hunks, scope drift, and cross-author overlaps.
---

# QE: Daily Commit Trajectory & Churn Intelligence

Use temporal commit history (not just the squashed PR diff) to spot hidden quality risks that static diff reviewers miss.

## Analysis Signals

1. **Pivot & Leftover Detection:** Compare early branch commits against the final diff (`trace_history`) to find abandoned approaches, orphaned helper functions, dead flags, or half-reverted edits.
2. **Fixup / High-Churn Hunks:** Flag files or functions touched repeatedly by rapid `wip` / `fix` / `try2` commits in the same day — elevate test & review scrutiny on those exact lines.
3. **Scope & Atomicity Check:** Warn when a PR mixes unrelated modules or bugfixes from a developer's daily workstream that belong in separate PRs.
4. **Cross-Author Overlap:** Cross-check files touched by other developers in recent commits to warn early about merge/contract collisions.
5. **AI Log Coverage:** Verify committed changes have corresponding entries in `ai-log/`.
