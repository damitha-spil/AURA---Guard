// The QA agent screen: pure helpers (qa.js) and the stub's QA stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeQaResult, startStub } from "./ui-stub-server.ts";

const uiDir = join(import.meta.dirname, "..", "..", "ui");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const qa = (await import(pathToFileURL(join(uiDir, "qa.js")).href)) as Any;

test("cases group by priority, P0 first, order kept", () => {
  const r = qa.safeResult(makeQaResult({ cases: 12 }));
  const g = qa.groupByPriority(r.cases);
  assert.deepEqual(g.map((x: Any) => x.priority), ["P0", "P1", "P2"]);
  assert.equal(g.reduce((n: number, x: Any) => n + x.cases.length, 0), 12);
  assert.ok(g[0].cases.every((c: Any) => c.priority === "P0"));
  assert.deepEqual(qa.groupByPriority([]), []);
});

test("filters by priority and type; counts never lead to an empty chip", () => {
  const r = qa.safeResult(makeQaResult({ cases: 12 }));
  assert.equal(qa.filterCases(r.cases, { priority: "P0" }).length, qa.priorityCounts(r.cases).P0);
  assert.equal(qa.filterCases(r.cases, { priority: "all", type: "all" }).length, 12);
  for (const t of qa.typeCounts(r.cases, "P0")) assert.ok(qa.filterCases(r.cases, { priority: "P0", type: t.type }).length === t.count && t.count > 0);
  assert.equal(qa.caseCountText(3, 12), "3 of 12 cases");
});

test("risk is named in words with an icon", () => {
  assert.deepEqual([qa.riskInfo("high").label, qa.riskInfo("medium").label, qa.riskInfo("low").label], ["High risk", "Medium risk", "Low risk"]);
  assert.equal(qa.riskInfo("nonsense").level, "low");
  assert.notEqual(qa.riskInfo("high").icon, qa.riskInfo("low").icon);
});

test("markdown export escapes pipes, backticks and html", () => {
  const raw = makeQaResult({});
  raw["cases"][0].title = "Pipe | and `tick` <b>x</b>";
  raw["cases"][0].cites = ["a`b.ts"];
  const md: string = qa.toMarkdown(raw, [true]);
  assert.match(md, /^# QA result: /);
  assert.ok(md.includes("Pipe \\| and \\`tick\\` \\<b\\>x\\</b\\>"));
  assert.ok(md.includes("``a`b.ts``"));
  assert.ok(md.includes("- [x] An old quote opens"));
  assert.ok(md.includes("- [ ] A quote with no discount"));
  const row = md.split("\n").find((l) => l.startsWith("| TC-01"))!;
  assert.equal(row.replace(/\\\|/g, "").split("|").length, 6);
  assert.ok(qa.mdCode("a``b").startsWith("```"));
});

test("a chip sends its value, or fills the box when it ends in a space", () => {
  assert.deepEqual(qa.chipAction({ value: "QA the latest change in x" }), { action: "send", text: "QA the latest change in x" });
  assert.deepEqual(qa.chipAction({ value: "QA PR " }), { action: "fill", text: "QA PR " });
  assert.equal(qa.chipAction({ value: "  " }).action, "none");
  assert.deepEqual(qa.usedChip({ options: [{ id: "a", value: "QA x" }] }, "QA x"), { used: true, chosen: "a" });
  assert.deepEqual(qa.usedChip({ options: [{ id: "a", value: "QA x" }] }, "other"), { used: true, chosen: null });
  assert.equal(qa.usedChip({ options: [] }, null).used, false);
});

class Mem {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
}
test("checklist is remembered per result and survives a throwing storage", () => {
  const s = new Mem();
  assert.equal(qa.saveChecklist(s, "r1", [true, false, true]), true);
  assert.deepEqual(qa.loadChecklist(s, "r1", 4), [true, false, true, false]);
  assert.deepEqual(qa.loadChecklist(s, "r2", 2), [false, false]);
  const bad = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(qa.loadChecklist(bad, "r1", 2), [false, false]);
  assert.equal(qa.saveChecklist(bad, "r1", [true]), false);
  assert.deepEqual(qa.loadChecklist(null, "r1", 1), [false]);
  s.setItem(qa.checklistKey("r3"), "{not json");
  assert.deepEqual(qa.loadChecklist(s, "r3", 1), [false]);
});

test("event reducer: a full run, needs-input and an error", () => {
  let s = qa.qaInitial();
  const ev = (o: Any) => (s = qa.reduceQaEvent(s, o, 1000));
  ev({ type: "step", step: { id: "x", kind: "search", status: "running", label: "normal" } });
  assert.equal(s.active, false, "a normal step is not QA");
  ev({ type: "agent", agent: "qa", label: "QA agent", state: "started" });
  ev({ type: "step", step: { id: "target", status: "running", label: "t", agent: "qa" } });
  ev({ type: "step", step: { id: "target", status: "done", label: "t", detail: "I assumed", agent: "qa" } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].status, "done");
  ev({ type: "qa", result: { id: "r" } });
  ev({ type: "agent", agent: "qa", state: "done" });
  ev({ type: "answer", text: "# QA result", sources: [], chat: { id: "c" } });
  assert.equal(s.agentState, "done");
  assert.equal(s.result.id, "r");
  assert.equal(s.answer, "# QA result");
  s = qa.qaInitial();
  ev({ type: "agent", agent: "qa", state: "started" });
  ev({ type: "needs-input", question: "Which?", options: [{ id: "a", label: "A", value: "QA PR " }, { id: "b", label: "", value: "x" }] });
  assert.equal(s.needsInput.options.length, 1);
  s = qa.qaInitial();
  ev({ type: "agent", agent: "qa", state: "started" });
  ev({ type: "agent", agent: "qa", state: "error" });
  ev({ type: "error", message: "boom", kind: "qa", chat: { id: "c" } });
  assert.equal(s.agentState, "error");
  assert.equal(s.error, "boom");
  assert.equal(s.errorKind, "qa");
  assert.equal(qa.qaErrorInfo("x", "blocked").retry, false);
  const j = qa.qaFromJson({ ok: true, agent: "qa", text: "t", trace: [{ id: "report", status: "done", label: "r" }], qa: { id: "q" }, chat: null });
  assert.equal(j.result.id, "q");
  assert.equal(j.steps.length, 1);
});

test("/qa free text goes to the QA agent; sub-commands stay commands", () => {
  assert.deepEqual(qa.routeSlash("/qa this change"), { kind: "qa", text: "this change" });
  assert.deepEqual(qa.routeSlash("/QA PR 12"), { kind: "qa", text: "PR 12" });
  for (const c of ["/qa", "/qa status", "/qa plan orders", "/qa generate x", "/qa check", "/qa run j1", "/qa agent hi", "/index"]) assert.equal(qa.routeSlash(c).kind, "command", c);
  assert.equal(qa.routeSlash("Can you QA it").kind, "ask");
  assert.ok(qa.qaSlashItems("/qa", "Finance").some((i: Any) => /Finance/.test(i.help)));
  assert.deepEqual(qa.qaSlashItems("/qa PR", "X").map((i: Any) => i.name), ["qa-pr"]);
  assert.deepEqual(qa.qaSlashItems("/index", "X"), []);
});

test("hostile text stays text: nothing in qa.js builds HTML", async () => {
  const bad = "<img src=x onerror=alert(1)>";
  const raw = makeQaResult({});
  raw["summary"] = bad; raw["cases"][0].title = bad; raw["cases"][0].steps = [bad];
  const r = qa.safeResult(raw);
  assert.equal(r.summary, bad);
  assert.equal(r.cases[0].title, bad);
  const fs = await import("node:fs");
  for (const f of ["qa.js", "qa-view.js"]) {
    const src = fs.readFileSync(join(uiDir, f), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), `${f} must not write HTML`);
  }
  assert.ok(!/(^|[^\\])<img/.test(qa.toMarkdown(raw)), "html in the export is escaped");
});

