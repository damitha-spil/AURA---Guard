---
name: qa-bug-sheet
description: Deduplicate failures with deterministic defect fingerprinting, compile structured Bug Sheets (repro steps, expected vs. actual, snapshots, console and network traces), and draft developer tickets.
---

# QA: Defect Fingerprinting, Bug Sheets & Ticket Drafts

Convert raw QA/oracle/security failures into clean, non-duplicate Bug Sheets and actionable developer tickets.

## Steps

1. **Fingerprint Every Defect:** Build a stable fingerprint from `route/screen + oracle/error code + normalized error message` so re-running a failing PR updates the existing issue instead of spamming duplicates.
2. **Compile Structured Bug Sheet:**
   - Title, Severity (`P0`/`P1`/`P2`), Fingerprint ID, and Environment (test DB only, redacted).
   - Step-by-step Reproduction Steps, Expected vs. Actual result.
   - Attached evidence: screenshot path, width (`800`/`1100`/`1440` px), console errors, network/IPC trace.
3. **Draft Developer Ticket & PR Warning:** Output a ready-to-file Azure DevOps / Jira / GitHub issue draft and a concise PR warning block, plus a `status: proposed` incident note in `vault/inbox/`.
4. **Never Auto-Post:** Present drafts for human review before creating external tickets or PR comments.
