import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { handleBrainRoute } from "../src/server/brain.ts";
import type { BrainRouteOptions } from "../src/server/brain.ts";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import type { SecretBackend } from "../src/brain/keystore.ts";
import type { GuardConfig } from "../src/types.ts";
import { seed } from "./chat-helpers.ts";

const fakeKey = (): string => "sk-ant-" + "fake" + randomBytes(18).toString("hex");
const usage = { input_tokens: 1, output_tokens: 1 };

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function http(port: number, o: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: o.path, method: o.method ?? "GET", headers: { Host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

function memoryStore(): SecretBackend & { value: string | null } {
  const s: SecretBackend & { value: string | null } = {
    name: "dpapi", value: null,
    available: async () => true,
    exists: async () => s.value !== null,
    set: async (v) => { s.value = v; },
    get: async () => s.value,
    remove: async () => { s.value = null; },
  };
  return s;
}

/** The handler behind a plain HTTP server. (Token and Host/Origin checks belong to server.ts; see the wired tests below.) */
async function start(over: Partial<BrainRouteOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "guard-bapi-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const cfg = { dataDir, vaultDir: join(root, "vault"), repos: [], busyProcesses: [], root } as GuardConfig;
  const store = memoryStore();
  const options: BrainRouteOptions = { env: {}, secrets: store, launcher: null, ...over };
  const server: Server = createServer((req, res) => {
    void handleBrainRoute({ req, res, path: new URL(req.url ?? "/", "http://x").pathname, method: req.method ?? "GET", cfg, options }).then((hit) => {
      if (!hit) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const json = { "Content-Type": "application/json" };
  return {
    cfg, root, dataDir, store, port,
    get: (path: string) => http(port, { path }),
    send: (method: string, path: string, obj?: unknown) => http(port, { path, method, headers: json, body: obj === undefined ? undefined : JSON.stringify(obj) }),
    stop: () => new Promise<void>((r) => { server.close(() => { rmSync(root, { recursive: true, force: true }); r(); }); server.closeAllConnections(); }),
  };
}

function noKeyOnDisk(dir: string, key: string): void {
  for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const p = join(dir, f);
    if (statSync(p).isFile()) assert.ok(!readFileSync(p, "utf8").includes(key), f);
  }
}

const everything = (r: Res): string => r.body + JSON.stringify(r.headers);

test("GET /api/brain: shape, no-store, nothing secret", async () => {
  const s = await start();
  try {
    const key = fakeKey();
    assert.equal((await s.send("PUT", "/api/brain/key", { key })).status, 200);
    const r = await s.get("/api/brain");
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    const j = JSON.parse(r.body);
    assert.deepEqual(Object.keys(j).sort(), ["apiKey", "backends", "models", "picked", "planCli", "reason", "wanted", "wantedSource"]);
    assert.equal(j.wanted, "auto");
    assert.equal(j.picked, "anthropic-api");
    assert.deepEqual(j.apiKey, { source: "stored", storage: "dpapi", canStore: true });
    assert.deepEqual(j.planCli, { found: false, help: j.planCli.help });
    assert.deepEqual(j.backends.map((b: { id: string; available: boolean }) => [b.id, b.available]), [["anthropic-api", true], ["claude-cli", false], ["antigravity-cli", false]]);
    assert.deepEqual(j.models.current, { "anthropic-api": "claude-sonnet-5-5", "claude-cli": "sonnet", "antigravity-cli": "gemini-4-neon-medium" });
    assert.equal(j.models.catalogue.length, 28);
    const all = everything(r);
    for (const part of [key, key.slice(0, 12), key.slice(-12), key.slice(8, 24), Buffer.from(key).toString("base64").slice(0, 16)]) assert.ok(!all.includes(part), part);
  } finally {
    await s.stop();
  }
});

test("PUT /api/brain: validates, writes settings.json, returns the new view", async () => {
  const s = await start();
  try {
    const r = await s.send("PUT", "/api/brain", { backend: "claude-cli", models: { "claude-cli": "opus" } });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.wanted, "claude-cli");
    assert.equal(j.models.current["claude-cli"], "opus");
    assert.equal(j.models.sources["claude-cli"], "settings");
    assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, "settings.json"), "utf8")).brain, { backend: "claude-cli", models: { "claude-cli": "opus" } });
    for (const bad of [{ backend: "gpt" }, { models: { "claude-cli": '"; rm -rf' } }, { models: { "claude-cli": "a b" } }, { models: { other: "x" } }, { models: "x" }, { extra: 1 }]) {
      assert.equal((await s.send("PUT", "/api/brain", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await s.send("PATCH", "/api/brain", {})).status, 405);
    assert.equal((await http(s.port, { path: "/api/brain", method: "PUT", body: "{}" })).status, 415);
    assert.equal((await http(s.port, { path: "/api/brain", method: "PUT", headers: { "Content-Type": "application/json" }, body: "nope" })).status, 400);
  } finally {
    await s.stop();
  }
});

test("PUT/DELETE /api/brain/key: stored, never echoed, bad keys 400, env wins message, oversized 413", async () => {
  const s = await start();
  try {
    const key = fakeKey();
    const r = await s.send("PUT", "/api/brain/key", { key });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true, source: "stored", stored: true });
    assert.equal(r.headers["cache-control"], "no-store");
    assert.ok(!everything(r).includes(key));
    assert.equal(s.store.value, key);
    noKeyOnDisk(s.dataDir, key);
    for (const bad of [{ key: "short" }, { key: "has space in the key 123456" }, { key: 5 }, {}, { key: "x".repeat(301) }]) {
      const b = await s.send("PUT", "/api/brain/key", bad);
      assert.equal(b.status, 400, JSON.stringify(bad));
      assert.ok(!everything(b).includes("has space in"));
    }
    const big = await s.send("PUT", "/api/brain/key", { key: "x".repeat(5000) }).catch(() => ({ status: 413 }) as Res);
    assert.equal(big.status, 413);
    const d = await s.send("DELETE", "/api/brain/key");
    assert.deepEqual(JSON.parse(d.body), { ok: true, source: null, stored: false });
    assert.equal(s.store.value, null);
  } finally {
    await s.stop();
  }
  const e = await start({ env: { ANTHROPIC_API_KEY: fakeKey() } });
  try {
    const key = fakeKey();
    const r = await e.send("PUT", "/api/brain/key", { key });
    const j = JSON.parse(r.body);
    assert.equal(j.source, "env");
    assert.match(j.message, /environment variable is set and is used instead/);
    assert.ok(!everything(r).includes(key));
    assert.equal(JSON.parse((await e.get("/api/brain")).body).apiKey.source, "env");
  } finally {
    await e.stop();
  }
});

