---
name: qa-wcag-gate
description: Enforce WCAG 2.1/2.2 DOM accessibility budgets on local pages via qa_axe_audit (@axe-core pattern) and file deduplicated defects.
---

# QA: WCAG Accessibility Gate

1. Run `qa_axe_audit` on local preview URLs (`127.0.0.1` / `localhost`) or rendered HTML snapshots.
2. Check for `html-has-lang`, `document-title`, `image-alt`, `button-name`, `input-label`, and `heading-order` violations.
3. Critical and serious findings are automatically deduplicated by SHA-256 fingerprint into `Defects` when `recordDefects` is enabled.
4. Provide semantic HTML / ARIA attribute fixes without altering unrelated layout styling.
