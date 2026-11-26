// A small stand-in for the server API, used to develop and screenshot the UI and to test it without
// the real engine. In-memory data only. It serves ui/ files and the endpoints the app calls, and it
// records every request (method, URL, body) so tests can check what the screen sent.
// Run: node --experimental-strip-types engine/test/ui-stub-server.ts [port] [empty|qa] [brain-json]
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const uiDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "ui");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86400000).toISOString();
const ANSWER = "SPIL AURA reads an order in three steps: **Reading**, **Checking** and **Saving** [Order flow overview].\n\n- Reading turns a PDF, drawing or email into order lines with AI helpers.\n- Checking compares every line with the shapes, prices and rules of the company.\n- Saving goes through a checked request. The helper never gets a create tool for the ERP.\n\nTo run the Rust checks, use `cargo test -p agent-core --lib`. One note about saving rules is still unapproved, so treat it as a draft.\n\n```\ncargo test -p agent-core --lib\n```";
const SOURCES: Json[] = [
  { ref: "note:order-flow", kind: "note", title: "Order flow overview", status: "active" },
  { ref: "note:saving-rules", kind: "note", title: "Saving rules", status: "proposed" },
  { ref: "commit:a1b2c3", kind: "commit", title: "Check prices before saving", status: "active" },
  { ref: "file:orders/save.rs", kind: "file", title: "orders/save.rs", status: "active" },
];
const TRACE: Json[] = [
  { id: "search", kind: "search", status: "done", label: "Searched notes, commits and files", ms: 410 },
  { id: "found", kind: "found", status: "done", label: "8 sources: 5 notes, 3 files", ms: 20 },
  { id: "write", kind: "write", status: "done", label: "Wrote the answer", ms: 2300 },
  { id: "done", kind: "done", status: "done", label: "Done", ms: 2800 },
];
const mins = (n: number): string => new Date(Date.now() - n * 60000).toISOString();
const dayStr = (n: number): string => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
function seedChats(): Json[] {
  const t = (id: string, title: string, ago: number, messages: Json[] = []): Json => ({ id, title, updated: mins(ago), messages });
  const u = (text: string): Json => ({ role: "user", text, ts: mins(3) });
  return [
    t("c0000000001", "How does an order get saved to the ERP?", 3, [u("How does an order get saved to the ERP?"), { role: "assistant", text: ANSWER, ts: mins(3), sources: SOURCES, trace: TRACE }]),
    t("c0000000002", "Which notes are still unapproved?", 95),
    t("c0000000003", "Why does the order check reject a line", 60 * 5),
    t("c0000000004", "What changed recently", 60 * 27),
    t("c0000000005", "How does the front desk choose a helper", 60 * 30),
    t("c0000000006", "Shape matching timeouts", 60 * 24 * 4),
    t("c0000000007", "Naming rules for helpers", 60 * 24 * 9),
    t("c0000000008", "Hi", 60 * 24 * 12),
    t("c0000000009", "What can you do", 60 * 24 * 20),
    t("c0000000010", "When does the nightly job run", 60 * 24 * 30),
  ];
}
const INBOX: Json = { total: 5, groups: [
  { type: "rule", count: 2, items: [
    { id: "rule-cache-keys", type: "rule", title: "Cache keys must include the tenant id", source: "pr-comment", created: dayStr(2), preview: "Every cache key in the order service has to carry the tenant id, otherwise two tenants can read each other's entries.", anchors: 3, evidence: { commits: 14, ratio: 0.42, repo: "aura-app" } },
    { id: "rule-retry", type: "rule", title: "Never retry a save automatically", source: "session", created: dayStr(0), preview: "A failed save needs a person to look at it first." },
  ] },
  { type: "pattern", count: 3, items: [
    { id: "pattern-one", type: "pattern", title: "Checks run inside one transaction", source: "commit", created: dayStr(9), preview: "Seen across the order checks: every run opens a transaction before it writes results." },
    { id: "pattern-two", type: "pattern", title: "Helper definitions live next to their tests", source: "import", created: dayStr(30), preview: "A helper file and its test sit in the same folder." },
    { id: "pattern-three", type: "pattern", title: "Config is read once at start", source: "evidence", created: dayStr(0), preview: "No service rereads its config while running." },
  ] },
] };
const REPORTS: Json[] = [
  { path: "reviews/pr-412.md", name: "pr-412.md", kind: "review", mtime: mins(120), size: 3200 },
  { path: "reviews/pr-409.md", name: "pr-409.md", kind: "review", mtime: mins(60 * 30), size: 2100 },
  { path: "qa/orders-plan.md", name: "orders-plan.md", kind: "qa-plan", mtime: mins(60 * 50), size: 5400 },
  { path: "qa/runs/2026-11-20-qa-8f3a21.md", name: "2026-11-20-qa-8f3a21.md", kind: "qa-plan", mtime: mins(4), size: 9100 },
  { path: "daily/2026-11-19.md", name: "2026-11-19.md", kind: "daily", mtime: mins(60 * 20), size: 900 },
];
const REPORT_BODY = "# Review of PR 412\n\nThe change is small and the tests cover it.\n\n| Area | Result | Note |\n| --- | --- | --- |\n| Tests | Pass | 41 new cases |\n| Rules | Warning | One rule needs review |\n\n- Check the cache key\n- Add a rollback test\n";