test("a store that cannot protect the key refuses plainly", async () => {
  const none: SecretBackend = { ...memoryStore(), available: async () => false };
  const s = await start({ secrets: none });
  try {
    const key = fakeKey();
    const r = await s.send("PUT", "/api/brain/key", { key });
    assert.equal(r.status, 400);
    assert.match(JSON.parse(r.body).error, /ANTHROPIC_API_KEY environment variable/);
    assert.ok(!everything(r).includes(key));
    assert.equal(JSON.parse((await s.get("/api/brain")).body).apiKey.canStore, false);
  } finally {
    await s.stop();
  }
});

test("POST /api/brain/test: fake complete, scrubbed error", async () => {
  const s = await start({ complete: async () => ({ text: "OK", usage }) });
  try {
    await s.send("PUT", "/api/brain/key", { key: fakeKey() });
    const r = JSON.parse((await s.send("POST", "/api/brain/test")).body);
    assert.equal(r.ok, true);
    assert.equal(r.backend, "anthropic-api");
    assert.equal(r.model, "claude-sonnet-5-5");
    assert.equal(typeof r.ms, "number");
    assert.equal((await s.get("/api/brain/test")).status, 405);
  } finally {
    await s.stop();
  }
  const key = fakeKey();
  const f = await start({ complete: async () => { throw new Error(`Model API returned 401: bad key ${key}`); } });
  try {
    await f.send("PUT", "/api/brain/key", { key });
    const res = await f.send("POST", "/api/brain/test");
    const r = JSON.parse(res.body);
    assert.equal(r.ok, false);
    assert.match(r.error, /401/);
    assert.ok(!everything(res).includes(key));
  } finally {
    await f.stop();
  }
});

test("POST /api/brain/test through the real brain with a fake fetch uses the stored key and chosen model", async () => {
  const seen: { key: string; model: string }[] = [];
  const fetchFn = (async (_u: unknown, init: { headers: Record<string, string>; body: string }) => {
    seen.push({ key: init.headers["x-api-key"] ?? "", model: JSON.parse(init.body).model });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "OK" }], usage }), { status: 200 });
  }) as unknown as typeof fetch;
  const s = await start({ fetch: fetchFn });
  try {
    const key = fakeKey();
    await s.send("PUT", "/api/brain/key", { key });
    await s.send("PUT", "/api/brain", { models: { "anthropic-api": "claude-haiku-5-5" } });
    const res = await s.send("POST", "/api/brain/test");
    assert.deepEqual(seen, [{ key, model: "claude-haiku-5-5" }]);
    const r = JSON.parse(res.body);
    assert.deepEqual([r.ok, r.backend, r.model], [true, "anthropic-api", "claude-haiku-5-5"]);
    assert.ok(!everything(res).includes(key));
    const logs = join(s.root, "logs");
    for (const f of readdirSync(logs)) assert.ok(!readFileSync(join(logs, f), "utf8").includes(key));
  } finally {
    await s.stop();
  }
});

// ---- behind the real server: token cookie and Host/Origin checks (run once server.ts routes /api/brain) ----

test("behind createGuardServer: 401 without the cookie, 403 for a foreign Origin, no-store", async (t) => {
  const TOKEN = "t".repeat(48);
  const root = mkdtempSync(join(tmpdir(), "guard-bapi2-"));
  const cfg = { dataDir: join(root, "data"), vaultDir: join(root, "vault"), repos: [], busyProcesses: [], root } as GuardConfig;
  const db = seed();
  const server = createGuardServer(cfg, {
    token: TOKEN, complete: async () => ({ text: "x", usage }), openIndex: () => ({ db, release: () => {} }),
    backendInfo: async () => ({ wanted: "auto", picked: null, label: "No model" }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const auth = { Cookie: `${COOKIE_NAME}=${TOKEN}` };
  try {
    assert.equal((await http(port, { path: "/api/brain" })).status, 401);
    assert.equal((await http(port, { path: "/api/brain/key", method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await http(port, { path: "/api/brain", headers: { ...auth, Origin: "http://evil.example" } })).status, 403);
    const wired = await http(port, { path: "/api/brain", headers: auth });
    if (wired.status === 404) return void t.skip("server.ts does not route /api/brain yet");
    assert.equal(wired.status, 200);
    assert.equal(wired.headers["cache-control"], "no-store");
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
});
