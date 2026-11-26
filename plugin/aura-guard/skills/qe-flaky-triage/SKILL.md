---
name: qe-flaky-triage
description: Detect intermittent/flaky tests, separate timing or environment noise from real product regressions, cluster root causes, and recommend stabilization fixes.
---

# QE: Flaky Test Detection & Root-Cause Triage

Prevent noisy pipelines from eroding developer trust in QA gates.

## Steps

1. **Compare Historical Runs:** Inspect recent QA run artifacts (`compareQaRuns` / `GET /api/qa/compare`) to spot steps that alternate pass/fail without code changes.
2. **Classify Failure Root Cause:**
   - **Timing / Hydration Race:** Fixed sleeps or assertions running before async data/IPC resolves.
   - **Environment / Resource Contention:** PC RAM pressure during parallel `cargo` / `vitest` runs or unreachable CDP/Cua port.
   - **Real Regression:** Deterministic failure tied to a recent commit or layout/oracle violation.
3. **Stabilize:** Save selector/timing hints via `applyTriageDecision` (`flaky_hint`), replace hardcoded waits with deterministic state assertions, and never silence a real failure.
