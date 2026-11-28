// Provider settings: turned-off providers, CLI paths and the routes. No real CLI or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fixtureUiDir, tmpCfg } from "./chat-helpers.ts";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import { binaryPathProblem, programName } from "../src/brain/provider-config.ts";
import { buildBackends, pickBackend } from "../src/brain/select.ts";
import type { SelectOptions } from "../src/brain/select.ts";
import { loadSettings, saveSettings, updateSettings } from "../src/brain/settings.ts";

const noSecrets = () => ({ kind: "memory", available: async () => false, exists: async () => false, get: async () => null, set: async () => {}, remove: async () => {} }) as never;
const options = (env: Record<string, string>): SelectOptions => ({ env, launcher: null, opencodeLauncher: null, secrets: noSecrets(), secretsFor: noSecrets });

test("a turned-off provider is not picked, selected, probed or called", async () => {
  const cfg = tmpCfg();
  const o = options({ ANTHROPIC_API_KEY: "k".repeat(30) });
  assert.equal((await pickBackend(cfg, o)).backend.id, "anthropic-api");
  saveSettings(cfg.dataDir, { version: 1, brain: { models: {} }, providers: { "anthropic-api": { enabled: false } } });
  await assert.rejects(pickBackend(cfg, o), /No model backend/);
  await assert.rejects(pickBackend(cfg, { ...o, env: { ...o.env, AURA_GUARD_BRAIN: "anthropic-api" } }), /Turned off/);
  const off = buildBackends(cfg, o).find((b) => b.id === "anthropic-api")!;
  await assert.rejects(off.complete({ role: "chat", system: [], user: "x", maxTokens: 1, audit: () => assert.fail() }), /Turned off/);
  assert.equal(updateSettings(cfg.dataDir, { backend: "anthropic-api" }).ok, false);
  assert.equal(updateSettings(cfg.dataDir, { models: { "claude-cli": "opus" } }).ok, true);
  assert.equal(loadSettings(cfg.dataDir).settings.providers!["anthropic-api"]!.enabled, false, "other settings changes keep provider settings");
});

test("program paths: only the CLI's own executable, absolute and local", () => {
  const dir = join(tmpCfg().root, "bin");
  mkdirSync(dir, { recursive: true });
  const good = join(dir, programName("claude-cli"));
  copyFileSync(process.execPath, good);
  writeFileSync(join(dir, "cmd.exe"), "x");
  assert.equal(binaryPathProblem("claude-cli", good), null);
  for (const p of [join(dir, "cmd.exe"), programName("claude-cli"), join(dir, "missing", programName("claude-cli")), `\\\\host\\share\\${programName("claude-cli")}`, `//host/share/${programName("claude-cli")}`]) {
    assert.ok(binaryPathProblem("claude-cli", p), p);
  }
  assert.ok(binaryPathProblem("antigravity-cli", good));
  assert.ok(binaryPathProblem("openai-api", good));
});

test("routes: shape, validation, health interval and no secrets", async () => {
  const cfg = tmpCfg();
  const TOKEN = "s".repeat(48);
  const KEY = "k".repeat(30);
  const server: Server = createGuardServer(cfg, {
    token: TOKEN, uiDir: fixtureUiDir(), openIndex: () => null, brain: options({ ANTHROPIC_API_KEY: KEY }),
    complete: async () => ({ text: "x", usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Cookie: `${COOKIE_NAME}=${TOKEN}`, "Content-Type": "application/json" };
  const call = async (method: string, path: string, body?: object) => {
    const r = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, text, json: JSON.parse(text) as any };
  };
  try {
    assert.equal((await fetch(`${base}/api/providers`)).status, 401);
    const first = await call("GET", "/api/providers");
    assert.equal(first.json.healthCheckSeconds, 300);
    const api = first.json.providers.find((p: any) => p.id === "anthropic-api");
    assert.deepEqual([api.enabled, api.available, api.inUse, api.keySource, api.envVar, api.supportsHomeDir], [true, true, true, "env", "ANTHROPIC_API_KEY", false]);
    assert.match(api.detail, /not been checked/);
    assert.ok(!first.text.includes(KEY));
    assert.equal((await call("GET", "/api/providers")).json.checkedAt, first.json.checkedAt, "cached");

    const off = (await call("PUT", "/api/providers/anthropic-api", { enabled: false, displayName: "Work key" })).json.providers.find((p: any) => p.id === "anthropic-api");
    assert.deepEqual([off.enabled, off.available, off.inUse, off.displayName], [false, false, false, "Work key"]);
    assert.equal((await call("PUT", "/api/brain", { backend: "anthropic-api" })).status, 400);
    const reset = (await call("PUT", "/api/providers/anthropic-api", { reset: true })).json.providers.find((p: any) => p.id === "anthropic-api");
    assert.deepEqual([reset.enabled, reset.displayName], [true, null]);

    assert.equal((await call("PUT", "/api/providers/claude-cli", { homeDir: cfg.root })).status, 200);
    for (const [id, body] of [
      ["claude-cli", { binaryPath: process.execPath }], ["antigravity-cli", { homeDir: cfg.root }], ["claude-cli", { args: ["--x"] }],
      ["claude-cli", { env: { A: "1" } }], ["openai-api", { baseUrl: "https://evil.example" }], ["claude-cli", { displayName: "x".repeat(61) }],
    ] as const) assert.equal((await call("PUT", `/api/providers/${id}`, body)).status, 400, JSON.stringify(body));
    assert.equal((await call("PUT", "/api/providers/codex", { enabled: true })).status, 404);
    for (const bad of [30, 4000, 90.5, "60"]) assert.equal((await call("PUT", "/api/providers", { healthCheckSeconds: bad })).status, 400, String(bad));
    assert.equal((await call("PUT", "/api/providers", { healthCheckSeconds: 0 })).json.healthCheckSeconds, 0);
    assert.ok(!readFileSync(join(cfg.dataDir, "settings.json"), "utf8").includes(KEY));
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  }
});
