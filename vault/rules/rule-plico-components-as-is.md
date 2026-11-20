---
id: rule-plico-components-as-is
type: rule
status: proposed
audience: [internal_dev]
department: dev
source: import
title: "Use plico-ui components as they are"
code_anchors:
  - repo: spil-aura
    path: apps/aura-ui/scripts/plico.mjs
  - repo: spil-aura
    path: apps/aura-ui/src/components/plico/plico.lock.json
created: 2026-11-20
---

# Use plico-ui components as they are

When a screen needs a component plico-ui has, install it with the plico script. Do not rebuild it.

Never edit an installed file by hand; a test fails if one was changed. If a component needs a small change so it shows only true state, put it in a marked changes file under `scripts/plico-changes/`.
