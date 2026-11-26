---
name: qa-triage
description: "Triage QA run failures and visual diffs with 1-click decisions: log a proposed bug incident + PR comment, update a visual baseline, or save a reusable execution hint."
---

# QA Failure Triage

## Steps

1. Open **QA Harness** -> **Replay & Artifacts** (`npm run ui`) or inspect the failed run via `qa evidence <run-id>`.
2. For each defect or visual delta, pick one triage action (`POST /api/qa/triage`):
   - **Real Bug**: writes a `status: proposed` incident note in `vault/inbox/` and drafts a PR comment.
   - **Update Baseline**: promotes the verified screenshot inside `.artifacts/qa/baselines/` as the new reference.
   - **Flaky Hint**: saves a hint in `data/qa/hints.json` so future runs avoid confusion.
3. Approve any proposed incident notes in the **Inbox** tab before treating them as active truth.
