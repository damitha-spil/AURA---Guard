---
name: qa-visual-regression
description: Compare baseline vs current QA screenshots with qa_visual_diff (Argos/reg-suit pattern) and triage layout shifts or missing UI elements.
---

# QA: Visual Regression Diffing

1. Keep baseline and candidate screenshots inside REO's `dataDir` or QA evidence artifacts folder.
2. Run `qa_visual_diff` with an appropriate `thresholdPct` (default `1.5%`) to measure dimension drift and pixel/byte diff ratio.
3. Inspect the saved JSON visual diff report and explain the visible change (dimension mismatch, cropped element, contrast/theme drift) in plain QA language.
4. Only raise a defect via `qa_bug_sheet` / `Defects` when the delta reflects an unintended UI regression rather than expected copy updates.
