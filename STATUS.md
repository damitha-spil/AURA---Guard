# SPIL Quality Support Bot: current status (for brainstorming)

Snapshot: 2026-11-20, end of day. Written to be pasted whole into another AI
so it has the full picture. It holds no secrets, server addresses or personal
details. Detailed docs in the repo: ARCHITECTURE.md, IMPLEMENTATION_PLAN.md,
THINKING.md, AI_HANDOFF.md, CHANGES.md, docs/adr/001-foundations.md.

---

## 1. What this is

**SPIL Quality Support Bot** is an internal engineering assistant for a glass-fabrication
software company. It learns one product, **Aura**, and the way its owner builds
it, then helps as Scribe, Code Reviewer, QA Planner and a writer of support
knowledge.

- **Aura** (the product): a Windows desktop app (Tauri 2 + Rust backend +
  React/Tailwind UI) installed at glass fabricators. It reads orders (PDFs,
  drawings, emails) with AI helpers, checks them, and saves them to the
  company's ERP ("SPIL Glass") through an MCP server. Hard rules in Aura: the AI
  never gets an ERP create tool and never guesses a price; no hard-coded company
  facts; secrets stay in an encrypted store; helpers are routed by "sign", never
  by name.
- **Guard** is separate from the product. It **reads** Aura's repositories and
  **suggests**. People decide and commit. Guard never writes to the ERP or to
  Aura's repo.
- Long term the same engine serves other departments (Finance, HR), each with
  its own knowledge folder and permissions.

## 2. Principles (agreed)

1. **Memory first, training later.** Build checked knowledge now; a paid model
   (Claude) reasons. Fine-tune a small local model only after 300-500 approved
   examples exist (there are about 11 proposed ones today).
2. **People approve what becomes a rule.** Guard proposes; the owner approves.
   Nothing is auto-approved.
3. **Read-only and advisory.** It never commits, merges, posts to PRs or blocks
   a merge until measured results earn that.
4. **Simple checks before AI checks.**
5. **No secrets leave the machine.** Every outgoing model call (API or CLI)
   passes local masking; a detected secret stops the call; an audit line (hash
   and counts only) is written.
6. **Respect the PC.** It runs out of memory during Rust builds, so background
   work waits while builds run.
7. **Support knowledge ships inside Aura.** Guard drafts, people review, it
   ships in Aura's repo. Aura never queries Guard live.

## 3. Progress

Against the 4-phase plan, **about 75% is built, but much less is proven**
(see section 5). Built does not mean good: the reviewer in particular has no
measured defect-finding ability yet.

| Phase | Built | Proven |
|---|---|---|
| 0 Setup | done | n/a |
| 1 Ingest, index, MCP, quiz | ~95% (meaning search deferred) | search works; quiz recall 90.5% on draft questions the owner has not reviewed |
| 2 Choice records, Scribe, rules | ~85% | Scribe wrote a real diary; session mining works; PR mining works but Aura's PRs have no human comments, so it has nothing to learn from |
| 3 Reviewer + QA in shadow mode, UI | ~70% | reviewer: no measured bug-finding yet; QA: never run live against Aura |
| 4 Go live, local model, support, ACP | ~15% | support draft pipeline proven on one topic; nothing live; no local model |

Tests: 271 in 29 files in the engine plus 22 in the VS Code extension, all passing; typecheck (src and tests) clean.

## 4. Architecture as built

```
 INTERFACES   Chat window (local web app in an Edge/Chrome app window)
              CLI (aura-guard ...) - MCP server over stdio (dev/qa/support scopes)
              Claude Code plugin (marketplace + skills + commit hook)
 ROLES        Scribe (diary) - Reviewer/Refactor - QA planner + Playwright runner
              Support writer - Rules pipeline - daily routine
 BRAIN        Claude via API key OR your Claude plan through the Claude Code CLI
              (text-only: no tools, no MCP, empty temp folder); always behind masking
 SEARCH       FTS5 word search - history - co-change - stale notes - code graph
              (graphify, local AST) - blast radius
 MEMORY       Obsidian vault (truth, git-versioned) + one disposable SQLite index
 INGEST       Aura + ERP-MCP git history and docs (read-only), Claude Code sessions,
              Azure DevOps PR threads (read-only GET), the AI activity log
```

### Tech

TypeScript on Node 26 run directly (`--experimental-strip-types`, no build);
`node:sqlite` (FTS5); deps: MCP SDK, zod, yaml, playwright-core (attach only, no
browser download). graphify runs from a local Python venv (not in git). The chat
app has no framework and no build step.

### Folder layout

```
engine/src/  ingest index vault mask guard brain roles sessions graph mcp cli
             chat server review qa prs quiz rules logcheck support
engine/test/ 25 test files      ui/  chat app (plain HTML/CSS/JS)
vault/       notes: rules adr patterns domain diary choices incidents journeys
             support inbox _templates   (Obsidian vault)
roles/       role configs: scribe, reviewer, refactor, qa-planner, review-rules.json, daily.json
qa/          Playwright helpers, forbidden-actions.json, generated specs (proposed)
evals/       masking case generator, quiz questions
plugin/      the Claude Code plugin    bin/  launchers and scripts
```

