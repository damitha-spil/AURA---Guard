import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { GuardConfig } from "../src/types.ts";
import { crawlDesktopApp, probeDesktopCrawlers } from "../src/qa/desktop_crawler.ts";
import type { DesktopCrawlerTransport } from "../src/qa/desktop_crawler.ts";
import { findFeatureEntry, loadFeatureMap, verifyClaimEvidence } from "../src/qa/feature_map.ts";
import { evaluateSkillEffectiveness, recommendDurableConstraint } from "../src/qe/constraints.ts";
import { getSkill } from "../src/roles/skills.ts";

const ROOT = join(import.meta.dirname, "..", "..");

test("DesktopCrawler probes Windows UIA and crawls Aura safely while blocking Tier 2 ERP buttons", async () => {
  const cfg: GuardConfig = {
    root: ROOT,
    dataDir: join(ROOT, "data"),
    vaultDir: join(ROOT, "vault"),
    repos: [],
    busyProcesses: [],
    cuaDriver: { allowedApps: ["personal-agent.exe"] },
  };

  const avail = await probeDesktopCrawlers(cfg);
  assert.equal(avail.windowsUia.available, process.platform === "win32");

  const clicked: string[] = [];
  const fakeTransport: DesktopCrawlerTransport = {
    backendName: "fake-uia",
    async listWindows() {
      return [
        { pid: 100, windowId: "w-ps", title: "Windows PowerShell", processName: "powershell.exe" },
        { pid: 101, windowId: "w-erp", title: "SPIL Glass", processName: "spilglass.exe" },
        { pid: 200, windowId: "w-aura", title: "SPIL AURA", processName: "personal-agent.exe" },
      ];
    },
    async inspectTree() {
      return [
        { token: "u1", role: "button", name: "Orders", enabled: true, offscreen: false, safetyTier: 0 },
        { token: "u2", role: "button", name: "Settings", enabled: true, offscreen: false, safetyTier: 0 },
        { token: "u3", role: "button", name: "Save to SPIL Glass", enabled: true, offscreen: false, safetyTier: 2 },
      ];
    },
    async click(_pid, name) { clicked.push(name); },
    async type() {},
  };

  const res = await crawlDesktopApp(cfg, { matchTitle: "AURA", dryRun: false, maxActions: 5 }, fakeTransport);
  assert.equal(res.window.processName, "personal-agent.exe");
  assert.deepEqual(res.clicked, ["Orders", "Settings"]);
  assert.ok(res.blockedControls.includes("Save to SPIL Glass"));
  assert.equal(clicked.includes("Save to SPIL Glass"), false);
  assert.ok(res.draftedJourney.steps.length >= 2);
});

test("Lauren Poteto Rules: skill, Feature Map, Evidence-to-Claim, Durable Constraints & Skill Eval", () => {
  const cfg: GuardConfig = { root: ROOT, dataDir: join(ROOT, "data"), vaultDir: join(ROOT, "vault"), repos: [], busyProcesses: [] };

  const skill = getSkill(ROOT, "lauren-poteto-rules");
  assert.ok(skill && skill.body.includes("Earn Trust with Evidence"));

  const features = loadFeatureMap(cfg);
  assert.ok(features.length >= 4);
  assert.equal(findFeatureEntry(cfg, "orders")[0]?.id, "orders-list");

  assert.equal(verifyClaimEvidence({ claim: "appearance", hasScreenshot: false }).ok, false);
  assert.equal(verifyClaimEvidence({ claim: "interaction", exercisedStepsCount: 0 }).ok, false);
  assert.equal(verifyClaimEvidence({ claim: "interaction", exercisedStepsCount: 2 }).ok, true);
  assert.equal(verifyClaimEvidence({ claim: "performance", hasTimingTrace: true }).ok, true);
  assert.equal(verifyClaimEvidence({ claim: "api", hasRequestReadback: false }).ok, false);

  assert.equal(recommendDurableConstraint({
    pattern: "missing button type",
    occurrences: 2,
    mechanicallyDetectable: true,
    canDesignOutInTypesOrApi: false,
    isMultiStepProcedure: false,
  }).mechanism, "mechanical_check");

  assert.equal(recommendDurableConstraint({
    pattern: "raw IPC bypass",
    occurrences: 1,
    mechanicallyDetectable: false,
    canDesignOutInTypesOrApi: true,
    isMultiStepProcedure: false,
  }).mechanism, "architecture");

  const evalCmp = evaluateSkillEffectiveness(
    [{ inspectedCodeFirst: false, exercisedRuntimeFlow: false, validEvidenceProvided: false, stayedInScope: true }],
    [{ inspectedCodeFirst: true, exercisedRuntimeFlow: true, validEvidenceProvided: true, stayedInScope: true }],
  );
  assert.equal(evalCmp.beforeScore, 15);
  assert.equal(evalCmp.afterScore, 100);
  assert.equal(evalCmp.improved, true);
});
