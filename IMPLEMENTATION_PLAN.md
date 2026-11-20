# SPIL AURA QA Bot implementation plan

Status: draft, 2026-11-20. Starts after the open decisions in
[ARCHITECTURE.md](ARCHITECTURE.md#14-open-decisions) are settled.

Each phase ends with something that works on its own and a way to prove it.

## Phase 0: Set up (day 1–2)

- [ ] Settle the five open decisions.
- [ ] `git init`; create the Azure DevOps remote if the owner wants one.
- [ ] Create the layout: `engine/ vault/ roles/ evals/ ui/ docs/`.
- [ ] Write ADR-001 with the decisions.
- [ ] Write the note format as a schema file and a checker.
- [ ] Add `AGENTS.md` with the working rules for this repo.

**Done when:** the repo exists, the note checker rejects a bad note and accepts a
good one.

## Phase 1: Ingest, index, read-only MCP (weeks 1–2)

- [ ] Ingest git history and diffs from Aura and ERP-MCP, incrementally, by
      content hash.
- [ ] Ingest `AI_HANDOFF.md`, `AGENTS.md`, skills and docs into first vault notes
      (status `proposed` until the owner reviews them).
- [ ] Build the SQLite index: FTS5, sqlite-vec with a small embedding model,
      Tree-sitter chunks.
- [ ] Resource guard: pause during builds; unload models when idle.
- [ ] Masking proxy, block-and-mask version; masking test set passes 100%.
- [ ] MCP server: `search_knowledge`, `explain_symbol`, `trace_history`.
- [ ] Owner writes the first 50 quiz questions; record the first score.

**Done when:** Claude Code can ask Guard about Aura through MCP and get answers
with citations; the masking test passes; a first quiz score is recorded.

## Phase 2: Choice records and the Scribe (weeks 3–4)

- [ ] Read Claude Code sessions and PR comments; mine choice records.
- [ ] Scribe role: end-of-day diary draft and 3 questions; answers become notes.
- [ ] Stale-note detection from `code_anchors`.
- [ ] Rule pipeline: observed → proposed → approved; fixed-shape rules compiled
      into Tier 0 checks.
- [ ] Code graph (Tree-sitter, graphify) and co-change graph; `get_blast_radius`.

**Done when:** a week of diary notes needed only small edits; at least one
rule has gone from proposed to an active Tier 0 check; a changed function marks
its note stale.

## Phase 3: Reviewer and QA in shadow mode (weeks 5–6)

- [ ] Reviewer runs silently on every PR; results stored, not posted.
- [ ] Past-PR replay harness on 30–50 old PRs.
- [ ] QA Planner in shadow mode: changed area → evidence flows → test plan.
- [ ] Control screen: rule queue, Scribe inbox, stale notes, review grading,
      scores.

**Done when:** replay precision and recall are measured and recorded, and the
owner has graded at least 20 shadow reviews.

## Phase 4: Go live, small local model, support drafts (months 2–3)

- [ ] Reviewer posts to Azure DevOps PRs once its gates pass. Still advisory.
- [ ] QA Planner live.
- [ ] Support writer drafts `customer_support` docs for Aura's repo, reviewed by
      people.
- [ ] Train a LoRA for the small local model on 300–500 approved choice records;
      compare quiz scores with and without the paid model.
- [ ] ACP interface.
- [ ] Move heavy jobs to pipelines (Azure Pipelines first).

**Done when:** each live role has passed its gate in
[ARCHITECTURE.md §11](ARCHITECTURE.md#11-proving-it-works).

## Daily routine (from Phase 2)

1. End of day: the Scribe drafts the diary from commits, handoff changes and
   sessions.
2. The owner fixes the draft and answers up to 3 questions (about 5 minutes).
3. The owner approves or dismisses proposed rules and checks stale notes.
4. Weekly: run the quiz and record the score.

## Risks

| Risk | What we do |
|---|---|
| Notes go out of date | `code_anchors` and stale detection |
| Noisy reviews | comment cap, no nitpicks, precision gate |
| Secrets leak | masking proxy, 100% test gate, local audit log |
| PC runs out of memory | resource guard, on-demand models, hash-based re-index |
| Guard becomes a second Aura | support knowledge ships inside Aura, never live from Guard |
| Too much at once | phases end with working pieces; no layer is built before it is needed |
