# Working in SPIL AURA QA Bot

Read [AI_HANDOFF.md](AI_HANDOFF.md) and run `git status --short` before
changing anything. Keep the handoff current after every meaningful change,
test, decision or blocker, and before stopping. Never record secrets.

Do not commit or push unless the owner asks.

## What Guard may and may not do

- Guard **reads** other repositories (Aura, ERP-MCP and others). It only runs
  read-only git commands there (`log`, `show`, `ls-files`, `rev-parse`). It never
  checks out, fetches, resets or writes in them.
- Guard **suggests**. It never commits, merges or writes to an ERP.
- Every outgoing paid-model call goes through `engine/src/mask/`. A call with a
  detected secret is not sent.
- Notes written by Guard start as `status: proposed`. Only the owner makes a
  note `active`.
- Support knowledge (`audience: customer_support`) is drafted here and shipped
  inside Aura after human review. Aura never queries Guard live.
- On the shared QA SQL Server, use only the Cobalt database.

- **One project.** This bot works on SPIL Aura only: one config, one vault, one index, one chat
  folder. Repo paths, folder paths and names are company facts: they live in local config
  (`guard.config.local.json`, git-ignored), never in code, tests, docs or git. Use generic
  names in tests and examples.
- **The vault and anything derived from private repos or chats stays out of git.**
  This repo is public: only code, generic docs, templates and fixtures are pushed.
- **Developer activity capture.** Only the VS Code extension writes the capture spool, and
  only after the developer's consent. The engine reads the spool and returns DRAFT
  ai-log entries; the extension appends a draft to the developer's own `ai-log/` only
  after the developer reviews a diff and confirms. The engine itself never writes into
  another repo.

## Layout

| Folder | What |
|---|---|
| `engine/src/ingest/` | read repos: commits, docs |
| `engine/src/index/` | SQLite index (disposable), search, history, co-change, stale notes |
| `engine/src/vault/` | note format, loading, checking, new notes |
| `engine/src/mask/` | secret blocking, masking, egress audit |
| `engine/src/guard/` | resource guard (pause during builds) |
| `engine/src/mcp/` | read-only MCP server |
| `engine/src/cli/` | `aura-guard` command line; words in `copy.ts` |
| `engine/src/capture/` | read the capture spool, draft ai-log entries |
| `engine/src/{review,qa,prs,quiz,rules,logcheck,support}/` | roles and learning |
| `engine/src/{chat,server}/` and `ui/` | chat app, landing page, dashboard (four themes) |
| `extension/` | VS Code companion extension (own package) |
| `plugin/` | Claude Code plugin |
| `vault/` | Obsidian vault: the source of truth |
| `roles/` | role config files |
| `evals/` | quiz, masking cases, PR replay |
| `docs/adr/` | decision records |

The index in `data/` is never committed; delete it and run
`npm run guard -- index` to rebuild.

## Rules for code

- TypeScript run directly by Node (`--experimental-strip-types`): `.ts`
  extensions in imports; no enums, namespaces or parameter properties.
- SQLite through `node:sqlite` only. No native modules without an ADR.
- Shared types live in `engine/src/types.ts`. Change them with a note in the
  handoff.
- No hard-coded paths, servers, company or customer names. Per-machine settings
  go in `guard.config.local.json` (ignored by git).
- Safety limits are named constants with a comment saying why.
- Run git and other programs with `execFile` and an argument list, never a
  shell string (paths have spaces on this PC).

## Checks

Stop heavy builds first; this PC runs out of memory.

```
npx tsc -p engine --noEmit
npm test
git diff --check
```

The masking test must catch 100% of planted secrets. Do not relax it to make it
pass.
