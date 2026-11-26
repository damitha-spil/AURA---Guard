---
name: pr-advisor
description: Get a complete PR readiness report and Wise Advisor brief combining Tier 0 defect/policy checks, blast radius, co-changed files, active rules, and past incidents.
---

# PR Manager and Wise Advisor

Run from the developer's Guard folder:

```
node "${user_config.guard_home}/bin/aura-guard.mjs" qa pr-readiness spil-aura
node "${user_config.guard_home}/bin/aura-guard.mjs" advise "<topic>"
```

## Steps

1. Before opening a PR, run `qa pr-readiness spil-aura` (or MCP `pr_readiness_report`) for defect findings, blast radius, AI-log coverage, and required evidence.
2. Before modifying unfamiliar code, run `advise "<topic>"` (or MCP `advise_architecture`) to check active rules vs. unapproved proposed hints and past incidents.
3. Keep Guard read-only; developers decide what to edit and commit.
