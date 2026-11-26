import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuardConfig } from "../src/types.ts";
import { openDb, upsertDoc } from "../src/index/db.ts";
import { buildBugSheet, fingerprintDefect } from "../src/qa/defects.ts";
import { generateApiTestCases, parseOpenApiSpec, runOpenApiChecks } from "../src/qa/openapi.ts";
import { checkNetworkTraffic, runAllOracles } from "../src/qa/oracles.ts";
import { runSecurityProbes } from "../src/qa/security_probes.ts";
import { analyzeRefinementAndKbDrift } from "../src/qe/refine.ts";
import { analyzeCommitTrajectory } from "../src/qe/trajectory.ts";
import type { DiffResult } from "../src/review/diff.ts";

const ROOT = join(import.meta.dirname, "..", "..");

test("QE Pillar 1: analyzeCommitTrajectory detects churn hotspots, pivots, scope drift, and cross-author overlaps", () => {
  const cfg: GuardConfig = { root: ROOT, dataDir: join(ROOT, "data"), vaultDir: join(ROOT, "vault"), repos: [], busyProcesses: [] };
  const rep = analyzeCommitTrajectory(cfg, null, {
    repo: "spil-aura",
    commitsOverride: [
      { sha: "aaa111", authorHash: "a1", date: "2026-11-26", subject: "wip: try1 orders", files: [{ path: "apps/aura-ui/orders.tsx", added: 20, removed: 5 }, { path: "apps/aura-ui/old-helper.ts", added: 10, removed: 0 }] },
      { sha: "bbb222", authorHash: "a2", date: "2026-11-26", subject: "fix orders layout", files: [{ path: "apps/aura-ui/orders.tsx", added: 15, removed: 10 }, { path: "crates/core/auth.rs", added: 5, removed: 2 }] },
      { sha: "ccc333", authorHash: "a1", date: "2026-11-26", subject: "fixup orders again", files: [{ path: "apps/aura-ui/orders.tsx", added: 8, removed: 4 }, { path: "docs/readme.md", added: 2, removed: 0 }, { path: "scripts/build.mjs", added: 3, removed: 1 }] },
    ],
    finalFilesOverride: ["apps/aura-ui/orders.tsx"],
  });

  assert.equal(rep.riskLevel, "high");
  assert.equal(rep.churnHotspots[0]!.path, "apps/aura-ui/orders.tsx");
  assert.equal(rep.churnHotspots[0]!.touches, 3);
  assert.equal(rep.crossAuthorOverlaps[0]!.distinctAuthors, 2);
  assert.ok(rep.pivotSignals.some((p) => p.includes("old-helper.ts")));
  assert.equal(rep.scopeAtomicityOk, false);
});

test("QE Pillar 5: analyzeRefinementAndKbDrift detects deep nesting, duplicate lines, magic numbers, and undocumented files", () => {
  const cfg: GuardConfig = { root: ROOT, dataDir: join(ROOT, "data"), vaultDir: join(ROOT, "vault"), repos: [], busyProcesses: [] };
  const db = openDb(":memory:");
  upsertDoc(db, { kind: "note", ref: "rule-1", title: "Existing rule", body: "rules", hash: "1", status: "active", audience: "internal_dev" });

  const diffOverride: DiffResult = {
    base: "a",
    head: "b",
    baseSha: "111",
    headSha: "222",
    skipped: [],
    files: [
      {
        path: "apps/aura-ui/NewModule.tsx",
        oldPath: null,
        status: "added",
        added: [10, 11, 12, 13],
        removed: [],
        addedLines: [
          { line: 10, text: "            if (deepNestedCondition) { return true; }" },
          { line: 11, text: "const timeout = 5000;" },
          { line: 12, text: "processOrderPayloadAndValidateTotals(row, ctx, true);" },
          { line: 13, text: "processOrderPayloadAndValidateTotals(row, ctx, true);" },
        ],
        hunks: [{ oldStart: 10, oldLines: 0, newStart: 10, newLines: 4, header: "" }],
        patch: "",
        patchTruncated: false,
      },
    ],
  };

  const rep = analyzeRefinementAndKbDrift(cfg, db, { repo: "spil-aura", diffOverride });
  const kinds = new Set(rep.refinements.map((r) => r.kind));
  assert.ok(kinds.has("deep-nesting"));
  assert.ok(kinds.has("magic-number"));
  assert.ok(kinds.has("duplicate-logic"));
  assert.ok(rep.undocumentedPatterns.includes("apps/aura-ui/NewModule.tsx"));
  assert.equal(rep.proposedVaultDrafts.length, 1);
  db.close();
});

