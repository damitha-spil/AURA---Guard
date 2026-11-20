---
id: rule-shared-qa-server-cobalt-only
type: rule
status: proposed
audience: [internal_dev, qa_internal]
department: dev
source: import
title: "Shared QA SQL Server: Cobalt database only"
code_anchors:
  - repo: spil-aura
    path: AGENTS.md
created: 2026-11-20
---

# Shared QA SQL Server: Cobalt database only

On the shared QA SQL Server, use only the Cobalt database. Never run schema experiments there without the owner's OK.

Each developer may use a local database or shared QA. The database location is configuration, never feature code.