/* ---------- QA agent stand-in: realistic events, results and stored messages (names are made up) ---------- */
const QA_CASE_BANK: Json[] = [
  { title: "Bulk discount applies at the tier boundary", type: "functional", priority: "P0", cites: ["src/quotes/total.ts"], pre: ["A quote with 49 units of one item", "The bulk tier starts at 50 units"], steps: ["Open the quote and set the quantity to 49", "Note the line total", "Raise the quantity to 50", "Compare the new line total with the tier price"], exp: ["At 49 units the full price is used", "At 50 units the tier price applies to every unit, not only the extra one"], data: "Item with price 12.00, tier price 10.50", auto: true, journey: "quote-total" },
  { title: "Discount never makes a line total negative", type: "negative", priority: "P0", cites: ["src/quotes/total.ts"], pre: ["A quote with one item"], steps: ["Enter a fixed discount larger than the line total", "Read the line total and the quote total"], exp: ["The line total stops at 0.00", "The quote total is not below 0.00"], auto: true },
  { title: "Quote total is the same after save and reopen", type: "regression", priority: "P0", cites: ["src/quotes/total.ts", "src/quotes/store.ts"], pre: ["A saved quote with a bulk discount"], steps: ["Save the quote", "Close it", "Reopen it from the list"], exp: ["Every line total and the quote total match what was shown before saving"], auto: true, journey: "quote-reopen" },
  { title: "Rounding follows the company setting", type: "data", priority: "P1", cites: ["src/quotes/rounding.ts"], pre: ["Rounding set to 2 decimals", "Rounding set to whole units"], steps: ["Create a line of 3 units at 3.333", "Switch the rounding setting", "Compare the totals"], exp: ["Each setting rounds once, at the quote total, not per line"], data: "3 x 3.333 = 9.999" },
  { title: "Discount column fits at 800 px wide", type: "accessibility", priority: "P1", cites: ["src/ui/QuoteTable.tsx"], pre: ["The app window is 800 px wide"], steps: ["Open a quote with five lines", "Tab through the discount cells", "Zoom the text to 200 percent"], exp: ["No sideways scrolling", "Focus is always visible", "Every discount value has a text label, not only a colour"] },
  { title: "A discount is read back by a screen reader", type: "accessibility", priority: "P2", cites: ["src/ui/QuoteTable.tsx"], pre: ["A screen reader is running"], steps: ["Move to a discounted line", "Listen to what is read"], exp: ["The reader says the original price, the discount and the final price"] },
  { title: "Two people edit the same quote", type: "edge", priority: "P1", cites: ["src/quotes/store.ts"], pre: ["The same quote is open in two windows"], steps: ["Change the quantity in window A and save", "Change the discount in window B and save"], exp: ["The second save is refused with a plain message", "Neither person loses their change without being told"] },
  { title: "Old quotes without a tier still open", type: "compat", priority: "P1", cites: ["src/quotes/migrate.ts"], pre: ["A quote saved before the tier field existed"], steps: ["Open the old quote", "Add a line that reaches a tier"], exp: ["The quote opens with its old totals", "The new line gets the tier price"] },
  { title: "Tier lookup stays fast on a 500 line quote", type: "performance", priority: "P2", cites: ["src/quotes/total.ts"], pre: ["A quote with 500 lines"], steps: ["Change one quantity", "Time how long the total takes to update"], exp: ["The total updates in under 200 ms"] },
  { title: "A staff member without price rights cannot edit tiers", type: "security", priority: "P0", cites: ["src/quotes/permissions.ts"], pre: ["A staff login without the price permission"], steps: ["Open the tier settings", "Try to change a tier price by calling the save action"], exp: ["The tier settings are read-only", "The save is refused and nothing is written"], auto: true },
  { title: "Tier price is shown, not guessed, when the price list is empty", type: "negative", priority: "P1", cites: ["src/quotes/total.ts"], pre: ["A product with no price in the price list"], steps: ["Add the product to a quote"], exp: ["The line shows 'Price needed' and the quote cannot be saved", "No price is invented"] },
  { title: "Exported quote shows the discount line", type: "functional", priority: "P2", cites: ["src/export/pdf.ts"], pre: ["A quote with a bulk discount"], steps: ["Export the quote as PDF", "Open the PDF"], exp: ["The discount appears as its own line with the tier name"] },
  { title: "Undo restores the previous tier price", type: "edge", priority: "P2", cites: ["src/quotes/total.ts", "src/ui/QuoteTable.tsx"], pre: ["A quote with two edits made"], steps: ["Press Ctrl+Z twice"], exp: ["Quantity and price return to the first state", "The total matches the first state"] },
];

function qaCases(n: number): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < n; i++) {
    const b = QA_CASE_BANK[i % QA_CASE_BANK.length]!;
    const round = Math.floor(i / QA_CASE_BANK.length);
    out.push({ id: `TC-${String(i + 1).padStart(2, "0")}`, title: round ? `${b["title"]} (variation ${round + 1})` : b["title"], type: b["type"], priority: b["priority"], cites: b["cites"], preconditions: b["pre"], steps: b["steps"], expected: b["exp"], ...(b["data"] ? { data: b["data"] } : {}), automatable: !!b["auto"], ...(b["journey"] ? { journeyId: b["journey"] } : {}) });
  }
  return out;
}

