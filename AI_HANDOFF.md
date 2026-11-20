# AI handoff: SPIL Quality Support Bot

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
- **Owner to check:** a few key-shaped strings in Aura's own source (locations
  kept out of this public repo; ask the assistant to re-run the scan). Probably
  test fixtures; not judged safe by Guard.
- The Aura folder was switched to `another feature branch` during
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

## Deeper layer (2026-11-20, three Sonnet agents + main session)

- Built: `engine/src/brain/client.ts` (Claude client behind masking),
  `engine/src/roles/scribe*.ts` + `roles/scribe.yaml`, `engine/src/sessions/*`
  (session mining), `bin/aura-guard.mjs`, `bin/run-tests.mjs`,
  `engine/src/graph/refresh.ts`, `engine/tsconfig.test.json`.
- Main session wired `diary` and `mine` into `EXTRA_COMMANDS` in
  `engine/src/cli/main.ts`, made choice-note titles neutral (owner words only
  in the body), regenerated the 9 inbox notes, fixed the `mine` summary counts.
- Evidence: `npm run typecheck` clean; `npm test` 12 files, 65 pass.
  `mine` real run: 14 sessions, 405 owner messages, 73 candidates, 0 blocked,
  9 written; re-run wrote 0 (dedupe). `diary` without a key prints the plain
  "not set" message; a no-commit date writes nothing. `graph refresh
  spil-aura`: 21,109 nodes / 55,843 edges in 58 s; second run skipped.
- Not verified: any real Claude API call (no key in this environment); Scribe
  prompt quality; mining recall.
- The hardening agent ran `git stash` + `pop` by accident; checked afterwards:
  no stash left, all new files present.
- agent-qa (vostride) researched read-only: FSL license, web/mobile only;
  adopt ideas (journeys as files, lesson retirement, evidence per run), no code.
- Next: owner sets `ANTHROPIC_API_KEY` and runs `npm run guard -- diary`;
  owner reviews `vault/inbox/` choice notes and the 12 seed notes; then build
  journeys + QA Planner in shadow mode. Not committed; owner decides.

## Claude Code plugin (2026-11-20, main session)

- Guard repo is now a plugin marketplace: `.claude-plugin/marketplace.json`
  (`spil-aura-tools`) → `plugin/aura-guard/` (plugin.json with `guard_home`
  user setting, `.mcp.json`, `bin/mcp-launch.mjs`, `hooks/hooks.json` +
  `hooks/log-commit.mjs`, skills `ask-guard` and `ai-log`).
- Aura (`feature/QA-Agent`, uncommitted): `.claude/settings.json` registers the
  marketplace from GitHub and enables `aura-guard@spil-aura-tools`.
- Evidence: `claude plugin validate . --strict` and on `plugin/aura-guard`:
  passed. Commit hook tested in a temp repo: one entry, no duplicate on rerun,
  ignores non-commit commands and bad input. MCP launcher: missing folder →
  plain message, exit 1; with Guard folder → 7 tools listed.
- Not verified: a real install through `/plugin`, the trust prompt, and the
  hook firing inside a live Claude Code session; PostToolUse `tool_response`
  fields not used on purpose (hook checks HEAD instead).
- Parallel work: a Sonnet agent is porting Aura FineTune's subscription-CLI
  brain (Claude Code / other plan CLIs instead of an API key) into
  `engine/src/brain/`.

## Subscription brain (2026-11-20, Sonnet agent + main session)

- Ported from Aura `aura/stable/FineTune` (read via `git show`, no checkout):
  `engine/src/brain/backends.ts` (`anthropic-api`, `claude-cli`),
  `engine/src/brain/select.ts` (`createBrain` picks a backend: config
  `brain.backend` auto|anthropic-api|claude-cli, env `AURA_GUARD_BRAIN`;
  auto = API key if set, else Claude Code on the user's plan).
- Claude Code runs as a text-only model: `--tools ""`, `--disallowedTools ...`,
  `--permission-mode dontAsk`, `--strict-mcp-config`, `--setting-sources ""`,
  `--disable-slash-commands`, `--no-session-persistence`; prompt on stdin; empty
  temp cwd; API key env removed so the plan is used. A run whose init event
  lists any tool or MCP server is rejected. Masking + audit apply as for the API.
- Left out: Codex, Antigravity, Cursor (cannot be locked to no tools); `.cmd`
  npm shims (would need a shell).
- New commands: `brain status`, `brain test`; `diary` prints the backend used.
- Evidence: `brain status` → claude-cli available (2.1.327), no API key.
  `brain test` → ok, about 2.9 s. Real `diary 2026-11-20` written through
  claude-cli. Main session fixed the doubled id (`diary-diary-...` →
  `diary-2026-11-20`) in `vault/new.ts` and renamed the note.
  `npm run typecheck` clean; `npm test` 72 pass.
- Not verified: logged-out behaviour, `.cmd`-only installs, real `claude.exe`
  timeout kill.

## Chat app (2026-11-20, Sonnet agent + main session)

- `npm run ui` / `node bin/aura-guard.mjs ui [--port N] [--no-open]`: local
  server on 127.0.0.1 (random port, per-launch token → HttpOnly SameSite=Strict
  cookie; Host/Origin checks; strict CSP; body cap; static allowlist) opened in
  an Edge/Chrome `--app` window with its own profile (`data/ui-profile/`); the
  server stops when the window closes. Files: `engine/src/server/*`,
  `engine/src/chat/*`, `engine/src/cli/commands-ui.ts`, `ui/*`,
  `bin/create-shortcut.ps1` (Desktop shortcut; tested only with `-OutDir`).
- Answers: search → one model call (Claude plan) → citations kept only if they
  are real sources; proposed notes labelled UNAPPROVED; "I don't know" when
  nothing matches. Slash commands are an allowlist run as child processes
  (never a shell; `--force` refused; one heavy command at a time).
- Evidence: 20 new tests (135 total at the time). Real answers through
  claude-cli (about 4 s each), correct citation, honest "I don't know" on an
  off-topic question. Headless screenshots at 800 and 1440 px looked at; no
  overflow or console errors. Real app window opened and server stopped on
  close. Main session merged `uiCommands` into `main.ts` and checked the real
  command: 401 without cookie, 403 wrong Host, 302 token page, status JSON ok.
- Known: off-topic questions still show loose keyword chips; the token is
  visible in the Edge command line to other local processes; Chrome fallback
  and the shortcut's launch are untested; index was stale (12 notes vs 29 in
  the vault) until `index` is re-run.

