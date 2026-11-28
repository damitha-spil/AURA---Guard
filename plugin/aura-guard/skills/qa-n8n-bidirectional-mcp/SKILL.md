---
name: qa-n8n-bidirectional-mcp
description: Connect n8n workflows and AI Agents bidirectionally with SPIL REO's stdio MCP server and webhook automation triggers.
---

# QA: Bidirectional n8n <-> SPIL REO MCP Bridge

1. **Outbound (REO -> n8n):** Use `n8n_list_workflows`, `n8n_list_executions`, and `n8n_trigger_webhook` to send masked QA verdicts, defect summaries, and release-gate alerts into n8n pipelines.
2. **Inbound (n8n AI Agents -> REO MCP):** Point `n8n-nodes-mcp` or external orchestrators at SPIL REO's stdio MCP server (`node engine/src/mcp/server.ts` with `SCOPE=qa` or `SCOPE=dev`).
3. Expose REO's deterministic QE/QA/DevSecOps tools (`search_knowledge`, `qe_commit_trajectory`, `review_ast_grep`, `sec_semgrep_scan`, `qa_bug_sheet`) as callable MCP tools for external agents.
4. Never grant `SCOPE=dev` to external untrusted workflows — use `SCOPE=support` for customer-facing automations so internal code/defects stay isolated.
