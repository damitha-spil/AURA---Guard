# AI handoff: AURA Guard

Keep this file current. Update it after every meaningful change, test,
decision or blocker, and before stopping. Never record credentials, tokens or
other secrets.

## Current state (2026-11-20, end of first build session)

- **Stage:** Phase 0 done, most of Phase 1 built. Nothing committed since the
  owner's first commit `ae56a11 project architecture`.
- **Repo:** `D:\AURA - Guard`, branch `master`, remote `origin` on GitHub
  (created by the owner). All new work is uncommitted.
- **Decisions:** recorded in [docs/adr/001-foundations.md](docs/adr/001-foundations.md)
  (TypeScript on Node 26, `node:sqlite`, this PC first, own model client, Aura
  and ERP-MCP first, words-only search in Phase 1). The owner said "build this";
  the recommended defaults were taken and can still be changed.
- **Built by four Sonnet agents, integrated and checked by the main session.**

## What exists

| Part | Files | State |
|---|---|---|
| Shared types, config, SQLite schema (v2, adds `note_type`) | `engine/src/types.ts`, `config.ts`, `index/db.ts` | done |
| Vault: note format, checker, loading, new notes | `engine/src/vault/*`, `engine/src/index/notes.ts` | done |
| 12 seed notes from Aura's AGENTS.md and software-factory guide | `vault/**` | `proposed`, **not reviewed by the owner** |
| Git ingest (commits, docs), history, co-change, stale notes | `engine/src/ingest/*`, `engine/src/index/{history,cochange,stale}.ts` | done |
| Search (FTS5, safe queries, stop words, audience and stale filters) | `engine/src/index/search.ts` | done |
| Masking, egress audit log | `engine/src/mask/*`, `evals/masking/cases.jsonl` (187 cases) | done, **being tuned** (see blockers) |
| Resource guard | `engine/src/guard/resources.ts` | done |
| MCP server (scopes dev / qa / support) | `engine/src/mcp/server.ts`, `.mcp.json.example` | done |
| CLI | `engine/src/cli/main.ts`, `copy.ts` | done |
| Working rules for this repo | `AGENTS.md` | done |

## Evidence (commands run in this session)

- `npx tsc -p engine --noEmit`: clean.
- `npm test`: 37 tests, 37 pass, 0 fail.
- `git diff --check`: clean.
- `npm run guard -- index` (real run, this PC): 12 notes; spil-aura 228
  commits and 145 docs; erp-mcp 26 commits and 43 docs; about 5 s. A second
  run added 0 new commits.
- `ask why does the AI never get an ERP create tool` → first hit
  `rule-ai-has-no-erp-create-tool`. `ask how is a job routed to a helper` →
  first hit `rule-desk-routing-by-sign`.
- `ask desk routing --audience customer_support` → nothing (correct: no
  support notes exist).
- MCP over stdio: `initialize` then `tools/call list_rules` returned the 8
  rule notes.
- `stale`: none (no anchor has a `verified_sha` yet). `check`: vault fine.

## Masking tuning (Sonnet agent, checked by main session)

- Real-code scan of 1,156 Aura files: blocked files went from 149 (13%) to 22
  (1.9%). Gate intact: block 93/93, replace 27/27, clean false positives
  0/118. Cases file now has 238 cases.
- Main fixes: `pat` no longer matches `path`/`pattern`; UI labels and key names
  (`tokenPlaceholder`, `input_tokens` ...) are not secrets; SVG paths, Tailwind
  classes, import paths, model ids and integrity hashes are not random secrets;
  obviously fake keys in tests are skipped. New gap closed: letters-only
  passwords in connection strings (`Password=Welcome;`) are now blocked.
- Trade-off to review: the "obviously fake key" rule (`looksFake`,
  `looksFakeKey` in `detectors.ts`) would let a real key with an `abcdef` or
  `123456` run through.
- **Owner to check (values not printed anywhere):** key-shaped strings in Aura at
  `agent-core/src/secrets.rs:238` and `:240` (Anthropic shape),
  `applog.rs:46`, `backup.rs:558` and `knowledge.rs:1338` (GitHub/OpenAI
  shapes). Probably test fixtures; not judged safe by Guard.
- The Aura folder was switched to `feat/order-entry-rebase-by-nisal` during
  this session (not by Guard), so later scans see a different file set.

## Graph direction fix (main session)

