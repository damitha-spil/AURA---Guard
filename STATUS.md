# AURA Guard: current status (for brainstorming)

Snapshot: 2026-11-20. This file is written to be pasted whole into another AI
so it has the full picture. It holds no secrets, server addresses or personal
details. Detailed docs in the repo: ARCHITECTURE.md, IMPLEMENTATION_PLAN.md,
THINKING.md, AI_HANDOFF.md, docs/adr/001-foundations.md.

---

## 1. What this is

**AURA Guard** is an internal engineering assistant for a glass-fabrication
software company. It learns one product, **Aura**, and the way its owner builds
it, so it can later act as Scribe, Code Reviewer, QA Planner and a writer of
support knowledge.

- **Aura** (the product being learned): a Windows desktop app (Tauri 2 + Rust
  backend + React/Tailwind UI) installed at glass fabricators. It takes orders
  (PDFs, drawings, emails), reads them with AI helpers, checks them, and saves
  them to the company's ERP ("SPIL Glass") through an MCP server ("ERP MCP").
  Hard rules in Aura: the AI never gets an ERP create tool and never guesses a
  price; no hard-coded company facts; secrets stay in an encrypted store;
  helpers are routed by "sign" (a capability label), never by name.
- **Guard** is separate from the product. It **reads** Aura's repositories and
  **suggests**. People decide and commit. Guard never writes to the ERP.
- Long term, the same engine serves other departments: AURA Guard Dev,
  Finance, HR. One engine, a separate knowledge folder and permissions for each.

## 2. Principles (agreed)

1. **Memory first, training later.** The first months build checked knowledge.
   A paid model (Claude) does the reasoning. A small local model is fine-tuned
   only after 300–500 approved examples exist.
2. **People approve what becomes a rule.** Guard proposes; the owner approves.
3. **Read-only and advisory.** It never commits, merges or blocks a merge until
   measured results earn that.
4. **Simple checks before AI checks.** Anything a fixed check can prove (files
   that must change together, forbidden imports) becomes a deterministic check.
   The paid model is kept for judgment.
5. **No secrets leave the machine.** Every outgoing model call passes a local
   masking step; a detected secret stops the call.
6. **Respect the PC.** The dev PC runs out of memory during Rust builds, so
   background work waits while builds run.
7. **Support knowledge ships inside Aura.** Guard drafts it, people review it,
   and it ships in Aura's repo. Aura never queries Guard live, because
   fabricators must not depend on a machine in the office.

## 3. Status at a glance

| Area | State |
|---|---|
| Design docs, ADR-001, working rules | done |
| Index (SQLite), word search, history, co-change | **built and working** |
| Obsidian vault + note format + checker + templates | **built**; 12 seed notes, all `proposed`, not yet reviewed by the owner |
| Stale-note detection (notes tied to code) | built; nothing to flag yet (no note has a verified commit) |
| Masking of outgoing calls | **built and tuned on real code** |
| Code graph (graphify) + blast radius | **built**; manual refresh |
| Read-only MCP server (dev / qa / support scopes) | **built** |
| CLI | **built** |
| Resource guard | built |
| Paid-model client | **not built** |
| Roles (Scribe, Reviewer, QA, Support writer) | **not built** |
| Meaning search (embeddings) | not built |
| Session / PR-comment mining, choice records | not built |
| Control screen (UI) | not built |
| Knowledge quiz | not started (owner writes the questions) |

Tests: 44, all passing. Typecheck clean. Code is on GitHub (`master`).

## 4. Architecture as built

