import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuardConfig } from "../src/types.ts";
import { CuaClient } from "../src/qa/cua_client.ts";
import type { CuaTransport } from "../src/qa/cua_client.ts";
import { createHybridDriver } from "../src/qa/driver.ts";
import { LiveSessionController, executeJourneyDsl, parseJourneyDsl } from "../src/qa/dsl.ts";
import { MAX_EXPLORE_STEPS, exploreScreen } from "../src/qa/explorer.ts";
import { draftJourneyFromRecording } from "../src/qa/recorder.ts";
import { extendForbidden, judgeActionByTier, loadForbidden } from "../src/qa/safety.ts";

function makeTempCfg(): { dir: string; cfg: GuardConfig } {
  const dir = mkdtempSync(join(tmpdir(), "guard-dsl-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "vault", "inbox"), { recursive: true });
  mkdirSync(join(dir, "qa"), { recursive: true });
  const realRoot = join(import.meta.dirname, "..", "..");
  return {
    dir,
    cfg: {
      root: realRoot,
      dataDir: join(dir, "data"),
      vaultDir: join(dir, "vault"),
      repos: [],
      busyProcesses: [],
    },
  };
}

function makeFakeCuaTransport(calls: { name: string; args: Record<string, unknown> }[]): CuaTransport {
  const pngTiny = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ).toString("base64");
  return {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "get_window_state") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tree: [
                  { element_token: "t1", role: "button", name: "Orders", text: "Orders", bounds: { x: 10, y: 10, width: 90, height: 30 } },
                  { element_token: "t2", role: "button", name: "New chat", text: "New chat", bounds: { x: 110, y: 10, width: 90, height: 30 } },
                  { element_token: "t3", role: "button", name: "Save to SPIL Glass", text: "Save to SPIL Glass", bounds: { x: 220, y: 10, width: 140, height: 30 } },
                ],
              }),
            },
            ...(args["include_screenshot"] ? [{ type: "image", data: pngTiny, mimeType: "image/png" }] : []),
          ],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    },
    async close() {},
  };
}

test("tiered safety allows Tier 1 local sandbox actions while hard-blocking Tier 2 ERP & messaging mutations", () => {
  const root = join(import.meta.dirname, "..", "..");
  const list = loadForbidden(root);

  // Tier 0 blocks "New chat"
  const t0New = judgeActionByTier({ role: "button", name: "New chat", control: true }, "New chat", list, { tier: 0 });
  assert.equal(t0New.allowed, false);

  // Tier 1 allows "New chat" and "Send" in chat context
  const t1New = judgeActionByTier({ role: "button", name: "New chat", control: true }, "New chat", list, { tier: 1, screenContext: "home chat" });
  assert.equal(t1New.allowed, true);
  const t1SendChat = judgeActionByTier({ role: "button", name: "Send", control: true, submits: true }, "Send", list, { tier: 1, screenContext: "chat" });
  assert.equal(t1SendChat.allowed, true);

  // Tier 1 STILL hard-blocks "Send" on WhatsApp/Messaging and "Save to SPIL Glass"
  const t2WhatsApp = judgeActionByTier({ role: "button", name: "Send", control: true }, "Send", list, { tier: 1, screenContext: "whatsapp" });
  assert.equal(t2WhatsApp.allowed, false);
  assert.equal(t2WhatsApp.tier, 2);
  const t2Erp = judgeActionByTier({ role: "button", name: "Save to SPIL Glass", control: true }, "Save to SPIL Glass", list, { tier: 1 });
  assert.equal(t2Erp.allowed, false);
  assert.equal(t2Erp.tier, 2);

  // extendForbidden cannot allow a Tier 2 hard-blocked item in Tier 1
  const extended = extendForbidden(list, { tier2HardBlockedNames: ["new chat"] });
  const afterExtend = judgeActionByTier({ role: "button", name: "New chat", control: true }, "New chat", extended, { tier: 1 });
  assert.equal(afterExtend.allowed, false);
});

test("CuaClient normalizes bounds and validates setWindowFrame bounds", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = new CuaClient(makeFakeCuaTransport(calls));
  const st = await client.getWindowState(200, "w-aura", false);
  assert.deepEqual(st.tree[0]?.bounds, { x: 10, y: 10, width: 90, height: 30 });

  await client.setWindowFrame(200, "w-aura", 800, 760);
  const frameCall = calls.find((c) => c.name === "set_window_frame");
  assert.ok(frameCall);
  assert.equal(frameCall.args["delivery_mode"], "background");
  assert.equal(frameCall.args["width"], 800);

  await assert.rejects(() => client.setWindowFrame(200, "w-aura", 100, 760), /Invalid window frame width/);
});

test("HybridAuraDriver, JourneyDsl parser/interpreter, LiveSessionController, Recorder, and Explorer", async () => {
  const { dir, cfg } = makeTempCfg();
  try {
    const md = [
      "# Sample Journey",
      "```qa-steps",
      JSON.stringify({
        id: "journey-orders-smoke",
        title: "Orders Smoke",
        tier: 0,
        widths: [800],
        steps: [
          { action: "click", target: "Orders" },
          { action: "capture", label: "orders-view" },
          { action: "assert_oracles" },
        ],
      }),
      "```",
    ].join("\n");
    const dsl = parseJourneyDsl(md);
    assert.equal(dsl.id, "journey-orders-smoke");

    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const cuaClient = new CuaClient(makeFakeCuaTransport(calls));
    const driver = createHybridDriver({
      cfg,
      cuaClient,
      window: { pid: 200, windowId: "w-aura", title: "SPIL AURA", processName: "personal-agent.exe" },
      forbidden: loadForbidden(cfg.root),
      shotDir: join(dir, "shots"),
    });
    assert.equal(driver.telemetryMode, "cua-only");

    const ctrl = new LiveSessionController();
    const res = await executeJourneyDsl(driver, dsl, { controller: ctrl, hints: ["Check Orders button"] });
    assert.equal(res.status, "passed");
    assert.equal(res.screenshots.length, 1);
    assert.ok(existsSync(res.screenshots[0]!.path));
    assert.equal(ctrl.getSnapshot().state, "completed");
    assert.equal(ctrl.getSnapshot().hints[0], "Check Orders button");

    // Pause / Step Over / Abort gate test
    const ctrl2 = new LiveSessionController();
    ctrl2.start("r2", "j2", 2);
    ctrl2.pause();
    assert.equal(ctrl2.getSnapshot().state, "paused");
    ctrl2.stepOver();
    assert.equal(await ctrl2.waitForGate(), "continue");
    assert.equal(ctrl2.getSnapshot().state, "paused");
    ctrl2.abort();
    assert.equal(await ctrl2.waitForGate(), "abort");

    // Recorder
    const drafted = draftJourneyFromRecording(cfg, {
      id: "orders-nav",
      title: "Orders Navigation",
      area: "orders",
      events: [{ action: "click", target: "Orders" }, { action: "resize", width: 800 }],
      writeProposal: true,
    });
    assert.ok(drafted.proposedPath && existsSync(drafted.proposedPath));
    assert.match(readFileSync(drafted.proposedPath, "utf8"), /status: proposed/);

    // Explorer (respects Tier 0 safety and skips Tier 2 Save to SPIL Glass)
    const exp = await exploreScreen(driver, { area: "home", widths: [800], maxSteps: MAX_EXPLORE_STEPS + 10 });
    assert.ok(exp.visitedControls.includes("Orders"));
    assert.ok(exp.skippedBlockedControls.includes("Save to SPIL Glass"));
    assert.equal(exp.defects.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
