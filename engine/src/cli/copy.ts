// Words the CLI shows to people.

import { PRODUCT_NAME, PRODUCT_SHORT } from "../brand.ts";

interface Changes {
  added: number;
  changed: number;
  removed: number;
}

export const copy = {
  help: `${PRODUCT_NAME} (${PRODUCT_SHORT}), command aura-guard

  index [--force] [--max N] [--graph]
                              Read the vault and the repos into the index
                              (--graph also rebuilds the code graph, about 45 s)
  ask <text...> [--audience internal_dev|qa_internal|customer_support] [--limit n]
                              Search what Guard knows
  check                       Check the vault notes
  stale                       Notes whose code changed
  history <repo> <path>       Recent commits for a path
  cochange <repo> <path>      Files that change together with a path
  status                      What is in the index
  graph import <repo> <graph.json>
                              Load a graphify code graph for a repo
  graph blast <repo> <path>   Code that depends on a file (two hops)
  graph refresh <repo> [--force]
                              Rebuild a repo's code graph with graphify
  diary [YYYY-MM-DD]          Draft the day's diary note (uses the model backend below)
  brain status                Which model backends exist, and which one is used
  brain test                  One tiny round trip through the chosen backend
  brain models                List the models you can choose
  brain backend <auto|backend id>
                              Choose where model calls go
  brain model <backend> <id>  Choose the model for a backend (a listed name, or your own)
  brain key set               Save the Anthropic API key (read from stdin or a hidden prompt)
  brain key status | remove   Where the key comes from / delete the saved key
  mine [repo] [--since YYYY-MM-DD] [--min-score 0.7] [--max 15] [--dry-run]
                              Find your corrections in Claude Code sessions;
                              writes proposed choice notes to vault/inbox/
  qa plan [repo] [--base ref] [--head ref] [--no-model]
                              Which journeys a change affects, ranked
  qa agent "<request>" [--no-model] [--json]
                              Plan QA for a change, PR, branch or feature (read-only)
  qa generate <journey-id>    Write a Playwright spec for a journey (never run unchecked)
  qa check <spec>             Safety-check a spec (no save/create/send)
  qa run <spec|journey-id> [--widths 800,1100,1440] [--video] [--note]
                              Run against a running Aura (needs AURA_CDP_URL)
  qa status                   Is Aura reachable? Journeys and specs
  prs sync|mine|dataset|status [repo] [--limit N] [--status completed|active|all]
                              Learn from Azure DevOps PR review comments (read-only)
  review [repo] [--base ref] [--head ref] [--no-model]
                              Review a change: fixed checks + model (reports only, posts nothing)
  refactor <repo> <path> [--no-model]
                              Up to 3 refactors with patches that were test-applied in a scratch copy
  replay [repo] [--limit N] [--model]
                              Score the reviewer on past bug fixes
  daily [--no-model] [--skip a,b]
                              End-of-day routine: index, mine, logcheck, stale, diary
  quiz list | quiz run [--no-model] [--judge] [--max N]
                              Score Guard against the 50 draft questions (gate: 90%)
  rules propose|list|show|approve|dismiss|export
                              Files that change together become checks only after you approve
  logcheck [repo] [--since YYYY-MM-DD]
                              Which commits have an AI-log entry
  support draft "<topic>" | support list | support export <id>
                              Customer-safe procedure drafts (leak-checked)
  capture status|show|summarize|purge
                              Developer activity capture: see what was recorded, draft ai-log entries, delete it
  answer "<question>" [--notes-only] [--json]
                              Ask the knowledge a question (used by the VS Code extension)
  ui [--port N] [--no-open]   Open the chat window
  help                        Show this text`,
  mined: (repo: string, sessions: number, turns: number, candidates: number, blocked: number, written: number, dup: number, dry: boolean) =>
    `${repo}: ${sessions} sessions, ${turns} of your messages, ${candidates} candidates, ${blocked} dropped for secrets, ` +
    (dry ? "dry run (nothing written)." : `${written} notes written, ${dup} already there.`),
  diaryWritten: (path: string) => `Diary draft written: ${path} (status: proposed).`,
  brainUsed: (id: string) => `Model backend used: ${id}.`,
  brainWanted: (w: string) => `Backend setting: ${w} (environment overrides settings; set it with: brain backend).`,
  brainRow: (id: string, kind: string, ok: boolean, detail: string) => `  ${ok ? "available  " : "unavailable"} ${id} (${kind}): ${detail}`,
  brainPicked: (id: string) => `Would use: ${id}`,
  brainNone: "Would use: nothing. Set ANTHROPIC_API_KEY, or install Claude Code and sign in.",
  brainTest: (id: string, ok: boolean, ms: number) => `backend=${id} ok=${ok} duration=${ms}ms`,
  brainTestFailed: (id: string | null, why: string) => `backend=${id ?? "none"} ok=false: ${why}`,
  diaryNothing: (date: string) => `No commits on ${date}; no diary written.`,
  busy: "Not indexing now:",
  busyHint: "Use --force to run anyway.",
  indexed: (added: number, updated: number, removed: number) =>
    `Notes: ${added} added, ${updated} updated, ${removed} removed.`,
  repoLine: (repo: string, commits: number, files: number, c: Changes, f: Changes) =>
    `${repo}: ${commits} new commits (${c.added} added, ${c.changed} changed); ${files} files (${f.added} added, ${f.changed} changed, ${f.removed} removed).`,
  repoSkipped: (repo: string, why: string) => `${repo}: skipped (${why}).`,
  problemLine: (file: string, message: string) => `Problem in ${file}: ${message}`,
  vaultOk: "The vault is fine.",
  vaultProblems: (n: number) => `${n} problem(s) in the vault.`,
  noHits: "Nothing found.",
  noStale: "No stale notes.",
  noHistory: "No history found.",
  noCochange: "No co-changed files found.",
  needArgs: (cmd: string, args: string) => `Usage: ${cmd} ${args}`,
  unknownCommand: (c: string) => `Unknown command: ${c}. Try "help".`,
  badAudience: "Audience must be internal_dev, qa_internal or customer_support.",
  graphImported: (repo: string, nodes: number, edges: number) =>
    `${repo}: ${nodes} graph nodes, ${edges} edges loaded.`,
  graphRefreshed: (repo: string, nodes: number, edges: number, secs: number) =>
    `${repo}: graph rebuilt, ${nodes} nodes, ${edges} edges (${secs} s).`,
  graphUnchanged: (repo: string) => `${repo}: graph is current (repo has not changed). Use --force to rebuild.`,
  graphSkipped: (repo: string, why: string) => `${repo}: graph not rebuilt (${why}).`,
  noGraphHits: "No graph nodes found for that path. Only code files that graphify parses have nodes.",
  noIndex: "Index not built yet; run `npm run guard -- index`",
};
