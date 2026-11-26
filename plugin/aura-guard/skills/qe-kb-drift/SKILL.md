---
name: qe-kb-drift
description: Detect Knowledge Base drift when a PR introduces new patterns/services or contradicts active Vault rules, and draft proposed Vault notes or stale-note updates for owner approval.
---

# QE: Knowledge Base Grounding & Drift Detection

Keep the engineering Knowledge Base synchronized with how the codebase actually evolves.

## Steps

1. **Check Stale Anchors:** Run `stale_notes` (MCP) or `npm run guard -- stale` to find Vault rules/ADRs whose `code_anchors` changed in recent commits.
2. **Detect Undocumented Patterns:** Compare new modules, MCP tools, or architectural conventions in the PR against `search_knowledge` and `list_rules`.
3. **Detect Rule Contradictions:** Flag when a change violates an `active` rule (must fix or explicitly update the ADR/rule).
4. **Draft Proposals Safely:** Draft new or updated `rule` / `adr` / `pattern` notes strictly with `status: proposed` in `vault/inbox/`. Only the owner promotes notes to `active`.
