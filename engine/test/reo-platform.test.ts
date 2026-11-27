import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREBUILT_AGENTS, routeIntentToAgents } from "../src/agents/registry.ts";
import { runAgenticMission } from "../src/agents/runner.ts";
import { BUILTIN_TOOLS } from "../src/tools/registry.ts";
import {
  computeDefectFingerprint,
  generateDefectReportHtml,
  listDefects,
  saveDefectReportHtml,
  updateDefectStatus,
  upsertDefect,
} from "../src/defects/store.ts";
import {
  buildTeamsDefectPayload,
  listPlugins,
  listTeamMembers,
  removeTeamMember,
  updatePlugin,
  upsertTeamMember,
} from "../src/plugins/store.ts";

test("REO orchestrator: general knowledge stays on landing, operational tasks route to workspace", () => {
  const k = routeIntentToAgents("What is our architecture rule for ERP writes?");
  assert.equal(k.destination, "landing");
  assert.deepEqual(k.agents, ["knowledge"]);

  const qa = routeIntentToAgents("QA the latest branch and crawl the order form");
  assert.equal(qa.destination, "workspace");
  assert.ok(qa.agents.includes("qa"));

  const sec = routeIntentToAgents("Run security probes for SQLi and XSS on localhost");
  assert.equal(sec.destination, "workspace");
  assert.ok(sec.agents.includes("security"));

  const mention = routeIntentToAgents("@review please inspect PR 42");
  assert.equal(mention.destination, "workspace");
  assert.ok(mention.agents.includes("review"));

  assert.equal(PREBUILT_AGENTS.length, 7);
  assert.ok(BUILTIN_TOOLS.length >= 17);
});

test("defects store: deduplicates by SHA-256 fingerprint, updates status, and exports escaped HTML report", () => {
  const dir = mkdtempSync(join(tmpdir(), "reo-defects-"));
  try {
    const fp = computeDefectFingerprint({ appName: "SPIL AURA", branch: "feat/orders", title: "Button missing type", fileRef: "OrderForm.tsx:12" });
    assert.equal(fp.length, 12);

    const d1 = upsertDefect(dir, {
      appName: "SPIL AURA",
      branch: "feat/orders",
      commitSha: "abc1234",
      testedBy: "QA Lead",
      assignedTo: "Alex",
      agentSource: "review",
      severity: "high",
      title: "Button missing type",
      expected: "Submit button should declare type=\"button\"",
      actual: "Reloads form <script>alert(1)</script>",
      reproSteps: ["Open Orders", "Click Add"],
      codeSuggestion: "Add type=\"button\" to <button>",
      fileRef: "OrderForm.tsx:12",
      evidencePaths: [".artifacts/qa/run-1/snap.png"],
    });
    const d2 = upsertDefect(dir, {
      appName: "SPIL AURA",
      branch: "feat/orders",
      commitSha: "abc1234",
      testedBy: "QA Lead",
      assignedTo: "Alex",
      agentSource: "review",
      severity: "high",
      title: "Button missing type",
      expected: "Submit button should declare type=\"button\"",
      actual: "Reloads form",
      reproSteps: ["Open Orders"],
      codeSuggestion: "Add type=\"button\"",
      fileRef: "OrderForm.tsx:12",
      evidencePaths: [],
    });
    assert.equal(d1.id, d2.id);
    assert.equal(listDefects(dir).length, 1);

    const patched = updateDefectStatus(dir, d1.id, { status: "triaged" });
    assert.equal(patched?.status, "triaged");

    const html = generateDefectReportHtml(listDefects(dir), { appName: "SPIL AURA", branch: "feat/orders", generatedBy: "Tester" });
    assert.match(html, /SPIL REO/);
    assert.match(html, /POWERED BY SPIL LABS/);
    assert.ok(!html.includes("<script>alert(1)</script>"), "HTML must escape untrusted defect text");

    const saved = saveDefectReportHtml(dir, html, "feat/orders");
    assert.ok(readFileSync(saved, "utf8").includes("Quality &amp; Defect Assurance Report"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugins store & team directory: configures Composio/MS Teams and builds adaptive card payload", () => {
  const dir = mkdtempSync(join(tmpdir(), "reo-plugins-"));
  try {
    const initial = listPlugins(dir);
    assert.ok(initial.some((p) => p.id === "composio"));
    assert.ok(initial.some((p) => p.id === "ms-teams"));

    const updated = updatePlugin(dir, "composio", { enabled: true, endpoint: "https://backend.composio.dev" });
    assert.equal(updated?.enabled, true);
    assert.equal(updated?.status, "configured");

    const m = upsertTeamMember(dir, {
      name: "Damitha",
      email: "damitha@example.com",
      gitAlias: "damitha",
      role: "Frontend",
      teamsWebhookOrId: "https://teams.example.com/webhook/123",
    });
    assert.equal(listTeamMembers(dir).length, 1);

    const card = buildTeamsDefectPayload({
      recipientName: m.name,
      note: "Urgent check",
      defects: [{ id: "DEF-123456", title: "XSS risk", severity: "high", appName: "SPIL AURA", branch: "dev", codeSuggestion: "Escape text" }],
    });
    assert.equal(card["@type"], "MessageCard");
    assert.equal(removeTeamMember(dir, m.id), true);
    assert.equal(listTeamMembers(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agentic mission runner: streams mission, plan, and real tool execution events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reo-mission-"));
  try {
    const fakeCfg = {
      root: dir,
      dataDir: dir,
      vaultDir: dir,
      repos: [],
      project: { id: "test", name: "Test App" },
    } as unknown as Parameters<typeof runAgenticMission>[0];
    const events: string[] = [];
    const res = await runAgenticMission(fakeCfg, "@qa crawl UI features", (ev) => {
      events.push(ev.type);
    });
    assert.ok(res.agents.includes("qa"));
    assert.ok(events.includes("mission"));
    assert.ok(events.includes("plan"));
    assert.ok(events.includes("tool"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
