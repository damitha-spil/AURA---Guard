# AI handoff: AURA Guard

Keep this file current. Update it after every meaningful change, test,
decision or blocker, and before stopping. Never record credentials, tokens or
other secrets.

## Current state (2026-11-20)

- **Stage:** design. No code.
- **Folder:** `D:\AURA - Guard`. **Not a git repository yet.** No remote.
- **Files:** README.md, ARCHITECTURE.md, IMPLEMENTATION_PLAN.md, THINKING.md,
  AI_HANDOFF.md, CHANGES.md. All written by Claude from the brainstorm; the
  owner has not reviewed them yet.
- **Name:** AURA Guard (chosen by the owner). Suggested slug `aura-guard`.

## Open decisions (owner)

1. Language: TypeScript (Node) for v1 (recommended) or Rust from day one.
2. Where it runs: this PC first (recommended) or an office machine.
3. Paid model: Guard's own client (recommended) or Aura's provider layer.
4. Repos indexed on day one: Aura and ERP-MCP (recommended).
5. Rename the folder to `D:\aura-guard`? `git init`? Create an Azure DevOps
   remote?

## Rules that hold

- Guard is read-only and advise-only. It never commits, merges or writes to the
  ERP.
- No secrets in the vault, the index, logs or outgoing model calls.
- On the shared QA SQL Server, use only the Cobalt database.
- Support knowledge ships inside Aura's repo after human review; Aura never
  queries Guard live.
- Do not commit or push unless the owner asks.
- This PC runs out of memory: do not run background indexing or local models
  during builds.

## Evidence so far

- None. Nothing has been built or run. The Crow notes in THINKING.md come from
  reading docs.crowci.com and crow-ai.dev on 2026-11-20; nothing was installed.

## Next action

- **Owner:** review the documents and settle the open decisions.
- **Then (assistant):** Phase 0 in IMPLEMENTATION_PLAN.md: git init, layout,
  ADR-001, note schema and checker, AGENTS.md.
