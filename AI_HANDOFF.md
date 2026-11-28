# AI handoff: AURA QA

> **Standing instruction for all future AIs:**
> Read this entire file and run `git status --short` before making any changes.
> **Every AI session MUST update `AI_HANDOFF.md`** after every meaningful implementation, test run, architectural decision, or blocker, and again before handing off or stopping. Record: what changed (exact file paths and symbols), exact commands and observed test/check results, what remains unverified (e.g., live UI visual proof), and the concrete next action. **Never record credentials, tokens, connection strings, or other secrets.**

---

## Phase 3 items 10-12: repeated steps, follow-ups, report views (2026-11-28)

Clean-room from the plan text; the SPIL AURA repo was not opened. Implement-only session: **no tests, build or typecheck were run.** Item 13 (helper agents) is a design section only in `docs/plans/qa-qe-phases.md`; no runtime.

- **10 Repeated steps** (new `engine/src/steps/store.ts`): `data/steps/steps.json`. `stepsFromRun` (only a run whose `run.status` is `passed`) makes `/read repo/path` steps for changed files. `ALLOWED_ACTIONS` = `/ls /read /find /system /time`; `checkStep` refuses anything else (and multi-line args). `replayStepList` runs through `runToolLine` only; no model call (`modelCalls: 0`). Routes: `GET /api/steps`, `POST /api/steps` ({runId, name?}), `POST /api/steps/:id/replay` (dry run unless body `{"run": true}`).
- **11 Follow-ups and tasks** (new `engine/src/followups/store.ts`): `data/followups/followups.json` and `tasks.json`. Text containing a detected secret is refused (400), so none is stored; `maskedFollowup` gives the masked copy for model use (not wired to any model call). Routes: `GET/POST /api/followups`, `PATCH /api/followups/:id`, plus `GET/POST /api/tasks?session=`, `PATCH /api/tasks/:id`.
- **12 Report views** (new `engine/src/reports/views.ts`): `ReportModel`, `renderReport`, `parseView` (default simple). `?view=simple|technical` adds a `report` field to `GET /api/qa/run`, `GET /api/defects/digest` and `POST /api/repos/:id/review` (also in the stream result event). Existing response fields are unchanged.
- **Other files changed:** `engine/src/server/server.ts`, `engine/src/repos/routes.ts`, `docs/plans/qa-qe-phases.md` (statuses, item 13 design).
- **Not verified (nothing was run):** type correctness, all routes, existing tests (a test checking exact JSON of those three routes may now see the extra `report` field), `stepsFromRun` path form against `/read`, and the web UI (not touched; does not show any of this).
- **Next:** `npx tsc -p engine --noEmit`, `npm test`, add tests for replay refusal, secret refusal and both views.

---

## Phase 2 items 5-9: repeat bugs, review rounds, note hygiene, lessons, sample guard (2026-11-28)

Clean-room from the plan text (`docs/plans/qa-qe-phases.md`); the SPIL AURA repo was not opened. Implement-only session: **no tests, build or typecheck were run.**