export interface QaOpts { cases?: number; offline?: boolean; journeys?: "runnable" | "blocked" | "none"; ran?: boolean; assumption?: boolean }
export function makeQaResult(o: QaOpts = {}): Json {
  const cases = qaCases(o.cases ?? 12);
  const jr = o.journeys ?? "runnable";
  const runnable = jr === "runnable" ? [{ journeyId: "quote-total", title: "Add a line and check the quote total", specPath: "journeys/quote-total.spec.json", caseIds: ["TC-01"] }, { journeyId: "quote-reopen", title: "Save a quote, reopen it and compare totals", specPath: "journeys/quote-reopen.spec.json", caseIds: ["TC-03"] }] : [];
  const blocked = jr === "blocked" ? [{ journeyId: "quote-total", reason: "No generated spec exists for this journey yet" }, { journeyId: "quote-reopen", reason: "The running app could not be reached" }] : [];
  const result: Json = {
    version: 1, id: "qa-8f3a21", generatedAt: new Date(Date.now() - 4 * 60000).toISOString(), department: { id: "spil-aura", name: "SPIL AURA" }, request: "Can you QA it",
    summary: "The change adds a bulk discount to the quote total. The money maths and the saved totals are the main risk: a wrong tier boundary changes every price a customer sees. The screen change is a new discount column in the quote table.",
    assumption: o.assumption === false ? null : "I assumed the latest change in orders-app: Add bulk discount rule to the quote total",
    correction: o.assumption === false ? null : "If you meant something else, say so: for example QA PR 123, or QA the last 3 commits.",
    target: { kind: "latest", label: "Latest change in orders-app: Add bulk discount rule to the quote total", fromConversation: false, description: null, pr: null, repos: [{ repo: "orders-app", range: "a1b2c3d..e4f5a6b", commits: 3, firstCommit: "a1b2c3d", baseSha: "a1b2c3d", headSha: "e4f5a6b" }], skipped: [] },
    risk: { level: o.offline ? "medium" : "high", reasons: ["The change edits the quote total, which every order price depends on", "No test file changed with the maths", "6 files changed across the quotes, the table and the export", "The discount column changes a screen people use all day"] },
    areas: [
      { name: "Quote total maths", why: "Tier boundary and rounding decide every price.", risk: "high" },
      { name: "Quote table screen", why: "A new column in a dense table.", risk: "medium" },
      { name: "Saved quotes", why: "Old quotes must open with the same totals.", risk: "medium" },
      { name: "PDF export", why: "The discount needs its own line.", risk: "low" },
      { name: "Permissions", why: "Tier prices must stay behind the price right.", risk: "medium" },
    ],
    cases, regressionChecklist: ["An old quote opens with the same total", "A quote with no discount is unchanged", "Copy a quote: the copy has the same discount", "PDF export still opens", "The quote list still sorts by date", "Search by customer still works", "Print preview shows every column", "Keyboard-only: create a quote without the mouse"],
    notCovered: ["Price-list import (not touched by this change)", "Customer-facing emails", "Load behaviour on the shared server"], questions: ["Should the tier price apply per item or per product family?", "Is a discount allowed on already-discounted promotions?"],
    evidence: { uiChange: true, needed: ["Real-app screenshots at 800, 1100 and 1440 px of the quote table, live and finished", "A walkthrough video of creating a discounted quote", "Name the environment and the database you tested on", "Test database only: nothing is saved to production or the ERP"] },
    checkCommands: [{ command: "cargo test -p agent-core --lib", source: "rules: aura-checks", approved: true }, { command: "npx vitest run --maxWorkers=1", source: "rules: aura-checks", approved: true }, { command: "git diff --check", source: "rules: aura-checks", approved: false }],
    journeys: { available: 2, offer: { runnable, blocked, targetReachable: jr === "runnable" ? true : jr === "blocked" ? false : null, note: jr === "blocked" ? "No app with a debugging port was found, so no journey can run." : jr === "runnable" ? "A running app was found." : "", safety: { checked: jr === "none" ? 0 : 2, passed: jr === "none" ? 0 : jr === "blocked" ? 0 : 2 } } },
    run: o.ran ? { status: "failed", runs: [{ journeyId: "quote-total", status: "passed", reportPath: null, defects: 0, blocker: null }, { journeyId: "quote-reopen", status: "failed", reportPath: "qa/runs/journey-quote-reopen.md", defects: 1, blocker: null }], defects: [{ journeyId: "quote-reopen", step: "Compare the reopened total", width: 800, expected: "Total 1,284.50 after reopening", actual: "Total 1,311.00 after reopening", screenshot: ".artifacts/qa/quote-reopen-800.png" }], proposedIncidents: 1 } : null,
    context: { files: 6, areas: 5, commits: 3, dependents: 14, coChange: 2, notes: 4, journeys: 2, hasDiff: true, hasGraph: true, changedFiles: [{ repo: "orders-app", path: "src/quotes/total.ts", category: "logic" }, { repo: "orders-app", path: "src/quotes/rounding.ts", category: "logic" }, { repo: "orders-app", path: "src/ui/QuoteTable.tsx", category: "ui" }, { repo: "orders-app", path: "src/export/pdf.ts", category: "api" }, { repo: "orders-app", path: "src/quotes/permissions.ts", category: "config" }, { repo: "orders-app", path: "src/quotes/migrate.ts", category: "data" }] },
    artifacts: { markdownPath: "D:\\guard\\data\\qa\\runs\\2026-11-20-qa-8f3a21.md", jsonPath: "D:\\guard\\data\\qa\\runs\\2026-11-20-qa-8f3a21.json" },
    modelUsed: !o.offline, modelNote: o.offline ? "No model was ready, so the plan comes from the case templates for each kind of file. Connect a model in Model & keys for a plan written for this change." : "", backend: o.offline ? null : "Claude plan", timings: { designSeconds: o.offline ? 0 : 42, totalSeconds: o.offline ? 3 : 47 },
  };
  return result;
}

