---
name: qa-visual-yaml-assertions
description: Compile declarative REO journeys into vision-grounded natural-language YAML assertions for canvas, PDF preview, and WebGL/3D shape surfaces.
---

# QA: Visual YAML Assertions (Midscene Pattern)

1. Identify screens where DOM selectors are blind (3D canvases, PDF previews, custom-drawn SVG/shape canvases).
2. Capture a screen grounding pass with `qa_vision_ground_screen` to locate regions by `[x1, y1, x2, y2]` bounding boxes and visual control labels.
3. Express assertions cleanly in declarative YAML steps (target region, expected visible state, tolerance, non-destructive action hint).
4. Record captured PNG evidence alongside the defect fingerprint when any visual expectation fails.
