import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuardConfig } from "../src/types.ts";
import { runBackendQaSuite } from "../src/qa/backend_qa.ts";
import { buildPrEvidencePacket } from "../src/qa/evidence.ts";
import { applyTriageDecision, evaluateTrajectory, evaluateWithRubric, loadQaHints } from "../src/qa/judge.ts";
import {
  checkConsoleAndRuntime, checkFormSemantics, checkProtocolAndPrivacyLeaks, checkResponsiveLayout,
  comparePngBuffers, runAllOracles,
} from "../src/qa/oracles.ts";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("5 deterministic oracles catch Aura layout, console, form, protocol, and visual bugs", () => {
  const layoutHits = checkResponsiveLayout({
    innerWidth: 800,
    scrollWidth: 860,
    panes: [{ name: "chat main", width: 170 }],
    interactiveRects: [
      { x: 10, y: 10, width: 100, height: 30, label: "A" },
      { x: 50, y: 15, width: 100, height: 30, label: "B" },
    ],
  }, 800);
  assert.ok(layoutHits.some((h) => h.code === "horizontal-overflow"));
  assert.ok(layoutHits.some((h) => h.code === "pane-squeezed"));
  assert.ok(layoutHits.some((h) => h.code === "control-overlap"));

  const consoleHits = checkConsoleAndRuntime([{ level: "error", text: "IPC failed" }], "Something went wrong");
  assert.equal(consoleHits.length, 2);

  const formHits = checkFormSemantics([
    { label: "Use the default", inForm: true, typeAttr: null },
    { label: "Save", inForm: true, typeAttr: "button" },
  ]);
  assert.equal(formHits.length, 1);
  assert.equal(formHits[0]!.code, "form-button-missing-type");

  const fakeSecret = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const protoHits = checkProtocolAndPrivacyLeaks(`<reasoning_effort>8</reasoning_effort>{"say":"hi","tool_calls":[]} ${fakeSecret}`);
  assert.ok(protoHits.some((h) => h.code === "stray-control-tag"));
  assert.ok(protoHits.some((h) => h.code === "raw-tool-json-leak"));
  assert.ok(protoHits.some((h) => h.code === "secret-rendered"));
  // Secret value itself must never appear in the finding message!
  assert.equal(protoHits.some((h) => h.message.includes(fakeSecret)), false);

  const same = comparePngBuffers(TINY_PNG, TINY_PNG);
  assert.equal(same.identical, true);
  assert.equal(same.diffRatio, 0);

  const mutated = Buffer.from(TINY_PNG);
  mutated[mutated.length - 1] = (mutated[mutated.length - 1]! ^ 0xff) & 0xff;
  const diff = comparePngBuffers(TINY_PNG, mutated);
  assert.equal(diff.comparable, true);
  assert.equal(diff.identical, false);
  assert.ok(diff.diffRatio > 0);

  const full = runAllOracles({
    width: 800,
    layout: { innerWidth: 800, scrollWidth: 800, panes: [{ name: "main", width: 520 }] },
    consoleEvents: [],
    formButtons: [{ label: "Cancel", inForm: true, typeAttr: "button" }],
    visibleText: "Orders loaded cleanly",
    baselinePng: TINY_PNG,
    currentPng: TINY_PNG,
  });
  assert.equal(full.ok, true);
  assert.equal(full.passed, 5);
});

