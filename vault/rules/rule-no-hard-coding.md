---
id: rule-no-hard-coding
type: rule
status: proposed
audience: [internal_dev]
department: dev
source: import
title: "No hard-coding of company facts"
code_anchors:
  - repo: spil-aura
    path: AGENTS.md
  - repo: spil-aura
    path: apps/personal-agent/crates/agent-core/bundled-agents/desk.json
created: 2026-11-20
---

# No hard-coding of company facts

No addresses, ports, server names, file paths, company or customer names, or company preferences in code.

## Where a value belongs

| Kind of value | Where it goes |
|---|---|
| Company facts: addresses, servers, people, customers, preferences | Admin settings, staff answers or ERP history |
| Product defaults: job types, helper signs, industry rules, filter lists | A bundled data file a company can extend or override |
| Safety limits and protocol values | A named constant in code, with a comment saying why |

Built-in entries are recognised by a marker or kind, not by their name.
