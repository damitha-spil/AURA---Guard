---
id: rule-pr-needs-real-app-evidence
type: rule
status: proposed
audience: [internal_dev, qa_internal]
department: dev
source: import
title: "A PR needs real-app evidence"
code_anchors:
  - repo: spil-aura
    path: docs/aura/pr-evidence.md
  - repo: spil-aura
    path: .claude/skills/aura-evidence
created: 2026-11-20
---

# A PR needs real-app evidence

Every PR declares its evidence scope. App and user-flow changes need screenshots and a walkthrough video from the real desktop app with approved test data. A browser with mock data does not count.

Service-only work needs real request, result and readback. Test counts alone do not prove a user flow. A missing service or capture tool is a blocker: the PR stays a draft, and sample proof is not a substitute.
