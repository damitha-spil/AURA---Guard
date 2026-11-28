# SPIL REO: QA and QE implementation plan

Status: a working plan. Each phase is a set of generic QA/QE capabilities written
from their descriptions, not copied from any other product's code or text.

Rules that apply to every phase:
- REO only reads other repositories. No clone, fetch, pull, checkout, commit, push,
  merge, or PR comment or vote. Those need the owner's decision first.
- Text sent to a model is masked first. Tools and files are never given to a model.
- No ERP, order, shape, glass or database-domain features.

## Phase 1: built

| # | Capability | What it does |
|---|---|---|
| 1 | PR test evidence | Classifies a change (app, service, docs/dev tool) and shows whether its proof is complete, incomplete or blocked. Mock data and screenshots alone do not count. |
| 2 | System health | One check page covering models, repos, the search index, desktop testing, key storage and the web build. |
| 3 | Nightly QA | Adds read-only health and QA checks to the daily routine. Unattended runs skip model calls and anything needing approval. |
| 4 | Desktop-test safety | Desktop testing stays off until exact apps are listed. Refuses shells, elevated windows and REO's own window. |

## Phase 2: repeat bugs, review quality and knowledge hygiene (built, tests not run)

| # | Capability | What it does |
|---|---|---|
| 5 | Repeat-bug handling | Matches duplicate defects, raises severity when a defect recurs, tracks acknowledged defects, and writes a plain daily digest. Status: built with screens, untested. |
| 6 | Review rounds and report style | Caps repeat review rounds, splits owner and reviewer findings, and keeps report text short and plain. Status: built with screens, untested. |
| 7 | Outdated and duplicate notes | Flags knowledge notes that overlap in wording or are older than a limit. Status: built with screens, untested. |
| 8 | Lesson suggestions | Proposes notes from past sessions as proposed items only. The owner approves them. Status: built with screens, untested. |
| 9 | Sample-data guard | Keeps sample or fixture data out of real app data and marks it clearly. Status: built with screens, untested. |

## Phase 3: later (10-12 built, untested; 13 design only, not built)

| # | Capability | What it does |
|---|---|---|
| 10 | Repeated steps | Turns repeated testing work into reusable step lists. Status: built with screens, untested. |
| 11 | Follow-ups and task list | Tracks follow-ups and a per-session task list. Status: built with screens, untested. |
| 12 | Report views | Simple and technical versions of the same report. Status: built with screens, untested. |
| 13 | Limited helper agents | Helpers with narrower permissions, only if needed. Status: design only, not built. |

### Item 13 design: limited helper agents (design only, not built)

No helper runtime exists and none should be added until the owner asks for one.

What a helper could do:
- Take one narrow, named job from a QA run or review, for example "read these changed
  files and list questions" or "check this step list against the allow list".
- Work on masked text only, return a short plain result, and stop.

Narrowed permissions:
- Read-only tools only, the same allow list the repeated-steps replay uses
  (`/ls`, `/read`, `/find`, `/system`, `/time`), limited to the folders the owner named for that job.
- No web, no shell, no desktop driver, no git write, no vault write, no notifications.
- A fixed budget: a small number of steps, a time limit and a cost cap, set before it starts.
- All text sent to a model goes through `engine/src/mask/`; a detected secret stops the call.

What it must never do:
- Start other helpers, widen its own permissions, or pick its own tools.
- Change a repository, commit, push, merge, or comment or vote on a pull request.
- Approve notes, mark a defect resolved, or send anything outside this machine.
- Run unattended (nightly runs skip helpers) or keep memory between jobs.

Approval step:
- Before it starts, the owner sees the job, the folders, the tools, the budget and
  the model it would use, and presses approve. No approval means no run.
- Its result is shown as a proposal. Anything that would change something is a
  separate request the owner approves on its own.
- Each run is logged with job, approval time, tools used and cost.

## Open decisions

- Whether REO may change your repositories (read-only, safe actions with
  confirmation, or full write access).
- Whether this repository is public. Anything copied from private material must
  stay out of a public repository.
