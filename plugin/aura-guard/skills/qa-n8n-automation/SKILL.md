---
name: qa-n8n-automation
description: Discover n8n workflows, inspect execution statuses, and trigger n8n webhooks autonomously from SPIL REO QA missions, /n8n commands, and release quality gates.
---

# QA: Autonomous n8n Workflow Automation

Use REO's built-in n8n tools (`n8n_list_workflows`, `n8n_list_executions`, `n8n_trigger_webhook`) or `/n8n` chat commands to orchestrate external QA, notification, ticket creation, and CI/CD pipelines through n8n.

## Steps

1. **Discover Available Workflows:** Call `n8n_list_workflows` (or `/n8n workflows`) to locate active workflows and inspect their webhook trigger paths and tags.
2. **Verify Recent Executions:** Before or after triggering, call `n8n_list_executions` (or `/n8n executions`) to confirm whether the target workflow is healthy and not failing repeatedly.
3. **Prepare Masked QA Event Payload:** Structure payloads cleanly with `event`, `verdict` (`PASS` / `NEEDS_REVIEW` / `BLOCK_RELEASE`), `summary`, and defect IDs/titles. Never include credentials, tokens, or connection strings — all outgoing payloads pass `maskOutgoing` and are blocked if any secret is detected.
4. **Trigger Webhook:** Call `n8n_trigger_webhook` (or `/n8n trigger <webhookPath> <json>`) against the configured n8n instance and attach the returned HTTP status and execution evidence to the mission log.
5. **Bind Autonomous Triggers:** For recurring or event-driven n8n runs, configure an Automation Trigger in **QA Harness** (`on_commit`, `on_pull_request`, `on_release_candidate`, or `schedule`) targeting `@report` / `@qa` with the desired n8n workflow.