- **5 Repeat bugs** (`engine/src/defects/store.ts`): a returning fingerprint keeps one record, adds 1 to `recurrenceCount`, raises severity one step (cap critical; incoming severity/status never lower it) and reopens a `fixed`/`resolved` record. New fields: `recurrenceCount`, `firstSeen`, `lastSeen`, `acknowledged`, `acknowledgedAt`, `resolvedAt`, `history[]` (append only). `acknowledged` is separate from `status`. New status `resolved`. `updateDefectStatus` takes `acknowledged` and `resolved`. `buildDailyDigest(records, date)` gives plain text: new, recurring, acknowledged and still open. Routes in `server/server.ts`: `GET /api/defects/digest?date=YYYY-MM-DD`; `PATCH /api/defects/:id` accepts `acknowledged` and `resolved`. Old records without the new fields are treated as count 1.
- **6 Review rounds** (`engine/src/review/report.ts`): `MAX_REVIEW_ROUNDS = 3` (`writeReviewReport` 4th arg overrides). Round = earlier reports in the same repo folder with the same base sha, plus this one. Past the cap only blockers are listed. Comments are split "For the owner to fix" (blocker, risk) and "For the reviewer to judge" (suggestion) via `splitFindings`. `PLAIN_REPORT_RULE` and `plainText()` keep finding text on one line, cut at 240 characters. The model prompt in `reviewer.ts` was not changed.
- **7 Note hygiene** (new `engine/src/vault/hygiene.ts`, route `GET /api/notes/hygiene`, read-only): look-alikes when shared words / words of the smaller note >= `DUPLICATE_OVERLAP_THRESHOLD` (0.8), notes under 8 distinct words skipped, max 200 pairs; outdated when `reviewed` (else `created`) is more than 60 days old. Deprecated notes skipped. The vault has no "updated" field, so age uses those two dates.
- **8 Lessons** (new `engine/src/vault/lessons.ts`): `suggestLessons(vaultDir, repoPath)` / `proposeLessonNotes(vaultDir, turns)` pick owner turns with rule wording (never, always, must, don't, ...), mask them, and write with `newNote()` so they are `status: proposed` `choice` notes. Dedupe by `lesson-hash` comment, max 10 per run, 14-day window. Not wired to any route or command; never approves.
- **9 Sample guard**: `upsertDefect` input takes `sample` or `fixture`; such records get `sample: true` and a separate fingerprint space (never merge with real ones). `listProductionDefects` drops them; used by the digest and `/api/reo/system` `defectsCount`. `GET /api/defects` still lists everything (sample flag visible); `POST /api/defects` accepts `sample`/`fixture`. Only the defect store has this; QA run records, notes and other stores are not flagged.
- **Not verified (nothing was run):** type correctness, any behaviour above, existing tests (a test that checks `upsertDefect` overwriting severity, or exact report text, may now fail), the web UI (does not show recurrence, acknowledged, resolved or the digest; `resolved` is a new status value the UI may not know). `report.ts` round counting reads the first line of existing `.md` reports.
- **Next:** run `npx tsc -p engine --noEmit` and `npm test`, add tests for recurrence, digest, hygiene, lessons and the round cap.

---

## Proof scope, system health, unattended daily run, desktop-test blocks (2026-11-28)

Clean-room from written descriptions; the SPIL AURA repo was not opened.

- **Proof scope:** `qa/evidence_scope.ts` (`classifyChange`, `evaluateEvidence`; app / service / docs-tool / unknown; complete / incomplete / blocked). `qa/evidence.ts` `runEvidence` adds `evidenceScope` to the packet and `evidence` to `GET /api/qa/run`. `prs/manager.ts` (`evidenceScope`, `required` now from the scope), `repos/review.ts` (`evidence`), `review/report.ts`, `commands-review.ts`, `Review.changedPaths`. UI `components/app/proof-panel.tsx` in the repo review and QA run detail. Optional `.artifacts/qa/<runId>/proof.json`: `environment`, `interaction{source,steps}`, `screenshots[{source,width,path}]`, `video{source}`, `serviceReadback{source:"real-service",request,result,readback}`, `checkOutput{command,output}`, `noAppPathReason`. PR readiness and code review credit no proof (nothing is tied to a commit). The packet's "Environment" line is now labelled policy, not verified.
- **Health:** `health/health.ts` (`runHealth`, 12 s per check, parallel, fixed text only, index opened read-only), `GET /api/health`, `aura-guard health [--json]` (`cli/commands-health.ts`), Settings > System health.
- **Daily:** new steps `health`, `qa-backend`, `qa-pr-readiness` in `roles/daily.json`. `--unattended` or no terminal: only the commands in `UNATTENDED` (`commands-daily.ts`) run; model steps (diary) and anything else are skipped with a reason. Child stdin is closed. `bin/schedule-daily.ps1` passes `--unattended`. No task installed. The chat `/daily` has no terminal, so it also skips the diary.
- **Desktop safety (behaviour change):** `cuaDriver.allowedApps` is now required and matched on the exact program name (before: optional, substring, window title counted). More shells, terminals, IDEs and script hosts; REO's own window/process; elevated or unverifiable windows refused. Cua tool allowlist; only navigation keys plus Enter in a real search field. Crawler: NaN `maxActions` removed the cap (fixed), re-judges before each click. `win-uia-crawler.ps1`: requires window handle and program name, rechecks program/elevation/title, exact unique control name (before: substring, any window of the PID). A root without `qa/forbidden-actions.json` now gets the shipped list (before: empty). `attachAura` skips pages titled SPIL REO. `qa-hybrid-dsl.test.ts` now sets `allowedApps`.
- **Cannot be enforced:** a shell inside an allowed app (embedded terminal, browser tab, renamed program; the lists go by name); allowing a browser allows all its non-REO windows; the cua-driver backend reports no elevation unless it sends `elevated`; Playwright/CDP has no process or elevation check; Enter and navigation keys go to whatever has focus; a window can change between the check and the click; the user's own `cuaDriver.command` / `CUA_DRIVER_CMD` chooses the driver binary; running the PowerShell script by hand has a shorter deny list and no allowlist.
- **Proof limits:** REO cannot tell whether an attached app used mock data, watch the video, or verify anything a person writes in proof.json. Path rules can misplace a file (unplaced = service).
- **Checks:** `npm run typecheck` pass. `npm run web:build` pass (the final build printed a chunk-size warning; it appeared after the concurrent 3D bot work below, cause not checked). `bin/schedule-daily.ps1` was edited but not run: the permission check denied even the print-only dry run. `npm test`: 391 tests, 390 pass, 0 fail, 1 skipped (55 files; 11 new in `evidence-health-safety.test.ts`). `git diff --check` clean apart from CRLF notices. cargo check not run (no Rust change).
- **Live:** own engine on a free port with a temp root (copied roles/qa, new config and data), throwing model call, faked launcher, headless Edge: Add repository picker passed (start places, missing-folder error, list, look inside, Backspace, taken id, add, temp config written, "Already added"); proof panels in review and run detail; health section; 0 model calls, 0 page errors, only the expected 404/409; user config hash unchanged. `daily --unattended` in a temp copy (prs/mine steps skipped by flag): diary refused; index refused by the resource guard, health and stale failed as expected there. `health` against the real config: ok/warn only (index behind for one repo; desktop tests off, no allowed app). UIA script on a probe Edge window: 10 windows listed, none unknown; handle/shell/program refusals worked; one real click on "Orders" reached the page; partial name "Order" refused. Not run: cua-driver, an elevated window, the Tauri window, a real scheduled task.
- **Concurrent edits:** while this ran, something else changed `web/package.json`, `web/package-lock.json`, `web/vite.config.ts`, `web/src/views/WorkspaceView.tsx` and added `web/src/components/app/reo-bot-3d.tsx`. Not touched by this work.
- **Next:** owner adds `cuaDriver.allowedApps` to the local config before desktop tests; restart the engine to load this code.

---

## Documentation Organization & Architecture Refresh (2026-11-28)

- **What changed:**
  - Created `docs/README.md` indexing all root Markdown documents, `docs/` technical guides, ADRs, and phase plans.
  - Updated `README.md`, `ARCHITECTURE.md`, and `STATUS.md` to reflect SPIL REO as built (`web/` React 19 + shadcn/ui + Three.js frontend, Tauri 2 shell, multi-provider CLI subscription sign-in, 3-column model picker, file attachments, and the Hermes-inspired QA Harness with configurable profiles, 3-layer QA memory, triggers, checkpoints, and Quality Gate).
- **Checks:** `git diff --check` (see below).

---

## Hermes-Inspired Autonomous QA Harness (2026-11-28)

- **What changed:**
  - `engine/src/agents/profiles.ts`: Configurable per-agent profiles (`systemPrompt`, `modelOverride`, `maxToolCalls`, `maxTimeSeconds`, `enabled`) with named safety bounds (`MAX_TOOL_CALLS_LIMIT = 50`, `MAX_TIME_SECONDS_LIMIT = 600`, `MAX_SYSTEM_PROMPT_CHARS = 4000`) persisted in `agent-profiles.json`.
  - `engine/src/memory/qa-memory.ts`: 3-layer persistent QA memory (`project`, `execution`, `procedural`) separating `hypothesis` entries from `verified` facts (`verifyMemory` promotion, `recallMemory` token scoring with verified boost).
  - `engine/src/automation/harness.ts`: Pre-seeded & customizable QA automation triggers (`schedule`, `on_commit`, `on_pull_request`, `on_test_failure`, `on_security_alert`, `on_release_candidate`), execution checkpoints (`baseline` / `completed`), and deterministic Quality Gate (`PASS` / `NEEDS_REVIEW` / `BLOCK_RELEASE`).
  - `engine/src/agents/runner.ts` & `engine/src/server/server.ts`: Missions now honor enabled agent profiles, recall memory, record baseline/completed checkpoints, log defect findings as `hypothesis` execution memory, emit `verdict` events, and expose `/api/reo/agents/:id`, `/api/reo/memory*`, `/api/reo/automation*`, and `/api/reo/checkpoints`.
  - `web/src/views/HarnessView.tsx` & `web/src/App.tsx`: Added the **QA Harness** page (Memory Explorer, Automation & Triggers, Checkpoints) to the sidebar.
  - `engine/test/hermes-harness.test.ts`: Unit tests for profiles, 3-layer memory, automation triggers, checkpoints, and quality gate verdicts.
- **Checks:** `npx.cmd tsc -p engine --noEmit`, `node --experimental-strip-types --test engine/test/hermes-harness.test.ts`, `npm run web:build`, and `git diff --check` (see below).
- **Not verified:** live UI interactions on the new QA Harness page or full `npm test` run.

---

## Workspace 3-Column Provider/Model Picker & File Attachments (2026-11-28)

- **What changed (`web/` only):**
  - `web/src/components/app/chat-model-picker.tsx`: Created `ChatModelPicker` with a pill trigger (`ProviderIcon` + active model label) and a 3-column popover (left provider icon rail + Favorites `★` persisted in `localStorage`, middle searchable model list with star pins and `Ctrl+1..9` badges, right Thinking Level selector `Low` / `Medium` / `High` / `Extra` matching model variants).
  - `web/src/views/WorkspaceView.tsx`: Replaced the old `Command` model picker with `ChatModelPicker`, and added file/resource uploading via a `Paperclip` button and drag-and-drop (`MAX_ATTACHMENTS = 5`, `MAX_ATTACHMENT_CHARS = 12_000`), removable attachment chips above the textarea, and `[Attached resource: ...]` prompt prepending on submit.
- **Checks:** `npm run web:build` and `git diff --check` (see below).
- **Not verified:** live UI layout, drag-and-drop file selection, and Favorites/Thinking Level switching in a running app.

---

## Providers Settings & 3-Step Official Sign-In Wizard (2026-11-28)

- **What changed:**
  - `engine/src/server/providers.ts`: Added `POST /api/providers/:id/signin` (`SIGNIN_ARGS` for `antigravity-cli`, `claude-cli`, `opencode-cli`) which resolves the CLI binary path and spawns `<cli> auth login` detached with an argument list (`child.unref()`), forgetting the cached provider status.
  - `web/src/components/app/add-provider-dialog.tsx`: Created `ProviderIcon`, `officialSignInLabel`, and the 3-step `AddProviderDialog` wizard (`Provider` → `Identity` → `Config`) supporting one-click official CLI sign-in (`Continue with Google` / `Continue with Claude` / `Sign in with OpenCode`) as well as manual CLI/API key setup.
  - `web/src/components/app/providers-settings.tsx`: Integrated `AddProviderDialog` and `ProviderIcon`, added an **Account** row for CLI subscription sign-in / account switching, enriched subscription status labels, and added a filterable **Models** list per provider.
- **Checks:** `npm run web:build`, `npx.cmd tsc -p engine --noEmit`, `node --experimental-strip-types --test engine/test/providers-api.test.ts`, and `git diff --check` (see below).
- **Not verified:** live OAuth/CLI browser sign-in flow and visual layout of the dialog/settings in the running desktop window.

---

## Brand Subtitle Update (2026-11-28)

- **What changed:** Replaced `"Review · Evaluate · Optimize"` / `"REVIEW · EVALUATE · OPTIMIZE"` with `"A Multi-Agent Quality Engineering & Software Assurance Platform."` in `engine/src/brand.ts` (`PRODUCT_MOTTO`), `engine/src/server/server.ts` (`PAIR_PAGE`), `engine/src/defects/store.ts` (`generateDefectReportHtml`), and `engine/src/plugins/store.ts` (`buildTeamsDefectPayload`). In `web/src/App.tsx`, shortened the sidebar header subtitle to a single-line `"Multi-Agent QE & Assurance"` with the full description in `title`.
- **Checks:** `npm run web:build`, `npx.cmd tsc -p engine --noEmit`, and `git diff --check` (see below).
- **Not verified:** live visual check of the wrapped sidebar subtitle in expanded and icon-collapsed states.

---

## Interactive 3D Animated Bot in Workspace Empty State (2026-11-28)

- **What changed (`web/` only):**
  - Added `three` and `@types/three` in `web/package.json` and isolated `three` into its own lazy-loaded Vite chunk in `web/vite.config.ts` (`manualChunks`).
  - Rewrote `web/src/components/app/reo-bot-3d.tsx` (`ReoBot3D`, default + named export) as a vibrant polished golden-yellow floating 3D robot using `NeutralToneMapping`, high-contrast 3-point + warm amber bounce lighting, reduced IBL washout (`envMapIntensity: 0.42`), deep pitch-navy screen with subtle blue OLED radial glow + glowing white eyes (`CanvasTexture`), plus `mood` acting styles (`idle`, `typing`, `thinking` with animated 3-dot gaze + head tilt + arm wiggle, and `happy` crescent smiles).
  - Integrated `ReoBot3D` via `React.lazy` + `React.Suspense` into `web/src/views/WorkspaceView.tsx` empty-state hero (pointer-tracking-only, with `presetGaze` on preset button hover) and mounted a mini peeking/flying `ReoBot3D` above the docked composer in active chats (`messages.length > 0`) animated with `motion/react` spring physics (`AnimatePresence` + `motion.div`), including a small `"Thinking..."` thought-cloud bubble while `busy` is true and a brief `"happy"` hop when a reply completes.
- **Checks:** `npm run web:build`, `npx.cmd tsc -p engine --noEmit`, and `git diff --check` pass cleanly (see below).
- **Not verified:** live visual appearance and pointer tracking in a running browser or Tauri WebView2 window.
- **Next:** start the app (`npm run ui` or `npm run desktop`) and visually verify the 3D bot on the Workspace empty state in both dark and light themes.

---

## Verification pass: tests, security coverage, smoke, PR links (2026-11-28)

- **Checks:** `npm run typecheck` and `npm run web:build` pass. `npm test`: 380 tests, 379 pass, 0 fail, 1 skipped (local question file). `git diff --check` clean apart from CRLF notices. cargo check not run (no Rust change).
- **Fixed in code:** Ctrl+K palette crashed the app (`CommandDialog` in `ui/command.tsx` lacked `<Command>`); Agents page called missing `/api/qa/skills` (now `/api/skills`); removed `ChartStyle` from `ui/chart.tsx` (CSP always blocked it); `index.css` now covers the blocked dialog scroll-lock and Select scrollbar styles; `MODEL_ID_RE` also refuses `..`, `//` and a trailing `/`.
- **PR links:** wry 0.57.4 ignores `window.open` when no new-window handler is set (`main.rs` sets none). New `POST /api/open-external` (`repos/routes.ts` `externalUrl`, `browserCommand`): https on dev.azure.com, *.visualstudio.com or github.com, rundll32/open/xdg-open with an argument list. `pull-list.tsx` uses it.
- **Tests:** updated `brain-settings-api` (apiKeys, new backends, memory stores for every provider, per-provider key routes), `brain-settings` (120 characters, path cases), `brain-cli` (env type). New: `brain-providers`, `open-external`, `web-safety`.
- **Smoke:** own server on a free port, temp copy of data/vault/roles, model calls throwing, browser launch faked; headless Edge over all pages and settings sections. Greeting reply worked with no model call.
- **Open:** Defects Export PDF popup is unstyled (the blob inherits `style-src 'self'`) and, from the wry source, does nothing in the desktop window; the saved HTML path is still reported. Fixing it needs an owner decision (CSP hash or opening the saved file). Sonner, ScrollArea, Select and scroll-lock styles still log CSP violations. Not verified: Tauri window, real browser launch, real provider or model calls.

---

## Engine: chat fix, native tools, old UI removed, usage, pull requests, repos, providers (2026-11-28)

- **Chat:** fixed replies for greetings/model questions (`chat/identity.ts`); without an index questions go to the selected model with a no-index prompt and a note (`chat/open-answer.ts`). `guard.config.local.json` created; index built with `npm run guard -- index --force` (the guard saw the idle `cargo tauri dev` session; no rustc was running): spil-aura 291 commits, 163 files; erp-mcp 30 commits, 43 files; both repos unchanged.
- **Native tools** (`tools/native/`): /web /fetch /browse /ls /read /find /system /processes /time and `webSearch: true`. Real runs: system, processes and browser render worked; keyless web search failed here (DuckDuckGo bot check, Bing unrelated results).
- **Old `ui/` deleted** with the five `engine/test/ui-*.test.ts` files and `ui-stub-server.ts`. Server tests moved to `server-stream.test.ts`. The server serves only `web/dist` and shows a self-reloading page when it is missing. The old safe-renderer and inbox-card tests were removed; `web/` has no equivalent tests.
- **New APIs:** `/api/usage`, `/api/usage/limits` (`usage/`, `roles/ai-pricing.json`), `/api/pulls`, `/api/repos...`, `/api/source-control` (`repos/`, `prs/pulls.ts`), `/api/providers` (`server/providers.ts`). AGENTS.md lists the allowed read-only git commands. Real PR list worked for both repos with the saved Git sign-in.
- **Tests:** `node --experimental-strip-types --test` on the brain, chat, server, review, API and new test files: 174 of 176 pass. The 2 failures (`brain-settings-api` expects no `apiKeys`; `brain-settings` expects an 80-character model id limit) and the `brain-cli.test.ts` type errors come from the earlier uncommitted provider work. `npx tsc -p engine --noEmit` passes. Full `npm test` was not run.
- **Not verified:** nothing checked in the running app (restart it to load this code). API rate-limit headers, OpenRouter limits and GitHub PRs were only tested with fakes.
- **Next:** owner decision on any repo or PR write actions (none are implemented); run full `npm test`.

---


**web/ CSP note (2026-11-27):** `style-src 'self'` blocks runtime `<style>` tags. Do not rely on shadcn `--color-*` chart vars; pass `var(--chart-N)` directly. Black bars fixed this way; ScrollArea scrollbar hiding and Sonner CSS moved into index.css. Build passes; not verified in the app. Other injected styles (e.g. dialog scroll lock) are unchecked.

---

## shadcn/ui redesign of web/ (2026-11-27)

- **What changed (web/ only):** Rebuilt the whole frontend on the official shadcn/ui CLI components (new-york style, neutral base, own indigo accent in oklch, light + dark via `.dark`). `components.json` added. CLI components in `web/src/components/ui/` (sidebar, button, card, badge, input, textarea, select, switch, tabs, table, sheet, dialog, dropdown-menu, separator, scroll-area, tooltip, skeleton, sonner, command, label, alert, avatar, breadcrumb, collapsible, checkbox, alert-dialog, chart, progress, popover). Old hand-made ui files and `message.tsx` removed. Added deps: radix-ui, cmdk, sonner, next-themes (only used by the CLI sonner file), recharts (via chart), class-variance-authority, tw-animate-css, motion.
- **Shell (`src/App.tsx`):** sidebar-07 style collapsible icon sidebar (8 nav items, engine status from `/api/project`, System/Light/Dark dropdown that keeps the `color-scheme` localStorage key), header with trigger, breadcrumb, search, New Chat, inbox badge. Ctrl+K command palette: go-to, actions (new chat, QA/security presets, theme, shortcuts) and `/api/search` hits (open in a Sheet via `/api/doc`). `?` opens a shortcuts dialog. Page fade via `motion` with `MotionConfig reducedMotion="user"`. Workspace stays mounted once opened, so chat state survives view switches.
- **Views (`src/views/*`):** Home dashboard (stat cards from `/api/reo/system`, ask box, quick actions, guardrails; fake bar chart and "100% masking gate" removed), Workspace (chat list, ScrollArea chat, Execution Canvas as side panel at 1280px+ and Sheet below; "Show work" now hides plan/tool steps), QA Lab (results rendered as tables/cards with a Raw toggle, not raw JSON), Defects (stat cards, severity chart, table + kanban board tabs, Dialogs, detail Sheet), Agents, Plugins (Save keeps current enabled value), Knowledge, Settings. Shared helpers in `src/components/app/page.tsx`. `src/lib/api.ts` unchanged; same endpoints and payloads.
- **Engine:** no engine, ui/ or src-tauri changes. No new routes.
- **Checks:** `npm run build` in `web/` (tsc -b + vite build): 0 errors; dist/index.html has no inline script/style. `git diff --check`: no whitespace errors (only CRLF warnings).
- **Not verified:** nothing was viewed in a running app or browser. No visual check at 800/1100/1440 px, no dark-mode check, no live endpoint calls, no CSP check in the Tauri window (Radix/sonner/sidebar style use should be CSSOM-only). Chart rendering and the motion page transition are untested at runtime. The bundle is about 1.1 MB (no code splitting yet).
- **Next action:** run `npm run web:build` / the desktop app, click through all 8 views at the three widths in both themes, then decide on code splitting. Owner: next assistant or Damitha.
- **Round 2 (2026-11-27, same section):**
  - New pages: Activity (merged timeline of defects, QA runs, chats and inbox with filters; `src/views/ActivityView.tsx`) and QA Runs (`RunsView.tsx`: sortable table from `/api/qa/runs`, run detail in a resizable right panel or Sheet from `/api/qa/run?id=`, step timeline with counting durations). Agent detail page with tools, skills and a run flow (`AgentsView.tsx`).
  - Home: four charts (defects over time by severity, defects by status, QA runs over time, vault notes by status) in `components/app/charts.tsx`, count-up stat cards and staggered cards (`components/app/motion.tsx`).
  - Defects: TanStack Table v8 (sort, pagination) and a kanban board where dragging a card PATCHes its status. Knowledge: sortable notes table and an inbox board (drag Proposed to Approved or Dismissed, posts to `/api/notes/:id/status`). Notifications popover in the header from `/api/inbox` with Approve and Dismiss.
  - Shell: sidebar `variant="inset"` at 17rem, Workspace Execution Canvas uses shadcn resizable, Settings uses a vertical settings nav with label/value rows and a Danger zone (AlertDialog). Skeleton sheen is CSS in `index.css`, off for reduced motion. Empty states use an icon tile.
  - Code splitting: every view is `React.lazy`, plus `manualChunks` in `vite.config.ts`. The chunk-size warning is gone (largest chunk about 404 kB).
  - Notes: `resizable.tsx` from the CLI imported `cn` from a package named "cn"; I changed that one import to `@/lib/utils`. Pinned `@tanstack/react-table@8.21.3` (the unpinned install pulled an alpha v9). No engine changes, no new routes.
  - Checks: `npm run build` in `web/` passes with no warnings. Still not viewed in a running app; drag and drop, the resizable panels, run detail data shapes (case and defect fields are rendered defensively) and all responsive widths are unverified.
- **Round 3 (2026-11-27, same section): Maia preset.**
  - Ran `npx shadcn@latest init --preset b2op2b03k --base radix --force --reinstall --yes` in `web/`. The CLI accepted the preset: `components.json` now has style `radix-maia`, neutral base, lucide icons; `src/index.css` got the green theme (primary about oklch(0.527 0.154 150), green chart-1..5), `--radius-2xl/3xl/4xl`, and Inter via `@import "@fontsource-variable/inter"` (bundled locally, no Google Fonts). All installed `ui/*` components were reinstalled in the Maia style (pill buttons and badges, rounded cards). The old indigo accent and the skeleton sheen CSS were overwritten and are gone.
  - CLI side effects fixed by hand: the CLI re-added a bogus `cn` npm package, rewrote `src/lib/utils.ts` as a re-export from it, and made ui files import `cn` from it. I restored `utils.ts` (clsx + tailwind-merge), changed every ui file import back to `@/lib/utils`, and uninstalled `cn`. Re-running the CLI will redo this; fix again after any `shadcn add` or `init`.
  - Restyled: stat tiles (`StatCard`) are rounded-2xl muted blocks with small uppercase labels and large bold numbers; Home is a masonry (CSS columns) card grid with icon-square list rows and one full-width primary CTA per card; chart bars have rounded tops; page background behind the inset panel is `bg-muted`; table wrappers use rounded-2xl.
  - Not verified: no visual comparison against the ui.shadcn.com/create screenshot, no run in the app, no dark-mode or width checks. Other views (Defects, Runs, Settings) inherit the Maia components and tiles but were not individually re-laid-out as masonry grids.
  - Checks: `npm run build` in `web/` passes with no warnings.
- **Round 4 (2026-11-27, same section): Maia card style on every page.** Added `IconRow` and `Tile` to `web/src/components/app/page.tsx`. Activity is now a card of icon-square rows with a right-aligned tag; QA Lab, Agents, Plugins use stacked full-width pill buttons; Agent detail lists tools as icon rows; Runs detail uses stat tiles and thicker green progress bars, and the runs table sits in a card; Defects, Knowledge notes and the team table sit in cards; Knowledge reports are icon rows; Settings repo and stat blocks are muted rounded-2xl tiles; Workspace bubbles and composer use large rounded corners. No shadcn init/add was run, so no `cn` package came back. `npm run build` passes with no warnings. Not viewed in a running app; Workspace, Defects and Settings were adjusted lightly rather than rebuilt as masonry grids.
- **Round 5 (2026-11-27, same section): colour themes, model picker, fixes.**
  - Themes: `[data-theme]` blocks appended to `web/src/index.css` for neutral, blue, violet, orange, rose, red, yellow and amber (green is the default, no attribute), each with light and `.dark` variants of primary, ring, chart-1..5 and sidebar-primary, plus `[data-radius]` none/small/default/large. Colours are my approximations of shadcn's theme colours (same hue family, generated ramp for charts), not copied values. `web/public/theme-init.js` now also sets `data-theme` and `data-radius` from localStorage keys `color-theme` and `radius` before paint. `web/src/lib/themes.ts` holds the lists and try/catch storage helpers.
  - UI: Settings > General has swatch cards with a check and a corner-radius choice; the sidebar Theme menu has a Colour submenu; Ctrl+K has "Change theme: <colour>" items. Swatches preview a colour by setting `data-theme` on a small element.
  - Settings > AI backend: model picker is now a searchable Command in a Popover, grouped by family (Gemini versions grouped by first three words, others by first word), with label, note and a check on the selected model; in-use backend first; trigger is `w-full min-w-0` with truncate so it no longer overflows. Still `PUT /api/brain {models:{id:model}}`; a custom model id not in the catalogue shows as "(custom)".
  - Workspace chat list: titles truncate with ellipsis and show relative time; CSS in `index.css` stops Radix ScrollArea's display:table wrapper from breaking truncation; the main content area now uses ScrollArea.
  - Checks: `npm run build` passes with no warnings. Not viewed in a running app: theme colours in both modes, family grouping with the real 21-model catalogue, and the ScrollArea change are unchecked.
- **Round 6 (2026-11-27, same section): Workspace rebuilt chat-app style.** `web/src/views/WorkspaceView.tsx` rewritten; the separate 240px chat column is gone. Chat history and a New chat button now render into the main app sidebar through React portals (`headSlot` and `listSlot` divs added in `App.tsx`, shown only while Workspace is active and hidden in icon mode). History is grouped Today / Yesterday / Previous 7 days / Older, single-line truncated titles ("New chat" when the title is 3 characters or fewer), relative time swapped for a delete button on hover, delete asks for confirmation (AlertDialog). Empty state: greeting "What should we check today?", centred composer, four suggestion cards with icons; after the first message the composer docks at the bottom. The header bar is removed; the Execution Canvas toggle is an icon button (route notice shows as a small badge). Composer: auto-growing textarea, searchable model list (kept the existing cross-backend `switchModel`, saves via `PUT /api/brain`), Show work and Notes only as toggle chips, `@` agent menu from `/api/reo/agents`, round send/stop button, hint line. Messages: user bubble right, assistant full width with avatar, Copy on hover, source chips, collapsible "Worked for Ns · N steps" (steps captured from the mission tool events; hidden when Show work is off). `index.css` now sets `scrollbar-width: thin` globally to remove native scrollbar arrows. `model-picker.tsx` is shared with Settings; `familyOf` is exported. No shadcn init/add (the Toggle component was not installed, so chips are Buttons with `aria-pressed`). `npm run build` passes. Not viewed in a running app: portal placement inside the sidebar, scrollbar styling in WebView2, the @ menu, and the worked-for collapsible are unverified.

---


## 100% React + Vite + Tailwind CSS v4 + shadcn/ui Frontend Replacement & Antigravity CLI Subscription (2026-11-27)

- **Brand-New `web/` Frontend (`web/src/`, `web/dist/`):**
  - Replaced the old `ui/` frontend with a complete React + Vite + Tailwind CSS v4 + shadcn/ui component system (`Button`, `Card`, `Badge`, `Input`, `Textarea`, `Select`, `Switch`, `Tabs`, `ResponsiveTable`, `Sheet`, `Message`, `Bubble`).
  - Built all 8 views (`HomeView`, `WorkspaceView`, `QaLabView`, `DefectsView`, `AgentsView`, `PluginsView`, `KnowledgeView`, `SettingsView`) with Light/Dark/System theme switching (`public/theme-init.js` + `<meta name="color-scheme">` + zero inline scripts/styles for strict CSP).
  - Updated `DEFAULT_UI_DIR` in `engine/src/server/server.ts` to serve `web/dist` (plus `/theme-init.js` and `/assets/*`), `src-tauri/tauri.conf.json` (`frontendDist: "../web/dist"`), and `package.json` (`web:build`, `ui`, `desktop`, `desktop:build`).
- **Antigravity CLI Subscription Backend (`engine/src/brain/`):**
  - Added `"antigravity-cli"` (`agy -p --output-format text --disable-slash-commands --mode plan`) to `backends.ts`, `models.ts`, `settings.ts`, `select.ts`, `roles/models.json`, `server/brain.ts`, and `SettingsView`.

---

## SPIL REO Platform Buildout: Multi-Agent Orchestrator, Defects/PDF, Plugins & Clean UI (2026-11-27)

- **Rebrand & Landing/Workspace/How-It-Works Split:**
  - Rebranded across `engine/src/brand.ts`, `ui/brand.js`, `ui/index.html`, `src-tauri/` (`spil-reo-desktop`, `com.spil.reo`), `defects.ts`, `server.ts`, `README.md`, and tests to **SPIL REO** (*Review · Evaluate · Optimize — Autonomous Engineering Intelligence, Powered by SPIL Labs*).
  - `src-tauri/src/main.rs` boots directly to the Chat workspace (`/?t=<token>`); `#view-overview` shows the clean cosmic Landing page, and `#view-how` is a dedicated **How REO Works** page; removed `#mascot` robot and clutter cards from the empty chat view.
- **Core Platform Modules (`engine/src/agents/registry.ts`, `tools/registry.ts`, `defects/store.ts`, `plugins/store.ts`):**
  - Prebuilt 7-agent roster (`qa`, `qe`, `review`, `security`, `api`, `knowledge`, `report`) + `routeIntentToAgents` (Landing knowledge vs. Workspace automation handoff).
  - Permission-tiered Tool Library (`BUILTIN_TOOLS`, 17 tools) + persistent Defect Store with SHA-256 deduplication, HTML/PDF report export (`.artifacts/reports/`), Plugins Hub (`composio`, `ms-teams`, `azure-devops`, `github`, `mcp-hub`), and MS Teams Team Directory + MessageCard payload builder.
- **UI Pages & Server API (`ui/reo-pages.js`, `ui/reo-pages.css`, `ui/index.html`, `ui/app.js`, `engine/src/server/server.ts`):**
  - Added **Defects**, **Agents & Skills**, and **Plugins** views with CSP-strict DOM rendering and wired REST routes (`/api/reo/agents`, `/api/reo/route`, `/api/defects*`, `/api/plugins*`, `/api/team*`).
- **Verification:** `npx.cmd tsc -p engine --noEmit` (0 errors), `node --experimental-strip-types --test engine/test/reo-platform.test.ts` (**3/3 passed**), `git diff --check` clean.

---

## Tauri 2 Native Desktop App & Documentation Restructure (2026-11-26)

- **Tauri 2 Desktop Shell (`src-tauri/`):**
  - Scaffolded `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/icons/icon.ico`, and `src-tauri/src/main.rs`.
  - `main.rs` spawns `node bin/aura-guard.mjs ui --no-open` hidden (`CREATE_NO_WINDOW`), reads `http://127.0.0.1:<port>/?t=<token>` from stdout, navigates the `main` WebviewWindow, and kills the child Node process on window close/exit.
  - Added `"desktop"` (`cargo tauri dev --manifest-path src-tauri/Cargo.toml`) and `"desktop:build"` (`cargo tauri build --manifest-path src-tauri/Cargo.toml`) to `package.json`.
  - Verified: `cargo check --manifest-path src-tauri/Cargo.toml` (`CARGO_BUILD_JOBS=1`) -> Passed (0 errors).
- **Documentation Restructure (`README.md`, `STATUS.md`, `AGENTS.md`):**
  - Updated product name to **AURA Sentinel**, documented Tauri 2 run/build commands, and added the Tech Stack & Architecture summary.

---

## Lauren Poteto Rules & Windows UIA Desktop App Crawler (2026-11-26)

- **`lauren-poteto-rules` Integration (`plugin/aura-guard/skills/lauren-poteto-rules/SKILL.md`, `qa/feature-map.json`, `engine/src/qa/feature_map.ts`, `engine/src/qe/constraints.ts`):**
  - Extracted all 8 engineering & verification rules from `unicodef1wn/lauren-poteto-rules` into a dedicated skill.
  - Added `loadFeatureMap`, `findFeatureEntry`, and `verifyClaimEvidence` (`appearance`, `interaction`, `performance`, `api`) in `feature_map.ts`.
  - Added `recommendDurableConstraint` (smallest effective mechanism: `architecture` → `mechanical_check` → `vault_rule` → `skill`) and `evaluateSkillEffectiveness` in `constraints.ts`.
- **Open-Source Windows UIA & Multi-Backend Desktop Crawler (`bin/win-uia-crawler.ps1`, `engine/src/qa/desktop_crawler.ts`):**
  - Built a zero-install Windows UIA crawler (`bin/win-uia-crawler.ps1` using .NET `UIAutomationClient` + `UIAutomationTypes`) supporting `list-windows`, `inspect-tree`, `click` (`InvokePattern`/`SelectionItemPattern`/`TogglePattern`/`ExpandCollapsePattern`), `type` (`ValuePattern`), and window `screenshot`.
  - Created `probeDesktopCrawlers`, `createWindowsUiaTransport`, and `crawlDesktopApp` enforcing `selectTargetWindow` (denylist + `allowedApps`) and `judgeActionByTier` before every click/type, plus drafting declarative `JourneyDsl` flows.
- **Wiring & Verification:**
  - Added HTTP routes (`GET /api/qa/crawlers`, `POST /api/qa/crawl`, `GET /api/qa/features`, `POST /api/qe/constraint`), 3 MCP tools (`qa_crawl_desktop_app`, `qa_feature_map`, `qe_recommend_constraint` — 21 tools total on `dev`/`qa`, `support` strictly 2 tools), CLI subcommands (`qa crawl`, `qa features`), and Test Lab `Crawl Desktop UI` button.
  - `npx.cmd tsc -p engine --noEmit` (0 errors), `npm.cmd run typecheck` (0 errors), `npm.cmd test` (**364 / 364 passed across 46 test files**, including `crawler-poteto.test.ts`), `git diff --check` clean.

---

## 100% React + Vite + Tailwind CSS v4 + shadcn/ui Frontend Replacement & Antigravity CLI Subscription (2026-11-27)

- **Brand-New `web/` Frontend (`web/src/`, `web/dist/`):**
  - Replaced the old `ui/` frontend with a complete React + Vite + Tailwind CSS v4 + shadcn/ui component system (`Button`, `Card`, `Badge`, `Input`, `Textarea`, `Select`, `Switch`, `Tabs`, `ResponsiveTable`, `Sheet`, `Message`, `Bubble`).
  - Built all 8 views (`HomeView`, `WorkspaceView`, `QaLabView`, `DefectsView`, `AgentsView`, `PluginsView`, `KnowledgeView`, `SettingsView`) with Light/Dark/System theme switching (`public/theme-init.js` + `<meta name="color-scheme">` + zero inline scripts/styles for strict CSP).
  - Updated `DEFAULT_UI_DIR` in `engine/src/server/server.ts` to serve `web/dist` (plus `/theme-init.js` and `/assets/*`), `src-tauri/tauri.conf.json` (`frontendDist: "../web/dist"`), and `package.json` (`web:build`, `ui`, `desktop`, `desktop:build`).
- **Antigravity CLI Subscription Backend (`engine/src/brain/`):**
  - Added `"antigravity-cli"` (`agy -p --output-format text --disable-slash-commands --mode plan`) to `backends.ts`, `models.ts`, `settings.ts`, `select.ts`, `roles/models.json`, `server/brain.ts`, and `SettingsView`.

---

## SPIL REO Platform Buildout: Multi-Agent Orchestrator, Defects/PDF, Plugins & Clean UI (2026-11-27)

- **Rebrand & Landing/Workspace/How-It-Works Split:**
  - Rebranded across `engine/src/brand.ts`, `ui/brand.js`, `ui/index.html`, `src-tauri/` (`spil-reo-desktop`, `com.spil.reo`), `defects.ts`, `server.ts`, `README.md`, and tests to **SPIL REO** (*Review · Evaluate · Optimize — Autonomous Engineering Intelligence, Powered by SPIL Labs*).
  - `src-tauri/src/main.rs` boots directly to the Chat workspace (`/?t=<token>`); `#view-overview` shows the clean cosmic Landing page, and `#view-how` is a dedicated **How REO Works** page; removed `#mascot` robot and clutter cards from the empty chat view.
- **Core Platform Modules (`engine/src/agents/registry.ts`, `tools/registry.ts`, `defects/store.ts`, `plugins/store.ts`):**
  - Prebuilt 7-agent roster (`qa`, `qe`, `review`, `security`, `api`, `knowledge`, `report`) + `routeIntentToAgents` (Landing knowledge vs. Workspace automation handoff).
  - Permission-tiered Tool Library (`BUILTIN_TOOLS`, 17 tools) + persistent Defect Store with SHA-256 deduplication, HTML/PDF report export (`.artifacts/reports/`), Plugins Hub (`composio`, `ms-teams`, `azure-devops`, `github`, `mcp-hub`), and MS Teams Team Directory + MessageCard payload builder.
- **UI Pages & Server API (`ui/reo-pages.js`, `ui/reo-pages.css`, `ui/index.html`, `ui/app.js`, `engine/src/server/server.ts`):**
  - Added **Defects**, **Agents & Skills**, and **Plugins** views with CSP-strict DOM rendering and wired REST routes (`/api/reo/agents`, `/api/reo/route`, `/api/defects*`, `/api/plugins*`, `/api/team*`).
- **Verification:** `npx.cmd tsc -p engine --noEmit` (0 errors), `node --experimental-strip-types --test engine/test/reo-platform.test.ts` (**3/3 passed**), `git diff --check` clean.

---

## Tauri 2 Native Desktop App & Documentation Restructure (2026-11-26)

- **Tauri 2 Desktop Shell (`src-tauri/`):**
  - Scaffolded `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/icons/icon.ico`, and `src-tauri/src/main.rs`.
  - `main.rs` spawns `node bin/aura-guard.mjs ui --no-open` hidden (`CREATE_NO_WINDOW`), reads `http://127.0.0.1:<port>/?t=<token>` from stdout, navigates the `main` WebviewWindow, and kills the child Node process on window close/exit.
  - Added `"desktop"` (`cargo tauri dev --manifest-path src-tauri/Cargo.toml`) and `"desktop:build"` (`cargo tauri build --manifest-path src-tauri/Cargo.toml`) to `package.json`.
  - Verified: `cargo check --manifest-path src-tauri/Cargo.toml` (`CARGO_BUILD_JOBS=1`) -> Passed (0 errors).
- **Documentation Restructure (`README.md`, `STATUS.md`, `AGENTS.md`):**
  - Updated product name to **AURA Sentinel**, documented Tauri 2 run/build commands, and added the Tech Stack & Architecture summary.

---

## AURA Sentinel Platform: 5 QA + QE + DevSecOps Pillars & Rebrand (2026-11-26)

- **Platform Rebrand (`engine/src/brand.ts`, `ui/brand.js`, `ui/index.html`):** Renamed display brand to **AURA Sentinel** (`Sentinel`, monogram `AS`), keeping `aura-guard` CLI/MCP/plugin identifiers backwards-compatible.
- **Pillar 1 — QE Commit Trajectory & Churn Engine (`engine/src/qe/trajectory.ts`):** Added `analyzeCommitTrajectory` detecting fixup/wip churn hotspots, mid-branch pivot leftovers, scope atomicity drift, and cross-author file overlaps (author names hashed).
- **Pillar 2 — Swagger / OpenAPI Contract & Endpoint Engine (`engine/src/qa/openapi.ts`):** Added `parseOpenApiSpec`, `generateApiTestCases`, and `runOpenApiChecks` (hard-locked to `allowedHosts` local test URLs, safe read-only execution).
- **Pillar 3 — Safe Adversarial Security Probes & Network Telemetry (`engine/src/qa/security_probes.ts`, `engine/src/qa/oracles.ts`, `engine/src/qa/driver.ts`):** Added `runSecurityProbes` (SQLi canary, XSS reflection, path traversal, oversized body DoS cap, security headers, secret leaks; local-only) plus `NetworkEvent` / `checkNetworkTraffic` and passive Playwright `response` / `requestfailed` listeners.
- **Pillar 4 — Defect Fingerprinting & Bug Sheets (`engine/src/qa/defects.ts`):** Added `fingerprintDefect` and `buildBugSheet` exporting deduplicated JSON/Markdown/CSV Bug Sheets, developer ticket drafts, and PR warning blocks under `.artifacts/qa/<runId>/`.
- **Pillar 5 — Structural Code Refinement & KB Drift (`engine/src/qe/refine.ts`):** Added `analyzeRefinementAndKbDrift` detecting large changes, deep nesting, duplicate logic, magic numbers, stale Vault anchors, and undocumented added modules.
- **Wiring & Tests:** Added HTTP routes (`/api/qe/trajectory`, `/api/qe/refine`, `/api/qa/bug-sheet`, `/api/qa/openapi`, `/api/qa/security-probes`), 4 MCP tools (`qe_commit_trajectory`, `qe_code_refine_drift`, `qa_bug_sheet`, `qa_security_probes` — 18 tools total on `dev`/`qa`, `support` strictly 2 tools), CLI subcommands (`qa bugs|openapi|security`, `qe trajectory|refine`), and Control Room UI panels.
- **Verification:** `npx.cmd tsc -p engine --noEmit` (0 errors), `npm.cmd run typecheck` (0 errors), `npm.cmd test` (**362 / 362 passed across 45 test files**, including `qe-devsecops-pillars.test.ts`), `git diff --check` clean.

---

## 100% React + Vite + Tailwind CSS v4 + shadcn/ui Frontend Replacement & Antigravity CLI Subscription (2026-11-27)

- **Brand-New `web/` Frontend (`web/src/`, `web/dist/`):**
  - Replaced the old `ui/` frontend with a complete React + Vite + Tailwind CSS v4 + shadcn/ui component system (`Button`, `Card`, `Badge`, `Input`, `Textarea`, `Select`, `Switch`, `Tabs`, `ResponsiveTable`, `Sheet`, `Message`, `Bubble`).
  - Built all 8 views (`HomeView`, `WorkspaceView`, `QaLabView`, `DefectsView`, `AgentsView`, `PluginsView`, `KnowledgeView`, `SettingsView`) with Light/Dark/System theme switching (`public/theme-init.js` + `<meta name="color-scheme">` + zero inline scripts/styles for strict CSP).
  - Updated `DEFAULT_UI_DIR` in `engine/src/server/server.ts` to serve `web/dist` (plus `/theme-init.js` and `/assets/*`), `src-tauri/tauri.conf.json` (`frontendDist: "../web/dist"`), and `package.json` (`web:build`, `ui`, `desktop`, `desktop:build`).
- **Antigravity CLI Subscription Backend (`engine/src/brain/`):**
  - Added `"antigravity-cli"` (`agy -p --output-format text --disable-slash-commands --mode plan`) to `backends.ts`, `models.ts`, `settings.ts`, `select.ts`, `roles/models.json`, `server/brain.ts`, and `SettingsView`.

---

## SPIL REO Platform Buildout: Multi-Agent Orchestrator, Defects/PDF, Plugins & Clean UI (2026-11-27)

- **Rebrand & Landing/Workspace/How-It-Works Split:**
  - Rebranded across `engine/src/brand.ts`, `ui/brand.js`, `ui/index.html`, `src-tauri/` (`spil-reo-desktop`, `com.spil.reo`), `defects.ts`, `server.ts`, `README.md`, and tests to **SPIL REO** (*Review · Evaluate · Optimize — Autonomous Engineering Intelligence, Powered by SPIL Labs*).
  - `src-tauri/src/main.rs` boots directly to the Chat workspace (`/?t=<token>`); `#view-overview` shows the clean cosmic Landing page, and `#view-how` is a dedicated **How REO Works** page; removed `#mascot` robot and clutter cards from the empty chat view.
- **Core Platform Modules (`engine/src/agents/registry.ts`, `tools/registry.ts`, `defects/store.ts`, `plugins/store.ts`):**
  - Prebuilt 7-agent roster (`qa`, `qe`, `review`, `security`, `api`, `knowledge`, `report`) + `routeIntentToAgents` (Landing knowledge vs. Workspace automation handoff).
  - Permission-tiered Tool Library (`BUILTIN_TOOLS`, 17 tools) + persistent Defect Store with SHA-256 deduplication, HTML/PDF report export (`.artifacts/reports/`), Plugins Hub (`composio`, `ms-teams`, `azure-devops`, `github`, `mcp-hub`), and MS Teams Team Directory + MessageCard payload builder.
- **UI Pages & Server API (`ui/reo-pages.js`, `ui/reo-pages.css`, `ui/index.html`, `ui/app.js`, `engine/src/server/server.ts`):**
  - Added **Defects**, **Agents & Skills**, and **Plugins** views with CSP-strict DOM rendering and wired REST routes (`/api/reo/agents`, `/api/reo/route`, `/api/defects*`, `/api/plugins*`, `/api/team*`).
- **Verification:** `npx.cmd tsc -p engine --noEmit` (0 errors), `node --experimental-strip-types --test engine/test/reo-platform.test.ts` (**3/3 passed**), `git diff --check` clean.

---

## Tauri 2 Native Desktop App & Documentation Restructure (2026-11-26)

- **Tauri 2 Desktop Shell (`src-tauri/`):**
  - Scaffolded `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/icons/icon.ico`, and `src-tauri/src/main.rs`.
  - `main.rs` spawns `node bin/aura-guard.mjs ui --no-open` hidden (`CREATE_NO_WINDOW`), reads `http://127.0.0.1:<port>/?t=<token>` from stdout, navigates the `main` WebviewWindow, and kills the child Node process on window close/exit.
  - Added `"desktop"` (`cargo tauri dev --manifest-path src-tauri/Cargo.toml`) and `"desktop:build"` (`cargo tauri build --manifest-path src-tauri/Cargo.toml`) to `package.json`.
  - Verified: `cargo check --manifest-path src-tauri/Cargo.toml` (`CARGO_BUILD_JOBS=1`) -> Passed (0 errors).
- **Documentation Restructure (`README.md`, `STATUS.md`, `AGENTS.md`):**
  - Updated product name to **AURA Sentinel**, documented Tauri 2 run/build commands, and added the Tech Stack & Architecture summary.

---

## Agentic QA Control Room, Hybrid Driver, Oracles, PR Manager & Wise Advisor (2026-11-26)

- **Repo Boundary:** All implementation below was done strictly inside `D:\AURA - Guard` (uncommitted); `d:\SPIL AURA` was not modified.
- **1. Tiered Safety & Cua Enhancements (`qa/forbidden-actions.json`, `engine/src/qa/safety.ts`, `engine/src/qa/cua_client.ts`):**
  - Added `SafetyTier` (`0 | 1 | 2`), `tier1SafeNames`, `tier2HardBlockedNames`, `tier2BlockedScreens`, `extendForbidden` hard-block protections, and `judgeActionByTier` so local sandbox interactions (e.g. `New chat`, chat `Send`) are allowed in Tier 1 while ERP writes and messaging sends remain Tier 2 hard-blocked.
  - Added `CuaBounds` normalization (`normalizeBounds`) and `CuaClient.setWindowFrame(pid, windowId, width, height)` in `delivery_mode: "background"` with frame dimension bounds (`320..3840` x `240..2160`).
- **2. Deterministic Oracles, Rubric Judge, Trajectory Eval, Triage & PR Evidence (`engine/src/qa/oracles.ts`, `engine/src/qa/judge.ts`, `engine/src/qa/evidence.ts`):**
  - `oracles.ts`: Implemented 5 zero-token oracles (`checkResponsiveLayout`, `checkConsoleAndRuntime`, `checkFormSemantics`, `checkProtocolAndPrivacyLeaks`, pure-JS PNG `comparePngBuffers`, and `runAllOracles`).
  - `judge.ts`: Implemented `evaluateWithRubric` (4 rubrics, outgoing text masked via `maskOutgoing`, deterministic fallback when offline), `evaluateTrajectory`, `applyTriageDecision` (`real_bug` -> proposed `vault/inbox/incident-qa-triage-*.md` + PR comment; `update_baseline` -> `.artifacts/qa/baselines/`; `flaky_hint` -> `data/qa/hints.json`), and `loadQaHints`.
  - `evidence.ts`: Implemented `buildPrEvidencePacket` writing redacted `.artifacts/qa/<runId>/pr-evidence.{md,json}`.
- **3. Unified Hybrid Driver, Declarative DSL, Live Controls, Recorder, Explorer & Backend QA (`engine/src/qa/{driver,dsl,recorder,explorer,backend_qa}.ts`):**
  - `driver.ts`: Implemented `AuraDriver` + `createHybridDriver` bridging `CuaClient` (background UIA + `PrintWindow` + `setWindowFrame`) and Playwright CDP (ARIA snapshots, layout/form/console telemetry).
  - `dsl.ts`: Implemented Zod-validated `JourneyDsl` (`parseJourneyDsl`, `executeJourneyDsl`) and `LiveSessionController` (`pause`, `resume`, `stepOver`, `injectHint`, `abort`, `getSnapshot`).
  - `recorder.ts`: Implemented `draftJourneyFromRecording` converting manual events into `qa-steps` proposals in `vault/inbox/`.
  - `explorer.ts`: Implemented bounded `exploreScreen` (`MAX_EXPLORE_STEPS = 15`).
  - `backend_qa.ts`: Implemented `runBackendQaSuite` verifying MCP `support` isolation, QA tool contracts, vault secret safety, QA safety policy, index/graph counts, and `cua-driver` health.
- **4. Upgraded Code Reviewer, PR Manager & Wise Advisor (`roles/review-rules.json`, `engine/src/review/{tier0,reviewer}.ts`, `engine/src/prs/manager.ts`, `engine/src/chat/advisor.ts`):**
  - Added 4 defect-class line rules (`form-button-missing-type`, `swallowed-catch-block`, `rust-ignored-result-let`, `hardcoded-sql-connstring`) and wired active exported/vault pattern rules (`checkActivePatternRules`, `loadTier0ActiveChecks`) into `runTier0` and `reviewChange`.
  - Created `buildPrReadinessReport` (`engine/src/prs/manager.ts`) and `adviseDeveloper` (`engine/src/chat/advisor.ts`).
- **5. Server APIs, MCP Tools, CLI & Plugin Skills (`engine/src/server/server.ts`, `engine/src/mcp/server.ts`, `engine/src/cli/{commands-qa,main}.ts`, `engine/src/roles/skills.ts`, `plugin/aura-guard/skills/`):**
  - Added 10 server routes: `/api/qa/live/status`, `/api/qa/live/control`, `/api/qa/triage`, `/api/qa/evidence`, `/api/qa/pr-readiness`, `/api/qa/backend-check`, `/api/qa/record/draft`, `/api/advisor`, `/api/skills`, and `/api/skill`.
  - Built dynamic Skill Registry (`engine/src/roles/skills.ts`: `listSkills`, `getSkill`, `inferSkillCategory`) scanning 32 modular skills (`10` Security `sec-*`, `12` QA `qa-*`, `6` QE `qe-*`, `4` Core).
  - Registered 7 new read-only/advisory MCP tools on `dev` and `qa` scopes (`qa_plan_for_diff`, `qa_get_evidence_packet`, `qa_check_driver_health`, `pr_readiness_report`, `advise_architecture`, `list_skills`, `get_skill`), keeping `support` strictly at `search_knowledge` + `get_doc`.
  - Added CLI subcommands (`qa evidence`, `qa backend`, `qa explore`, `qa pr-readiness`, `advise`) and 29 new plugin skills (`sec-audit-master`, `sec-auth-access`, `sec-api-input`, `sec-db-secrets`, `sec-desktop-frontend`, `sec-mobile`, `sec-supplychain-infra`, `sec-business-logic`, `sec-logging-perf`, `sec-threat-model`, `qa-diff`, `qa-evidence`, `qa-explore`, `qa-record`, `qa-triage`, `qa-swagger-api`, `qa-ui-telemetry`, `qa-bug-sheet`, `qa-test-generator`, `qa-regression-select`, `qa-accessibility-responsive`, `qa-adversarial-probes`, `qe-commit-trajectory`, `qe-code-refine`, `qe-flaky-triage`, `qe-contract-drift`, `qe-kb-drift`, `qe-release-gate`, `pr-advisor`).
- **6. Interactive QA Control Room UI (`ui/qa-harness.js`, `ui/qa-harness-view.js`, `ui/qa-harness.css`):**
  - Added `buildResponsiveMatrix`, `buildOracleSummary`, `formatSafetyBadge`; wired Live Control Strip, Responsive 800/1100/1440 Matrix, 1-Click Triage Bar, PR Evidence export, Record & Draft Journey, Backend & MCP QA trigger, Oracles/Rubrics scorecard, PR Readiness & Wise Advisor panel (strict CSP, zero inline styles).
- **7. Verification & Observed Results:**
  - `npx.cmd tsc -p engine --noEmit`: **Passed (0 errors)**.
  - `npm.cmd run typecheck` (`tsc -p engine --noEmit && tsc -p engine/tsconfig.test.json`): **Passed (0 errors)**.
  - `npm.cmd test`: **Passed — 358 / 358 tests across 44 test files** (0 failed, 0 skipped), including `qa-hybrid-dsl.test.ts`, `qa-oracles-judge-evidence.test.ts`, `pr-advisor-review.test.ts`, and `skills-catalog.test.ts`.
  - `git diff --check`: **Clean**.
- **Unverified:**
  - Live visual rendering of the updated QA Harness Control Room inside `npm run ui` across all 4 themes and widths.
  - End-to-end live execution of `createHybridDriver` / `executeJourneyDsl` / `exploreScreen` against a running `d:\SPIL AURA` window with `cua-driver` or WebView2 CDP.
- **Next Action:** Start `npm run ui` in `D:\AURA - Guard`, verify the QA Harness Control Room visually, and run one live background check (`qa backend` and `qa explore home`) against a running Aura test instance on the Cobalt database.

---

## 100% React + Vite + Tailwind CSS v4 + shadcn/ui Frontend Replacement & Antigravity CLI Subscription (2026-11-27)

- **Brand-New `web/` Frontend (`web/src/`, `web/dist/`):**
  - Replaced the old `ui/` frontend with a complete React + Vite + Tailwind CSS v4 + shadcn/ui component system (`Button`, `Card`, `Badge`, `Input`, `Textarea`, `Select`, `Switch`, `Tabs`, `ResponsiveTable`, `Sheet`, `Message`, `Bubble`).
  - Built all 8 views (`HomeView`, `WorkspaceView`, `QaLabView`, `DefectsView`, `AgentsView`, `PluginsView`, `KnowledgeView`, `SettingsView`) with Light/Dark/System theme switching (`public/theme-init.js` + `<meta name="color-scheme">` + zero inline scripts/styles for strict CSP).
  - Updated `DEFAULT_UI_DIR` in `engine/src/server/server.ts` to serve `web/dist` (plus `/theme-init.js` and `/assets/*`), `src-tauri/tauri.conf.json` (`frontendDist: "../web/dist"`), and `package.json` (`web:build`, `ui`, `desktop`, `desktop:build`).
- **Antigravity CLI Subscription Backend (`engine/src/brain/`):**
  - Added `"antigravity-cli"` (`agy -p --output-format text --disable-slash-commands --mode plan`) to `backends.ts`, `models.ts`, `settings.ts`, `select.ts`, `roles/models.json`, `server/brain.ts`, and `SettingsView`.

---

## SPIL REO Platform Buildout: Multi-Agent Orchestrator, Defects/PDF, Plugins & Clean UI (2026-11-27)

- **Rebrand & Landing/Workspace/How-It-Works Split:**
  - Rebranded across `engine/src/brand.ts`, `ui/brand.js`, `ui/index.html`, `src-tauri/` (`spil-reo-desktop`, `com.spil.reo`), `defects.ts`, `server.ts`, `README.md`, and tests to **SPIL REO** (*Review · Evaluate · Optimize — Autonomous Engineering Intelligence, Powered by SPIL Labs*).
  - `src-tauri/src/main.rs` boots directly to the Chat workspace (`/?t=<token>`); `#view-overview` shows the clean cosmic Landing page, and `#view-how` is a dedicated **How REO Works** page; removed `#mascot` robot and clutter cards from the empty chat view.
- **Core Platform Modules (`engine/src/agents/registry.ts`, `tools/registry.ts`, `defects/store.ts`, `plugins/store.ts`):**
  - Prebuilt 7-agent roster (`qa`, `qe`, `review`, `security`, `api`, `knowledge`, `report`) + `routeIntentToAgents` (Landing knowledge vs. Workspace automation handoff).
  - Permission-tiered Tool Library (`BUILTIN_TOOLS`, 17 tools) + persistent Defect Store with SHA-256 deduplication, HTML/PDF report export (`.artifacts/reports/`), Plugins Hub (`composio`, `ms-teams`, `azure-devops`, `github`, `mcp-hub`), and MS Teams Team Directory + MessageCard payload builder.
- **UI Pages & Server API (`ui/reo-pages.js`, `ui/reo-pages.css`, `ui/index.html`, `ui/app.js`, `engine/src/server/server.ts`):**
  - Added **Defects**, **Agents & Skills**, and **Plugins** views with CSP-strict DOM rendering and wired REST routes (`/api/reo/agents`, `/api/reo/route`, `/api/defects*`, `/api/plugins*`, `/api/team*`).
- **Verification:** `npx.cmd tsc -p engine --noEmit` (0 errors), `node --experimental-strip-types --test engine/test/reo-platform.test.ts` (**3/3 passed**), `git diff --check` clean.

---

## Tauri 2 Native Desktop App & Documentation Restructure (2026-11-26)

- **Tauri 2 Desktop Shell (`src-tauri/`):**
  - Scaffolded `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/icons/icon.ico`, and `src-tauri/src/main.rs`.
  - `main.rs` spawns `node bin/aura-guard.mjs ui --no-open` hidden (`CREATE_NO_WINDOW`), reads `http://127.0.0.1:<port>/?t=<token>` from stdout, navigates the `main` WebviewWindow, and kills the child Node process on window close/exit.
  - Added `"desktop"` (`cargo tauri dev --manifest-path src-tauri/Cargo.toml`) and `"desktop:build"` (`cargo tauri build --manifest-path src-tauri/Cargo.toml`) to `package.json`.
  - Verified: `cargo check --manifest-path src-tauri/Cargo.toml` (`CARGO_BUILD_JOBS=1`) -> Passed (0 errors).
- **Documentation Restructure (`README.md`, `STATUS.md`, `AGENTS.md`):**
  - Updated product name to **AURA Sentinel**, documented Tauri 2 run/build commands, and added the Tech Stack & Architecture summary.

---

## Agentic QA Harness UI, Backend API & Cua Driver Plan (2026-11-23)

- **Cua Driver Background QA Integration (`engine/src/qa/cua_client.ts`, `engine/src/qa/cua_harness.ts`, `engine/src/qa/runner.ts`, `engine/src/types.ts`, `engine/src/config.ts`, `engine/src/qa/harness_api.ts`, `engine/src/server/server.ts`, `ui/qa-harness-view.js`):**
  - Implemented `CuaClient` (`@modelcontextprotocol/sdk` stdio MCP client for `cua-driver mcp`) with `CUA_CALL_TIMEOUT_MS = 15_000`, `probeCuaDriver`, and hard tool blocking (`kill_app`, `bring_to_front`, `get_desktop_state`, `launch_app`).
  - Implemented `cua_harness.ts` (`judgeTargetWindow`, `selectTargetWindow`, `createCuaStepContext`) enforcing `delivery_mode: "background"`, process denylist (`BUILTIN_DENY_PROCESSES` + `cuaDriver.denyApps`), allowlist (`cuaDriver.allowedApps`), and pre-action `qa/safety.ts` (`judgeElement`, `isCommitKey`, `isEnterKey`) checks on UIA `element_token`s.
  - Added `runJourneyWithCua` in `engine/src/qa/runner.ts` saving background screenshots into `.artifacts/qa/<runId>/` and `GET /api/qa/driver` (`cuaDriverStatus`) surfaced in the **QA Harness** UI.
  - Added `engine/test/cua-harness.test.ts`.
- **Active Repo & Branch:** `D:\AURA - Guard` on branch `master` (all changes below are uncommitted).
- **Repo Boundary Rule:** Do **not** modify `D:\SPIL AURA` unless the user explicitly asks to switch there. (A read-only research & design document `Cua Driver design plan.md` was written in `D:\SPIL AURA` earlier in the session; all code implementation was done strictly in `D:\AURA - Guard`.)

### 1. What Was Built in `D:\AURA - Guard`

#### A. Read-Only QA Harness Backend (`engine/src/qa/harness_api.ts`, `engine/src/server/server.ts`)
- **`engine/src/qa/harness_api.ts`:**
  - `listQaRuns(cfg)`: Scans `data/qa/runs/*.json` (capped at `MAX_QA_RUNS = 100`), computes per-run `Scorecard` (`totalCases`, `p0Count`/`p1Count`/`p2Count`, `safetyChecked`/`safetyPassed`, `defectsCount`, `passRate`, and deterministic `releaseGate`: `"pass" | "warn" | "block"`), and aggregates KPIs (`totalRuns`, `executedRuns`, `passRate`, `totalDefects`, `avgSeconds`, `modelRuns`).
  - `getQaRun(cfg, id)`: Validates `id` (`^[a-zA-Z0-9_-]{3,80}$`), loads the `QaResult`, builds `WaterfallSpan[]` (`buildSpans`) across pipeline stages (`root`, `context`, `design`, `safety`, `report`, `runner`), and collects verified defect screenshots.
  - `compareQaRuns(cfg, baseId, headId)`: Computes `RunComparison` (case/P0/defect/duration/passRate deltas, added/removed cases, added/resolved defects).
  - `listQaSuite(cfg)`: Aggregates `vault/journeys/*.md` (`loadJourneys`), `roles/qa-case-templates.json` (`loadTemplates`), and recent run cases.
  - `listGovernanceAndCost(cfg)`: Reads `qa/forbidden-actions.json` (`loadForbidden`) and `data/logs/egress-*.jsonl` (capped at `MAX_AUDIT_RECORDS = 150`; hashes/counts/models only, never secret values).
  - `safeQaScreenshotPath(cfg, rawPath)`: Path-jailed image resolver strictly under `<root>/.artifacts/qa/` (rejects symlinks, traversal, non-images, and files > `MAX_ARTIFACT_BYTES = 10 MB`).
- **`engine/src/server/server.ts`:**
  - Registered `/qa-harness.js`, `/qa-harness-view.js`, and `/qa-harness.css` in `STATIC_FILES`.
  - Added routes: `GET /api/qa/runs`, `GET /api/qa/run?id=...`, `GET /api/qa/compare?base=...&head=...`, `GET /api/qa/suite`, `GET /api/qa/governance`, and `GET /api/qa/artifact?path=...`.

#### B. Upgraded Existing UI + New QA Harness Workspace (`ui/`)
- **Strict CSP & Theme Rules Followed:** Zero inline `style=` attributes or `.style.` mutations, `textContent` / `createElement` / `createElementNS` only (no `innerHTML` on server/model data), zero external CDNs, and full 4-theme compatibility via `themes.css` custom properties. SVG is used for waterfall bars, the multi-agent workflow DAG, and the regression trend chart.
- **`ui/steps.js`:** Added `stepKindLabel(kind)` and `computeWaterfall(steps)` for proportional timing bars.
- **`ui/qa.js` & `ui/qa-view.js`:** Added `computeScorecard(qa)` and `groupDefects(defects)`. Chat QA cards now render an inline **Release Gate & Scorecard** banner and an **"Open in QA Harness"** button.
- **`ui/qa-harness.js` (pure, DOM-free):** Exports `HARNESS_TABS`, `GATE_INFO`, `buildWaterfallSpans`, `buildWorkflowGraph`, `buildReplayFrames`, `filterSuiteCases`, and `regressionSeries`.
- **`ui/qa-harness-view.js` & `ui/qa-harness.css`:** Redesigned as a Linear + LangSmith + Postman + Playwright desktop engineering workstation mounted under `#tab-qa` / `#view-qa`:
  - **3 Major Workspaces (`1`/`2`/`3`):** `Agent Observability` (Overview, Agent Runs, Workflows, Replay & Artifacts), `Test Lab` (Test Suites, Journey Specs), `Evaluation Lab` (Evaluations, Run Comparison, Governance & Audit).
  - **IDE 4-Zone Split Workbench:** Top workspace/command toolbar + Postman-style closable **Multi-Tab Execution Bar**; CSS-resizable Left Rail (workspace nav, Pipeline Agents status, recent runs); Center Canvas (KPIs, Release Gate, interactive SVG Workflow DAG & Execution Waterfall, Test Explorer, Run Comparison, Playwright/Cua Action Replay, Regression SVG); Right **Span / Syntax-Colored JSON / Safety Inspector** (`I` to toggle); Bottom dockable **Execution Logs / Artifacts / Cua Driver Console** (`J` to toggle).
  - **Command Palette (`Ctrl+Shift+K`):** Instant search/jump across workspaces, views, runs, and test cases.

#### C. Tests Added
- `engine/test/qa-harness-api.test.ts`: Tests `listQaRuns`, `getQaRun`, `compareQaRuns`, `listQaSuite`, `listGovernanceAndCost`, `computeScorecard`, and `safeQaScreenshotPath` path-traversal rejection.
- `engine/test/ui-qa-harness.test.ts`: Tests `ui/qa.js` scorecard/defect grouping, `ui/steps.js` waterfall calculation, and `ui/qa-harness.js` graph/replay/filter/trend helpers.

### 2. Research Completed (Not Yet Implemented in Code)
- **Cua Driver (`trycua/cua` → `libs/cua-driver`) Integration Design:** Researched Windows UIA/`PostMessage`/`PrintWindow`/CDP background delivery, `element_token` snapshots, `cursor-overlay`, and mapped gaps against `D:\SPIL AURA`. Design saved at `D:\SPIL AURA\Cua Driver design plan.md` (awaiting owner go-ahead before touching `D:\SPIL AURA`).

### 3. Verification & Current Status
- `npx tsc -p engine --noEmit`: **Passed** (0 errors).
- `npm test`: **Passed** — **345 / 345 tests** across 39 test files (including CSP inline-style checks and both new QA Harness test files).
- `git diff --check`: **Clean**.
- **Unverified:** Live visual rendering and interactive clicks inside `npm run ui` with real `data/qa/runs/*.json` and `.artifacts/qa/` screenshots across all 4 themes and responsive widths.
- **Next Action:** Start `npm run ui` in `D:\AURA - Guard`, inspect the **QA Harness** tab visually across all 5 sub-views, then proceed to Phase 2 (LLM-as-Judge rubric evaluation panel, per-step token/cost telemetry, and interactive pause/inject-instruction controls).

---

## 100% React + Vite + Tailwind CSS v4 + shadcn/ui Frontend Replacement & Antigravity CLI Subscription (2026-11-27)

- **Brand-New `web/` Frontend (`web/src/`, `web/dist/`):**
  - Replaced the old `ui/` frontend with a complete React + Vite + Tailwind CSS v4 + shadcn/ui component system (`Button`, `Card`, `Badge`, `Input`, `Textarea`, `Select`, `Switch`, `Tabs`, `ResponsiveTable`, `Sheet`, `Message`, `Bubble`).
  - Built all 8 views (`HomeView`, `WorkspaceView`, `QaLabView`, `DefectsView`, `AgentsView`, `PluginsView`, `KnowledgeView`, `SettingsView`) with Light/Dark/System theme switching (`public/theme-init.js` + `<meta name="color-scheme">` + zero inline scripts/styles for strict CSP).
  - Updated `DEFAULT_UI_DIR` in `engine/src/server/server.ts` to serve `web/dist` (plus `/theme-init.js` and `/assets/*`), `src-tauri/tauri.conf.json` (`frontendDist: "../web/dist"`), and `package.json` (`web:build`, `ui`, `desktop`, `desktop:build`).
- **Antigravity CLI Subscription Backend (`engine/src/brain/`):**
  - Added `"antigravity-cli"` (`agy -p --output-format text --disable-slash-commands --mode plan`) to `backends.ts`, `models.ts`, `settings.ts`, `select.ts`, `roles/models.json`, `server/brain.ts`, and `SettingsView`.

---

## SPIL REO Platform Buildout: Multi-Agent Orchestrator, Defects/PDF, Plugins & Clean UI (2026-11-27)

- **Rebrand & Landing/Workspace/How-It-Works Split:**
  - Rebranded across `engine/src/brand.ts`, `ui/brand.js`, `ui/index.html`, `src-tauri/` (`spil-reo-desktop`, `com.spil.reo`), `defects.ts`, `server.ts`, `README.md`, and tests to **SPIL REO** (*Review · Evaluate · Optimize — Autonomous Engineering Intelligence, Powered by SPIL Labs*).
  - `src-tauri/src/main.rs` boots directly to the Chat workspace (`/?t=<token>`); `#view-overview` shows the clean cosmic Landing page, and `#view-how` is a dedicated **How REO Works** page; removed `#mascot` robot and clutter cards from the empty chat view.
- **Core Platform Modules (`engine/src/agents/registry.ts`, `tools/registry.ts`, `defects/store.ts`, `plugins/store.ts`):**
  - Prebuilt 7-agent roster (`qa`, `qe`, `review`, `security`, `api`, `knowledge`, `report`) + `routeIntentToAgents` (Landing knowledge vs. Workspace automation handoff).
  - Permission-tiered Tool Library (`BUILTIN_TOOLS`, 17 tools) + persistent Defect Store with SHA-256 deduplication, HTML/PDF report export (`.artifacts/reports/`), Plugins Hub (`composio`, `ms-teams`, `azure-devops`, `github`, `mcp-hub`), and MS Teams Team Directory + MessageCard payload builder.
- **UI Pages & Server API (`ui/reo-pages.js`, `ui/reo-pages.css`, `ui/index.html`, `ui/app.js`, `engine/src/server/server.ts`):**
  - Added **Defects**, **Agents & Skills**, and **Plugins** views with CSP-strict DOM rendering and wired REST routes (`/api/reo/agents`, `/api/reo/route`, `/api/defects*`, `/api/plugins*`, `/api/team*`).
- **Verification:** `npx.cmd tsc -p engine --noEmit` (0 errors), `node --experimental-strip-types --test engine/test/reo-platform.test.ts` (**3/3 passed**), `git diff --check` clean.

---

## Tauri 2 Native Desktop App & Documentation Restructure (2026-11-26)

- **Tauri 2 Desktop Shell (`src-tauri/`):**
  - Scaffolded `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/icons/icon.ico`, and `src-tauri/src/main.rs`.
  - `main.rs` spawns `node bin/aura-guard.mjs ui --no-open` hidden (`CREATE_NO_WINDOW`), reads `http://127.0.0.1:<port>/?t=<token>` from stdout, navigates the `main` WebviewWindow, and kills the child Node process on window close/exit.
  - Added `"desktop"` (`cargo tauri dev --manifest-path src-tauri/Cargo.toml`) and `"desktop:build"` (`cargo tauri build --manifest-path src-tauri/Cargo.toml`) to `package.json`.
  - Verified: `cargo check --manifest-path src-tauri/Cargo.toml` (`CARGO_BUILD_JOBS=1`) -> Passed (0 errors).
- **Documentation Restructure (`README.md`, `STATUS.md`, `AGENTS.md`):**
  - Updated product name to **AURA Sentinel**, documented Tauri 2 run/build commands, and added the Tech Stack & Architecture summary.

---


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
|---

## 100% React + Vite + Tailwind CSS v4 + shadcn/ui Frontend Replacement & Antigravity CLI Subscription (2026-11-27)

- **Brand-New `web/` Frontend (`web/src/`, `web/dist/`):**
  - Replaced the old `ui/` frontend with a complete React + Vite + Tailwind CSS v4 + shadcn/ui component system (`Button`, `Card`, `Badge`, `Input`, `Textarea`, `Select`, `Switch`, `Tabs`, `ResponsiveTable`, `Sheet`, `Message`, `Bubble`).
  - Built all 8 views (`HomeView`, `WorkspaceView`, `QaLabView`, `DefectsView`, `AgentsView`, `PluginsView`, `KnowledgeView`, `SettingsView`) with Light/Dark/System theme switching (`public/theme-init.js` + `<meta name="color-scheme">` + zero inline scripts/styles for strict CSP).
  - Updated `DEFAULT_UI_DIR` in `engine/src/server/server.ts` to serve `web/dist` (plus `/theme-init.js` and `/assets/*`), `src-tauri/tauri.conf.json` (`frontendDist: "../web/dist"`), and `package.json` (`web:build`, `ui`, `desktop`, `desktop:build`).
- **Antigravity CLI Subscription Backend (`engine/src/brain/`):**
  - Added `"antigravity-cli"` (`agy -p --output-format text --disable-slash-commands --mode plan`) to `backends.ts`, `models.ts`, `settings.ts`, `select.ts`, `roles/models.json`, `server/brain.ts`, and `SettingsView`.

---

## SPIL REO Platform Buildout: Multi-Agent Orchestrator, Defects/PDF, Plugins & Clean UI (2026-11-27)

- **Rebrand & Landing/Workspace/How-It-Works Split:**
  - Rebranded across `engine/src/brand.ts`, `ui/brand.js`, `ui/index.html`, `src-tauri/` (`spil-reo-desktop`, `com.spil.reo`), `defects.ts`, `server.ts`, `README.md`, and tests to **SPIL REO** (*Review · Evaluate · Optimize — Autonomous Engineering Intelligence, Powered by SPIL Labs*).
  - `src-tauri/src/main.rs` boots directly to the Chat workspace (`/?t=<token>`); `#view-overview` shows the clean cosmic Landing page, and `#view-how` is a dedicated **How REO Works** page; removed `#mascot` robot and clutter cards from the empty chat view.
- **Core Platform Modules (`engine/src/agents/registry.ts`, `tools/registry.ts`, `defects/store.ts`, `plugins/store.ts`):**
  - Prebuilt 7-agent roster (`qa`, `qe`, `review`, `security`, `api`, `knowledge`, `report`) + `routeIntentToAgents` (Landing knowledge vs. Workspace automation handoff).
  - Permission-tiered Tool Library (`BUILTIN_TOOLS`, 17 tools) + persistent Defect Store with SHA-256 deduplication, HTML/PDF report export (`.artifacts/reports/`), Plugins Hub (`composio`, `ms-teams`, `azure-devops`, `github`, `mcp-hub`), and MS Teams Team Directory + MessageCard payload builder.
- **UI Pages & Server API (`ui/reo-pages.js`, `ui/reo-pages.css`, `ui/index.html`, `ui/app.js`, `engine/src/server/server.ts`):**
  - Added **Defects**, **Agents & Skills**, and **Plugins** views with CSP-strict DOM rendering and wired REST routes (`/api/reo/agents`, `/api/reo/route`, `/api/defects*`, `/api/plugins*`, `/api/team*`).
- **Verification:** `npx.cmd tsc -p engine --noEmit` (0 errors), `node --experimental-strip-types --test engine/test/reo-platform.test.ts` (**3/3 passed**), `git diff --check` clean.

---

## Tauri 2 Native Desktop App & Documentation Restructure (2026-11-26)

- **Tauri 2 Desktop Shell (`src-tauri/`):**
  - Scaffolded `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/icons/icon.ico`, and `src-tauri/src/main.rs`.
  - `main.rs` spawns `node bin/aura-guard.mjs ui --no-open` hidden (`CREATE_NO_WINDOW`), reads `http://127.0.0.1:<port>/?t=<token>` from stdout, navigates the `main` WebviewWindow, and kills the child Node process on window close/exit.
  - Added `"desktop"` (`cargo tauri dev --manifest-path src-tauri/Cargo.toml`) and `"desktop:build"` (`cargo tauri build --manifest-path src-tauri/Cargo.toml`) to `package.json`.
  - Verified: `cargo check --manifest-path src-tauri/Cargo.toml` (`CARGO_BUILD_JOBS=1`) -> Passed (0 errors).
- **Documentation Restructure (`README.md`, `STATUS.md`, `AGENTS.md`):**
  - Updated product name to **AURA Sentinel**, documented Tauri 2 run/build commands, and added the Tech Stack & Architecture summary.

---|---

## 100% React + Vite + Tailwind CSS v4 + shadcn/ui Frontend Replacement & Antigravity CLI Subscription (2026-11-27)

- **Brand-New `web/` Frontend (`web/src/`, `web/dist/`):**
  - Replaced the old `ui/` frontend with a complete React + Vite + Tailwind CSS v4 + shadcn/ui component system (`Button`, `Card`, `Badge`, `Input`, `Textarea`, `Select`, `Switch`, `Tabs`, `ResponsiveTable`, `Sheet`, `Message`, `Bubble`).
  - Built all 8 views (`HomeView`, `WorkspaceView`, `QaLabView`, `DefectsView`, `AgentsView`, `PluginsView`, `KnowledgeView`, `SettingsView`) with Light/Dark/System theme switching (`public/theme-init.js` + `<meta name="color-scheme">` + zero inline scripts/styles for strict CSP).
  - Updated `DEFAULT_UI_DIR` in `engine/src/server/server.ts` to serve `web/dist` (plus `/theme-init.js` and `/assets/*`), `src-tauri/tauri.conf.json` (`frontendDist: "../web/dist"`), and `package.json` (`web:build`, `ui`, `desktop`, `desktop:build`).
- **Antigravity CLI Subscription Backend (`engine/src/brain/`):**
  - Added `"antigravity-cli"` (`agy -p --output-format text --disable-slash-commands --mode plan`) to `backends.ts`, `models.ts`, `settings.ts`, `select.ts`, `roles/models.json`, `server/brain.ts`, and `SettingsView`.

---

## SPIL REO Platform Buildout: Multi-Agent Orchestrator, Defects/PDF, Plugins & Clean UI (2026-11-27)

- **Rebrand & Landing/Workspace/How-It-Works Split:**
  - Rebranded across `engine/src/brand.ts`, `ui/brand.js`, `ui/index.html`, `src-tauri/` (`spil-reo-desktop`, `com.spil.reo`), `defects.ts`, `server.ts`, `README.md`, and tests to **SPIL REO** (*Review · Evaluate · Optimize — Autonomous Engineering Intelligence, Powered by SPIL Labs*).
  - `src-tauri/src/main.rs` boots directly to the Chat workspace (`/?t=<token>`); `#view-overview` shows the clean cosmic Landing page, and `#view-how` is a dedicated **How REO Works** page; removed `#mascot` robot and clutter cards from the empty chat view.
- **Core Platform Modules (`engine/src/agents/registry.ts`, `tools/registry.ts`, `defects/store.ts`, `plugins/store.ts`):**
  - Prebuilt 7-agent roster (`qa`, `qe`, `review`, `security`, `api`, `knowledge`, `report`) + `routeIntentToAgents` (Landing knowledge vs. Workspace automation handoff).
  - Permission-tiered Tool Library (`BUILTIN_TOOLS`, 17 tools) + persistent Defect Store with SHA-256 deduplication, HTML/PDF report export (`.artifacts/reports/`), Plugins Hub (`composio`, `ms-teams`, `azure-devops`, `github`, `mcp-hub`), and MS Teams Team Directory + MessageCard payload builder.
- **UI Pages & Server API (`ui/reo-pages.js`, `ui/reo-pages.css`, `ui/index.html`, `ui/app.js`, `engine/src/server/server.ts`):**
  - Added **Defects**, **Agents & Skills**, and **Plugins** views with CSP-strict DOM rendering and wired REST routes (`/api/reo/agents`, `/api/reo/route`, `/api/defects*`, `/api/plugins*`, `/api/team*`).
- **Verification:** `npx.cmd tsc -p engine --noEmit` (0 errors), `node --experimental-strip-types --test engine/test/reo-platform.test.ts` (**3/3 passed**), `git diff --check` clean.

---

## Tauri 2 Native Desktop App & Documentation Restructure (2026-11-26)

- **Tauri 2 Desktop Shell (`src-tauri/`):**
  - Scaffolded `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/icons/icon.ico`, and `src-tauri/src/main.rs`.
  - `main.rs` spawns `node bin/aura-guard.mjs ui --no-open` hidden (`CREATE_NO_WINDOW`), reads `http://127.0.0.1:<port>/?t=<token>` from stdout, navigates the `main` WebviewWindow, and kills the child Node process on window close/exit.
  - Added `"desktop"` (`cargo tauri dev --manifest-path src-tauri/Cargo.toml`) and `"desktop:build"` (`cargo tauri build --manifest-path src-tauri/Cargo.toml`) to `package.json`.
  - Verified: `cargo check --manifest-path src-tauri/Cargo.toml` (`CARGO_BUILD_JOBS=1`) -> Passed (0 errors).
- **Documentation Restructure (`README.md`, `STATUS.md`, `AGENTS.md`):**
  - Updated product name to **AURA Sentinel**, documented Tauri 2 run/build commands, and added the Tech Stack & Architecture summary.

---|---

## 100% React + Vite + Tailwind CSS v4 + shadcn/ui Frontend Replacement & Antigravity CLI Subscription (2026-11-27)

- **Brand-New `web/` Frontend (`web/src/`, `web/dist/`):**
  - Replaced the old `ui/` frontend with a complete React + Vite + Tailwind CSS v4 + shadcn/ui component system (`Button`, `Card`, `Badge`, `Input`, `Textarea`, `Select`, `Switch`, `Tabs`, `ResponsiveTable`, `Sheet`, `Message`, `Bubble`).
  - Built all 8 views (`HomeView`, `WorkspaceView`, `QaLabView`, `DefectsView`, `AgentsView`, `PluginsView`, `KnowledgeView`, `SettingsView`) with Light/Dark/System theme switching (`public/theme-init.js` + `<meta name="color-scheme">` + zero inline scripts/styles for strict CSP).
  - Updated `DEFAULT_UI_DIR` in `engine/src/server/server.ts` to serve `web/dist` (plus `/theme-init.js` and `/assets/*`), `src-tauri/tauri.conf.json` (`frontendDist: "../web/dist"`), and `package.json` (`web:build`, `ui`, `desktop`, `desktop:build`).
- **Antigravity CLI Subscription Backend (`engine/src/brain/`):**
  - Added `"antigravity-cli"` (`agy -p --output-format text --disable-slash-commands --mode plan`) to `backends.ts`, `models.ts`, `settings.ts`, `select.ts`, `roles/models.json`, `server/brain.ts`, and `SettingsView`.

---

## SPIL REO Platform Buildout: Multi-Agent Orchestrator, Defects/PDF, Plugins & Clean UI (2026-11-27)

- **Rebrand & Landing/Workspace/How-It-Works Split:**
  - Rebranded across `engine/src/brand.ts`, `ui/brand.js`, `ui/index.html`, `src-tauri/` (`spil-reo-desktop`, `com.spil.reo`), `defects.ts`, `server.ts`, `README.md`, and tests to **SPIL REO** (*Review · Evaluate · Optimize — Autonomous Engineering Intelligence, Powered by SPIL Labs*).
  - `src-tauri/src/main.rs` boots directly to the Chat workspace (`/?t=<token>`); `#view-overview` shows the clean cosmic Landing page, and `#view-how` is a dedicated **How REO Works** page; removed `#mascot` robot and clutter cards from the empty chat view.
- **Core Platform Modules (`engine/src/agents/registry.ts`, `tools/registry.ts`, `defects/store.ts`, `plugins/store.ts`):**
  - Prebuilt 7-agent roster (`qa`, `qe`, `review`, `security`, `api`, `knowledge`, `report`) + `routeIntentToAgents` (Landing knowledge vs. Workspace automation handoff).
  - Permission-tiered Tool Library (`BUILTIN_TOOLS`, 17 tools) + persistent Defect Store with SHA-256 deduplication, HTML/PDF report export (`.artifacts/reports/`), Plugins Hub (`composio`, `ms-teams`, `azure-devops`, `github`, `mcp-hub`), and MS Teams Team Directory + MessageCard payload builder.
- **UI Pages & Server API (`ui/reo-pages.js`, `ui/reo-pages.css`, `ui/index.html`, `ui/app.js`, `engine/src/server/server.ts`):**
  - Added **Defects**, **Agents & Skills**, and **Plugins** views with CSP-strict DOM rendering and wired REST routes (`/api/reo/agents`, `/api/reo/route`, `/api/defects*`, `/api/plugins*`, `/api/team*`).
- **Verification:** `npx.cmd tsc -p engine --noEmit` (0 errors), `node --experimental-strip-types --test engine/test/reo-platform.test.ts` (**3/3 passed**), `git diff --check` clean.

---

## Tauri 2 Native Desktop App & Documentation Restructure (2026-11-26)

- **Tauri 2 Desktop Shell (`src-tauri/`):**
  - Scaffolded `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/icons/icon.ico`, and `src-tauri/src/main.rs`.
  - `main.rs` spawns `node bin/aura-guard.mjs ui --no-open` hidden (`CREATE_NO_WINDOW`), reads `http://127.0.0.1:<port>/?t=<token>` from stdout, navigates the `main` WebviewWindow, and kills the child Node process on window close/exit.
  - Added `"desktop"` (`cargo tauri dev --manifest-path src-tauri/Cargo.toml`) and `"desktop:build"` (`cargo tauri build --manifest-path src-tauri/Cargo.toml`) to `package.json`.
  - Verified: `cargo check --manifest-path src-tauri/Cargo.toml` (`CARGO_BUILD_JOBS=1`) -> Passed (0 errors).
- **Documentation Restructure (`README.md`, `STATUS.md`, `AGENTS.md`):**
  - Updated product name to **AURA Sentinel**, documented Tauri 2 run/build commands, and added the Tech Stack & Architecture summary.

---|
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

- Product renamed to **SPIL AURA QA Bot** in all user-facing text. Identifiers stay
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

## Fix: false "looks like a secret" on a normal question (2026-11-20)

- Symptom: asking "hi what do you know about aura" showed "Your message looks like it contains a
  secret (HIGH_ENTROPY x2)". Cause: the masking step checks the whole prompt, and two retrieved
  proposed rule notes have ids like `pattern-cochange-0829e6e17ce2` (words plus a 12-character hex
  tail), which the entropy detector read as random keys. The message wrongly blamed the user.
- Fixes: (1) `engine/src/mask/detectors.ts` treats lower-case words plus a 6-16 character hex tail as
  an identifier (named key formats are still caught by their own detectors; masking gate still 100%,
  0 false positives in 121 clean cases, 3 new clean cases for these id shapes). (2)
  `engine/src/chat/answer.ts` masks each retrieved source on its own: a source that looks like it holds a
  secret is left out and named in the "found" step detail, instead of failing the whole question.
  (3) When a block is not caused by the question (for example an earlier chat message) the message
  says "Something in this chat ... looked like a secret".
- Evidence: 3 new tests in `engine/test/chat-withhold.test.ts`; full suite 274 pass; the exact question
  now answers through the Claude plan in 11.6 s with citations. Restart the app (`npm run ui`) to get it.
- Not committed.

## Departments removed; SPIL AURA QA Bot (2026-11-20, main session + Sonnet agents)

- The multi-department design described in the sections above was REMOVED on the owner's request
  (engine, server, CLI and UI). The bot is one project, SPIL Aura, and opens straight into chat.
  Treat any earlier text about departments, `dept`, a landing page or a registry as history.
- Product name: **SPIL AURA QA Bot** (short "AURA QA"). Identifiers unchanged: `aura-guard`
  command, `AURA_GUARD_*` env vars (with `QSB_*` aliases), plugin id `aura-guard`, extension id
  `aura-guard-companion`.
- Local config (git-ignored): `guard.config.local.json` lists the repos: spil-aura, pdf-svg-parser,
  shapes-core, shapes-service, erp-mcp (edit to trim). Old department data was moved aside to
  `data/_departments-removed-2026-11-20/` (indexes, two test chats, QA test artifacts): delete it when
  you like. Vault, index and chats are the same files as before.
- Repo rename checklist: rename the GitHub repo (suggested `spil-aura-qa-bot`) in Settings, then
  `git remote set-url origin <new url>`, update the marketplace repo in Aura's `.claude/settings.json`
  and in `README.md`, then rename the folder (close VS Code first). Then rename the `aura-guard`
  identifiers together.
- Evidence: see the test and real-run numbers in the commit message and STATUS.md section 11.

## 2026-11-26 UI redesign: Sentinel light and dark themes (owner: UI agent)

- Changed (all under `ui/`, plus three tests): `themes.css` is now the single token file (light default,
  `[data-mode="dark"]`, and `[data-mode="system"]` following the OS). `theme.js` keeps one layout style (`noir`),
  default mode `light`; old stored styles migrate to `noir`, unknown modes to `light`. `styles.css` lost the dead
  dots/pulse/aurora rule lines (also in `qa.css`, `settings.css`) and gained a redesign layer at the end (pill nav,
  card sidebar footer, hero banner, KPI cards, rounded cards). Hard-coded colours in all CSS outside `themes.css`
  were replaced by tokens (including `qa-harness.css`, owner work: colours only, plus a block that stacks the
  rail and inspector below 1100 px). `index.html`: tagline, sidebar theme toggle (`#theme-toggle`). `app.js`: toggle
  logic, Style picker removed from Appearance, Theme card in Settings, KPI cards built from the real index counts.
- Tests updated (pure styling): `ui-agent.test.ts` (styles/prefs), `ui-project.test.ts` (contrast now checked for light
  and dark token sets).
- Checks: `npm run typecheck` clean; `npm test` 364 pass, 0 fail. Screenshots (UI served by the test stub, so data is
  sample data) in `.artifacts/redesign/` for chat, inbox, reports, qa, settings, light and dark, 1440 and 800 px; no
  horizontal overflow reported at either width.
- Unverified: 1100 px screenshots, the real (non-stub) server, the Ctrl+K search field, and the QA harness with real runs.
- Omitted for lack of real data: sparklines and deltas on KPI cards, the notifications bell, a global search field
  (Ctrl+K already means New chat), the orchestration flow and knowledge-base list outside the QA harness.

## 2026-11-26 UI redesign v2: Overview home, plico-ui component language (owner: UI agent)

- Owner rejected v1. v2 changes: new `ui/overview.js` + `ui/overview.css` (Overview home: greeting hero, 4 KPI cards with
  sparklines from real data, memory pipeline, recent QA runs, recent activity, knowledge base, repositories, quick actions).
  The app now opens on Overview; Chat is its own page. Sidebar has Workspace / Knowledge / Quality groups, a status card and
  a user/version footer. A global bar has search (Ctrl+Shift+F; Ctrl+K and Ctrl+/ were already taken) over chats and
  notes/commits/files, an engine connection dot and an inbox bell.
- New read-only endpoints (`engine/src/server/overview.ts`, wired in `server.ts`): `GET /api/overview` (commits per day for 30
  days, recent commits/notes, note types, inbox groups, QA runs and pass-rate series) and `GET /api/search?q=` (internal_dev
  audience, 8 hits). `GET /api/status` now also returns `version`. Tests: `engine/test/overview-api.test.ts`; the stub server
  serves sample versions of both for screenshots and UI tests. `/overview.js` and `/overview.css` are on the server's allow list.
- Palettes (`ui/themes.css`): light = white cards on cool grey, slate text, violet #5b3df5, dark = deep navy with violet glow.
  Button, card, composer, segmented-control and motion styles are ported from plico-ui (MIT, (c) 2026 Plico UI contributors;
  attribution is in the CSS comments). No React or Tailwind added.
- QA Harness: controls restyled; below 1100 px the rail, centre, inspector and log drawer stack in one scrolling column, so the
  drawer no longer overlaps content at 800 px.
- Tests changed: `ui-project.test.ts` (helper opens Overview then Chat; new Overview test; contrast test now checks accent
  button text and soft status backgrounds), `ui-agent.test.ts` (from v1). Checks: `npm run typecheck` clean; `npm test` 367 pass, 0 fail.
- Screenshots: `.artifacts/redesign-v2/` (overview, chat, inbox, reports, qa, settings; light and dark; 1440, 1100, 800), taken
  against the stub server, so numbers are sample data. No horizontal overflow reported.
- Unverified: real server with a real index; Mobbin/Refero etc. were not fetched; the QA harness with real runs.

## 2026-11-26 UI redesign v3: landing home, pairing fix, icon, process wave, chat page, three-pane review (owner: UI agent)

- Error fix. Root cause: the desktop shell (src-tauri/src/main.rs, owner change) opens `/landing.html?t=<token>`, but the server
  only turned `?t=` into the cookie for the path `/`, so the landing request had no cookie and got `{"error":"Open Guard from its own
  window."}`. Fixed in `engine/src/server/server.ts`: `?t=` pairs on `/` and `/landing.html` (302 to `/`); a wrong or old token or a
  stale cookie no longer returns JSON to a page navigation: it gets a friendly HTML page with an Open Guard button (`/pair`, which
  pairs only on a same-origin user click via Sec-Fetch headers); typing the address (Sec-Fetch-Site: none) pairs directly; `/api` and
  fetch calls still get JSON 401. Host, Origin, loopback and SameSite=Strict cookie checks are unchanged; added frame-ancestors
  none and X-Frame-Options DENY. The launch token is now stable (`data/launch-token`, git-ignored) so a window or bookmark that
  outlives a restart still pairs. Tests: `engine/test/pairing.test.ts`. Note: `ui/landing.html` (owner file, untracked) is not
  served as its own page; `/landing.html` redirects to the app home. Its inline styles would be blocked by the CSP.
- Home is now a full-width landing hero (no sidebar): glow sky, real composer in the hero (the same `#composer` is moved between
  hero and Chat page), source chips from real counts, big stat blocks, the process wave (`ui/process.js`, reusable via
  `buildProcess` and `guardProcessSteps`), then the Overview panels. The chat history column shows on the Chat page only; the top-right
  gear menu reaches New chat, Project status, Appearance, Model and keys. New icon: `ui/favicon.svg`, PNGs, `.ico`, also copied to
  `src-tauri/icons/icon.ico`. Chat empty state: headline, quick pills, three real-data cards, tabbed suggestions, full-body robot
  (`#robot-sym`, states is-happy, is-wave, is-thinking). Inbox and Reports: three-pane folders / list / reading pane.
- Found changed outside this task: `ui/themes.css` light and dark palettes were rewritten to emerald / zinc (not by me). My new
  tokens are kept; hero sky colours are still blue. Decide whether to align them.
- Checks and screenshots: see the final report; screenshots are in `.artifacts/redesign-v3/`.

**2026-11-27:** Added docs/qa-tool-summary.md (docs only). Private notes are local in ignored data/. Full engine test run still not completed.

## web/ UI round (2026-11-28)

- New app icon used in chat, greeting, sidebar and Home (`web/src/components/app/brand.tsx`); icon links, `tauri.conf.json` `bundle.icon`, shortcut `IconLocation`.
- Chat: tool slash lines go to `/ask`, command-runner lines to `/api/command` (`web/src/lib/slash.ts`), slash menu, Web search chip.
- New: Appearance settings (`lib/appearance.ts`, `public/theme-init.js`), Usage, Pull requests, Repositories + diff viewer, Settings > Providers (replaces AI backend and Danger zone), Source control, Diffs & pull requests.
- Checks: `npm run web:build` passes. Headless Edge on `web/dist` with the app CSP and mocked API data: pages render, no JS errors; screenshots reviewed for part of the screens only. Not run against the real engine or in the Tauri window; no Rust build.
- CSP: the headless run reports blocked runtime `<style>` tags from bundled libraries (also on first load).
- Unverified: `window.open` in the Tauri window (Open in browser); `/api/providers` was not in the engine yet when checked. `ui/` and `engine/` not edited.

- Add repository picker: `web/src/components/app/add-repo.tsx` replaces the old dialog; new `GET /api/repos/browse` (`engine/src/repos/browse.ts`, test `engine/test/repos-browse.test.ts`, one route line in `repos/routes.ts`). Browse and repos-api tests 10/10, engine typecheck clean, `npm run web:build` passes. Picker checked in headless Edge with mocked data only.
