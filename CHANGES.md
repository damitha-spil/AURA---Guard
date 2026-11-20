# Changes

Newest first.

## 2026-11-20: departments, landing page, capture, VS Code extension, rename (uncommitted)

- Product renamed to SPIL Quality Support Bot (identifiers unchanged for now).
- Departments: registry, templates, isolation, API, `dept` commands, `index --all`, `daily --all`.
- UI: landing page ("Choose your department"), overview, department page, Add department wizard.
- Capture: `capture status|show|summarize|purge`, `answer --json`; VS Code extension in `extension/`.
- Seed data moved out of code into local `data/departments/seed.json`.
- Tests use generic fixtures: no real department, project or staff names in tracked files.

## 2026-11-20: chat window redesign with four themes (uncommitted)

- Chat window rebuilt to feel like an agent: dot/orb marks, live work steps from
  real server events (streamed as ndjson), collapsed "Worked for N s" trace,
  tool cards for slash commands, word-by-word reveal, thumbs up/down feedback
  (`data/chats/feedback.jsonl`), keyboard shortcuts.
- Four full themes (not recolors): **Noir** (default, Grok-like), Pulse
  (GPT-like), Dots, Aurora (Muse-like); Appearance picker with live switch,
  mode, motion and "Show work" defaults; saved per user, applied before first
  paint.
- "Notes only" option restricts answers to vault notes.
- 214 tests in 26 files pass.

## 2026-11-20: reviewer, QA, PR learning, quiz, rules, support, inbox, daily (uncommitted)

- `review` / `refactor` / `replay`: fixed checks (defect vs rule-compliance
  classes, top-5 cap) + one model call on changed lines; refactor patches are
  test-applied in a scratch copy. Replay scores bug-finding on past fixes.
- `qa plan|generate|check|run|status`: journeys as vault notes, Playwright specs
  checked by a static safety check and a runtime guard (no save/create/send).
- `prs sync|mine|dataset|status`: read-only Azure DevOps PR threads.
- `quiz`, `rules` (propose, approve, export), `logcheck`, `support draft`.
- Chat app: Inbox (approve / dismiss / undo) and Reports views.
- `daily` end-of-day routine and `bin/schedule-daily.ps1` (plans only unless
  `-Install`).
- Plugin: skill `guard-review`.
- 201 tests in 25 files, all passing.

## 2026-11-20: chat app (uncommitted)

- `ui` command: local chat window (Edge/Chrome app mode) with chat history,
  source chips and panel, slash-command menu; token, Host/Origin and CSP
  protections; safe text rendering. `npm run ui`.

## 2026-11-20: brain, Scribe, session mining, hardening (uncommitted)

- Claude client behind masking: blocked calls send nothing; audit line before
  sending; prompt caching; placeholders restored in answers. Key from
  `ANTHROPIC_API_KEY` only.
- Scribe role and `diary [date]` command: daily diary draft, at most 3
  questions, written as a proposed note.
- `mine` command: finds owner corrections in Claude Code sessions (masked,
  secrets dropped) and writes proposed choice notes to `vault/inbox/`; titles
  are neutral. First run: 14 sessions, 73 candidates, 9 notes.
- Hardening: `bin/aura-guard.mjs` launcher, change counts in `index`, merge
  commits list files, `graph refresh` / `index --graph`, tests typechecked,
  Windows-safe test runner.
- 65 tests, all passing.

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
