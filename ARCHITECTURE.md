# SPIL REO Architecture

Status: updated 2026-11-28. Open decisions are marked **OPEN**. See [docs/README.md](docs/README.md) for the full documentation index.

## 1. Purpose

1. Learn Aura: its code, rules, decisions, history and the reasons behind them.
2. Learn how the owner works: choices made, options rejected, review habits,
   daily routine.
3. Later, use that knowledge in roles: Scribe, Code Reviewer, QA Planner, and a
   source of checked support knowledge for Aura.
4. Stay focused on one project: SPIL Aura.

## 2. Principles

- **Memory first, training later.** For the first months, "learning" means
  building checked knowledge. A paid model does the reasoning. Fine-tuning a
  small local model comes only after hundreds of approved examples exist.
- **People approve what becomes a rule.** Guard proposes; the owner approves.
  Nothing becomes active knowledge silently.
- **Read-only and advise-only by default.** Guard never commits, never merges,
  never gets an ERP write tool. It does not block merges until measured results
  earn that.
- **Simple checks before AI checks.** Anything a fixed check can prove is done
  by a fixed check. The paid model is kept for judgment.
- **One project.** SPIL AURA QA Bot works on SPIL Aura and the repositories it depends on.
  Repositories are listed in the local config.
- **No secrets leave the machine.** Every outgoing model call goes through a
  local masking step.
- **Respect this PC.** It runs out of memory. Background work pauses during
  builds.

## 3. Shape

```
┌──────────────────────── 6. INTERFACES ────────────────────────┐
│ Tauri 2 Desktop + React 19 / shadcn/ui Web App (web/)         │
│ Workspace · QA Harness · QA Lab · Defects · Agents · Settings │
│ MCP server (stdio) · CLI (aura-guard) · Azure DevOps / GitHub │
└───────────────────────────────┬───────────────────────────────┘
┌─────────────── 5. AUTONOMOUS QA HARNESS & AGENTS ─────────────┐
│ Orchestrator + 12 Specialist Agents (qa, qe, review, security,│
│ api, a11y, perf, release, architect, triage, knowledge,       │
│ report) + REO-Created Custom Agents, Composite Tools & Skills │
│ Parallel Swarm · Live Steering · Self-Learning · OTel Traces  │
└───────────────────────────────┬───────────────────────────────┘
┌────────────── 4. MULTI-PROVIDER BRAIN & MASKING ──────────────┐
│ Official CLI Subscriptions (Antigravity, Claude, OpenCode)    │
│ + Encrypted OS Key Store API Providers · 100% Masking Proxy   │
│ Tier 0 fixed checks · Resource Guard (pauses during builds)   │
└───────────────────────────────┬───────────────────────────────┘
┌─────────────── 3. SEARCH AND PATTERN LEARNING ────────────────┐
│ words (FTS5) + code graph + co-change + trajectory/drift      │
│ choice records → rule proposals → stale-note detection        │
└───────────────────────────────┬───────────────────────────────┘
┌──────────────────────── 2. MEMORY ────────────────────────────┐
│ Truth: git-versioned Obsidian vault (`vault/`)                │
│ 3-Layer QA Memory (`project`, `execution`, `procedural`)      │
│ Index: disposable SQLite (`data/guard.db`) rebuilt anytime    │
└───────────────────────────────▲───────────────────────────────┘
┌──────────────────────── 1. INGEST ────────────────────────────┐
│ git history and diffs · Azure DevOps & GitHub PRs ·           │
│ AI_HANDOFF.md · AGENTS.md · skills · Claude Code sessions ·   │
│ CI and test logs · evidence packets · owner's notes           │
└───────────────────────────────────────────────────────────────┘
```

## 4. Memory

### 4.1 The vault is the truth

The Obsidian vault (`vault/`) holds every piece of curated knowledge as a
Markdown note. It lives in git, so every change has history and review.
SQLite is only an index: delete it and rebuild it from the vault and the
repositories. Facts never live only in SQLite.

### 4.2 Note format

Every note starts with this frontmatter. The indexer rejects notes that do not
follow it.

