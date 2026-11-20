# QA agent

When someone in the chat asks to QA or test something, Guard starts a QA sub-agent. It reads the change
(read-only), designs a test plan, shows its work as steps and answers with a structured result.
It works on the one project (SPIL Aura). It never runs a repository's builds or tests and never
writes into a repository.

Code: `engine/src/qa/{agent,target,context,cases,design,templates,run,report-md,safe-out}.ts`,
`engine/src/chat/{intent,qa-route}.ts`. Data: `roles/qa-agent.yaml`, `roles/qa-case-templates.json`.

## The flow

1. **Intent** (`chat/intent.ts`, no model call). `detectIntent(message, history)` returns
   `{intent: "qa" | "ask", confidence, reason}`.
2. **Understand**, **Target**, **Context**, **Design**, **Safety** (only if a case links to a journey
   spec), **Report**. **Run** only after an explicit confirmation.
3. Result: a Markdown file and a JSON file in `data/qa/runs/`, plus the
   same Markdown as the chat answer.

## Intent rules

QA when the message:

- is the slash command `/qa <text>` (the old `/qa status|plan|generate|check|run` stay with the command runner);
- asks to QA, UAT, test, retest, verify, validate, sanity-check, smoke-test or regression-test something
  ("Can you QA it", "test this change", "QA PR 123");
- asks for test cases, a test plan, scenarios, an acceptance checklist or a regression suite
  ("write test cases for ...", "give me a regression test plan");
- asks what or how to test ("what should I test for the checkout feature", "how should I test this");
- replies to the bot's own "QA needs one answer before I start" question, or confirms the journey run it
  offered ("run the journeys").

