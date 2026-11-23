import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuardConfig } from "../src/types.ts";
import { compareQaRuns, computeScorecard, getQaRun, listGovernanceAndCost, listQaRuns, listQaSuite, safeQaScreenshotPath } from "../src/qa/harness_api.ts";

function makeCfg(dir: string): GuardConfig {
  const dataDir = join(dir, "data");
  const vaultDir = join(dir, "vault");
  mkdirSync(join(dataDir, "qa", "runs"), { recursive: true });
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  mkdirSync(join(vaultDir, "journeys"), { recursive: true });
  mkdirSync(join(dir, "roles"), { recursive: true });
  mkdirSync(join(dir, "qa", "generated"), { recursive: true });
  mkdirSync(join(dir, ".artifacts", "qa", "run-1"), { recursive: true });
  writeFileSync(join(dir, "qa", "forbidden-actions.json"), JSON.stringify({ names: ["save*"], selectors: [], keys: ["ctrl+s"], allowedHosts: ["127.0.0.1"], allowedUploadDirs: [] }));
  writeFileSync(join(dir, "roles", "qa-case-templates.json"), JSON.stringify({
    version: 1,
    thresholds: { medium: 3, high: 8 },
    churnPerPoint: 50,
    categories: [{
      id: "orders",
      label: "Orders",
      match: ["orders/"],
      riskWeight: 2,
      ui: true,
      service: false,
      cases: [{
        type: "functional",
        priority: "P0",
        title: "Template check",
        preconditions: ["Logged in"],
        steps: ["Open orders"],
        expected: ["Orders load"],
        automatable: true,
      }],
    }],
  }));
  return {
    root: dir,
    dataDir,
    vaultDir,
    repos: [],
    model: "claude-sonnet-4-6",
    backend: "auto",
  } as unknown as GuardConfig;
}

function sampleRun(id: string, defects: number, totalCases: number) {
  return {
    version: 1,
    id,
    generatedAt: "2026-11-23T10:00:00.000Z",
    department: { id: "spil-aura", name: "SPIL AURA" },
    request: "QA orders",
    summary: "Summary",
    assumption: null,
    correction: null,
    target: { kind: "commits", label: "last commit", fromConversation: false, description: null, pr: null, repos: [{ repo: "aura", range: "HEAD~1..HEAD", commits: 1, firstCommit: "fix", baseSha: "a", headSha: "b" }], skipped: [] },
    risk: { level: "medium", reasons: ["touches orders"] },
    areas: [],
    cases: Array.from({ length: totalCases }, (_, i) => ({
      id: `C${i + 1}`, priority: i === 0 ? "P0" : "P1", type: "functional", area: "orders", title: `Case ${i + 1}`,
      preconditions: [], steps: [], expected: [], cites: [], automatable: true, journeyId: "journey-orders",
    })),
    regressionChecklist: [],
    notCovered: [],
    questions: [],
    evidence: { uiChange: false, needed: [] },
    checkCommands: [],
    journeys: { available: 1, offer: { runnable: [], blocked: [], targetReachable: true, note: "", safety: { checked: 1, passed: 1 } } },
    run: {
      status: defects > 0 ? "failed" : "passed",
      runs: [{ journeyId: "journey-orders", status: defects > 0 ? "failed" : "passed", reportPath: null, defects, blocker: null }],
      defects: defects > 0 ? [{ journeyId: "journey-orders", step: "click row", width: 800, expected: "opens", actual: "stuck", screenshot: null }] : [],
    },
    context: { files: 2, areas: 1, commits: 1, dependents: 1, coChange: 0, notes: 0, journeys: 1, hasDiff: true, hasGraph: true, changedFiles: [] },
    artifacts: { markdownPath: null, jsonPath: null },
    modelUsed: true,
    modelNote: "",
    backend: "Claude plan",
    timings: { designSeconds: 1.2, totalSeconds: 2.5 },
  };
}

test("harness_api lists runs, builds waterfall spans, compares runs, and blocks path traversal", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-harness-"));
  try {
    const cfg = makeCfg(dir);
    writeFileSync(join(cfg.dataDir, "qa", "runs", "2026-11-23-run1.json"), JSON.stringify(sampleRun("2026-11-23-run1", 1, 2)));
    writeFileSync(join(cfg.dataDir, "qa", "runs", "2026-11-23-run2.json"), JSON.stringify(sampleRun("2026-11-23-run2", 0, 3)));
    writeFileSync(join(cfg.dataDir, "logs", "egress-2026-11-23.jsonl"), JSON.stringify({ ts: "2026-11-23T10:00:00Z", role: "qa", model: "claude", blocked: [], replaced: [{ kind: "token", count: 2 }] }) + "\n");
    const pngPath = join(dir, ".artifacts", "qa", "run-1", "shot.png");
    writeFileSync(pngPath, "PNG");

    const listed = listQaRuns(cfg);
    assert.equal(listed.runs.length, 2);
    assert.equal(listed.kpis.totalDefects, 1);
    assert.equal(listed.kpis.passRate, 50);

    const detail = getQaRun(cfg, "2026-11-23-run1");
    assert.ok(detail);
    assert.equal(detail.scorecard.releaseGate, "block");
    assert.ok(detail.spans.some((s) => s.id === "runner"));

    const cmp = compareQaRuns(cfg, "2026-11-23-run1", "2026-11-23-run2");
    assert.ok(cmp);
    assert.equal(cmp.deltas.cases, 1);
    assert.equal(cmp.deltas.defects, -1);
    assert.equal(cmp.addedCases.length, 1);
    assert.equal(cmp.resolvedDefects.length, 1);

    const suite = listQaSuite(cfg);
    assert.equal(suite.templates.length, 1);
    assert.equal(suite.recentCases.length, 5);

    const gov = listGovernanceAndCost(cfg);
    assert.equal(gov.forbidden.names, 1);
    assert.equal(gov.egress.maskedSecrets, 2);

    assert.ok(safeQaScreenshotPath(cfg, ".artifacts/qa/run-1/shot.png"));
    assert.equal(safeQaScreenshotPath(cfg, "../../package.json"), null);
    assert.equal(safeQaScreenshotPath(cfg, ".artifacts/qa/run-1/not-an-image.txt"), null);
    assert.equal(computeScorecard(sampleRun("x", 0, 1) as never).releaseGate, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