const qaTrace = (o: { offline?: boolean; ran?: boolean; assumption?: boolean } = {}): Json[] => {
  const s = (id: string, label: string, ms: number, detail?: string): Json => ({ id, kind: id, status: "done", label, ms, ...(detail ? { detail } : {}), agent: "qa" });
  const t: Json[] = [s("understand", "Understood: you want QA on a change", 3, "Reading your request as: Can you QA it"), s("target", o.assumption === false ? "Target: Latest change in orders-app" : "Assumed: Latest change in orders-app", 61, o.assumption === false ? "orders-app a1b2c3d..e4f5a6b" : "I assumed the latest change in orders-app: Add bulk discount rule to the quote total"), s("context", "Read 6 changed files in 5 areas", 380, "3 commits, 14 dependents, 4 related notes"), s("design", o.offline ? "Designed 12 tests from templates" : "Designed 12 tests", o.offline ? 40 : 42000, o.offline ? "No model was used" : "Claude plan"), s("safety", "Safety check: 2 of 2 specs passed", 90), s("report", "QA result saved", 30)];
  if (o.ran) t.splice(5, 0, s("run", "Journey run failed: 2 run, 1 defect", 5200));
  return t;
};
const qaMarkdown = (r: Json): string => `# QA result: ${r["target"].label}\n\nRisk: ${r["risk"].level}. ${r["summary"]}\n\n## Test cases\n\n${(r["cases"] as Json[]).map((c) => `- ${c["id"]} ${c["priority"]} ${c["title"]}`).join("\n")}\n`;
const NEEDS_INPUT = { question: "I could not tell what to QA. Which change do you mean?", options: [{ id: "latest-orders-app", label: "Latest change in orders-app", value: "QA the latest change in orders-app" }, { id: "latest-cut-planner", label: "Latest change in cut-planner", value: "QA the latest change in cut-planner" }, { id: "pr", label: "A pull request by number", value: "QA PR " }] };

function seedQaChats(): Json[] {
  const full = makeQaResult({});
  const offline = makeQaResult({ offline: true, journeys: "blocked", cases: 6 });
  const mk = (id: string, title: string, ago: number, messages: Json[]): Json => ({ id, title, updated: mins(ago), messages });
  return [
    mk("c0000000020", "QA the latest change", 4, [
      { role: "user", text: "Can you QA it", ts: mins(5) },
      { role: "assistant", text: qaMarkdown(full), ts: mins(4), sources: [], trace: qaTrace(), qa: full },
    ]),
    mk("c0000000021", "QA", 8, [
      { role: "user", text: "QA", ts: mins(9) },
      { role: "assistant", text: "QA needs one answer before I start\n\n" + NEEDS_INPUT.question, ts: mins(8), sources: [], trace: qaTrace().slice(0, 2), needsInput: NEEDS_INPUT },
    ]),
    mk("c0000000022", "QA offline plan", 12, [
      { role: "user", text: "QA the offline plan", ts: mins(13) },
      { role: "assistant", text: qaMarkdown(offline), ts: mins(12), sources: [], trace: qaTrace({ offline: true }), qa: offline },
    ]),
  ];
}

const sleep = (n: number): Promise<void> => new Promise((r) => setTimeout(r, n));
const qaRequested = (q: string, body: Json): boolean => body["runJourneys"] === true || body["mode"] === "qa" || /\bqa\b|test cases|test plan/i.test(q);

