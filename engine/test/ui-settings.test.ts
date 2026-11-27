// Tests for the pure part of ui/settings.js: validation, wording, lock rules, the reducer and the
// controller (with a fake fetch). The DOM half is checked in a real browser against the stub server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const mod = (await import(pathToFileURL(join(import.meta.dirname, "..", "..", "ui", "settings.js")).href)) as Any;
const { validateModelId, validateKeyInput, sourceLabel, locks, keyStatusText, protectionText, modelsFor, applyPatch, reduce, initialState, createController, formatSeconds, NO_STORE_TEXT } = mod;

const fakeKey = (): string => ["ANTHROPIC", "FAKE", "k3y"].join("-") + "x".repeat(24); // built at run time, never a real secret

function view(over: Record<string, unknown> = {}): Any {
  return {
    wanted: "auto", wantedSource: "default", picked: "claude-cli", reason: "AURA QA will use Claude plan (Claude Code).",
    backends: [
      { id: "auto", kind: "auto", label: "Automatic", available: true, detail: "ok" },
      { id: "anthropic-api", kind: "api", label: "Anthropic API key", available: false, detail: "No key" },
      { id: "claude-cli", kind: "cli", label: "Claude plan (Claude Code)", available: true, detail: "ok" },
    ],
    models: {
      current: { "anthropic-api": "claude-sonnet-5-5", "claude-cli": "sonnet" },
      sources: { "anthropic-api": "default", "claude-cli": "default" },
      catalogue: [
        { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "n", backends: ["anthropic-api"], default: true },
        { id: "claude-opus-5-5", label: "Opus 5.5", note: "n", backends: ["anthropic-api"] },
        { id: "sonnet", label: "Sonnet (plan)", note: "n", backends: ["claude-cli"], default: true },
      ],
    },
    apiKey: { source: null, storage: "dpapi", canStore: true },
    planCli: { found: true, version: "2.1.8" },
    ...over,
  };
}

test("model names: the server's pattern, plain messages", () => {
  for (const ok of ["claude-sonnet-5-5", "sonnet", "a", "x.y:z_1-2", " opus "]) assert.equal(validateModelId(ok).ok, true, ok);
  for (const bad of ["", "   ", "-abc", "has space", "a/b", "é", "a".repeat(81)]) {
    const r = validateModelId(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(r.error.length > 10 && !/regex|\^|\$/.test(r.error));
  }
  assert.equal(validateModelId(" opus ").value, "opus");
});

test("key input: 20-300 plain characters, no whitespace; messages never contain the key", () => {
  const k = fakeKey();
  assert.equal(validateKeyInput(k).ok, true);
  const bads = ["", "short", `${k} ${k}`, `${k}\n`, "k".repeat(301), `${k}é`, `${k}\t`];
  for (const b of bads) {
    const r = validateKeyInput(b);
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes(k) && !r.error.includes("ANTHROPIC-FAKE"));
  }
  assert.equal(validateKeyInput(undefined).ok, false);
});

test("source labels and lock rules", () => {
  assert.equal(sourceLabel("env"), "from the environment");
  assert.equal(sourceLabel("settings"), "saved here");
  assert.equal(sourceLabel("config"), "from the config file");
  assert.equal(sourceLabel("default"), "default");
  assert.equal(sourceLabel("nonsense"), "default");
  assert.deepEqual(locks(null), { backend: false, models: { "anthropic-api": false, "claude-cli": false, "antigravity-cli": false } });
  const l = locks(view({ wantedSource: "env", models: { ...view().models, sources: { "anthropic-api": "env", "claude-cli": "settings" } } }));
  assert.equal(l.backend, true);
  assert.equal(l.models["anthropic-api"], true);
  assert.equal(l.models["claude-cli"], false);
});

test("status wording follows the key source and storage", () => {
  assert.equal(keyStatusText({ source: null }), "No key saved");
  assert.equal(keyStatusText({ source: "env", storage: "dpapi" }), "Using the ANTHROPIC_API_KEY environment variable");
  assert.equal(keyStatusText({ source: "stored", storage: "dpapi" }), "Saved on this computer (encrypted by Windows)");
  assert.match(keyStatusText({ source: "stored", storage: "keychain" }), /Keychain/);
  assert.match(keyStatusText({ source: "stored", storage: "secret-service" }), /keyring/);
  assert.match(protectionText({ storage: "dpapi" }), /Encrypted for your Windows account only\. It protects the key from other users and from a copied disk, not from programs already running as you\./);
  assert.match(NO_STORE_TEXT, /ANTHROPIC_API_KEY/);
  assert.equal(formatSeconds(1420), "1.4 s");
  assert.equal(formatSeconds(23000), "23 s");
});

