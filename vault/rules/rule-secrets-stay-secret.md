---
id: rule-secrets-stay-secret
type: rule
status: proposed
audience: [internal_dev]
department: dev
source: import
title: "Secrets stay in the secret store"
code_anchors:
  - repo: spil-aura
    path: AGENTS.md
created: 2026-11-20
---

# Secrets stay in the secret store

Passwords, tokens and connection strings go into the encrypted secret store. They are never printed, logged, committed or shown.
