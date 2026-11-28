---
name: qa-cwv-audit
description: Audit Core Web Vitals, TTFB latency, HTML payload budgets, render-blocking scripts, and CLS unsized images on localhost via qa_lighthouse_budget.
---

# QA: Core Web Vitals & Lighthouse Budget

1. Target only local preview URLs (`127.0.0.1` / `localhost`) with `qa_lighthouse_budget`.
2. Measure TTFB, HTML payload KB, synchronous `<head>` render-blocking scripts, unsized `<img>` tags (CLS hazard), and viewport metadata.
3. Track score trends across commits in REO's `cwv-history.json` store.
4. Flag regressions exceeding `maxTtfbMs` or `maxHtmlKb` before release-candidate sign-off.
