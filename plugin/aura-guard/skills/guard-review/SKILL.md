---
name: guard-review
description: Run SPIL Quality Support Bot's change review and QA plan before opening or updating a pull request, or when asked to review a branch. Gives fixed-rule findings, model findings on the changed lines, files that usually change together, and which test journeys the change affects. Reports only; it posts nothing and changes no repo.
---

# SPIL Quality Support Bot review and QA plan

Guard's commands run from the developer's own Guard folder:
`${user_config.guard_home}`. Use the launcher with a quoted path (it contains
spaces on some machines):

```
node "${user_config.guard_home}/bin/aura-guard.mjs" <command>
```

## When

- Before opening or updating a PR: review the branch.
- When asked "what could this break?" or "what should we test?".
- After a large change: check which journeys are affected.

## Steps

1. Make sure the index is current: `index` (about 5 s; it waits while a build
   is running, so stop `cargo` first).
2. Review the branch against its base (default: merge-base with
   `origin/development`): `review spil-aura` (add `--no-model` for the fixed
   checks only, which is instant and free). The report path is printed; read
   it. At most 5 findings are shown first, the rest are in the appendix.
3. QA plan: `qa plan spil-aura --no-model` lists the journeys the change
   affects and the UI areas with no journey. Aura's evidence rules still apply:
   real-app screenshots at 800, 1100 and 1440 px and a walkthrough video for
   UI changes.
4. Refactor ideas for one file: `refactor spil-aura <path>`. Patches were
   test-applied in a scratch copy; Guard never edits the repo. Apply a patch
   yourself only if you agree with it.

## Reading the results

- Blockers (secrets in code, edits to installed plico files) must be fixed.
- Risks and suggestions are for you to judge. Fixed rules can be wrong, and
  model findings are unverified: check the code before acting.
- Guard is read-only. Nothing it prints is approved; the developer decides.
- Record what you did and decided in the AI activity log (skill `ai-log`).
