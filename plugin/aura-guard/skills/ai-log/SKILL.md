---
name: ai-log
description: Write an entry in the repo's AI activity log (ai-log/) after any change, commit, decision, correction from the developer, blocker or idea, and before stopping or handing off. Use in any repo that has ai-log/README.md.
---

# Write the AI activity log

Repos that have `ai-log/README.md` keep a log of all AI-assisted work. AURA
Guard reads it to learn how the product is built and why. Write to it every
time; a commit hook adds a short entry for each commit automatically, but only
you know the why, the rejected options and the ideas.

## Steps

1. Read `ai-log/README.md` once per session for the current format.
2. File: `ai-log/<YYYY>/<MM>/<YYYY-MM-DD>-<name>.md`, where `<name>` is the
   first word of `git config user.name` in lower case. Create it if missing,
   starting with `# <date> · <name>`.
3. Append (never rewrite) an entry at the bottom:

   ```markdown
   ## HH:MM · Claude Code · <branch>

   - **What:** ...
   - **Why:** ...
   - **Files:** ...
   - **Commit:** <sha or "not committed">
   - **Decided:** chosen option, and what was rejected and why
   - **Correction:** what the developer told you to do differently
   - **Checks:** commands and results
   - **Not verified:** ...
   - **Ideas:** ...
   ```

   Leave out lines that do not apply. If the commit hook already wrote an entry
   for a commit, add the missing Why / Decided / Ideas lines under it instead of
   a second entry.
4. Corrections matter most: when the developer says "no, do it this way",
   record what you proposed and what they chose.

## Never write

Secrets of any kind, server addresses, customer or company names, staff
details, or file paths that contain a user name.
