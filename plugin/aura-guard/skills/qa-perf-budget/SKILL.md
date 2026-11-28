---
name: qa-perf-budget
description: Run bounded localhost smoke-load latency checks (<=10 VUs, <=10s) via qa_k6_smoke_load (k6 pattern) and enforce p95 response budgets.
---

# QA: Bounded Localhost Smoke-Load Budget

1. Run `qa_k6_smoke_load` strictly against local dev/preview endpoints (`127.0.0.1` / `localhost`) during `on_release_candidate` checks.
2. Stay within hard safety bounds (`vus <= 10`, `durationSeconds <= 10`, `<= 100` requests) so local machines never saturate.
3. Inspect `errorRatePct` plus `p50`, `p95`, and `p99` latencies against `p95BudgetMs` (default `500ms`).
4. Flag latency regressions (`budgetPassed === false`) for profiling with execution traces before release.
