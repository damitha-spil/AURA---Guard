---
name: qa-record
description: Turn a manual walkthrough of Aura into a safe declarative qa-steps journey proposal with automatic responsive layout, console, form, and protocol assertions.
---

# Record and Teach Journey

## Steps

1. Open the Guard UI (`npm run ui`) -> **QA Harness** -> **Test Lab** -> **Record & Draft Journey**.
2. Enter the journey ID, title, area, and recorded click/type/resize steps (Tier 0 read or Tier 1 local sandbox).
3. Click **Draft Proposed Journey** (calls `POST /api/qa/record/draft` with `writeProposal: true`) to save a `status: proposed` note in `vault/inbox/`.
4. Review and promote the journey only after checking that no Tier 2 ERP/messaging actions are included.