### Note format

Frontmatter: `id`, `type` (adr | rule | pattern | incident | domain | diary |
choice | journey), `status` (proposed | shadow | active | stale | deprecated),
`audience` (internal_dev | qa_internal | customer_support), `source`,
`code_anchors` (repo, path, optional verified commit; a later change to the path
marks the note stale), `created`, `reviewed`. Pattern notes carry a fenced JSON
check block (for example "when A changes, B must change").

### Commands

`index [--graph]`, `ask`, `check`, `stale`, `history`, `cochange`, `status`,
`graph import|blast|refresh`, `diary [date]`, `mine`, `brain status|test`,
`ui`, `review`, `refactor`, `replay`, `qa plan|generate|check|run|status`,
`prs sync|mine|dataset|status`, `quiz list|run`, `rules
propose|list|show|approve|dismiss|export`, `logcheck`, `support
draft|list|export`, `daily`. Run with `npm run guard -- <cmd>` or
`node bin/aura-guard.mjs <cmd>`.

### MCP tools (read-only)

search_knowledge, get_doc, get_blast_radius, trace_history, co_changed,
list_rules, stale_notes. The support scope gets only search_knowledge and
get_doc, and only notes tagged customer_support.

### Chat window

Four full themes (Noir default, Pulse, Dots, Aurora) switched from an Appearance
picker; each changes layout, typography, mark and motion, not just colour.
Live work steps come from real server events. Local server on 127.0.0.1 with a per-launch token cookie, Host/Origin checks and
a strict CSP; all model and note text is escaped before display. Views: Chat
(answers cite real sources, proposed notes are labelled unapproved, honest "I
don't know"), Inbox (approve / dismiss / undo proposed notes; every approval is
logged), Reports (review, QA plan, daily, quiz, log check). Slash commands come
from a fixed allowlist.

### Safety measures

Masking (secrets block the call; sensitive values become placeholders;
unmasked locally); the CLI brain has no tools; QA specs pass a static safety
check and a runtime guard that refuse save/create/send/delete and non-local
traffic; PR mining uses GET only and stores people as hashes; support drafts
pass a leak check (no code, paths, shas, hosts, names); approvals edit only the
status/reviewed lines.

## 5. Measured results (honest)

| Area | Result |
|---|---|
| Index | Aura 254 commits + 145 docs (ERP-MCP included), 32 notes, about 5 s; graph 21,109 nodes / 55,843 edges (about 1 minute) |
| Quiz (50 draft questions, drafted by an AI from the same notes) | retrieval recall@5 90.5% (gate 90%); model mode 10 of 10 on a sample. Flattering until the owner reviews the questions |
| Masking | test gate 100% on 238 synthetic cases; on 1,156 real Aura files wrongly blocked fell 13% to 1.9% |
| Session mining | 14 sessions, 405 owner messages, 73 candidates, 9 proposed notes |
| PR mining | 12 Aura PRs, 122 threads, all system events: **zero human review comments** |
| Rules | 2 proposed co-change rules (4 commits of evidence each, weak) |
| Log check | 0% of Aura commits have an AI-log entry (the log started today) |
| Reviewer, fixed checks, replay on past bug fixes (15 fixes) | defect-class recall **0 of 210** later-fixed lines, precision 0; noise cut from 1,285 findings to 39 policy findings after tuning |
| Reviewer, model, same replay | run on only 3 changes: 1 finding, 0 matches. Sample far too small to conclude anything |
| QA | plan ranked 7 journeys for Aura HEAD; one spec generated and safety-checked; **never run against a live Aura** |

**The 80% precision / 70% recall gate for the reviewer is nowhere near.** To get
there: 50-100 labelled cases, the model run on every case (split large changes
instead of skipping them), defect checks designed from what past fixes really
were (ignored errors, state guessed from fields, tool-list edge cases), and
hand-grading of the model's findings. Rule compliance (no hard-coding,
Tailwind-only, plico untouched) is a different job from defect finding and is
now reported separately.

## 6. Known problems and gaps

1. Reviewer has no proven defect-finding ability; keep it in shadow mode.
2. Aura PRs have no human comments, so PR-based taste learning has no data.
3. QA needs Aura started with a WebView2 debugging port; whether Playwright
   attaches to Aura's WebView is an untested assumption. No video via CDP.
4. graphify has no nodes for JSON files (e.g. the helper config); graph refresh
   is opt-in.
5. Session mining is keyword-based; recall unmeasured; mid-score candidates are
   mostly noise.
6. Masking trade-off: obviously fake-looking keys are let through.
7. Off-topic chat questions still show loose search chips beside "I don't know".
8. The chat window's one-time token is visible on the Edge command line to
   other local programs.
9. A few key-shaped strings in Aura's source await the owner's confirmation
   that they are test values.
