---
id: domain-aura-erp-mcp-glass-split
type: domain
status: proposed
audience: [internal_dev]
department: dev
source: import
title: "Who owns what: Aura, ERP MCP and SPIL Glass"
code_anchors:
  - repo: spil-aura
    path: docs/aura/software-factory.md
created: 2026-11-20
---

# Who owns what: Aura, ERP MCP and SPIL Glass

- Aura: shared screens, helpers, skills, jobs, orchestration and permissions.
- SPIL ERP MCP: exposes the exact ERP operations and the tenant adaptations.
- SPIL Glass: owns the ERP rules and records.

A module is available only when the MCP supports the exact operation, the ERP setup enables it and the user has permission. A connected server alone does not prove every feature works. Tenant-specific work never goes into shared Aura code.
