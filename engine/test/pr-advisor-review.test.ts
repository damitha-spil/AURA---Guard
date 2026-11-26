import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GuardConfig } from "../src/types.ts";
import { adviseDeveloper } from "../src/chat/advisor.ts";
import { buildServer } from "../src/mcp/server.ts";
import { buildPrReadinessReport } from "../src/prs/manager.ts";
import type { DiffResult } from "../src/review/diff.ts";
import { checkActivePatternRules, loadRules, runTier0 } from "../src/review/tier0.ts";

test("Tier 0 defect-class rules and approved pattern rules catch real Aura regressions", () => {
  const root = join(import.meta.dirname, "..", "..");
  const rules = loadRules(root);
  const diff: DiffResult = {
    base: "a",
    head: "b",
    baseSha: "111",
    headSha: "222",
    skipped: [],
    files: [
      {
        path: "apps/aura-ui/src/Settings.tsx",
        oldPath: null,
        status: "modified",
        added: [12, 13],
        removed: [],
        addedLines: [
          { line: 12, text: `<button className="btn">Use the default</button>` },
          { line: 13, text: `try { x(); } catch (e) {}` },
        ],
        hunks: [{ oldStart: 12, oldLines: 0, newStart: 12, newLines: 2, header: "" }],
        patch: "",
        patchTruncated: false,
      },
      {
        path: "apps/personal-agent/crates/agent-core/src/orders.rs",
        oldPath: null,
        status: "modified",
        added: [40, 41],
        removed: [],
        addedLines: [
          { line: 40, text: `let _ = client.save_order(&draft);` },
          { line: 41, text: `let conn = "Data Source=sql.example.internal;Initial Catalog=Sales;";` },
        ],
        hunks: [{ oldStart: 40, oldLines: 0, newStart: 40, newLines: 2, header: "" }],
        patch: "",
        patchTruncated: false,
      },
    ],
  };

  const findings = runTier0(diff, {
    rules,
    activeChecks: [
      {
        id: "rule-ui-copy",
        title: "UI components update copy.ts",
        check: {
          kind: "co-change",
          if_changed: ["apps/aura-ui/src/*.tsx"],
          then_changed: ["apps/aura-ui/src/copy.ts"],
          evidence: { commits: 5, ratio: 0.8, repo: "spil-aura" },
        },
      },
    ],
    repoId: "spil-aura",
  });

  const ruleIds = new Set(findings.map((f) => f.rule));
  assert.ok(ruleIds.has("form-button-missing-type"));
  assert.ok(ruleIds.has("swallowed-catch-block"));
  assert.ok(ruleIds.has("rust-ignored-result-let"));
  assert.ok(ruleIds.has("hardcoded-sql-connstring"));
  assert.ok(ruleIds.has("approved-pattern-rule-ui-copy"));

  const patternOnly = checkActivePatternRules(diff, [
    {
      id: "rule-ui-copy",
      title: "UI components update copy.ts",
      check: {
        kind: "co-change",
        if_changed: ["apps/aura-ui/src/*.tsx"],
        then_changed: ["apps/aura-ui/src/*.tsx"], // satisfied in same diff
        evidence: { commits: 5, ratio: 0.8, repo: "spil-aura" },
      },
    },
  ]);
  assert.equal(patternOnly.length, 0);
});

test("Wise Advisor, PR Readiness Report, and MCP scope isolation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-adv-"));
  try {
    mkdirSync(join(dir, "data", "qa", "runs"), { recursive: true });
    mkdirSync(join(dir, "vault", "rules"), { recursive: true });
    mkdirSync(join(dir, "vault", "inbox"), { recursive: true });
    mkdirSync(join(dir, "qa"), { recursive: true });

    writeFileSync(
      join(dir, "vault", "rules", "rule-ai-no-erp-create.md"),
      "---\nid: rule-ai-no-erp-create\ntype: rule\nstatus: active\naudience: [internal_dev, qa_internal]\nsource: owner-answer\ncreated: 2026-11-20\ntitle: AI never gets an ERP create tool\n---\n\nThe backend checks and saves; the AI never gets a create tool.\n",
    );
    writeFileSync(
      join(dir, "vault", "inbox", "rule-proposed-hint.md"),
      "---\nid: rule-proposed-hint\ntype: rule\nstatus: proposed\naudience: [internal_dev]\nsource: session\ncreated: 2026-11-21\ntitle: Draft ERP validation hint\n---\n\nUnapproved hint for ERP validation.\n",
    );

    const cfg: GuardConfig = {
      root: join(import.meta.dirname, "..", ".."),
      dataDir: join(dir, "data"),
      vaultDir: join(dir, "vault"),
      repos: [],
      busyProcesses: [],
    };

    const brief = adviseDeveloper(cfg, null, "ERP create tool");
    assert.equal(brief.activeRules.length, 1);
    assert.equal(brief.activeRules[0]!.id, "rule-ai-no-erp-create");
    assert.equal(brief.proposedHints.length, 1);
    assert.equal(brief.proposedHints[0]!.id, "rule-proposed-hint");
    assert.ok(brief.recommendations.length >= 2);

    const readiness = buildPrReadinessReport(cfg, null);
    assert.equal(readiness.releaseGate, "pass");
    assert.match(readiness.prSummaryMarkdown, /PR Readiness Summary/);

    // Verify MCP server registers new tools for dev/qa and isolates support scope
    const [cDev, sDev] = InMemoryTransport.createLinkedPair();
    const devServer = buildServer(null, "dev", cfg);
    const devClient = new Client({ name: "t-dev", version: "0.1.0" }, { capabilities: {} });
    await Promise.all([devServer.connect(sDev), devClient.connect(cDev)]);
    const devTools = (await devClient.listTools()).tools.map((t) => t.name);
    assert.ok(devTools.includes("pr_readiness_report"));
    assert.ok(devTools.includes("advise_architecture"));
    assert.ok(devTools.includes("qa_check_driver_health"));
    await devClient.close();
    await devServer.close();

    const [cSup, sSup] = InMemoryTransport.createLinkedPair();
    const supServer = buildServer(null, "support", cfg);
    const supClient = new Client({ name: "t-sup", version: "0.1.0" }, { capabilities: {} });
    await Promise.all([supServer.connect(sSup), supClient.connect(cSup)]);
    const supTools = (await supClient.listTools()).tools.map((t) => t.name);
    assert.deepEqual(supTools.sort(), ["get_doc", "search_knowledge"]);
    await supClient.close();
    await supServer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