```
             ┌──────────── INTERFACES ─────────────┐
             │ CLI (aura-guard ...)                 │
             │ MCP server over stdio                │
             │   dev / qa scope: 7 tools            │
             │   support scope: 2 tools, support    │
             │   notes only                         │
             └──────────────┬───────────────────────┘
                            │
   ┌──────────── SEARCH AND GRAPH ──────────────────┐
   │ FTS5 word search (safe query builder,          │
   │   stop words, audience + stale filters)        │
   │ history by path · files that change together   │
   │ stale notes · blast radius (code graph)        │
   └──────────────┬──────────────────────────────────┘
                  │
   ┌──────────── INDEX: one SQLite file ────────────┐
   │ docs (notes, commits, repo docs) + FTS5        │
   │ commit_files · anchors · repo_state            │
   │ graph_nodes · graph_edges                      │
   │ disposable: rebuilt from vault + repos          │
   └──────────────┬──────────────────────────────────┘
                  │
   ┌──────────── SOURCES ───────────────────────────┐
   │ Obsidian vault (source of truth for knowledge) │
   │ Aura + ERP MCP repos: git log, docs, skills    │
   │   (read-only git commands only)                │
   │ graphify output (local AST, no LLM)            │
   └─────────────────────────────────────────────────┘

   Side parts: masking (secret block + placeholder replace + audit log)
               resource guard (waits for builds / low memory)
```

### Tech choices (ADR-001)

- TypeScript run directly by Node 26 (`--experimental-strip-types`), no build
  step for development.
- SQLite through Node's built-in `node:sqlite` (FTS5 works; extension loading
  available for sqlite-vec later). No native npm modules.
- Dependencies: MCP SDK, zod, yaml. graphify runs from a local Python venv.
- Runs on the owner's Windows PC first; an office machine later.
- Paid model: Guard's own small client (planned), always behind masking.

### Repository layout

```
engine/src/
  types.ts, config.ts         shared contracts, per-machine config
  ingest/                     git commits, repo docs (read-only)
  index/                      db, notes, search, history, co-change, stale, graph
  vault/                      frontmatter, schema (zod), load, new note
  mask/                       detectors, mask/unmask, audit log
  guard/resources.ts          pause during builds / low memory
  mcp/server.ts               read-only MCP server with scopes
  cli/                        command line; words in copy.ts
engine/test/                  44 tests (node:test)
vault/                        Obsidian vault: rules/ adr/ patterns/ domain/
                              diary/ choices/ incidents/ inbox/ _templates/
evals/masking/                case generator (fake secrets made at test time)
docs/adr/                     decision records
```

### Note format (every vault note)

```yaml
---
id: rule-desk-routing-by-sign
type: rule            # adr | rule | pattern | incident | domain | diary | choice
status: proposed      # proposed | shadow | active | stale | deprecated
audience: [internal_dev, qa_internal]   # or customer_support
department: dev
source: import        # owner-answer | commit | pr-comment | session | evidence | import
code_anchors:
  - repo: spil-aura
    path: apps/personal-agent/crates/agent-core/src/desk/
    verified_sha: <commit>    # when set, later changes to the path mark the note stale
created: 2026-11-20
---
```

### MCP tools

| Tool | dev | qa | support |
|---|---|---|---|
| `search_knowledge` | yes | yes | yes (support notes only) |
| `get_doc` | yes | yes | yes (support notes only) |
| `trace_history` | yes | yes | no |
| `co_changed` | yes | yes | no |
| `list_rules` | yes | yes | no |
| `stale_notes` | yes | yes | no |
| `get_blast_radius` | yes | yes | no |

### CLI

`index`, `ask`, `check`, `stale`, `history`, `cochange`, `status`,
`graph import`, `graph blast`, `help`.

## 5. Real numbers so far

- Index build: Aura 228 commits + 145 docs, ERP MCP 26 commits + 43 docs, 12
  notes, about 5 s. Re-run picks up only new commits.
- Search: "why does the AI never get an ERP create tool" → the matching rule
  note first; "how is a job routed to a helper" → the routing rule first.
- graphify on Aura: about 45 s, 21,109 nodes, 55,843 edges; import 1.7 s.
  Blast radius of the desk router lists the files that call it.
- Masking on 1,156 real Aura files: wrongly blocked files went from 13% to
  1.9% after tuning. Test gate: 93/93 secrets blocked, 27/27 private values
  replaced, 0/118 clean cases changed.

## 6. Known problems and gaps

1. `npm run guard -- ask "..."` breaks in Git Bash on Windows (npm re-quotes
   through cmd). Calling Node directly works.
2. graphify gives no nodes for JSON files (e.g. the helper config `desk.json`),
   and the graph is a manual snapshot, not refreshed by `index`.
