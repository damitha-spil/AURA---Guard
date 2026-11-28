---
name: qa-playwright-mcp
description: Navigate local web UIs via structured ARIA accessibility tree snapshots (qa_a11y_tree_snapshot) instead of brittle CSS selectors or pixel-only clicking.
---

# QA: Playwright MCP Semantic ARIA Navigation

1. Target only verified local URLs (`127.0.0.1` / `localhost`). Never run UI probes against external or ERP hosts.
2. Call `qa_a11y_tree_snapshot` to inspect landmark roles (`heading`, `button`, `link`, `textbox`, `checkbox`, `combobox`) with stable node refs (`e1`, `e2`, ...).
3. Flag all interactive controls where `labeled === false` as Accessibility / locator-fragility findings before scripting Playwright actions.
4. Pair every interactive click with REO Tier 0/1/2 safety rules (`qa/forbidden-actions.json`) so state-changing ERP buttons stay blocked.
