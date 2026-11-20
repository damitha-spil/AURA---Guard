---
id: rule-ai-has-no-erp-create-tool
type: rule
status: proposed
audience: [internal_dev, qa_internal]
department: dev
source: import
title: "The AI never gets an ERP create tool"
code_anchors:
  - repo: spil-aura
    path: AGENTS.md
  - repo: spil-aura
    path: apps/personal-agent/src-tauri/src/orders
created: 2026-11-20
---

# The AI never gets an ERP create tool

The AI helper never gets a create tool for the ERP. The backend checks the request and saves it.

A helper may ask for a checked action. The backend owns the create operation and the permission to run it. Advertising a write tool alone grants no authority.

This covers new batches, rack assignment and any other ERP change.
