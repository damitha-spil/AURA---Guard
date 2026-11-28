import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PREBUILT_AGENTS } from "../src/agents/registry.ts";
import { runAgenticMission } from "../src/agents/runner.ts";
import {
  detectAndProposeFromDefects,
  listMissionTraces,
  listModelBenchmarks,
  listSkillProposals,
  proposeSkillImprovement,
  reviewSkillProposal,
  runModelBenchmark,
} from "../src/automation/observatory_and_evals.ts";
import { listProductionDefects, upsertDefect } from "../src/defects/store.ts";
import { apiHurlRunner, apiSchemathesisFuzz, qaK6SmokeLoad } from "../src/qa/api_and_load.ts";
import { secDependencyCves, secGitleaksHistory, secNucleiLocal, secSemgrepScan } from "../src/qa/devsecops_suite.ts";
import { qaA11yTreeSnapshot, qaAxeAudit, qaLighthouseBudget, qaVisionGroundScreen, qaVisualDiff } from "../src/qa/visual_and_a11y.ts";
import { qeArchBoundaries, qeDeadCodeScan, qeMutationScore, reviewAstGrep } from "../src/qe/tier0_suite.ts";
import { listSkills } from "../src/roles/skills.ts";
import { BUILTIN_TOOLS } from "../src/tools/registry.ts";
import type { GuardConfig } from "../src/types.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function makeTempCfg(extra?: Partial<GuardConfig>): { dir: string; cfg: GuardConfig } {
  const dir = mkdtempSync(join(tmpdir(), "reo-waves-test-"));
  const dataDir = join(dir, "data");
  const vaultDir = join(dir, "vault");
  const srcDir = join(dir, "sample-repo");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  const cfg: GuardConfig = {
    root: REPO_ROOT,
    dataDir,
    vaultDir,
    repos: [{ id: "sample", path: srcDir }],
    busyProcesses: [],
    ...extra,
  };
  return { dir, cfg };
}

test("All 19 Wave 1-3 skills and 16 tools are discoverable and wired", () => {
  const skills = listSkills(REPO_ROOT);
  const expectedSkills = [
    "qa-playwright-mcp",
    "qa-self-healing-journeys",
    "qa-visual-yaml-assertions",
    "qa-visual-regression",
    "qe-ast-rules",
    "qe-dead-code",
    "qe-architecture-guard",
    "qe-mutation-audit",
    "sec-sarif-triage",
    "sec-git-secret-audit",
    "sec-sca-gate",
    "sec-nuclei-localhost",
    "qa-api-fuzzing",
    "qa-hurl-contracts",
    "qa-perf-budget",
    "qa-wcag-gate",
    "qa-cwv-audit",
    "qe-model-benchmark",
    "qa-n8n-bidirectional-mcp",
  ];
  const names = new Set(skills.map((s) => s.name));
  for (const name of expectedSkills) {
    assert.ok(names.has(name), `Missing skill: ${name}`);
  }

  const toolIds = new Set(BUILTIN_TOOLS.map((t) => t.id));
  const expectedTools = [
    "qa_a11y_tree_snapshot",
    "qa_vision_ground_screen",
    "qa_visual_diff",
    "qa_axe_audit",
    "qa_lighthouse_budget",
    "review_ast_grep",
    "qe_dead_code_scan",
    "qe_arch_boundaries",
    "qe_mutation_score",
    "sec_semgrep_scan",
    "sec_gitleaks_history",
    "sec_dependency_cves",
    "sec_nuclei_local",
    "api_schemathesis_fuzz",
    "api_hurl_runner",
    "qa_k6_smoke_load",
  ];
  for (const id of expectedTools) {
    assert.ok(toolIds.has(id), `Missing builtin tool: ${id}`);
  }
  assert.ok(PREBUILT_AGENTS.find((a) => a.id === "security")!.allowedTools.includes("sec_semgrep_scan"));
  assert.ok(PREBUILT_AGENTS.find((a) => a.id === "api")!.allowedTools.includes("api_schemathesis_fuzz"));
});

