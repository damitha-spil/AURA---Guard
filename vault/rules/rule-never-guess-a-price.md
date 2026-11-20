---
id: rule-never-guess-a-price
type: rule
status: proposed
audience: [internal_dev, qa_internal]
department: dev
source: import
title: "Never guess a price"
code_anchors:
  - repo: spil-aura
    path: AGENTS.md
created: 2026-11-20
---

# Never guess a price

Aura and its helpers must never invent a price. A price comes from the ERP or from the staff member's answer. If it is missing, say so and ask.