10. Nothing in the vault is `active` yet: the 12 seed notes, 11 inbox notes,
    journeys and the support draft all wait for the owner.
11. No meaning (embedding) search: no local model runtime installed and memory
    is tight.

## 7. Next steps

1. Owner: review the 50 quiz questions, the seed rules and the inbox in the chat
   window; approve what is right.
2. Run live QA once: start Aura with a debugging port, `qa run` a read-only
   journey.
3. Grade the reviewer by hand in shadow mode on real PRs; build the labelled
   replay set; design defect checks from real fixes.
4. Leave human review comments on PRs so there is something to learn from.
5. Wire approved co-change rules into the reviewer's fixed checks
   (`rules export` writes them; the reviewer does not read them yet).
6. First real diaries every day (`daily`, optionally scheduled).
7. Later: embeddings, small local model after 300-500 approved examples, ACP
   interface, other departments, PR hooks once gates pass.

## 8. Ideas considered and where they landed

| Idea | Decision |
|---|---|
| Fine-tune a model first | No: memory first. |
| CrewAI / AutoGen | No: one state machine per role, config files. |
| Crow CI | Maybe later as a job runner; not now. |
| Crow ADE / crow-cli (ACP) | Borrow ideas; add ACP as an interface later; never run Guard roles inside an all-access agent. |
| vostride/agent-qa | Ideas only (journeys as reviewable files, lessons retired when stale, evidence per run). Code not reused: FSL license, web/mobile only, sends data to a provider. |
| Obsidian | Yes: the source of truth. |
| graphify | Yes, local mode only; data in SQLite not the vault. |
| Support helper querying Guard live | No: Guard drafts, Aura ships. |
| Other plan CLIs (Codex, Antigravity, Cursor) as brains | No: cannot be locked to text-only. |
| Tauri installer for the chat app | Later; a Node server in an app window is enough now. |

## 9. Open questions to brainstorm

1. How to get a trustworthy labelled set of past bugs to measure the reviewer?
2. What defect checks would have caught the real fixes (logic and behaviour
   faults, not style)? Can a model be steered to find them with few false
   alarms?
3. Without human PR comments, where does the owner's review taste come from?
   (Grading Guard's own findings? A daily 5-minute chat? Voice notes?)
4. Is a model comment at 3 per change useful or noise to a developer? How to
   measure usefulness, not just matches to later fixes?
5. How to run live QA safely and cheaply against a Tauri/WebView2 app on a
   memory-limited PC; how to get video evidence.
6. How to keep notes from rotting beyond code anchors (wrong, not just stale)?
7. Which embedding model and runtime fit a memory-limited Windows PC that also
   compiles Rust, and is it needed at all given 90% word-search recall?
8. How to separate departments (Finance, HR) so data cannot cross, including
   inside the shared index?
9. When is Guard allowed to comment on real PRs, and who decides?
10. Best use of the AI activity log: coverage check, learning source, or both?

## 10. Constraints any suggestion must respect

- Guard only reads other repos; it never writes to them, to PRs, or to any ERP.
- No secrets in the vault, index, logs or outgoing calls.
- The shared QA database server may only use its designated test database.
- Windows 11 dev PC with limited memory; paths contain spaces.
- Notes become rules only with the owner's approval.
- Nothing ships to fabricators from Guard directly.

---

## 11. Update: departments, the landing page and developer capture

Added after the sections above were written.

- **Multi-department platform.** Departments, modules, sub-modules and sources are created and edited
  in the app (wizard, landing page, department page) or with `dept ...`. Each department has its own
  vault, index and chats; isolation is tested across every API endpoint. The registry and the starting
  set are local files (`data/departments/`), never in git.
- **Landing page.** The app always opens on "Choose your department" (tiles or an overview table),
  in all four themes. Noir is the default.
- **Developer capture (opt-in).** A VS Code extension (own package in `extension/`, 22 tests, packaged
  as a 20 KB `.vsix`) records masked activity to a local spool; the engine drafts ai-log entries;
  the developer reviews a diff before anything is written to their repo.
- **Measured.** End to end with the extension's own code and the real CLI: 7 events written, read,
  summarised through the Claude plan in 4.4 s into a faithful draft, purged; the repo stayed clean. A
  `repoKey` mismatch between the extension and the engine was found by the shared test vectors and
  fixed. Departments indexed read-only for real (for example 290 commits for the project department,
  737 for the two repositories of the shapes department).
- **Still unproven.** The extension has never run in a live VS Code window (consent dialog, status
  bar, `@guard`, diff view); installing works into a throwaway profile only. Only the Claude Code
  transcripts are read for AI prompts and replies; Copilot Chat or Cursor chats cannot be read.
- **Decisions to make.** The project department no longer indexes the ERP connector repository;
  add it as a second source of that department if cross-repo contract checks matter. Rename the GitHub
  repository and the identifiers (`aura-guard`) together, then update Aura's `.claude/settings.json`.
