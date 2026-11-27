import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadCatalogue, validateModelId, BUILTIN_MODELS } from "../src/brain/models.ts";
import { effectiveBrain, loadSettings, machineDataDir, saveSettings, settingsFile, updateSettings } from "../src/brain/settings.ts";
import { createKeyStore, dpapiBackend, DPAPI_FILE, KeyStoreError, scrubSecrets, validateApiKey } from "../src/brain/keystore.ts";
import type { SecretBackend } from "../src/brain/keystore.ts";
import { createBrain, describeBackends } from "../src/brain/select.ts";
import { runBrainSettings } from "../src/cli/commands-brain.ts";
import type { GuardConfig } from "../src/types.ts";

/** Throwaway fake: built at run time, never a real key. */
const fakeKey = (): string => "sk-ant-" + "fake" + randomBytes(18).toString("hex");

function tmp() {
  const root = mkdtempSync(join(tmpdir(), "guard-bset-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const cfg = { dataDir, vaultDir: join(root, "vault"), repos: [], busyProcesses: [], root } as GuardConfig;
  return { root, dataDir, cfg, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function memoryStore(): SecretBackend & { value: string | null } {
  const s: SecretBackend & { value: string | null } = {
    name: "dpapi",
    value: null,
    available: async () => true,
    exists: async () => s.value !== null,
    set: async (v) => { s.value = v; },
    get: async () => s.value,
    remove: async () => { s.value = null; },
  };
  return s;
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => join(dir, f)).filter((f) => existsSync(f) && !readdirSyncSafe(f));
}
function readdirSyncSafe(p: string): boolean {
  try { readdirSync(p); return true; } catch { return false; }
}

// ---- settings ----

test("no settings file: defaults, and existing config still applies", () => {
  const t = tmp();
  const eff = effectiveBrain(t.cfg, {});
  assert.equal(eff.backend, "auto");
  assert.equal(eff.backendSource, "default");
  assert.equal(eff.models["anthropic-api"].id, "claude-sonnet-5-5");
  assert.equal(eff.models["claude-cli"].id, "sonnet");
  const withConfig = { ...t.cfg, brain: { backend: "claude-cli", models: { "claude-cli": "haiku" } } } as GuardConfig;
  const e2 = effectiveBrain(withConfig, {});
  assert.deepEqual([e2.backend, e2.backendSource, e2.models["claude-cli"].id, e2.models["claude-cli"].source], ["claude-cli", "config", "haiku", "config"]);
  t.cleanup();
});

test("precedence: env > settings.json > config > default, QSB_ before AURA_GUARD_", () => {
  const t = tmp();
  const cfg = { ...t.cfg, brain: { backend: "anthropic-api", models: { "claude-cli": "haiku" } } } as GuardConfig;
  assert.equal(updateSettings(t.dataDir, { backend: "claude-cli", models: { "claude-cli": "opus" } }).ok, true);
  let e = effectiveBrain(cfg, {});
  assert.deepEqual([e.backend, e.backendSource, e.models["claude-cli"].id, e.models["claude-cli"].source], ["claude-cli", "settings", "opus", "settings"]);
  e = effectiveBrain(cfg, { AURA_GUARD_BRAIN: "anthropic-api", AURA_GUARD_CLI_MODEL: "sonnet" });
  assert.deepEqual([e.backend, e.backendSource, e.models["claude-cli"].id, e.models["claude-cli"].source], ["anthropic-api", "env", "sonnet", "env"]);
  e = effectiveBrain(cfg, { AURA_GUARD_BRAIN: "anthropic-api", QSB_BRAIN: "auto", AURA_GUARD_MODEL: "x-model", QSB_MODEL: "claude-opus-5-5" });
  assert.equal(e.backend, "auto");
  assert.equal(e.models["anthropic-api"].id, "claude-opus-5-5");
  t.cleanup();
});

test("settings: validation, clearing, atomic write and .bak", () => {
  const t = tmp();
  assert.equal(updateSettings(t.dataDir, { backend: "gpt" }).ok, false);
  assert.equal(updateSettings(t.dataDir, { models: { "claude-cli": "; rm -rf /" } }).ok, false);
  assert.equal(updateSettings(t.dataDir, { models: { nope: "opus" } }).ok, false);
  assert.equal(updateSettings(t.dataDir, { models: [] }).ok, false);
  assert.ok(!existsSync(settingsFile(t.dataDir)), "a refused change writes nothing");
  assert.equal(updateSettings(t.dataDir, { backend: "claude-cli" }).ok, true);
  assert.ok(!existsSync(settingsFile(t.dataDir) + ".bak"), "no .bak on the first write");
  assert.equal(updateSettings(t.dataDir, { models: { "anthropic-api": "claude-opus-5-5" } }).ok, true);
  assert.ok(existsSync(settingsFile(t.dataDir) + ".bak"));
  assert.equal(JSON.parse(readFileSync(settingsFile(t.dataDir) + ".bak", "utf8")).brain.models["anthropic-api"], undefined);
  const now = JSON.parse(readFileSync(settingsFile(t.dataDir), "utf8"));
  assert.deepEqual(now, { version: 1, brain: { backend: "claude-cli", models: { "anthropic-api": "claude-opus-5-5" } } });
  assert.equal(updateSettings(t.dataDir, { models: { "anthropic-api": null } }).ok, true);
  assert.deepEqual(loadSettings(t.dataDir).settings.brain.models, {});
  assert.ok(!readdirSync(t.dataDir).some((f) => f.endsWith(".tmp")), "no temp file is left");
  t.cleanup();
});

test("a broken settings.json is ignored, not fatal", () => {
  const t = tmp();
  writeFileSync(settingsFile(t.dataDir), "{ not json");
  const l = loadSettings(t.dataDir);
  assert.ok(l.problem);
  assert.equal(effectiveBrain(t.cfg, {}).backend, "auto");
  writeFileSync(settingsFile(t.dataDir), JSON.stringify({ version: 1, brain: { models: { "claude-cli": "a b" } } }));
  assert.ok(loadSettings(t.dataDir).problem);
  t.cleanup();
});

// ---- catalogue ----

test("model ids: plain ids pass, anything else is refused", () => {
  for (const ok of ["claude-sonnet-5-5", "sonnet", "claude-3-7:beta", "a.b_c-d"]) assert.equal(validateModelId(ok).ok, true, ok);
  for (const bad of ['"; rm -rf', "has space", "x".repeat(81), "", "-flag", "--model", "a;b", "a\nb", "a$(b)", 5, null]) {
    assert.equal(validateModelId(bad as unknown).ok, false, String(bad));
  }
  assert.equal(validateModelId("x".repeat(80)).ok, true);
});

test("catalogue: roles/models.json has the expected models; a broken file falls back", () => {
  const real = loadCatalogue(join(import.meta.dirname, "..", ".."));
  assert.deepEqual(real.map((m) => m.id), BUILTIN_MODELS.map((m) => m.id));
  assert.deepEqual(real.filter((m) => m.default).map((m) => m.id).sort(), ["claude-sonnet-5-5", "gemini-4-neon-medium", "sonnet"]);
  for (const m of real) assert.ok(m.note.length > 0 && m.label.length > 0);
  const t = tmp();
  mkdirSync(join(t.root, "roles"));
  writeFileSync(join(t.root, "roles", "models.json"), "garbage");
  assert.deepEqual(loadCatalogue(t.root), BUILTIN_MODELS);
  writeFileSync(join(t.root, "roles", "models.json"), JSON.stringify({ version: 1, models: [{ id: "bad id", label: "x", note: "", backends: ["claude-cli"] }, { id: "mine", label: "Mine", note: "n", backends: ["claude-cli"] }] }));
  assert.deepEqual(loadCatalogue(t.root).map((m) => m.id), ["mine"]);
  t.cleanup();
});

// ---- key validation and store ----

test("api key validation: no prefix needed, bad shapes refused, no echo", () => {
  assert.equal(validateApiKey(fakeKey()).ok, true);
  assert.equal(validateApiKey("x".repeat(20)).ok, true);
  const bad = ["", "short", "x".repeat(301), "has a space in it 123456789", "line1\nline2-abcdefghijklmnop", "é".repeat(25), 7, undefined];
  for (const b of bad) assert.equal(validateApiKey(b as unknown).ok, false);
  assert.equal((validateApiKey("  " + "k".repeat(25) + "\r\n") as { key: string }).key, "k".repeat(25));
  const secret = "secret" + "Q".repeat(24) + " tail";
  const r = validateApiKey(secret);
  assert.ok(!r.ok && !JSON.stringify(r).includes("secretQ"));
});

test("scrubSecrets hides the known key and anything key-shaped", () => {
  const k = fakeKey();
  const out = scrubSecrets(`failed with ${k} and ${k.slice(0, 12)} also sk-ant-api03-abcdefghij`, [k]);
  assert.ok(!out.includes(k) && !out.includes("abcdefghij"));
});

test("key store with a fake backend: set/get/remove, env wins, key never in settings or files", async () => {
  const t = tmp();
  const be = memoryStore();
  const key = fakeKey();
  const store = createKeyStore({ dataDir: t.dataDir, env: {}, backend: be });
  assert.deepEqual(await store.status(), { source: null, backend: null });
  await store.set(key);
  updateSettings(t.dataDir, { backend: "anthropic-api" });
  assert.deepEqual(await store.status(), { source: "stored", backend: "dpapi" });
  assert.deepEqual(await store.resolve(), { key, source: "stored" });
  const st = JSON.stringify(await store.status());
  assert.ok(!st.includes(key.slice(0, 10)) && !/length|hash|last/.test(st));
  for (const f of allFiles(t.root)) assert.ok(!readFileSync(f, "utf8").includes(key), f);
  const envKey = fakeKey();
  const withEnv = createKeyStore({ dataDir: t.dataDir, env: { ANTHROPIC_API_KEY: envKey }, backend: be });
  assert.deepEqual(await withEnv.status(), { source: "env", backend: null });
  assert.equal((await withEnv.resolve())?.key, envKey);
  await store.remove();
  assert.equal(await store.resolve(), null);
  t.cleanup();
});

test("key store: refuses a bad key and an unavailable store without leaking", async () => {
  const t = tmp();
  const key = fakeKey();
  const none: SecretBackend = { ...memoryStore(), available: async () => false };
  const store = createKeyStore({ dataDir: t.dataDir, env: {}, backend: none });
  await assert.rejects(store.set(key), (e: unknown) => e instanceof KeyStoreError && /ANTHROPIC_API_KEY environment variable/.test(e.message) && !e.message.includes(key));
  const failing: SecretBackend = { ...memoryStore(), set: async (v) => { throw new Error(`boom with ${v}`); } };
  await assert.rejects(createKeyStore({ dataDir: t.dataDir, env: {}, backend: failing }).set(key), (e: unknown) => !(e as Error).message.includes(key));
  await assert.rejects(createKeyStore({ dataDir: t.dataDir, env: {}, backend: memoryStore() }).set("bad key"), (e: unknown) => e instanceof KeyStoreError);
  t.cleanup();
});

// ---- real DPAPI (Windows only) ----

test("DPAPI round trip on Windows with a throwaway secret", { skip: process.platform !== "win32" }, async () => {
  const t = tmp();
  const key = fakeKey();
  const be = dpapiBackend(t.dataDir);
  const file = join(t.dataDir, ...DPAPI_FILE);
  try {
    assert.equal(await be.available(), true);
    assert.equal(await be.exists?.(), false);
    await be.set(key);
    assert.ok(existsSync(file));
    const bytes = readFileSync(file);
    assert.ok(!bytes.includes(Buffer.from(key)), "plaintext is not on disk");
    assert.ok(!bytes.includes(Buffer.from(Buffer.from(key).toString("base64"))), "base64 of the plaintext is not on disk");
    assert.ok(!bytes.toString("utf8").includes(key.slice(8, 24)));
    assert.equal(await be.get(), key);
    const store = createKeyStore({ dataDir: t.dataDir, env: {}, backend: be });
    assert.deepEqual(await store.status(), { source: "stored", backend: "dpapi" });
    await be.remove();
    assert.ok(!existsSync(file));
    assert.equal(await be.get(), null);
  } finally {
    rmSync(file, { force: true });
    t.cleanup();
  }
});

// ---- the brain uses settings and the stored key ----

function fakeFetch(calls: { key: string; model: string }[]): typeof fetch {
  return (async (_url: unknown, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ key: init.headers["x-api-key"] ?? "", model: JSON.parse(init.body).model });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "OK" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("createBrain: a stored key is used when the env has none; env wins when set; settings pick the model", async () => {
  const t = tmp();
  const be = memoryStore();
  const key = fakeKey();
  await createKeyStore({ dataDir: t.dataDir, env: {}, backend: be }).set(key);
  updateSettings(t.dataDir, { models: { "anthropic-api": "claude-opus-5-5" } });
  const calls: { key: string; model: string }[] = [];
  const req = { role: "t", system: ["rules"], user: "say ok", maxTokens: 10 };
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try {
    const brain = createBrain(t.cfg, { env: {}, secrets: be, fetch: fakeFetch(calls), launcher: null });
    assert.equal((await brain.complete(req)).text, "OK");
    assert.equal(brain.backendUsed(), "anthropic-api");
    assert.deepEqual(calls[0], { key, model: "claude-opus-5-5" });
    const envKey = fakeKey();
    const b2 = createBrain(t.cfg, { env: { ANTHROPIC_API_KEY: envKey, AURA_GUARD_MODEL: "claude-haiku-5-5" }, secrets: be, fetch: fakeFetch(calls), launcher: null });
    await b2.complete(req);
    assert.deepEqual(calls[1], { key: envKey, model: "claude-haiku-5-5" });
  } finally {
    console.log = origLog;
  }
  assert.ok(!logged.join("\n").includes(key));
  for (const f of allFiles(t.root)) assert.ok(!readFileSync(f, "utf8").includes(key), f);
  const d = await describeBackends(t.cfg, { env: {}, secrets: be, launcher: null });
  assert.equal(d.picked, "anthropic-api");
  assert.ok(!JSON.stringify(d).includes(key));
  t.cleanup();
});

test("createBrain: settings.json backend choice is honoured and env still overrides it", async () => {
  const t = tmp();
  const be = memoryStore();
  await be.set(fakeKey());
  updateSettings(t.dataDir, { backend: "claude-cli" });
  const d = await describeBackends(t.cfg, { env: {}, secrets: be, launcher: null });
  assert.equal(d.wanted, "claude-cli");
  assert.equal(d.picked, null, "claude-cli chosen, none found: no silent fallback to the key");
  const d2 = await describeBackends(t.cfg, { env: { AURA_GUARD_BRAIN: "anthropic-api" }, secrets: be, launcher: null });
  assert.equal(d2.picked, "anthropic-api");
  t.cleanup();
});

// ---- CLI ----

test("brain CLI: backend, model, models, key set/status/remove; nothing secret is printed", async () => {
  const t = tmp();
  const be = memoryStore();
  const key = fakeKey();
  const lines: string[] = [];
  const run = (rest: string[], extra: { readSecret?: () => Promise<string> } = {}) =>
    runBrainSettings(rest[0], { rest, out: (s) => lines.push(s), cfg: t.cfg, env: {}, secrets: be, ...extra });
  assert.equal(await run(["backend", "claude-cli"]), 0);
  assert.equal(await run(["backend", "bogus"]), 2);
  assert.equal(await run(["model", "claude-cli", "opus"]), 0);
  assert.equal(await run(["model", "claude-cli", '"; rm -rf']), 2);
  assert.equal(await run(["model", "nope", "opus"]), 2);
  assert.equal(await run(["models"]), 0);
  assert.ok(lines.some((l) => l.includes("claude-sonnet-5-5")) && lines.some((l) => l.includes("[in use]")));
  assert.deepEqual(loadSettings(t.dataDir).settings.brain, { backend: "claude-cli", models: { "claude-cli": "opus" } });
  assert.equal(await run(["key", "status"]), 0);
  assert.ok(lines.some((l) => /API key: none/.test(l)));
  assert.equal(await run(["key", "set"], { readSecret: async () => "bad key" }), 2);
  assert.equal(await run(["key", "set"], { readSecret: async () => key + "\n" }), 0);
  assert.equal(be.value, key);
  assert.equal(await run(["key", "status"]), 0);
  assert.ok(lines.some((l) => /saved on this computer/.test(l)));
  assert.equal(await run(["key", "remove"]), 0);
  assert.equal(be.value, null);
  assert.ok(!lines.join("\n").includes(key.slice(0, 14)), "the key is never printed");
  assert.equal(await run(["key", "set", key], { readSecret: async () => "bad key" }), 2, "a key typed on the command line is ignored, never read from argv");
  t.cleanup();
});
