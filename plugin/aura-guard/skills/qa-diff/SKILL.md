---
name: qa-diff
description: Plan risk-ranked QA journeys and deterministic checks from the current branch diff and code-graph blast radius, then run safe read/sandbox checks in background mode.
---

# QA for Current Diff

Run from the developer's Guard folder using the quoted launcher:

```
node "${user_config.guard_home}/bin/aura-guard.mjs" qa plan spil-aura --no-model
```

## Steps

1. Refresh the index if commits changed: `node "${user_config.guard_home}/bin/aura-guard.mjs" index`.
2. Call MCP `qa_plan_for_diff` (or run `qa plan spil-aura --no-model`) to rank affected journeys and uncover UI/service gaps.
3. Run safe read-only Backend & MCP QA checks: `node "${user_config.guard_home}/bin/aura-guard.mjs" qa backend`.
4. Confirm with the developer before running any live UI journey (`qa run <journey-id> --widths 800,1100,1440`).
5. Never write to SPIL Glass ERP or send external messages; tests use the Cobalt test DB only.
