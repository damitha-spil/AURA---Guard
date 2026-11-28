---
name: qa-self-healing-journeys
description: Stagehand-style hybrid act/extract/observe pattern to propose patched Playwright/JourneyDsl selectors when UI refactors break existing locators.
---

# QA: Self-Healing Journey Repair

1. When a `qa/` Playwright spec or `JourneyDsl` assertion fails with a locator timeout, capture an updated `qa_a11y_tree_snapshot` and `qa_vision_ground_screen`.
2. Match the broken locator's intent (`role`, accessible text, nearby label, or normalized bounding box) against live ARIA nodes.
3. Propose the replacement semantic selector (`getByRole` / `getByLabel`) as a **reviewable patch or Vault draft** (`qa-proposals`) — never overwrite configured source repos directly.
4. Re-verify the repaired selector cleanly passes under Tier 0 read-only safety constraints.
