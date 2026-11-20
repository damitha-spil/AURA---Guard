---
id: rule-desk-routing-by-sign
type: rule
status: proposed
audience: [internal_dev]
department: dev
source: import
title: "Route desk jobs by helper sign"
code_anchors:
  - repo: spil-aura
    path: apps/personal-agent/crates/agent-core/bundled-agents/desk.json
  - repo: spil-aura
    path: apps/personal-agent/crates/agent-core/src/desk
created: 2026-11-20
---

# Route desk jobs by helper sign

Job types and helper signs live in `desk.json`. Aura routes a job by the helper's sign, never by the helper's name.

A helper never names another helper. It asks for a kind of help (`asks_for`), and Aura finds the helper whose sign matches.