```yaml
---
id: rule-desk-routing-by-sign
type: rule            # adr | rule | pattern | incident | domain | diary | choice
status: active        # proposed | shadow | active | stale | deprecated
audience: [internal_dev, qa_internal]   # who may see it (see 4.4)
source: owner-answer  # owner-answer | commit | pr-comment | session | evidence
code_anchors:
  - repo: spil-aura
    path: apps/personal-agent/crates/agent-core/src/desk/
    symbol: route_job
    verified_sha: <commit>
created: 2026-11-20
reviewed: 2026-11-20
---
```

### 4.3 Stale-note detection

On each new commit, the indexer compares changed functions and files with every
note's `code_anchors`. If an anchored function changed in a meaningful way, the
note becomes `stale` and goes into the owner's daily inbox for a quick check.
The Reviewer never uses a stale note as an active rule.

### 4.4 Audiences

| Audience | Who sees it |
|---|---|
| `internal_dev` | Dev roles: code, history, decisions, preferences |
| `qa_internal` | QA Planner |
| `customer_support` | Only checked, product-level knowledge: workflows, troubleshooting, known limits. No code, no internal bugs, no history |

The MCP server gives each consumer a separate scope and token. A consumer only
receives notes in its audience.

### 4.5 Choice records

The most useful learning signal is what the owner rejected, not only what was
committed. Guard mines it from Claude Code sessions, the gap between an AI draft
and the final commit, and PR comments.

```json
{
  "context": "Retry when the reader is slow",
  "rejected": "Unbounded retries with a silent catch",
  "chosen": "Fallback to Aura's own reading after a time limit, with a visible state",
  "why": "Silent retries hide problems from staff",
  "source": ["session", "commit"],
  "status": "approved"
}
```

Early on, the three most relevant approved records are given to a role as
examples. Later, 300–500 approved records become the training set for the
small local model.

## 5. Search

One SQLite file (WAL mode) holds four indexes. Results are merged by
reciprocal rank fusion.

| Index | Built with | Answers |
|---|---|---|
| Words | FTS5 | exact names, error text, config keys |
| Meaning | sqlite-vec + small embedding model, chunks split at function/class edges by Tree-sitter | "how do we handle the reader failing?" |
| Code graph | Tree-sitter + graphify edges | "what depends on this function?" |
| Co-change | git history | files that always change together, even across repos |

## 6. Pattern learning and rules

```
observed → proposed → shadow → active → (stale | deprecated)
```

- The pattern miner proposes rules, for example "when `desk.json` changes,
  `copy.ts` and the desk test change too".
- The owner approves or dismisses in the control screen.
- **Fixed-shape rules** (files that change together, forbidden imports, missing
  fields, naming) become Tier 0 checks: a Tree-sitter query, a JSON schema or a
  diff rule.
- **Judgment rules** (architecture, boundaries, wording on screens) stay as
  notes the paid model reads.

## 7. Router, masking and resource guard

### 7.1 Tiers

