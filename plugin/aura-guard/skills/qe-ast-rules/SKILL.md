---
name: qe-ast-rules
description: Enforce Vault engineering rules and Tier 0 structural patterns deterministically via ast-grep / review_ast_grep before any LLM review tokens are spent.
---

# QE: Deterministic AST Rules (Tier 0)

1. Run `review_ast_grep` first on target repositories (`--pattern` optional) at zero LLM cost.
2. Catch high-signal structural smells immediately: `eval`/`new Function`, shell string interpolation (`shell: true`), missing `<button type="...">`, raw `dangerouslySetInnerHTML`, and unmasked credential console logs.
3. Translate recurring human code-review rules from `vault/rules/` into repeatable structural patterns or `SkillProposal` drafts.
4. Never modify source files in `cfg.repos` — attach file + line citations for engineering triage.