Everything else is a normal question, including questions that only mention tests ("why does the test
fail in X?", "where are the tests?", "what is QA?", "explain regression testing"). The screen can
force a route with `mode: "qa" | "ask"` in the ask request body. The rules are the regular expressions in
`intent.ts`; `chat-intent.test.ts` holds the table of positive and negative phrases.

## Target

Resolved from the message, the chat and the project's git sources (`cfg.repos`).
Order: PR number (`PR 123`, `#123`: stored data in `data/prs/<repo>/<id>.json`, else a "Merged PR 123"
commit) > commit range (`abc123..def456`) > "last N commits" > a branch name > file paths > a feature or
requirement text (pasted text too) > "it/this/nothing": the last target named earlier in the chat >
the latest change.

The latest change, per git source of the project, is `HEAD` against `git merge-base` with
`origin/development` when that ref exists and differs from HEAD, else `HEAD~1` (`LATEST_FALLBACK_COMMITS`).
Whenever the request did not name the target, the result carries `assumption` ("I assumed the latest
change in <repo>: <subject>") and `correction` (how to say it differently).

If nothing can be resolved (no sources and no description, or a PR with no data) the agent returns
needs-input with a question and 2 to 4 chips and runs nothing.

## Context

Read-only: the diff (the caps of `review/diff.ts`, secret-looking patches withheld), changed files grouped
by category and area, commit messages, blast radius and co-change gaps (index/graph, if present), related
vault notes (active first; proposed ones marked unapproved), the project's rule titles, journeys that
touch the change (only if any), changed and nearby test files, and the check commands recorded in the
project's rules notes (inline code starting with a tool listed in `roles/qa-agent.yaml`). Only the project's cfg, vault and index are read.

## Deterministic and model parts

| Part | How |
|---|---|
| Intent, target, context, areas, risk floor, evidence rules, check commands, journey offer, safety check, artifacts | Fixed code and data, never the model |
| Cases, summary, risk reasons, regression checklist, questions | One model call (`role: "qa-agent"`, masked, audited by the brain); reply validated with zod; invalid JSON or a case that cites nothing real: one retry with the errors, then the offline plan |
| Offline plan (`--no-model`, no backend, blocked, or two bad replies) | `roles/qa-case-templates.json`: categories by file path (UI, API, data/schema, config, parser/algorithm, dependencies, build/CI, logic, docs, tests, other), each with case templates; a risk score from category weights, churn, dependents and co-change gaps |

The result says plainly when the model was not used (`modelUsed: false`, `modelNote`). Evidence rules
come from `roles/qa-agent.yaml` (`ui_change`: real-app screenshots at 800, 1100 and 1440 px and a
walkthrough video; `service_change`: request, result and readback; `always`: name the environment, test
database only, nothing saved to production or the ERP). The model cannot remove them.

## Safety

- Source repos are only read (`git rev-parse | merge-base | log | diff | ls-tree | cat-file`). The agent
  never runs a repository's build or tests. The plan lists the exact commands for a developer to run.
- The only files written: `qa/runs/<date>-<id>.{md,json}` inside the data
  folder (the path is checked to stay inside it).
- Everything in the result, the events and the artifacts passes the masker; a string that looks like a
  secret is replaced. A secret in the user's message stops the agent before anything is read or sent.
- Journeys run only when: a case links to a journey of this project, a generated spec exists and passes
  the static safety checker, a debuggable app is reachable (`AURA_CDP_URL`), and the person confirms in a
  later message ("run the journeys") or sends `runJourneys: true`. The run is the existing runner (runtime
  guard, never save/create/send/delete, never launches the app). Failed steps become defects and
  proposed `incident` notes in the vault inbox. `runConfirmed` throws without `confirmed: true`.

## Chat protocol (additive)

Streaming (`Accept: application/x-ndjson`), in this order:

```json
{"type":"agent","agent":"qa","label":"QA agent","state":"started"}
{"type":"step","step":{"id":"understand","kind":"understand","status":"done","label":"...","detail":"...","ms":3,"agent":"qa"}}
```

Step ids, in order: `understand`, `target` (running, then done), `context`, `design`, `safety` (only if a
case links to a journey spec), `run` (only when confirmed), `report`. A step with the same id updates the
same row. `ms` is real time.

```json
{"type":"agent","agent":"qa","label":"QA agent","state":"done"}
{"type":"qa","result":{ ...QaResult... }}
{"type":"answer","text":"# QA result: ...","sources":[],"chat":{...}}
```

Needs input:

```json
{"type":"needs-input","question":"...","options":[{"id":"latest","label":"Latest change in <repo>","value":"QA the latest change in <repo>"}]}
{"type":"answer","text":"QA needs one answer before I start\n\n...","sources":[],"chat":{...}}
```

`value` is the text to send (or put in the input box when it ends with a space, such as `QA PR `).
Blocked secret or a failure: `{"type":"error","message":"...","kind":"blocked"|"qa","chat":{...}}` and the
agent event has `state:"error"`. Plain JSON mode returns
`{ok,text,sources:[],agent:"qa",trace,qa?,needsInput?,error?,chat}`. The assistant message in the chat file
holds `qa`, `needsInput` and `trace` (with `agent`), masked and capped.

`QaResult` (version 1): `id, generatedAt, department{id,name} (the project name, always SPIL AURA; the field keeps its old name for the UI), request, summary, assumption, correction,
target{kind,label,fromConversation,description,pr,repos[{repo,range,commits,firstCommit,baseSha,headSha}],skipped},
risk{level,reasons}, areas[{name,why,risk}], cases[{id,title,type,priority,cites,preconditions,steps,expected,data?,automatable,journeyId?}],
regressionChecklist, notCovered, questions (max 3), evidence{uiChange,needed}, checkCommands[{command,source,approved}],
journeys{available,offer{runnable,blocked,targetReachable,note,safety}}, run (null until confirmed),
context{files,areas,commits,dependents,coChange,notes,journeys,hasDiff,hasGraph,changedFiles}, artifacts{markdownPath,jsonPath},
modelUsed, modelNote, backend, timings{designSeconds,totalSeconds}`.

## Command line

`aura-guard qa agent "<request>" [--no-model] [--json]` runs the same pipeline. It prints the
Markdown, or with `--json` exactly one JSON object: `{"kind":"result","result":{...}}`,
`{"kind":"needs-input","question","options"}` or `{"kind":"blocked"|"error","text"}`. Exit codes: 0 result,
2 needs input, 1 blocked or error. Running journeys from the command line stays `qa run <journey-id>`.

## Limits and known gaps

- Caps (`cases.ts`, `context.ts`): 24 cases, 12 areas, 12 steps, 3 questions, 120 files, 14 patch excerpts.
- Branch names in stored PR data may be hashed by the PR privacy step; then the PR's merge commit or its
  file list is used.
