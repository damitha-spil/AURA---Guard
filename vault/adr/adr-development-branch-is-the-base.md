---
id: adr-development-branch-is-the-base
type: adr
status: proposed
audience: [internal_dev]
department: dev
source: import
title: "Feature branches start from development"
code_anchors:
  - repo: spil-aura
    path: docs/aura/software-factory.md
  - repo: spil-aura
    path: .claude/skills/aura-new-task
created: 2026-11-20
---

# Feature branches start from development

Shared feature branches start from the latest `origin/development` and go back to `development` through review. `main` is never a feature base or merge target.

Tenant-specific ERP MCP work starts from its maintained tenant branch and returns there. Work happens on task branches in the original repository folder, not in extra worktrees. If the base branch is missing, ask the repo owner.
