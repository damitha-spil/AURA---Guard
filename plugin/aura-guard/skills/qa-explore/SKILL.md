---
name: qa-explore
description: Run a bounded exploratory QA scan on a new or changed Aura screen (max 15 safe controls, 800/1100/1440 px layout/console/form/protocol oracles) and draft a proposed journey.
---

# Exploratory Screen QA

Run from the developer's Guard folder:

```
node "${user_config.guard_home}/bin/aura-guard.mjs" qa explore <area>
```

## Steps

1. Check driver readiness with MCP `qa_check_driver_health` or `qa status`.
2. Launch `qa explore <area>` against a running Aura test instance (test DB only).
3. Review discovered layout, console, form-button, or protocol-leak findings and any proposed journey note in `vault/inbox/`.
4. Only the owner promotes proposed notes to `active`.
