# Changes

Newest first.

## 2026-11-20: graph, Obsidian, masking tuning (uncommitted)

- graphify (local mode, in `.venv`) feeds a code graph into SQLite; new
  `graph import|blast` commands and `get_blast_radius` MCP tool (dev/qa).
  Blast radius lists code that depends on a file.
- `vault/` is an Obsidian vault with a template per note type.
- Masking tuned on real Aura code: false blocks 13% → 1.9%; letters-only
  connection-string passwords now blocked; 238 cases.
- 44 tests, all passing.

## 2026-11-20: first build (uncommitted)

- Phase 0: `package.json`, TypeScript config, `.gitignore`, config example,
  `AGENTS.md`, ADR-001.
- Engine: shared types, SQLite index (`node:sqlite`, FTS5, schema v2), vault
  note format and checker, git and docs ingest, history, co-change, stale-note
  detection, search with audience filters, masking with egress audit log,
  resource guard, read-only MCP server with dev/qa/support scopes, CLI.
- 12 seed notes in `vault/` (status `proposed`).
- 187 synthetic masking cases in `evals/masking/`.
- 37 tests, all passing.
- Fixes during integration: rule notes are found by note type instead of id
  prefix; common words are dropped from search queries so the right note ranks
  first.

## 2026-11-20

- Created the first documents from the design brainstorm: README.md,
  ARCHITECTURE.md, IMPLEMENTATION_PLAN.md, THINKING.md, AI_HANDOFF.md and this
  file.
- Name chosen: AURA Guard.