test("a damaged result still reads; progress notes and report matching", () => {
  const r = qa.safeResult({ cases: [null, { priority: "P9", type: "x" }], risk: null, journeys: 5 });
  assert.equal(r.cases.length, 2);
  assert.equal(r.cases[1].priority, "P2");
  assert.equal(qa.progressNote("design", 3000), "");
  assert.match(qa.progressNote("design", 30000), /stop waiting/);
  assert.equal(qa.findReportPath("D:\\x\\qa\\runs\\d\\a.md", [{ path: "qa/runs/d/a.md" }, { path: "qa/other.md" }]), "qa/runs/d/a.md");
  assert.equal(qa.findReportPath("", []), null);
  assert.equal(qa.journeyState(makeQaResult({}), false).canRun, false);
  assert.equal(qa.journeyState(makeQaResult({}), true).canRun, true);
  assert.equal(qa.journeyState(makeQaResult({ journeys: "none" }), true).none, true);
  assert.equal(qa.journeyState(makeQaResult({ ran: true }), true).canRun, false);
  assert.deepEqual(qa.runBody(), { question: "Run the read-only journeys for this QA result", runJourneys: true });
});

test("the stub streams the QA contract (normal, needs-input, offline, error, run)", async () => {
  process.env["STUB_QA_STEP_MS"] = "5";
  const h = await startStub({ qa: true });
  try {
    const ask = async (question: string, extra: Record<string, unknown> = {}) => {
      const chat = (await (await fetch(h.url + "/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Any;
      const res = await fetch(`${h.url}/api/chats/${chat.id}/ask`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify({ question, ...extra }) });
      return (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Any);
    };
    const normal = await ask("Can you QA it");
    assert.equal(normal[0].agent, "qa");
    assert.deepEqual(normal.filter((e) => e.type === "step" && e.step.status === "done").map((e) => e.step.id), ["understand", "target", "context", "design", "safety", "report"]);
    assert.equal(normal.find((e) => e.type === "qa").result.cases.length, 12);
    assert.equal(normal.at(-1).type, "answer");
    assert.equal((await ask("QA offline")).find((e) => e.type === "qa").result.modelUsed, false);
    const needs = await ask("QA");
    assert.ok(needs.some((e) => e.type === "needs-input") && !needs.some((e) => e.type === "qa"));
    const err = await ask("QA boom");
    assert.equal(err.at(-1).type, "error");
    assert.equal(err.at(-1).kind, "qa");
    assert.equal((await ask("QA my secret")).at(-1).kind, "blocked");
    assert.ok((await ask("Run", { runJourneys: true })).find((e) => e.type === "qa").result.run);
  } finally {
    await h.close();
  }
});