test("catalogue filter and optimistic patch", () => {
  const v = view();
  assert.deepEqual(modelsFor(v, "claude-cli").map((m: Any) => m.id), ["sonnet"]);
  const a = applyPatch(v, { backend: "anthropic-api", models: { "anthropic-api": "claude-opus-5-5" } });
  assert.equal(a.wanted, "anthropic-api");
  assert.equal(a.models.current["anthropic-api"], "claude-opus-5-5");
  assert.equal(a.models.sources["anthropic-api"], "settings");
  assert.equal(v.models.current["anthropic-api"], "claude-sonnet-5-5", "the original is not changed");
  const r = applyPatch(a, { models: { "anthropic-api": null } });
  assert.equal(r.models.current["anthropic-api"], "claude-sonnet-5-5");
  assert.equal(r.models.sources["anthropic-api"], "default");
});

test("reducer: load, save with revert, test states", () => {
  let s = initialState();
  assert.equal(s.phase, "loading");
  s = reduce(s, { type: "load-failed", error: "no" });
  assert.equal(s.phase, "error");
  s = reduce(s, { type: "loaded", view: view() });
  assert.equal(s.phase, "ready");
  s = reduce(s, { type: "load-failed", error: "later" });
  assert.equal(s.phase, "ready", "a failed refresh keeps what is on screen");
  const before = s.view;
  s = reduce(s, { type: "save-start", optimistic: applyPatch(before, { backend: "claude-cli" }) });
  assert.equal(s.saving, true);
  assert.equal(s.view.wanted, "claude-cli");
  s = reduce(s, { type: "save-failed", revertTo: before, error: "bad" });
  assert.equal(s.view.wanted, "auto");
  assert.equal(s.notice.kind, "error");
  s = reduce(s, { type: "test-start" });
  assert.equal(s.test.status, "running");
  s = reduce(s, { type: "test-done", result: { ok: true } });
  assert.equal(s.test.status, "done");
});

interface Call { path: string; method: string; body: string | undefined }
function fakeFetch(handlers: Record<string, (c: Call) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fn = async (path: string, init: Any = {}): Promise<Any> => {
    const c: Call = { path, method: init.method || "GET", body: init.body };
    calls.push(c);
    const h = handlers[`${c.method} ${path}`];
    if (!h) return { ok: false, status: 404, json: async () => ({ error: "Not found." }) };
    const r = h(c);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.json };
  };
  return { calls, fn };
}

test("controller: the key is sent only in the PUT body, cleared from state, never rendered or stored", async () => {
  const key = fakeKey();
  let stored = false;
  const { calls, fn } = fakeFetch({
    "GET /api/brain": () => ({ json: view({ apiKey: { source: stored ? "stored" : null, storage: "dpapi", canStore: true } }) }),
    "PUT /api/brain/key": () => { stored = true; return { json: { ok: true, source: "stored", stored: true } }; },
  });
  const seen: string[] = [];
  const ctl = createController({ fetchImpl: fn, onChange: (s: Any) => seen.push(JSON.stringify(s)) });
  await ctl.load();
  assert.equal(await ctl.saveKey(key), true);
  const withKey = calls.filter((c) => c.body?.includes(key));
  assert.equal(withKey.length, 1);
  assert.equal(withKey[0]!.method, "PUT");
  assert.equal(withKey[0]!.path, "/api/brain/key");
  assert.deepEqual(JSON.parse(withKey[0]!.body!), { key });
  for (const c of calls) assert.ok(!c.path.includes(key), "never in a URL");
  assert.equal(ctl.state.view.apiKey.source, "stored");
  assert.equal(ctl.state.notice.kind, "ok");
  const everything = [...seen, JSON.stringify(ctl.state)].join("\n");
  assert.ok(!everything.includes(key), "not in any state or message");
  assert.ok(!everything.includes(key.slice(-6)), "not even the last characters");
});