test("QA Pillar 2 & 3: OpenAPI checks, Security Probes, and Network Traffic Oracle enforce local-only safety", async () => {
  const cfg: GuardConfig = { root: ROOT, dataDir: join(ROOT, "data"), vaultDir: join(ROOT, "vault"), repos: [], busyProcesses: [] };
  const spec = JSON.stringify({
    paths: {
      "/api/status": { get: { operationId: "getStatus", responses: { "200": { description: "ok" } } } },
      "/api/orders": { post: { operationId: "createOrder", requestBody: {}, responses: { "201": { description: "created" } } } },
    },
  });
  const endpoints = parseOpenApiSpec(spec);
  assert.equal(endpoints.length, 2);
  const cases = generateApiTestCases(endpoints);
  assert.ok(cases.length >= 4);

  // Remote hosts MUST be refused
  await assert.rejects(() => runOpenApiChecks(cfg, { specText: spec, baseUrl: "https://evil.example.com" }), /non-local host/);
  await assert.rejects(() => runSecurityProbes(cfg, { baseUrl: "https://evil.example.com" }), /non-local host/);

  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("svg")) {
      return new Response("<html>escaped &lt;svg&gt;</html>", {
        status: 200,
        headers: { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'" },
    });
  };

  const oa = await runOpenApiChecks(cfg, { specText: spec, baseUrl: "http://127.0.0.1:4310", fetchFn: fakeFetch });
  assert.equal(oa.passed, 2);
  assert.equal(oa.failed, 0);
  assert.ok(oa.skipped >= 2); // POST /api/orders not auto-executed

  const sec = await runSecurityProbes(cfg, { baseUrl: "http://127.0.0.1:4310", fetchFn: fakeFetch });
  assert.equal(sec.ok, true);
  assert.ok(sec.passed >= 5);

  const netHits = checkNetworkTraffic([
    { url: "http://127.0.0.1:4310/api/orders", method: "GET", status: 500 },
    { url: "http://127.0.0.1:4310/api/slow", method: "GET", status: 200, ms: 4200 },
  ]);
  assert.equal(netHits.length, 2);
  const combined = runAllOracles({ width: 800, networkEvents: [{ url: "http://127.0.0.1/x", method: "GET", status: 502 }] });
  assert.equal(combined.ok, false);
});

test("QA Pillar 4: Defect fingerprinting deduplicates reruns and builds Bug Sheets (JSON/MD/CSV)", () => {
  const fp1 = fingerprintDefect({ journey: "orders", step: "open 12345", actual: "HTTP 500 at 98765" });
  const fp2 = fingerprintDefect({ journey: "orders", step: "open 99999", actual: "HTTP 500 at 11111" });
  assert.equal(fp1, fp2);

  const dir = mkdtempSync(join(tmpdir(), "guard-bugs-"));
  try {
    mkdirSync(join(dir, "data", "qa", "runs"), { recursive: true });
    mkdirSync(join(dir, "qa"), { recursive: true });
    writeFileSync(join(dir, "qa", "forbidden-actions.json"), readFileSync(join(ROOT, "qa", "forbidden-actions.json"), "utf8"));
    const runJson = {
      version: 1,
      id: "20261126-dup-bugs",
      generatedAt: "2026-11-26T15:00:00Z",
      department: { id: "spil-aura", name: "SPIL AURA" },
      request: "QA",
      summary: "Summary",
      assumption: null,
      correction: null,
      target: { kind: "latest", label: "HEAD", fromConversation: false, description: null, pr: null, repos: [], skipped: [] },
      risk: { level: "high", reasons: [] },
      areas: [],
      cases: [],
      regressionChecklist: [],
      notCovered: [],
      questions: [],
      evidence: { uiChange: true, needed: [] },
      checkCommands: [],
      journeys: { available: 1, offer: { runnable: true, blocked: false, targetReachable: true, note: "", safety: { checked: 1, passed: 1 } } },
      run: {
        status: "failed",
        runs: [{ journeyId: "j1", status: "failed", defects: 2 }],
        defects: [
          { journeyId: "j1", step: "click Orders", width: 800, expected: "opens", actual: "IPC error 1001", screenshot: null },
          { journeyId: "j1", step: "click Orders", width: 1100, expected: "opens", actual: "IPC error 2002", screenshot: null },
        ],
      },
      context: { files: 1, areas: 1, commits: 1, dependents: 0, coChange: 0, notes: 0, journeys: 1, hasDiff: true, hasGraph: false, changedFiles: [] },
      artifacts: { markdownPath: null, jsonPath: null },
      modelUsed: false,
      modelNote: "offline",
      backend: null,
      timings: { designSeconds: 0.1, totalSeconds: 0.2 },
    };
    writeFileSync(join(dir, "data", "qa", "runs", "20261126-dup-bugs.json"), JSON.stringify(runJson));

    const cfg: GuardConfig = { root: dir, dataDir: join(dir, "data"), vaultDir: join(dir, "vault"), repos: [], busyProcesses: [] };
    const sheet = buildBugSheet(cfg, "20261126-dup-bugs");
    assert.ok(sheet);
    assert.equal(sheet.totalRawDefects, 2);
    assert.equal(sheet.uniqueBugs, 1);
    assert.equal(sheet.bugs[0]!.occurrences, 2);
    assert.deepEqual(sheet.bugs[0]!.widths, [800, 1100]);
    assert.ok(existsSync(sheet.paths.jsonPath));
    assert.ok(existsSync(sheet.paths.markdownPath));
    assert.ok(existsSync(sheet.paths.csvPath));
    assert.match(sheet.prWarningMarkdown, /AURA Sentinel PR Warning/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