test("Rubric judge (offline + mocked), trajectory eval, 1-click triage, PR evidence packet, and Backend QA", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-judge-"));
  try {
    mkdirSync(join(dir, "data", "qa", "runs"), { recursive: true });
    mkdirSync(join(dir, "vault", "inbox"), { recursive: true });
    mkdirSync(join(dir, ".artifacts", "qa", "20261126-orders"), { recursive: true });
    const shotPath = join(dir, ".artifacts", "qa", "20261126-orders", "shot-800.png");
    writeFileSync(shotPath, TINY_PNG);

    const cfg: GuardConfig = {
      root: dir,
      dataDir: join(dir, "data"),
      vaultDir: join(dir, "vault"),
      repos: [],
      busyProcesses: [],
    };
    // Copy forbidden-actions.json into temp root so loadForbidden works
    mkdirSync(join(dir, "qa"), { recursive: true });
    writeFileSync(
      join(dir, "qa", "forbidden-actions.json"),
      readFileSync(join(import.meta.dirname, "..", "..", "qa", "forbidden-actions.json"), "utf8"),
    );

    const runJson = {
      version: 1,
      id: "20261126-orders",
      generatedAt: "2026-11-26T10:00:00Z",
      department: { id: "spil-aura", name: "SPIL AURA" },
      request: "QA orders",
      summary: "Orders check",
      assumption: null,
      correction: null,
      target: { kind: "latest", label: "HEAD", fromConversation: false, description: null, pr: null, repos: [{ repo: "spil-aura", range: "a..b", commits: 1, firstCommit: null, baseSha: null, headSha: null }], skipped: [] },
      risk: { level: "medium", reasons: [] },
      areas: [],
      cases: [{ id: "C1", title: "Orders list", type: "functional", priority: "P0", cites: ["orders.tsx"], preconditions: [], steps: [], expected: [], automatable: true }],
      regressionChecklist: [],
      notCovered: [],
      questions: [],
      evidence: { uiChange: true, needed: [] },
      checkCommands: [],
      journeys: { available: 1, offer: { runnable: true, blocked: false, targetReachable: true, note: "", safety: { checked: 1, passed: 1 } } },
      run: {
        status: "failed",
        runs: [{ journeyId: "journey-orders-list", status: "failed", defects: 1 }],
        defects: [{ journeyId: "journey-orders-list", step: "open", width: 800, expected: "no overflow", actual: "overflow", screenshot: ".artifacts/qa/20261126-orders/shot-800.png" }],
      },
      context: { files: 1, areas: 1, commits: 1, dependents: 0, coChange: 0, notes: 0, journeys: 1, hasDiff: true, hasGraph: false, changedFiles: [] },
      artifacts: { markdownPath: null, jsonPath: null },
      modelUsed: false,
      modelNote: "offline",
      backend: null,
      timings: { designSeconds: 0.1, totalSeconds: 0.5 },
    };
    writeFileSync(join(dir, "data", "qa", "runs", "20261126-orders.json"), JSON.stringify(runJson));

    // Offline rubric & trajectory eval
    const offline = await evaluateWithRubric({ journey: "orders", safetyBlockedCount: 0 });
    assert.equal(offline.modelUsed, false);
    assert.equal(offline.rubrics.length, 4);

    const traj = evaluateTrajectory([
      { action: "click", target: "Orders", status: "passed" },
      { action: "click", target: "Orders", status: "passed" },
      { action: "click", target: "Save", status: "blocked" },
    ]);
    assert.equal(traj.repeatedLoops, 1);
    assert.equal(traj.safetyBlocks, 1);

    // 1-click Triage: real_bug, update_baseline, flaky_hint
    const bugRes = applyTriageDecision(cfg, {
      action: "real_bug",
      runId: "20261126-orders",
      journey: "journey-orders-list",
      step: "open",
      width: 800,
      expected: "no overflow",
      actual: "overflow",
      screenshotPath: ".artifacts/qa/20261126-orders/shot-800.png",
    });
    assert.equal(bugRes.ok, true);
    assert.ok(bugRes.incidentPath && existsSync(bugRes.incidentPath));
    assert.match(bugRes.prCommentMarkdown ?? "", /QA Defect: open/);

    const baseRes = applyTriageDecision(cfg, {
      action: "update_baseline",
      runId: "20261126-orders",
      journey: "journey-orders-list",
      step: "open",
      width: 800,
      screenshotPath: ".artifacts/qa/20261126-orders/shot-800.png",
    });
    assert.equal(baseRes.ok, true);
    assert.ok(baseRes.baselinePath && existsSync(baseRes.baselinePath));

    const hintRes = applyTriageDecision(cfg, {
      action: "flaky_hint",
      runId: "20261126-orders",
      journey: "journey-orders-list",
      step: "open",
      hint: "Wait for table hydration",
    });
    assert.equal(hintRes.ok, true);
    assert.equal(loadQaHints(cfg).length, 1);

    // PR Evidence Packet
    const ev = await buildPrEvidencePacket(cfg, "20261126-orders");
    assert.ok(ev);
    assert.ok(existsSync(ev.markdownPath));
    assert.ok(existsSync(ev.jsonPath));
    assert.deepEqual(ev.packet.widthsCovered, [800]);

    // Backend & MCP QA Suite
    const be = await runBackendQaSuite(cfg);
    assert.equal(be.ok, true);
    assert.ok(be.checks.some((c) => c.id === "mcp-support-isolation" && c.status === "pass"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
