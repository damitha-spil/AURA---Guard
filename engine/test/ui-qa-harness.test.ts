import test from "node:test";
import assert from "node:assert/strict";
import { computeScorecard, groupDefects } from "../../ui/qa.js";
import { computeWaterfall, stepKindLabel } from "../../ui/steps.js";
import {
  WORKSPACES, buildExecutionLogs, buildReplayFrames, buildWaterfallSpans, buildWorkflowGraph,
  filterExecutionLogs, filterSuiteCases, regressionSeries, searchPalette, tokenizeJsonLines,
} from "../../ui/qa-harness.js";

test("ui/qa.js computeScorecard & groupDefects compute gate and groups", () => {
  const sc = computeScorecard({
    cases: [{ id: "1", priority: "P0" }, { id: "2", priority: "P1" }],
    journeys: { offer: { safety: { checked: 1, passed: 1 } } },
    run: { status: "failed", runs: [{ journeyId: "j1", status: "failed", defects: 1 }], defects: [{ journeyId: "j1", step: "click", expected: "ok", actual: "err" }] },
  });
  assert.equal(sc.gate, "block");
  assert.equal(sc.counts.P0, 1);
  const grouped = groupDefects([{ journeyId: "j1", step: "s1" }, { journeyId: "j1", step: "s2" }]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].items.length, 2);
});

test("ui/steps.js computeWaterfall builds proportional offsets", () => {
  const wf = computeWaterfall([
    { id: "context", kind: "context", status: "done", startedAt: 1000, ms: 200 },
    { id: "design", kind: "design", status: "done", startedAt: 1200, ms: 800 },
  ]);
  assert.equal(wf.length, 2);
  assert.equal(stepKindLabel("design"), "LLM");
  assert.equal(wf[0].leftPct, 0);
  assert.ok(wf[1].leftPct > 0);
});

test("ui/qa-harness.js workstation workspaces, logs, palette, JSON tokenizer, graph, replay, and trend", () => {
  assert.equal(WORKSPACES.length, 3);
  const detail = {
    scorecard: { releaseGate: "block" },
    spans: [{ id: "root", parentId: null, label: "Root", kind: "agent", status: "done", startMs: 0, durationMs: 1000, detail: "ok" }],
    result: {
      id: "r1",
      modelUsed: true,
      cases: [{ id: "C1" }],
      target: { label: "last commit", repos: [{ repo: "aura" }] },
      journeys: { offer: { safety: { checked: 1, passed: 1 } } },
      run: { status: "failed", runs: [{ journeyId: "j1", status: "failed", defects: 1 }], defects: [{ journeyId: "j1", step: "open", width: 800, expected: "a", actual: "b", screenshot: "s.png" }] },
    },
  };
  assert.equal(buildWaterfallSpans(detail.spans)[0].widthPct, 100);
  const graph = buildWorkflowGraph(detail);
  assert.equal(graph.nodes.length, 7);
  assert.equal(graph.edges.length, 7);
  const frames = buildReplayFrames(detail);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].screenshot, "s.png");
  assert.equal(filterSuiteCases([{ id: "C1", priority: "P0", type: "functional", title: "Order login", area: "orders" }], { priority: "P0", query: "login" }).length, 1);
  assert.equal(regressionSeries([{ id: "r1", generatedAt: "2026-11-23T00:00:00Z", scorecard: { passRate: 100, defectsCount: 0, totalCases: 2, releaseGate: "pass" } }]).length, 1);

  const logs = buildExecutionLogs(detail, { egress: { totalCalls: 4, blockedSecrets: 1, maskedSecrets: 2 } }, { available: false, command: "cua-driver", blockedTools: ["kill_app"] });
  assert.ok(logs.some((l) => l.level === "error" && l.source === "DEFECT"));
  assert.equal(filterExecutionLogs(logs, { level: "error" }).length, 1);

  const pal = searchPalette("workflows", { runs: [{ id: "r1", targetLabel: "aura", scorecard: { releaseGate: "pass" } }] });
  assert.ok(pal.some((p) => p.kind === "view" && p.view === "workflows"));

  const toks = tokenizeJsonLines({ ok: true, count: 3 });
  assert.ok(toks.some((line) => line.some((t) => t.kind === "key" && t.text === "\"ok\"")));
});