## End of day 2026-11-20: whole system built (main session + Sonnet/Haiku agents)

- Read STATUS.md first: it has the full picture, measured results and open
  questions. This section lists what to do next.
- Built and merged into the CLI: ui, review, refactor, replay, qa, prs, quiz,
  rules, logcheck, support, daily (see `help`). 201 tests in 25 files pass;
  `npm run typecheck` clean; vault check clean (32 notes); index current.
- Honest state: the reviewer has NO measured defect-finding ability (replay on
  15 past fixes: 0 of 210 later-fixed lines, 3 model runs, 1 finding, 0
  matches). Noise was cut (rule-compliance reported separately, top-5 cap,
  unwrap-in-rust off by default). Keep it in shadow mode.
- Aura's 12 PRs have 0 human review comments (122 system threads), so PR mining
  has no data.
- QA has never run live. To run: start Aura from a shell with
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, set
  `AURA_CDP_URL=http://127.0.0.1:9222`, then `qa status`, `qa run
  journey-orders-list`.
- Owner actions waiting: review the 50 draft quiz questions
  (`evals/quiz/questions.json`), approve or dismiss the inbox in the chat window
  (`npm run ui` > Inbox), confirm the key-shaped strings in Aura listed earlier,
  decide on committing and pushing (Guard first, so the plugin link works),
  optionally `powershell -File bin\schedule-daily.ps1 -Install`.
- Known small issues: off-topic chat questions show loose source chips; the chat
  token is visible on the Edge command line; `rules export` is not read by the
  reviewer yet; `replay` excludes the co-change rule; `new-css-file` flagged 5
  files in replay that were not examined.
- Nothing is committed since `95abf04`. Aura repo (`feature/QA-Agent`)
  uncommitted: `ai-log/`, `AGENTS.md` rule, `AI_HANDOFF.md` note,
  `.claude/settings.json`.

## Chat window redesign (2026-11-20, Sonnet agent + main session)

- Themes in `ui/themes.css` (generated colour sets) and `ui/styles.css`
  (structure), marks in `ui/marks.js`, early apply in `ui/theme.js`. Default is
  **Noir**. Each theme changes layout, message shape, typography, mark, motion,
  work-steps default and empty state; Inbox and Reports follow the theme.
- Streaming: `POST /api/chats/:id/ask` with `Accept: application/x-ndjson`
  emits `step` events then `answer` or `error`; `POST /api/command` can stream
  `started`/`output`/`done`; without the header the old JSON replies remain.
- Feedback: `POST /api/feedback` appends ids, rating and a masked short note.
- Evidence: 214 tests (13 new); screenshots in `.artifacts/ui/v2-*` looked at
  by the agent and by the main session (Noir answer view, Aurora thinking view);
  one real question through the Claude plan took 3.7 s; real app window opened
  with the new icon and title.
- Not verified in a browser: keyboard shortcuts, picker focus order, pulsing
  dots on a running chat, Regenerate and the thumbs-down prompt. Pulse is the
  weakest theme (plain sources/actions; inbox badge overlaps the collapsed
  icon). Contrast checked for 8 colour sets; Aurora measured against
  approximated opaque backgrounds. `themes.css` reduced-motion block comes from
  a script that is not in the repo.

## Departments, capture, extension and rename (2026-11-20, main session + Sonnet agents)

- Product renamed to **SPIL Quality Support Bot** in all user-facing text. Identifiers stay
  (`aura-guard`, `AURA_GUARD_*` with `QSB_*` aliases, plugin id, extension id) until the GitHub repo is
  renamed. To finish the rename: rename the GitHub repo (Settings > General), then
  `git remote set-url origin <new url>`, update the marketplace repo in Aura's
  `.claude/settings.json` and in `README.md`, then rename the folder (close VS Code first).
- Built: departments engine and API (`engine/src/departments/*`, isolation tests), landing page,
  overview, department page and wizard (`ui/depts.js` and friends), capture engine
  (`engine/src/capture/*`, `capture` and `answer` commands), VS Code extension (`extension/`).
- Local data (git-ignored): `data/departments/registry.json` (the real departments),
  `data/departments/seed.json` (the starting set; `dept seed` reads it). The repo only has
  `departments.example.json` and `departments.seed.example.json` with generic names.
- Evidence: root `npm test` 271 pass (29 files); extension `npm test` 22 pass; typechecks clean;
  end-to-end capture check (see STATUS.md section 11); a fresh-clone test is run before every push.
- Fixed in this session: extension `repoKey` did not match the engine (trailing slash, runs of
  symbols); real department names, paths and staff names were hard-coded in a seed and in tests and
  were moved to local data or replaced with generic names.
- Not verified: the extension in a real VS Code window; Index now from the dashboard against the real
  `/api/command`; 409 etag conflict UI live; the other three themes against the real server.
- Owner actions: make the GitHub repo private; install the extension to try it
  (`code --install-extension <vsix>`), delete the stray empty folder `D:\tmp`; tell the team before
  rolling out capture.
