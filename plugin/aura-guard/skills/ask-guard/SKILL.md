---
name: ask-guard
description: Ask SPIL AURA QA Bot what it knows before changing Aura code - the rules that apply, past decisions, files that usually change together, and what depends on a file. Use at the start of a feature or fix, before editing a file you have not touched in this session, and before a code review.
---

# Ask SPIL AURA QA Bot

SPIL AURA QA Bot is SPIL's internal engineering assistant. It has read Aura's history,
docs and rules, and holds the owner's decisions as notes. Its tools come from
the `aura-guard` MCP server. They are read-only.

## When

- Starting a feature or fix: search for rules and past decisions on the area.
- Before editing a file: check what usually changes with it and what depends
  on it, so the change is complete.
- Reviewing a change: list the active rules and check the diff against them.

## How

1. `search_knowledge` with the topic in plain words ("attachment routing",
   "ERP create", "desk sign"). Notes rank first; cite their ids.
2. `co_changed` with repo `spil-aura` and the file path: files that usually
   change in the same commits. If a usual partner is missing from your change,
   say why or include it.
3. `get_blast_radius` with the file path: code that depends on it. Check or
   test those callers.
4. `trace_history` for recent commits on a path, to see why it looks the way
   it does.
5. `list_rules` before a review.

## Reading the answers

- Notes with `status: active` are approved rules. `proposed` notes are not
  approved yet: treat them as hints, and say so.
- Guard can be out of date. If code contradicts a note, trust the code, tell
  the developer, and record it in the AI activity log.
- If the server is not available, carry on without it and mention that Guard
  was not consulted.
