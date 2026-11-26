---
name: qe-code-refine
description: "Perform structural code refinement audits: dead code, unused exports, duplicated logic, deep nesting, complex functions, magic numbers, and missing observability or error-handling context."
---

# QE: Structural Code Refinement & Maintainability

Improve long-term engineering health by catching structural decay before it becomes technical debt.

## Refinement Checklist

1. **Duplication & Coupling:** Spot copy-pasted blocks across PR files or existing helpers (`search_knowledge`) that should be unified into one parameterized helper.
2. **Complexity & Nesting:** Flag deeply nested conditionals (prefer early returns), oversized multi-purpose functions, and SOLID / single-responsibility violations.
3. **Dead Code & Hygiene:** Identify unused imports, unreachable branches, leftover `console.log`/`dbg!`/`println!`, and unexplained magic numbers (safety limits need comments explaining why).
4. **Error Handling & Observability:** Catch swallowed `catch {}` blocks, discarded `let _ =` Rust results, and missing contextual error messages (without leaking secrets).
5. **Advisory Only:** Present clean, minimal patch suggestions; developers choose what to apply.