test("Category 1 & 5: A11y tree, OmniParser grounding, Visual diff, Axe WCAG, and Lighthouse CWV", async () => {
  const { dir, cfg } = makeTempCfg();
  try {
    const html = `<!doctype html><html><head></head><body><h1>Dashboard</h1><img src="x.png"><button></button><button>Submit</button><input id="u" type="text"></body></html>`;
    const snap = await qaA11yTreeSnapshot(cfg, { html });
    assert.ok(snap.nodeCount >= 4);
    assert.ok(snap.unlabeledCount >= 1);
    await assert.rejects(() => qaA11yTreeSnapshot(cfg, { url: "https://example.com" }), /Blocked non-local target URL/);

    const axe = await qaAxeAudit(cfg, { html, recordDefects: true });
    assert.equal(axe.passed, false);
    assert.ok(axe.violations.some((v) => v.id === "image-alt"));
    assert.ok(axe.violations.some((v) => v.id === "button-name"));
    assert.ok(axe.defectsRecorded >= 2);
    assert.ok(listProductionDefects(cfg.dataDir).length >= 2);

    // 2x2 valid minimal PNG header (IHDR width=2 height=2)
    const pngA = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02,
      0x08, 0x02, 0x00, 0x00, 0x00,
    ]);
    const pngB = Buffer.from(pngA);
    pngB[pngB.length - 1] = 0xff;
    const p1 = join(cfg.dataDir, "base.png");
    const p2 = join(cfg.dataDir, "curr.png");
    writeFileSync(p1, pngA);
    writeFileSync(p2, pngB);

    const ground = await qaVisionGroundScreen(cfg, { imagePath: p1, html });
    assert.equal(ground.imageMeta?.width, 2);
    assert.ok(ground.elements.length >= 3);

    const same = qaVisualDiff(cfg, { baselinePath: p1, currentPath: p1 });
    assert.equal(same.status, "match");
    assert.equal(same.diffRatioPct, 0);

    const diff = qaVisualDiff(cfg, { baselinePath: p1, currentPath: p2 });
    assert.equal(diff.status, "diff");
    assert.ok(diff.diffRatioPct > 0);
    assert.ok(existsSync(diff.reportPath));

    const cwv = await qaLighthouseBudget(cfg, {
      url: "http://127.0.0.1:4310/",
      fetchFn: async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }),
    });
    assert.equal(cwv.budgetsPassed, false);
    assert.equal(cwv.metrics.unsizedImages, 1);
    assert.equal(cwv.metrics.hasViewport, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Category 2: Tier 0 AST grep, dead code, arch boundaries cycles, and mutation audit", async () => {
  const { dir, cfg } = makeTempCfg();
  const repoDir = cfg.repos[0]!.path;
  try {
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "tmp", dependencies: { "unused-leftover-pkg": "1.0.0" } }));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    mkdirSync(join(repoDir, "test"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.ts"), `import { bFn } from "./b";\nexport function usedA(x: number) { if (x <= 0) return 0; return eval("1") + bFn(); }\nexport function neverUsedExport() { return 42; }\n`);
    writeFileSync(join(repoDir, "src", "b.ts"), `import { usedA } from "./a";\nexport function bFn() { return typeof usedA === "function" ? 1 : 0; }\n`);
    writeFileSync(join(repoDir, "src", "btn.tsx"), `export function Btn() { return <button>Save</button>; }\n`);
    writeFileSync(join(repoDir, "test", "a.test.ts"), `import assert from "node:assert";\nimport { usedA } from "../src/a";\nassert.equal(typeof usedA, "function");\n`);

    const ast = await reviewAstGrep(cfg, { targetDir: repoDir });
    assert.ok(ast.findings.some((f) => f.ruleId === "no-eval-or-new-function"));
    assert.ok(ast.findings.some((f) => f.ruleId === "button-explicit-type"));

    const dead = await qeDeadCodeScan(cfg, { targetDir: repoDir });
    assert.ok(dead.unusedDependencies.includes("unused-leftover-pkg"));
    assert.ok(dead.unusedExports.some((e) => e.symbol === "neverUsedExport"));

    const bounds = await qeArchBoundaries(cfg, { targetDir: repoDir });
    assert.equal(bounds.ok, false);
    assert.ok(bounds.circularDependencies.length >= 1);

    const mut = await qeMutationScore(cfg, { targetDir: repoDir, files: ["src/a.ts"] });
    assert.ok(mut.totalMutantSites >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Category 3: DevSecOps Semgrep SARIF ingestion, Gitleaks secret redaction, CVE gate, and Nuclei local", async () => {
  const { dir, cfg } = makeTempCfg();
  const repoDir = cfg.repos[0]!.path;
  try {
    // 1. SARIF ingest
    const sarif = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          results: [
            {
              ruleId: "ts.express.sqli",
              level: "error",
              message: { text: "Unsanitized SQL template literal" },
              locations: [{ physicalLocation: { artifactLocation: { uri: "src/orders.ts" }, region: { startLine: 19 } } }],
            },
          ],
        },
      ],
    });
    const sarifRes = await secSemgrepScan(cfg, { sarifJson: sarif, targetDir: repoDir, recordDefects: true });
    assert.equal(sarifRes.totalFindings, 1);
    assert.equal(sarifRes.defectsIngested, 1);

    // 2. Git commit secret history scan + strict redaction
    const rawSecret = "sk-ant-api03-Qx9mK2pL8vW4zR7nT5yB";
    execFileSync("git", ["init", repoDir], { windowsHide: true });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "qa@spil.local"], { windowsHide: true });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "QA Bot"], { windowsHide: true });
    writeFileSync(join(repoDir, "config.ts"), `export const k = "${rawSecret}";\n`);
    execFileSync("git", ["-C", repoDir, "add", "config.ts"], { windowsHide: true });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "add config"], { windowsHide: true });

    const leaks = await secGitleaksHistory(cfg, { targetDir: repoDir });
    assert.ok(leaks.leaksFound >= 1);
    assert.ok(!JSON.stringify(leaks).includes(rawSecret), "Raw secret leaked in output!");

    // 3. Dependency CVE release gate
    writeFileSync(
      join(repoDir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/lodash": { version: "4.17.15" } } }),
    );
    const cveRes = await secDependencyCves(cfg, { targetDir: repoDir, recordDefects: true });
    assert.equal(cveRes.releaseGate, "BLOCK_RELEASE");
    assert.ok(cveRes.highCount >= 1);

    // 4. Nuclei localhost-only guard + detection
    await assert.rejects(() => secNucleiLocal(cfg, { baseUrl: "https://evil.example.com" }), /Blocked sec_nuclei_local/);
    const nuc = await secNucleiLocal(cfg, {
      baseUrl: "http://127.0.0.1:4310",
      fetchFn: async (input) => {
        const u = String(input);
        if (u.endsWith("/.env")) return new Response("DB_PASS=secret\n", { status: 200 });
        return new Response("ok", { status: 200 });
      },
    });
    assert.ok(nuc.findings.some((f) => f.templateId === "exposed-dotenv-file"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Category 4: Schemathesis fuzz, Hurl chain runner, and bounded k6 smoke load", async () => {
  const { dir, cfg } = makeTempCfg();
  try {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      paths: { "/orders/{id}": { get: { responses: { "200": { description: "ok" } } } } },
    });
    await assert.rejects(() => apiSchemathesisFuzz(cfg, { baseUrl: "https://remote.example", specText: spec }), /Blocked api_schemathesis_fuzz/);
    const fuzz = await apiSchemathesisFuzz(cfg, {
      baseUrl: "http://127.0.0.1:4310",
      specText: spec,
      fetchFn: async (input) => {
        if (String(input).includes("-1")) return new Response("Internal error", { status: 500 });
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    assert.ok(fuzz.serverErrors5xx >= 1);

    const hurl = [
      "GET http://127.0.0.1:4310/token",
      "HTTP 200",
      "[Captures]",
      'itemId: jsonpath "$.id"',
      "",
      "GET http://127.0.0.1:4310/items/{{itemId}}",
      "HTTP 200",
      "[Asserts]",
      'jsonpath "$.status" == "ready"',
    ].join("\n");
    const hurlRes = await apiHurlRunner(cfg, {
      hurlText: hurl,
      fetchFn: async (input) => {
        if (String(input).endsWith("/token")) return new Response(JSON.stringify({ id: "ord-42" }), { status: 200 });
        if (String(input).endsWith("/items/ord-42")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
        return new Response("missing", { status: 404 });
      },
    });
    assert.equal(hurlRes.passedEntries, 2);
    assert.equal(hurlRes.failedEntries, 0);

    const k6Res = await qaK6SmokeLoad(cfg, {
      url: "http://127.0.0.1:4310/health",
      vus: 99, // clamped to MAX_K6_VUS = 10
      durationSeconds: 99, // clamped to MAX_K6_DURATION_SECONDS = 10
      fetchFn: async () => new Response("ok", { status: 200 }),
    });
    assert.equal(k6Res.vus, 10);
    assert.equal(k6Res.durationSeconds, 10);
    assert.equal(k6Res.budgetPassed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Category 6: Execution Observatory OTel spans, Evaluation Lab benchmark, and Skill Proposal Loop", async () => {
  const { dir, cfg } = makeTempCfg();
  try {
    // Seed recurring defect before mission to test auto skill proposal
    const defectInput = {
      appName: "SPIL REO",
      branch: "current",
      commitSha: "",
      testedBy: "QA",
      assignedTo: "",
      agentSource: "qe" as const,
      severity: "medium" as const,
      title: "deep-nesting: src/orders.ts",
      expected: "Use early returns",
      actual: "Nested 14 spaces",
      reproSteps: ["run qe"],
      codeSuggestion: "Extract helper",
      fileRef: "src/orders.ts:12",
      evidencePaths: [],
    };
    upsertDefect(cfg.dataDir, defectInput);
    upsertDefect(cfg.dataDir, defectInput); // recurrenceCount = 2

    const mission = await runAgenticMission(cfg, "@qe check trajectory", () => {});
    assert.ok(mission.traceId.length >= 16);
    const traces = listMissionTraces(cfg.dataDir);
    assert.equal(traces.length, 1);
    assert.ok(traces[0]!.spans.some((s) => s.kind === "AGENT"));
    assert.ok(traces[0]!.spans.some((s) => s.kind === "GATE"));

    detectAndProposeFromDefects(cfg.dataDir, mission.id);
    const prop = proposeSkillImprovement(cfg.dataDir, {
      patternKey: "missing-button-type",
      targetName: "qe-ast-rules",
      title: "Enforce explicit button type",
      rationale: "Avoid accidental submits",
      proposedPatchMarkdown: "- Add `<button type='button'>` check",
    });
    assert.equal(prop.status, "proposed");

    const approved = reviewSkillProposal(cfg.dataDir, prop.id, "approved", cfg.vaultDir);
    assert.equal(approved?.status, "approved");
    assert.ok(approved?.vaultDraftPath && existsSync(join(cfg.vaultDir, approved.vaultDraftPath)));
    const noteText = readFileSync(join(cfg.vaultDir, approved!.vaultDraftPath!), "utf8");
    assert.match(noteText, /status:\s*proposed/);
    assert.ok(listSkillProposals(cfg.dataDir, "approved").length >= 1);

    const bench = await runModelBenchmark(cfg, {
      prompt: "Audit src/orders.ts against vault security rules",
      providers: ["antigravity-cli", "claude-cli"],
      expectedKeywords: ["orders.ts", "vault"],
      completeOverride: async (pid) => ({
        model: `${pid}-model`,
        text: pid === "claude-cli" ? "- Check `src/orders.ts` against vault/rules/security.md." : "Check code.",
      }),
    });
    assert.equal(bench.winner, "claude-cli");
    assert.equal(listModelBenchmarks(cfg.dataDir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