/** Streams one QA turn the way the real server does and stores the assistant message in the chat. */
async function qaRun(c: Json, q: string, body: Json, w: (o: Json) => void): Promise<void> {
  const pace = Number(process.env["STUB_QA_STEP_MS"] ?? 320);
  const slow = /slow/i.test(q);
  const stepEv = (s: Json): void => w({ type: "step", step: s });
  const done = (s: Json): Json => ({ ...s, status: "done" });
  const flow = (id: string, label: string, ms: number, detail?: string): Json => ({ id, kind: id, status: "running", label, agent: "qa", ...(detail ? { detail } : {}), ms });
  w({ type: "agent", agent: "qa", label: "QA agent", state: "started" });
  const offline = /offline/i.test(q);
  const ran = body["runJourneys"] === true;
  const trace = qaTrace({ offline, ran, assumption: !/named/i.test(q) });
  const finishError = (message: string, kind: string): void => {
    const m: Json = { role: "assistant", text: message, ts: new Date().toISOString(), error: true, sources: [], trace: trace.slice(0, 2) };
    c.messages.push(m);
    w({ type: "agent", agent: "qa", label: "QA agent", state: "error" });
    w({ type: "error", message, kind, chat: c });
  };
  stepEv(flow("understand", "Reading your request", 0));
  await sleep(pace / 2);
  stepEv(trace[0]!);
  if (/secret/i.test(q)) return finishError("Your message looks like it contains a secret (HIGH_ENTROPY x2). Nothing was read and nothing was sent. Remove it and ask again.", "blocked");
  if (/^\s*qa\s*[.?!]?\s*$/i.test(q) || /needs input/i.test(q)) {
    stepEv(flow("target", "Working out what to QA", 0));
    await sleep(pace);
    stepEv({ ...trace[1]!, label: "Need to know what to QA", detail: NEEDS_INPUT.question });
    c.messages.push({ role: "assistant", text: "QA needs one answer before I start\n\n" + NEEDS_INPUT.question, ts: new Date().toISOString(), sources: [], trace: trace.slice(0, 2), needsInput: NEEDS_INPUT });
    w({ type: "agent", agent: "qa", label: "QA agent", state: "done" });
    w({ type: "needs-input", ...NEEDS_INPUT });
    w({ type: "answer", text: "QA needs one answer before I start\n\n" + NEEDS_INPUT.question, sources: [], chat: c });
    return;
  }
  stepEv(flow("target", "Working out what to QA", 0));
  await sleep(pace);
  stepEv(trace[1]!);
  stepEv(flow("context", "Reading the change", 0));
  await sleep(pace);
  stepEv(trace[2]!);
  stepEv(flow("design", offline ? "Designing the tests from templates" : "Asking Claude plan to design the tests", 0));
  await sleep(slow ? Number(process.env["STUB_QA_SLOW_MS"] ?? 60000) : offline ? pace : pace * 2);
  if (/boom|fail/i.test(q)) {
    stepEv({ ...flow("design", "The model did not answer in time", 0), status: "error", ms: 90000 });
    return finishError("The QA agent could not finish: the model did not answer in time. Nothing was changed. Try again, or ask for an offline plan.", "qa");
  }
  stepEv(trace[3]!);
  const result = makeQaResult({ offline, ran, cases: /60 cases|many/i.test(q) ? 60 : /few|six/i.test(q) ? 6 : 12, journeys: /no journeys/i.test(q) ? "none" : /blocked/i.test(q) || offline ? "blocked" : "runnable", assumption: !/named/i.test(q) });
  if (!ran) {
    stepEv(flow("safety", "Checking journey specs with the safety checker", 0));
    await sleep(pace / 2);
    stepEv(trace[4]!);
  } else {
    stepEv(flow("run", "Running 2 read-only journeys", 0));
    await sleep(pace * 3);
    stepEv(trace[5]!);
  }
  stepEv(flow("report", "Writing the QA result", 0));
  await sleep(pace / 2);
  stepEv(trace[trace.length - 1]!);
  const text = qaMarkdown(result);
  c.messages.push({ role: "assistant", text, ts: new Date().toISOString(), sources: [], trace, qa: result });
  w({ type: "agent", agent: "qa", label: "QA agent", state: "done" });
  w({ type: "qa", result });
  w({ type: "answer", text, sources: [], chat: c });
  void done;
}

/** Model & key settings stand-in. Flags can be set at start (opts.brain) or later with POST /stub/brain. */
export interface BrainStub {
  backend: string; models: Json; storedKey: string | null; envKey: boolean; envBackend: boolean; envModel: boolean;
  noStore: boolean; planFound: boolean; testMode: "ok" | "slow" | "fail"; testRunning: boolean; latencyMs: number; failLoad: boolean; failSave: boolean;
}
const CATALOGUE: Json[] = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Balanced speed, quality and cost. The default.", backends: ["anthropic-api"], default: true },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Most capable. Slower and costs more.", backends: ["anthropic-api"] },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Fastest and cheapest. Good for short, simple jobs.", backends: ["anthropic-api"] },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2", note: "Another Anthropic model line. Use it if your key can access it.", backends: ["anthropic-api"] },
  { id: "sonnet", label: "Sonnet (plan)", note: "Balanced. The default for the Claude plan.", backends: ["claude-cli"], default: true },
  { id: "opus", label: "Opus (plan)", note: "Most capable. Slower, and uses more of your plan allowance.", backends: ["claude-cli"] },
  { id: "haiku", label: "Haiku (plan)", note: "Fastest, and uses the least of your plan allowance.", backends: ["claude-cli"] },
];
const BRAIN_DEFAULTS: Record<string, string> = { "anthropic-api": "claude-sonnet-5-5", "claude-cli": "sonnet" };
const BRAIN_LABELS: Record<string, string> = { "anthropic-api": "Anthropic API key", "claude-cli": "Claude plan (Claude Code)" };
const MODEL_OK = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export interface Seen { method: string; url: string; body: Json }
export interface StubHandle { server: Server; url: string; brain: BrainStub; seen: Seen[]; project: Json; close: () => Promise<void> }

