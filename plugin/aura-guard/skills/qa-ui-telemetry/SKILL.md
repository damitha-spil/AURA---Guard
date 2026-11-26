---
name: qa-ui-telemetry
description: Run automated UI click-flows (Cua Driver / Playwright / Selenium) with visual snapshots, browser console error capture, and network XHR/Fetch (4xx/5xx/latency) inspection.
---

# QA: UI Automation & Deep Telemetry

Drive user journeys through the running application while capturing visual screenshots, browser console logs, and failed network/IPC requests on every step.

## Steps

1. **Choose Safe Tier & Driver:** Use Tier 0 (pure read) by default or Tier 1 (local sandbox) when approved; prefer background `cua-driver` + passive WebView2 CDP telemetry.
2. **Execute User Flows:** Navigate via semantic ARIA roles, labels, and `data-testid` selectors (avoid brittle CSS/XPath).
3. **Capture Multi-Layer Evidence per Step:**
   - Visual screenshot (`800`, `1100`, `1440` px).
   - Browser `console.error`, `pageerror`, and React error boundaries.
   - Network / IPC failures (`4xx`/`5xx`, rejected `invoke()` calls, slow responses).
4. **Enforce Safety:** Pre-check every click/type/key with `judgeActionByTier`; never click ERP commit/save or external send controls.
