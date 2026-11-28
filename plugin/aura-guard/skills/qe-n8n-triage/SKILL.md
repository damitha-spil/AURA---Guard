---
name: qe-n8n-triage
description: Inspect failing n8n workflow executions, correlate automation failures with recent repository commits or API contract drift, and record deduplicated REO defects.
---

# QE: n8n Execution Triage & Root-Cause Analysis

Diagnose broken or flaky n8n workflows connected to SPIL REO and trace failures back to recent code, schema, or environment changes.

## Steps

1. **Pull Recent Executions:** Run `n8n_list_executions` (or `/n8n executions <workflowId>`) to identify `error` or `crashed` runs and capture their `workflowId` and timestamps.
2. **Correlate with Repo & Memory:** Cross-reference the failure window with `trace_history`, `qe_commit_trajectory`, and REO's 3-layer QA memory (`execution` / `project` layers).
3. **Verify Dependencies & Contracts:** If the failing workflow calls a local or API service, verify contract compatibility with `qa_openapi_checks` or `qa_security_probes`.
4. **Record Findings Safely:** File a deduplicated defect via `qa_bug_sheet` and add an `execution` memory hypothesis in **QA Harness** until a fix is verified.