const SUGGESTIONS = [
  { id: "overview", title: "How is SPIL AURA put together?", hint: "Its parts and what each one does", text: "How is SPIL AURA put together?" },
  { id: "recent", title: "What changed recently?", hint: "Latest commits and notes", text: "What changed recently?" },
  { id: "review", title: "What needs my review?", hint: "Proposed notes waiting in the inbox", text: "What needs my review?" },
  { id: "unapproved", title: "Which notes are still unapproved?", hint: "Drafts the answers handle with care", text: "Which notes are still unapproved?" },
];
function seedProject(): Json {
  return {
    productName: "SPIL AURA QA Bot", productShort: "AURA QA",
    repos: [
      { id: "aura-app", label: "aura-app", branch: "development", lastCommitAt: mins(60 * 26), indexedAt: mins(8), commits: 560 },
      { id: "erp-mcp", label: "erp-mcp-servers", branch: "main", lastCommitAt: mins(60 * 24 * 3), indexedAt: mins(8), commits: 252 },
    ],
    index: { indexedAt: mins(8), commits: 812, files: 2140, notes: 64 },
    vault: { notes: 64, active: 51, proposed: 13, stale: 2, problems: 0 },
    inbox: { pending: 5 },
    lastDaily: mins(60 * 20),
  };
}

