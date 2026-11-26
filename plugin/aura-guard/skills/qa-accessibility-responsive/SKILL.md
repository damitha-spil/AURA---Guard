---
name: qa-accessibility-responsive
description: Audit UI screens at 800, 1100, and 1440 px for horizontal overflow, squeezed panes, overlapping controls, keyboard navigation, ARIA landmarks, dark mode contrast, and reduced motion.
---

# QA: Responsive Layout & Accessibility (a11y) Audit

Verify every changed UI screen behaves cleanly across desktop breakpoints, themes, and assistive technologies.

## Checks

1. **Responsive Matrix (`800`, `1100`, `1440` px):**
   - `scrollWidth <= innerWidth` (zero horizontal overflow).
   - Main/chat content panes remain `>= 320` px wide; no clipped modals, drawers, or truncated chips breaking layout.
   - No overlapping interactive buttons or controls (`getBoundingClientRect`).
2. **Semantics & Keyboard:**
   - Every `<button>` inside `<form>` has explicit `type="button" | "submit" | "reset"`.
   - Interactive controls have accessible names (`aria-label`, text, or `aria-labelledby`), visible focus indicators, and full `Tab`/`Enter`/`Escape` keyboard support.
3. **Themes & Motion:** Check both light and dark modes (tokens only, no hardcoded colors) and `prefers-reduced-motion` support.