| Tier | What | Used for |
|---|---|---|
| 0 | Fixed checks | anything with a provable answer |
| 1 | Small local model (1–4B) and embeddings, via llama.cpp or Ollama, started on demand | sorting, triage, masking help, offline answers |
| 2 | Paid model (**OPEN**: own client vs Aura's provider layer) | review, explanation, test plans |

Static instructions and active rules go first in each prompt, so prompt caching
lowers the cost of repeated reviews.

### 7.2 Masking

Every Tier 2 call goes through a local proxy:

1. Find secrets: patterns, high-randomness strings, connection strings, tokens.
   These are **blocked**; the call does not go out.
2. Replace sensitive names (customers, servers, internal addresses, schema
   names) with stable placeholders such as `CUSTOMER_01`.
3. Keep a local log of the hash of every payload sent.
4. Later: put the real names back into the answer locally.

A test set of planted secrets must be caught 100% of the time. That is a hard
release gate.

### 7.3 Resource guard

- Before indexing or starting a local model, check for `cargo`, `rustc`,
  `msbuild`, `node` builds and memory pressure. If any are busy, wait.
- Unload the local model after a few idle minutes.
- Re-index only what changed, by content hash.

## 8. Roles

Each role is one file in `roles/`. A small state machine runs it. There is no
free agent-to-agent chat.

| Role | Trigger | Tools | Limits | Output |
|---|---|---|---|---|
| Scribe | end of day, after merge | git diff, session reader, vault draft | never writes active notes; at most 3 questions a day | diary draft, proposed notes, stale alerts |
| Code Reviewer | PR, or `aura-guard review` | diff, code graph, rules, Tier 0 checks | read-only; at most 5 comments a PR; no style nitpicks | findings: blocker / risk / suggestion, with a suggested patch |
| QA Planner | PR ready for test, release | code graph, evidence history, read-only QA data (Cobalt only on the shared server) | no ERP writes | ranked test plan, edge cases, test stubs |
| Support writer | on request | `customer_support` notes | no code or history | support docs drafted **for Aura's repo**, reviewed by people |

### Why the support helper does not query Guard live

Aura is installed at every fabricator. Guard runs inside SPIL. If Aura's support
helper depended on Guard at run time, customers would depend on a machine in
SPIL's office. So Guard **drafts** support knowledge, people review it, and it
ships inside Aura as docs or skills. Guard drafts; Aura ships.

## 9. Interfaces

- **MCP server** (first): `search_knowledge`, `explain_symbol`,
  `get_blast_radius`, `trace_history`, `list_rules`. Used from Claude Code and
  VS Code.
- **CLI**: `aura-guard ask`, `review`, `diary`, `index`, `eval`.
- **Control screen**: rule approval queue, Scribe inbox, stale notes, shadow
  review grading, eval scores.
- **Azure DevOps**: PR hook for the Reviewer, once it goes live.
- **ACP** (planned): lets editors that speak the Agent Client Protocol, such as
  Zed or Crow ADE, talk to Guard's roles.

## 10. Where heavy jobs run

Fixed checks, the weekly quiz, past-PR replay and nightly re-indexing run as
pipeline jobs. First choice: Azure Pipelines with a self-hosted Windows agent,
because the repos and PRs already live in Azure DevOps. Crow CI is an option
for a self-run office machine; check first that it supports Azure DevOps.

## 11. Proving it works

| Test | Measures | Gate before going live |
|---|---|---|
| Knowledge quiz | 50+ questions about Aura, with citations | 90% correct with valid citations |
| Past-PR replay | Reviewer on 30–50 old PRs vs real bugs and human comments | precision ≥ 80%, recall on serious bugs ≥ 70% |
| Search recall | right files and active rules in the top 5 for a diff | ≥ 85%, no stale rules used |
| Masking test | planted secrets and private data | 100% caught |
| Owner signal | useful Scribe questions, accepted rules | ≥ 75% accepted |

Gates use measured results, not the model's own confidence.

## 12. One project

The bot works on one project, SPIL Aura, and the repositories listed in `guard.config.local.json`.
There is one vault (`vault/`), one index (`data/guard.db`) and one set of chats (`data/chats/`).
(An earlier multi-department design was tried and removed on 2026-11-20: the owner decided the bot only
needs to focus on SPIL Aura.)

## 13. Repository layout (as built)

```
engine/       ingest, index, search, brain/providers, masking, QA/QE, automation harness, HTTP + MCP
web/          React 19 + Vite + Tailwind CSS v4 + shadcn/ui + Three.js frontend (built to web/dist)
src-tauri/    Tauri 2 (Rust + WebView2) native desktop shell
vault/        Obsidian vault (source of truth)
roles/        role, model, and pricing config files
evals/        quiz, PR replay set, masking test set
docs/         ADRs, plans, and feature guides (indexed in docs/README.md)
```

## 16. Web UI, Multi-Provider Sign-In & QA Harness (built 2026-11-28)

- **Web App (`web/src/`):** CSP-strict (`style-src 'self'; script-src 'self'`) React 19 UI served by `engine/src/server/server.ts` and hosted inside Tauri 2 (`src-tauri/`).
- **Workspace (`WorkspaceView.tsx`, `ChatModelPicker`, `ReoBot3D`):** 3-column provider/model/thinking-level selector with starred favorites, drag-and-drop / paperclip file & resource attachments, `AssistantAvatar` pixel mascot, and pointer-tracking / acting 3D companion (`reo-bot-3d.tsx`).
- **Providers (`ProvidersSettings`, `AddProviderDialog`, `engine/src/server/providers.ts`):** 3-step Add Provider wizard, one-click official CLI subscription sign-in (`POST /api/providers/:id/signin`), encrypted OS credential storage for API keys, and per-provider model lists.
- **Autonomous QA Harness (`HarnessView.tsx`, `profiles.ts`, `qa-memory.ts`, `harness.ts`):** Configurable per-agent budgets and prompts (`/api/reo/agents/:id`), 3-layer QA memory separating `hypothesis` findings from `verified` facts (`/api/reo/memory*`), scheduled & event triggers (`/api/reo/automation*`), execution checkpoints (`/api/reo/checkpoints`), and deterministic Quality Gate verdicts (`PASS`, `NEEDS_REVIEW`, `BLOCK_RELEASE`).

## 14. Open decisions

1. **Language**: TypeScript (Node) for v1, Rust later for hot parts
   (recommended), or Rust from day one.
2. **Where it runs**: this PC first (recommended), office machine later.
3. **Paid model**: Guard's own small client (recommended) or Aura's provider
   layer.
4. **Repos read on day one**: Aura and ERP-MCP (recommended), then the PDF
   reader and others.
5. **Repo name and remote**: folder is `D:\AURA - Guard`; suggested slug
   `aura-guard`; Azure DevOps remote not created yet.

## 15. Developer capture, the QA agent and settings (built 2026-11-20)

- **Developer capture.** A VS Code extension, opt-in per developer and per workspace, records masked
  activity (commits, saves as counts, tasks, allowlisted terminal commands, diagnostics counts, ideas,
  decisions, corrections, `@guard` chats) to a local spool. "Summarize my day" asks the engine for
  draft ai-log entries (using the developer's own Claude plan or key, plus their local Claude Code
  transcripts). The developer reviews a diff and applies it. See `docs/capture-privacy.md`: this is
  activity monitoring and needs the team's agreement.
- **QA agent.** In the chat, asking to QA something starts a QA sub-agent that resolves the target,
  reads the change, and returns a risk level, test cases, a regression checklist and the evidence
  needed. It is read-only. See `docs/qa-agent.md`.
- **Model and key settings.** The Claude backend (plan or API key) and model are chosen in the app;
  the API key is stored encrypted by Windows and never shown again. See `docs/brain-settings.md`.
- **Data contract.** `docs/capture-events.md`; the extension and engine share `repoKey`, with test
  vectors checked on both sides.

## Chat: attachments, prompt budget and agent mode (2026-11-28)

- **Attachments** (`engine/src/chat/attachments.ts`, `engine/src/server/attachment-routes.ts`): files are stored per
  chat in `data/attachments/<chatId>/` (server-made ids, size and count caps, same cookie/Host/Origin checks, deleted
  with the chat). Text is extracted in the engine: text/code, PDF (`unpdf`, a bundled pdf.js build, text only), DOCX
  (`node:zlib`). Messages keep metadata only. File text reaches a model separately from the question, as untrusted
  data, after the mask step; a file that fails the mask sends nothing of itself and is named in the answer.
- **Prompt** (`engine/src/chat/prompt.ts`): rules, product and backend identity, attached files, history and project
  sources are sized to a per-backend budget (Antigravity takes the prompt as one argument cut at 24,000 characters, so
  its prompt is kept under 22,000). Project sources are looked up only when the message has topic words (and, with
  files attached, names the project), a hit is kept only when it shares topic words, and only cited sources are shown.
  Notes only keeps the strict rules.
- **Agent mode** (`engine/src/chat/agent-loop.ts`): see the model rule in AGENTS.md. It uses the same masked
  `complete` as every call, so it works for API and text-only CLI backends. Each step streams as a step event.
- **Not built yet:** token streaming of answer text (the brain layer returns whole replies), background missions, a
  memory store, creating follow-ups/notes/defect drafts from chat, and approval cards. No action outside REO's own
  data exists, so there is nothing to approve.