export interface StubOpts { port?: number; empty?: boolean; qa?: boolean; brain?: Partial<BrainStub>; failSuggestions?: boolean; failProject?: boolean; staleIndex?: boolean; neverIndexed?: boolean }
export function startStub(opts: StubOpts = {}): Promise<StubHandle> {
  const brain: BrainStub = { backend: "auto", models: {}, storedKey: null, envKey: false, envBackend: false, envModel: false, noStore: false, planFound: true, testMode: "ok", testRunning: false, latencyMs: 0, failLoad: false, failSave: false, ...opts.brain };
  const brainView = (): Json => {
    const key = brain.envKey ? "env" : brain.storedKey ? "stored" : null;
    const want = brain.envBackend ? "claude-cli" : brain.backend;
    const picked = want === "claude-cli" ? (brain.planFound ? "claude-cli" : null) : want === "anthropic-api" ? (key ? "anthropic-api" : null) : key ? "anthropic-api" : brain.planFound ? "claude-cli" : null;
    const cur = (b: string): string => (brain.envModel && b === "anthropic-api" ? "claude-opus-5-5" : (brain.models[b] ?? BRAIN_DEFAULTS[b]!));
    const src = (b: string): string => (brain.envModel && b === "anthropic-api" ? "env" : brain.models[b] ? "settings" : "default");
    return {
      wanted: brain.envBackend ? "claude-cli" : brain.backend, wantedSource: brain.envBackend ? "env" : brain.backend === "auto" ? "default" : "settings", picked,
      reason: picked ? `AURA QA will use ${BRAIN_LABELS[picked]}.` : "No model is ready. Save an API key, or sign in to Claude Code.",
      backends: [
        { id: "auto", kind: "auto", label: "Automatic", available: !!picked, detail: picked ? "Picks the best one that is ready." : "Nothing is set up yet." },
        { id: "anthropic-api", kind: "api", label: BRAIN_LABELS["anthropic-api"], available: !!key, detail: key ? "An API key is available." : "No API key yet. Save one below." },
        { id: "claude-cli", kind: "cli", label: BRAIN_LABELS["claude-cli"], available: brain.planFound, detail: brain.planFound ? "Claude Code is installed and signed in." : "Claude Code was not found on this computer." },
      ],
      models: { current: { "anthropic-api": cur("anthropic-api"), "claude-cli": cur("claude-cli") }, sources: { "anthropic-api": src("anthropic-api"), "claude-cli": src("claude-cli") }, catalogue: CATALOGUE },
      apiKey: { source: key, storage: brain.noStore ? null : "dpapi", canStore: !brain.noStore },
      planCli: brain.planFound ? { found: true, version: "2.1.8 (Claude Code)", path: "claude" } : { found: false, help: "Install Claude Code, run claude once in a terminal and sign in. Then Guard can use your Claude plan." },
    };
  };
  let chats: Json[] = opts.empty ? [] : opts.qa ? [...seedChats(), ...seedQaChats()] : seedChats();
  const project = seedProject();
  if (opts.staleIndex) { project["index"].indexedAt = mins(60 * 24 * 12); for (const r of project["repos"]) r.indexedAt = mins(60 * 24 * 12); }
  if (opts.neverIndexed) { project["index"] = { indexedAt: null, commits: 0, files: 0, notes: 0 }; project["repos"] = project["repos"].map((r: Json) => ({ ...r, indexedAt: null, commits: 0 })); project["vault"] = { notes: 0, active: 0, proposed: 0, stale: 0, problems: 0 }; }
  const seen: Seen[] = [];
  const mockCmd = (): string[] => ["Reading commits...", "Indexing 812 commits", "Indexing 2140 files", "Index built."];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    const send = (code: number, body: unknown): void => {
      const s = JSON.stringify(body);
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(s);
    };
    let body: Json = {};
    if (method !== "GET") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Json; } catch { body = {}; }
    }
    const p = url.pathname;
    if (p.startsWith("/api/") || p.startsWith("/stub/")) seen.push({ method, url: p + url.search, body });
    if (!p.startsWith("/api/")) {
      const file = p === "/" ? "index.html" : p.slice(1);
      try {
        const data = readFileSync(join(uiDir, file));
        res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
        return void res.end(data);
      } catch {
        res.writeHead(404);
        return void res.end();
      }
    }
    if (p === "/stub/brain" && method === "POST") { Object.assign(brain, body); return send(200, { ok: true }); }
    if (p === "/api/brain" || p.startsWith("/api/brain/")) {
      res.setHeader("Cache-Control", "no-store");
      if (brain.latencyMs) await new Promise((r) => setTimeout(r, brain.latencyMs));
      if (p === "/api/brain" && method === "GET") return brain.failLoad ? send(500, { error: "Something went wrong with the model settings." }) : send(200, brainView());
      if (p === "/api/brain" && method === "PUT") {
        if (brain.failSave) return send(500, { error: "Something went wrong with the model settings." });
        for (const k of Object.keys(body)) if (k !== "backend" && k !== "models") return send(400, { error: `Unknown field "${k.slice(0, 40)}".` });
        if (body["backend"] !== undefined) {
          if (!["auto", "anthropic-api", "claude-cli"].includes(String(body["backend"]))) return send(400, { error: "Unknown way of answering." });
          brain.backend = String(body["backend"]);
        }
        for (const [b, v] of Object.entries((body["models"] ?? {}) as Json)) {
          if (b !== "anthropic-api" && b !== "claude-cli") return send(400, { error: "Unknown way of answering." });
          if (v === null) delete brain.models[b];
          else if (typeof v !== "string" || !MODEL_OK.test(v)) return send(400, { error: "That model name is not valid. Use letters, digits and . _ : - only." });
          else brain.models[b] = v;
        }
        return send(200, brainView());
      }
      if (p === "/api/brain/key" && method === "PUT") {
        const k = body["key"];
        if (typeof k !== "string" || k.length < 20 || k.length > 300 || /\s/.test(k)) return send(400, { error: "That does not look like an API key." });
        if (brain.noStore) return send(400, { error: "This computer has no secure place to keep a key." });
        brain.storedKey = k;
        return send(200, brain.envKey ? { ok: true, source: "env", stored: true, message: "Saved. The ANTHROPIC_API_KEY environment variable is set and is used instead of the saved key." } : { ok: true, source: "stored", stored: true });
      }
      if (p === "/api/brain/key" && method === "DELETE") { brain.storedKey = null; return send(200, { ok: true, source: brain.envKey ? "env" : null, stored: false }); }
      if (p === "/api/brain/test" && method === "POST") {
        if (brain.testRunning) return send(409, { error: "A test is already running." });
        brain.testRunning = true;
        try {
          const v = brainView();
          await new Promise((r) => setTimeout(r, brain.testMode === "slow" ? 2500 : 300));
          const b = v["picked"] as string | null;
          const model = b ? (v["models"] as Json)["current"][b] : "";
          if (brain.testMode === "fail" || !b) return send(200, { ok: false, backend: b, model, ms: 1180, error: b === "anthropic-api" ? "Anthropic refused the key (401). Check that it is correct and still active." : "No model is ready." });
          return send(200, { ok: true, backend: b, model, ms: 1420 });
        } finally { brain.testRunning = false; }
      }
      return send(404, { error: "Not found." });
    }
    if (p === "/api/overview") {
      const perDay = Array.from({ length: 30 }, (_, i) => ({ day: dayStr(29 - i), n: [0, 2, 5, 3, 1, 0, 0, 4, 6, 2][i % 10]! }));
      return send(200, {
        commitsPerDay: perDay,
        recentCommits: [
          { ref: "aura-app@a1b2c3d", title: "Check prices before saving", repo: "aura-app", date: iso(0) },
          { ref: "aura-app@b2c3d4e", title: "Match shapes with a timeout", repo: "aura-app", date: iso(1) },
          { ref: "erp-mcp@c3d4e5f", title: "Add a read-only price lookup", repo: "erp-mcp", date: iso(2) },
        ],
        recentNotes: [
          { ref: "note:order-flow", title: "Order flow overview", status: "active", type: "adr", date: dayStr(2) },
          { ref: "note:saving-rules", title: "Saving rules", status: "proposed", type: "rule", date: dayStr(3) },
        ],
        noteTypes: [{ type: "rule", n: 31 }, { type: "adr", n: 14 }, { type: "pattern", n: 9 }],
        inbox: { total: 5, groups: [{ type: "rule", count: 2 }, { type: "pattern", count: 3 }] },
        qa: { totalRuns: 3, passRate: 88, totalDefects: 2, passSeries: [70, 82, 90, 88], recent: [
          { id: "r3", generatedAt: iso(0), request: "QA the latest change", riskLevel: "medium", passRate: 88, defects: 1, seconds: 41.2 },
          { id: "r2", generatedAt: iso(1), request: "QA offline plan", riskLevel: "low", passRate: null, defects: 0, seconds: 3.4 },
        ] },
      });
    }
    if (p === "/api/search") return send(200, { hits: /order/i.test(url.searchParams.get("q") ?? "") ? [{ kind: "note", ref: "note:order-flow", title: "Order flow overview", status: "active" }, { kind: "commit", ref: "aura-app@a1b2c3d", title: "Check prices before saving", status: null }] : [] });
    if (p === "/api/project") return opts.failProject ? send(500, { error: "No project facts." }) : send(200, project);
    if (p === "/api/suggestions") return opts.failSuggestions ? send(500, { error: "No suggestions." }) : send(200, { suggestions: SUGGESTIONS });
    if (p === "/api/status") return send(200, { index: project["index"].indexedAt ? { note: 64, commit: 812, file: 2140 } : null, vault: { notes: project["vault"].notes, problems: 0 }, backend: { wanted: "auto", picked: "claude-cli", label: "Claude plan" }, running: null });
    if (p === "/api/commands") return send(200, { commands: [{ name: "index", usage: "/index", help: "Rebuild the search index", available: true }, { name: "check", usage: "/check", help: "Check the vault notes for problems", available: true }, { name: "stale", usage: "/stale", help: "List notes that may be out of date", available: true }, { name: "qa", usage: "/qa plan <topic>", help: "Write a QA plan for a topic", available: true }, { name: "review", usage: "/review <pr>", help: "Review a pull request", available: false }] });
    const chatM = /^\/api\/chats\/([^/]+)(\/ask)?$/.exec(p);
    if (p === "/api/chats" && method === "GET") return send(200, { chats: chats.map(({ messages: _m, ...c }) => c) });
    if (p === "/api/chats" && method === "POST") {
      const c: Json = { id: "n" + String(chats.length + 1).padStart(11, "0"), title: "New chat", updated: new Date().toISOString(), messages: [] };
      chats.unshift(c);
      return send(201, c);
    }
    if (chatM && !chatM[2] && method === "GET") {
      const c = chats.find((x) => x.id === chatM[1]);
      return c ? send(200, c) : send(404, { error: "No such chat." });
    }
    if (chatM && !chatM[2] && method === "DELETE") { chats = chats.filter((x) => x.id !== chatM[1]); return send(200, { ok: true }); }
    if (chatM && chatM[2] && method === "POST") {
      const c = chats.find((x) => x.id === chatM[1]);
      if (!c) return send(404, { error: "No such chat." });
      const q = String(body["question"] ?? "");
      c.messages.push({ role: "user", text: q, ts: new Date().toISOString() });
      if (c.title === "New chat") c.title = q;
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
      const w = (o: Json): void => void res.write(JSON.stringify(o) + "\n");
      if (qaRequested(q, body)) {
        if (c.title === "New chat") c.title = q;
        await qaRun(c, q, body, w);
        return void res.end();
      }
      w({ type: "step", step: { id: "search", kind: "search", status: "running", label: "Searching notes, commits and files" } });
      await new Promise((r) => setTimeout(r, /slow/.test(q) ? 60000 : 400));
      w({ type: "step", step: { id: "search", kind: "search", status: "done", label: "Searched notes, commits and files", ms: 410 } });
      if (/secret/.test(q)) {
        const message = "Your message looks like it contains a secret (HIGH_ENTROPY x2). Nothing was sent. Remove it and ask again.";
        c.messages.push({ role: "assistant", text: message, ts: new Date().toISOString(), error: true, trace: TRACE.slice(0, 2) });
        w({ type: "error", message, chat: c });
      } else {
        c.messages.push({ role: "assistant", text: ANSWER, ts: new Date().toISOString(), sources: SOURCES, trace: TRACE });
        w({ type: "answer", text: ANSWER, sources: SOURCES, chat: c });
      }
      return void res.end();
    }
    if (p === "/api/feedback") return send(200, { ok: true });
    if (p === "/api/inbox") return send(200, INBOX);
    if (p === "/api/reports") return send(200, { reports: REPORTS });
    if (p === "/api/report") return send(200, { path: url.searchParams.get("path"), name: "pr-412.md", text: REPORT_BODY, body: REPORT_BODY });
    if (p === "/api/command" && method === "POST") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
      res.write(JSON.stringify({ type: "started", command: "/index" }) + "\n");
      for (const line of mockCmd()) {
        await new Promise((r) => setTimeout(r, 120));
        res.write(JSON.stringify({ type: "output", chunk: line + "\n" }) + "\n");
      }
      project["index"].indexedAt = new Date().toISOString();
      for (const r of project["repos"]) r.indexedAt = project["index"].indexedAt;
      res.write(JSON.stringify({ type: "done", ok: true, code: 0, command: "/index", chat: null }) + "\n");
      return void res.end();
    }
    send(404, { error: "Not found." });
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, brain, seen, project, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const h = await startStub({ port: Number(process.argv[2] ?? 4700), empty: process.argv[3] === "empty", qa: process.argv[3] === "qa", staleIndex: process.argv[3] === "stale", neverIndexed: process.argv[3] === "never", failSuggestions: process.argv[3] === "nosuggest", brain: process.argv[4] ? (JSON.parse(process.argv[4]) as Partial<BrainStub>) : {} });
  console.log(h.url);
}
