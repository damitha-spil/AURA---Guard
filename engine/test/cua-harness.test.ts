import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuardConfig } from "../src/types.ts";
import {
  CuaBackgroundUnavailableError, CuaClient, CuaToolBlockedError,
} from "../src/qa/cua_client.ts";
import type { CuaTransport } from "../src/qa/cua_client.ts";
import { createCuaStepContext, judgeTargetWindow, selectTargetWindow } from "../src/qa/cua_harness.ts";
import { ForbiddenActionError } from "../src/qa/harness.ts";
import { runJourneyWithCua } from "../src/qa/runner.ts";
import { cuaDriverStatus } from "../src/qa/harness_api.ts";
import { loadForbidden } from "../src/qa/safety.ts";

function makeCfg(dir: string, allowedApps?: string[]): GuardConfig {
  mkdirSync(join(dir, "qa"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "vault"), { recursive: true });
  writeFileSync(join(dir, "qa", "forbidden-actions.json"), JSON.stringify({
    names: ["save*", "delete*", "submit*"],
    selectors: [],
    keys: ["ctrl+s"],
    allowedHosts: ["127.0.0.1"],
    allowedUploadDirs: [],
  }));
  return {
    root: dir,
    dataDir: join(dir, "data"),
    vaultDir: join(dir, "vault"),
    repos: [],
    busyProcesses: [],
    cuaDriver: { command: "nonexistent-cua-driver-bin", ...(allowedApps ? { allowedApps } : {}) },
  };
}

function fakeTransport(calls: { name: string; args: Record<string, unknown> }[], opts?: { failBg?: boolean }): CuaTransport {
  return {
    async callTool(name, args) {
      calls.push({ name, args });
      if (opts?.failBg && (name === "click" || name === "type_text")) {
        return { isError: true, content: [{ type: "text", text: "background_unavailable: window requires elevation" }] };
      }
      if (name === "list_windows") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              windows: [
                { pid: 100, windowId: "w-ps", title: "Windows PowerShell", processName: "powershell.exe" },
                { pid: 200, windowId: "w-aura", title: "SPIL AURA", processName: "personal-agent.exe" },
              ],
            }),
          }],
        };
      }
      if (name === "get_window_state") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tree: [
                  { element_token: "tok-search", role: "textbox", name: "Search orders", text: "Search orders", value: "" },
                  { element_token: "tok-save", role: "button", name: "Save Order", text: "Save Order", value: "" },
                  { element_token: "tok-orders", role: "tab", name: "Orders", text: "Orders", value: "" },
                ],
              }),
            },
            { type: "image", mimeType: "image/png", data: Buffer.from("PNG_BYTES").toString("base64") },
          ],
        };
      }
      return { content: [{ type: "text", text: "{}" }] };
    },
    async close() {},
  };
}

test("CuaClient blocks dangerous tools and enforces background delivery_mode", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = new CuaClient(fakeTransport(calls));

  await assert.rejects(() => (client as unknown as { invoke: (t: string, a: Record<string, unknown>) => Promise<unknown> }).invoke("kill_app", {}), CuaToolBlockedError);
  await assert.rejects(() => (client as unknown as { invoke: (t: string, a: Record<string, unknown>) => Promise<unknown> }).invoke("bring_to_front", {}), CuaToolBlockedError);
  await assert.rejects(() => (client as unknown as { invoke: (t: string, a: Record<string, unknown>) => Promise<unknown> }).invoke("get_desktop_state", {}), CuaToolBlockedError);

  await client.clickToken("tok-orders");
  assert.equal(calls[0]!.name, "click");
  assert.equal(calls[0]!.args["delivery_mode"], "background");
});

test("judgeTargetWindow refuses shells/ERP and selectTargetWindow picks Aura", () => {
  const dir = mkdtempSync(join(tmpdir(), "cua-win-"));
  try {
    const cfg = makeCfg(dir, ["personal-agent.exe"]);
    const wins = [
      { pid: 100, windowId: "w-ps", title: "PowerShell", processName: "powershell.exe" },
      { pid: 101, windowId: "w-erp", title: "SPIL Glass", processName: "spilglass.exe" },
      { pid: 200, windowId: "w-aura", title: "SPIL AURA", processName: "personal-agent.exe" },
    ];
    assert.ok(judgeTargetWindow(wins[0]!, cfg));
    assert.ok(judgeTargetWindow(wins[1]!, cfg));
    assert.equal(judgeTargetWindow(wins[2]!, cfg), null);
    assert.equal(selectTargetWindow(wins, cfg).windowId, "w-aura");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cua_harness blocks forbidden element clicks and commit keys before calling cua-driver", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cua-guard-"));
  try {
    const cfg = makeCfg(dir, ["personal-agent.exe"]);
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = new CuaClient(fakeTransport(calls));
    const ctx = createCuaStepContext({
      client,
      window: { pid: 200, windowId: "w-aura", title: "SPIL AURA", processName: "personal-agent.exe" },
      forbidden: loadForbidden(dir),
      shotDir: join(dir, ".artifacts", "qa", "test-run"),
      record: () => {},
    });

    await ctx.observe(true);
    await assert.rejects(() => ctx.clickByName("Save Order"), ForbiddenActionError);
    await assert.rejects(() => ctx.pressKey("Ctrl+S"), ForbiddenActionError);
    await assert.rejects(() => ctx.pressKey("Enter", "Orders tab"), ForbiddenActionError);

    // Search box Enter and safe tab click are allowed and stay in background mode
    await ctx.clickByName("Orders");
    await ctx.typeByName("Search orders", "4471");
    await ctx.pressKey("Enter", "Search orders");

    assert.ok(!calls.some((c) => c.args["element_token"] === "tok-save"));
    assert.ok(calls.some((c) => c.name === "click" && c.args["element_token"] === "tok-orders" && c.args["delivery_mode"] === "background"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runJourneyWithCua records defects, saves screenshots, and handles background_unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cua-run-"));
  try {
    const cfg = makeCfg(dir, ["personal-agent.exe"]);
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = new CuaClient(fakeTransport(calls, { failBg: true }));

    const res = await runJourneyWithCua(cfg, "journey-orders-list", async (ctx) => {
      await ctx.step("Open Orders tab", "Orders tab opens in background", async () => {
        await ctx.clickByName("Orders");
      });
    }, {}, { cuaClient: client });

    assert.equal(res.status, "failed");
    assert.equal(res.defects.length, 1);
    assert.ok(res.defects[0]!.actual.includes("background_unavailable"));
    assert.ok(res.defects[0]!.screenshot && existsSync(res.defects[0]!.screenshot));

    const drv = await cuaDriverStatus(cfg);
    assert.equal(drv.available, false);
    assert.equal(drv.deliveryMode, "background");
    assert.ok(drv.blockedTools.includes("kill_app"));
    assert.ok(CuaBackgroundUnavailableError.name === "CuaBackgroundUnavailableError");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