test("controller: a bad or failed key save shows a plain error without the key", async () => {
  const key = fakeKey();
  const { calls, fn } = fakeFetch({
    "GET /api/brain": () => ({ json: view() }),
    "PUT /api/brain/key": () => ({ status: 400, json: { error: "That does not look like an API key." } }),
  });
  const ctl = createController({ fetchImpl: fn, onChange: () => {} });
  await ctl.load();
  assert.equal(await ctl.saveKey(key), false);
  assert.equal(ctl.state.notice.text, "That does not look like an API key.");
  assert.ok(!JSON.stringify(ctl.state).includes(key));
  assert.equal(await ctl.saveKey("bad key"), false);
  assert.equal(calls.filter((c) => c.path === "/api/brain/key").length, 1, "an invalid key is never sent");
});

test("controller: optimistic save reverts on failure and shows the server's words", async () => {
  const { fn } = fakeFetch({ "GET /api/brain": () => ({ json: view() }), "PUT /api/brain": () => ({ status: 400, json: { error: "Unknown way of answering." } }) });
  const ctl = createController({ fetchImpl: fn, onChange: () => {} });
  await ctl.load();
  const p = ctl.save({ backend: "claude-cli" });
  assert.equal(ctl.state.view.wanted, "claude-cli", "optimistic");
  await p;
  assert.equal(ctl.state.view.wanted, "auto", "reverted");
  assert.equal(ctl.state.notice.text, "Unknown way of answering.");
  assert.equal(ctl.state.saving, false);
});

test("controller: changes made during a save are merged and sent next, in order", async () => {
  const sent: string[] = [];
  const { fn } = fakeFetch({ "GET /api/brain": () => ({ json: view() }), "PUT /api/brain": (c) => { sent.push(c.body!); return { json: view({ wanted: "claude-cli" }) }; } });
  const ctl = createController({ fetchImpl: fn, onChange: () => {} });
  await ctl.load();
  const a = ctl.save({ backend: "claude-cli" });
  const b = ctl.save({ models: { "claude-cli": "opus" } });
  const c = ctl.save({ models: { "anthropic-api": null } });
  await Promise.all([a, b, c]);
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(sent[0]!), { backend: "claude-cli" });
  assert.deepEqual(JSON.parse(sent[1]!), { models: { "claude-cli": "opus", "anthropic-api": null } });
});

test("controller: test connection handles success, failure, 409 and an unreachable server", async () => {
  let mode = "ok";
  const { fn } = fakeFetch({
    "GET /api/brain": () => ({ json: view() }),
    "POST /api/brain/test": () => (mode === "ok" ? { json: { ok: true, backend: "claude-cli", model: "sonnet", ms: 900 } } : mode === "409" ? { status: 409, json: { error: "A test is already running." } } : { json: { ok: false, backend: null, model: "", ms: 10, error: "No model is ready." } }),
  });
  const ctl = createController({ fetchImpl: fn, onChange: () => {} });
  await ctl.load();
  await ctl.runTest();
  assert.equal(ctl.state.test.result.ok, true);
  mode = "409";
  await ctl.runTest();
  assert.equal(ctl.state.test.status, "error");
  assert.match(ctl.state.test.error, /already running/);
  mode = "bad";
  await ctl.runTest();
  assert.equal(ctl.state.test.result.error, "No model is ready.");
  const down = createController({ fetchImpl: async () => { throw new Error("ECONNREFUSED 127.0.0.1"); }, onChange: () => {} });
  await down.load();
  assert.equal(down.state.phase, "error");
  assert.match(down.state.error, /Could not reach AURA QA/);
  assert.ok(!down.state.error.includes("ECONNREFUSED"), "raw network errors are not shown");
});

test("controller: a second test while one runs is ignored", async () => {
  let n = 0;
  const { fn } = fakeFetch({ "GET /api/brain": () => ({ json: view() }), "POST /api/brain/test": () => { n++; return { json: { ok: true, backend: "claude-cli", model: "sonnet", ms: 5 } }; } });
  const ctl = createController({ fetchImpl: fn, onChange: () => {} });
  await ctl.load();
  await Promise.all([ctl.runTest(), ctl.runTest()]);
  assert.equal(n, 1);
});