3. Merge commits record no changed files.
4. Tests are not typechecked.
5. Masking trade-off: keys that look obviously fake (`abcdef`, `123456` runs)
   are allowed through, which could let an unusual real key through.
6. A few key-shaped strings exist in Aura's own source and need the owner to
   confirm they are test values.
7. The seed notes came from Aura's written rules only; none is `active` yet.

## 7. Planned next steps

1. **Paid-model client** behind masking, with prompt caching on fixed rules.
2. **Scribe role**: end-of-day diary from commits, handoff changes and coding
   sessions; asks up to 3 questions; answers become notes.
3. **Choice records**: mine Claude Code sessions, AI-draft-vs-final-commit gaps
   and PR comments for "context / rejected / chosen / why".
4. **Rule pipeline**: observed → proposed → approved; fixed-shape rules become
   deterministic checks.
5. **Reviewer in shadow mode** on real PRs, scored by replaying 30–50 past PRs.
6. **QA Planner in shadow mode**: changed files → affected flows → test plan.
7. Meaning search (sqlite-vec + small embedding model).
8. Control screen: rule approvals, Scribe inbox, stale notes, grading, scores.
9. Later: LoRA on approved choice records for a small local model; ACP
   interface for editors; other departments.

### Release gates before a role goes live

| Test | Gate |
|---|---|
| Knowledge quiz (50+ questions with citations) | ≥ 90% correct |
| Past-PR replay | precision ≥ 80%, recall on serious bugs ≥ 70% |
| Search recall for a diff | ≥ 85% in top 5, no stale rules used |
| Masking test | 100% of planted secrets caught |
| Owner acceptance of proposals | ≥ 75% |

## 8. Ideas considered and where they landed

| Idea | Decision |
|---|---|
| Fine-tune a model from day one | No. Memory first; fine-tune later on approved data. |
| CrewAI / AutoGen multi-agent | No. A small state machine + one config file per role. |
| Crow CI (CI with worker agents) | Maybe later as a job runner on an office machine; Azure/GitHub pipelines first. |
| Crow ADE / crow-cli (ACP coding agent) | Borrow ideas (skills catalog, live tool calls); add ACP as an interface later. Do not run Guard's roles inside an all-access agent. |
| Obsidian | Yes: the human-readable source of truth. |
| graphify | Yes: local AST mode only; data in SQLite, not in the vault. |
| Support helper querying Guard live | No: Guard drafts, Aura ships. |
| Reversible masking (put real names back) | Later; block-and-mask first. |
| Gate on the model's own confidence | No: gate on measured precision/recall. |
| Names | Considered Facet, Kiln, Vitra and others; owner chose **AURA Guard**. |

## 9. Open questions to brainstorm

1. Best way to capture the owner's **taste**: which signals beyond sessions,
   commits and PR comments (voice notes? a daily 5-minute chat?)
2. How to turn choice records into review comments without nagging:
   thresholds, comment caps, when to stay silent.
3. Smallest useful **Scribe**: what exactly goes in a daily note, and how to
   keep the owner's daily effort under 5 minutes.
4. How to detect when a note is **wrong**, not only stale.
5. Which local model and embedding model fit a memory-limited Windows PC that also
   compiles Rust, and when to load them.
6. Shape of the **QA Planner** output so it plugs into Aura's existing evidence
   rules (real-app screenshots and video for UI changes).
7. How to structure department separation (Finance, HR) so data can never
   cross, including in the shared index.
8. Control-screen design: CLI only, a small web page, or a Tauri window like
   Aura's.
9. How to keep the graph fresh cheaply (incremental graphify? tree-sitter
   directly in Node?).
10. What the first 50 quiz questions should cover.

## 10. Constraints any suggestion must respect

- Guard only reads other repos; it never writes to them or to any ERP.
- No secrets in the vault, index, logs or outgoing calls.
- The shared QA database server may only use its designated test database.
- Windows 11 dev PC with limited memory; paths contain spaces.
- Notes become rules only with the owner's approval.
- Nothing ships to fabricators from Guard directly.
