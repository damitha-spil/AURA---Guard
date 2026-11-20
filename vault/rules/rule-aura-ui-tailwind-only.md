---
id: rule-aura-ui-tailwind-only
type: rule
status: proposed
audience: [internal_dev]
department: dev
source: import
title: "aura-ui uses Tailwind only"
code_anchors:
  - repo: spil-aura
    path: apps/aura-ui/src/components/aura
  - repo: spil-aura
    path: apps/aura-ui/src/styles/palettes.css
created: 2026-11-20
---

# aura-ui uses Tailwind only

Screens in `apps/aura-ui` are styled with Tailwind utilities and theme tokens such as `bg-muted` and `text-foreground`. No new CSS files, no inline style strings, no hard-coded colours.

Words on screens live in `copy.ts` files, not inline. Reuse `@rerun/ui` and the existing `components/aura` before building anything new.