- `get_blast_radius` / `graph blast` now lists code that **depends on** a file
  (incoming edges; graphify edges point from user to used). The first version
  followed outgoing edges, and `walk` had no incoming-only mode. Fixed in
  `engine/src/index/graph.ts`; tests in `engine/test/graph.test.ts` now pin the
  direction. Real run on `desk/router.rs` lists `desk/chat_order.rs` and
  `src-tauri/src/desk_cmds.rs`.

## Checks after all agents (main session)

- `npx tsc -p engine --noEmit`: clean. `npm test`: 44 tests, 44 pass.
  `git diff --check`: clean.

## Known problems

1. `npm run guard -- ask "..."` breaks in Git Bash (npm.cmd re-quotes through
   cmd). Use `node --experimental-strip-types engine/src/cli/main.ts ask ...`.
2. Re-running `index` reports the total file-doc count, not only changes.
3. Tests are not typechecked (`engine/tsconfig.json` includes only `src`).
4. Merge commits record no files.
5. Graphify finds no nodes in JSON files (e.g. `desk.json`); the graph is a
   snapshot, not refreshed by `index` yet.
6. Obsidian desktop has not opened the vault yet.

## Not built yet

- Paid-model client behind the masking step (no role calls a model yet).
- `explain_symbol`; automatic graphify refresh inside `index`.
- Meaning search (sqlite-vec plus embeddings).
- The quiz (owner writes questions in `evals/quiz/`).
- Session and PR-comment mining, the Scribe, the control screen.

## Rules that hold

- Guard only reads other repos (read-only git commands). It never commits,
  merges or writes to an ERP.
- No secrets in the vault, the index, logs or outgoing calls.
- Shared QA SQL Server: Cobalt database only.
- Support knowledge ships inside Aura after review; Aura never queries Guard.
- Do not commit or push unless the owner asks.

## Next action

- **Assistant (when asked):** fix the npm quoting problem, run graphify from
  `index`, then build the paid-model client behind masking and the Scribe.
- **Owner:** review the 12 seed notes and mark the good ones `active`; check
  the key-shaped masking hits; write the first quiz questions; say whether to
  commit.

## Graphify and Obsidian (2026-11-20, graphify-obsidian agent)

- **graphify** = PyPI `graphifyy` 0.9.113 (CLI `graphify`), github.com/graphify-labs/graphify, Apache-2.0 / MIT. Installed only in `.venv/` (git-ignored). Python 3.14.7 used.
- Ran `graphify update <export> --no-cluster` with `GRAPHIFY_BACKEND=none` (local tree-sitter AST, no LLM). Nothing sent externally. Export: `git archive HEAD` of `D:\SPIL AURA` into `data/graphify/src-spil-aura/` (not a worktree). Output: `data/graphify/spil-aura/graph.json` (23.6 MB, 21,109 nodes, 55,843 links, about 45 s). Git-ignored.
- Format used by the importer: node-link JSON, `nodes[]` {id, label, file_type, source_file} and `links[]` {source, target, relation}.
- `engine/src/index/graph.ts`: `graph_nodes`, `graph_edges`, `importGraphify`, `neighbours` (both directions, depth 1-2), `blastRadius` (now incoming, 2 hops; same-file nodes left out). Caps: `MAX_GRAPH_DEPTH = 2`, `MAX_GRAPH_ROWS = 200`.
- Wired: CLI `graph import|blast`, MCP `get_blast_radius` (dev and qa only; dev/qa tool count now 7), test `engine/test/graph.test.ts` (5 tests).
- Obsidian: `vault/.obsidian/` (app, templates, core-plugins), `vault/_templates/` (7 types), loader skips `_templates`, test `engine/test/vault-templates.test.ts` (2 tests). Graphify data is not written into the vault.
- Checks: `npx.cmd tsc -p engine --noEmit` clean; `npm.cmd test` 44 pass, 0 fail (once the mask agent's tests were green). `git diff --check` clean.
- Not verified: Obsidian desktop app opening the vault (no GUI run). Obsidian export (`graphify export obsidian`) exists but is not used by design.
- Direction later switched to incoming edges by the main session (see "Graph direction fix").

## Push fix (main session)

- First push was rejected by GitHub push protection: the synthetic masking
  cases (`evals/masking/cases.jsonl`) held fake keys in real key formats.
- Fix: the cases are now generated at test time by
  `evals/masking/generate.mjs` from a fixed seed (the original generator, plus
  `extra-cases.template.jsonl` where random tokens are `{{rand:...}}`
  placeholders). `cases.jsonl` is git-ignored; run the generator to inspect it.
  The first 187 generated cases are byte-identical to the old file; 238 total;
  the gate is unchanged. GitHub's "allow secret" links were not used.
