// The OpenAI-compatible providers and OpenCode, with a fake fetch and a fake CLI. No network, no real CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpCfg } from "./chat-helpers.ts";
import { discoverApiModels, forgetApiModels, openAiCompatBackend } from "../src/brain/openai-compat.ts";
import { assertNoTools, opencodeArgs, opencodeCliBackend, parseOpencodeStream } from "../src/brain/opencode.ts";
import { OPENAI_COMPAT, findProvider } from "../src/brain/providers.ts";
import { AUTO_BACKEND_IDS, pickBackend } from "../src/brain/select.ts";
import { updateSettings } from "../src/brain/settings.ts";
import type { SecretBackend } from "../src/brain/keystore.ts";

const KEY = "fake-key-" + "z".repeat(30);
const noSecrets = (): SecretBackend => ({ name: "dpapi", available: async () => false, exists: async () => false, get: async () => null, set: async () => {}, remove: async () => {} });
const request = (audit: (text: string, model: string) => void = () => {}) => ({ role: "t", system: ["a", "b"], user: "question", maxTokens: 9, audit });

interface Seen { url: string; init: RequestInit & { headers: Record<string, string> } }
function fakeFetch(replies: Response[], seen: Seen[]): typeof fetch {
  return (async (url: unknown, init: Seen["init"]) => { seen.push({ url: String(url), init }); return replies.shift()!; }) as unknown as typeof fetch;
}
const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

test("every OpenAI-compatible provider has a fixed https address and its own key variable", () => {
  for (const p of OPENAI_COMPAT) assert.equal(new URL(p.base).protocol, "https:", p.id);
  assert.equal(new Set(OPENAI_COMPAT.map((p) => p.env)).size, OPENAI_COMPAT.length);
  assert.equal(findProvider("anthropic-api"), undefined);
});

test("openai-compat: audits the exact body, refuses redirects, separates cached tokens", async () => {
  for (const p of OPENAI_COMPAT) {
    const seen: Seen[] = [];
    const audited: string[] = [];
    const b = openAiCompatBackend(p, { env: { [p.env]: KEY }, model: "m-1", fetch: fakeFetch([reply({ choices: [{ message: { content: " hi " } }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } })], seen) });
    const r = await b.complete(request((t) => audited.push(t)));
    assert.equal(r.text, "hi");
    assert.deepEqual(r.usage, { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 4 });
    assert.equal(seen[0]!.url, `${p.base}/chat/completions`);
    assert.equal(seen[0]!.init.redirect, "error");
    assert.equal(seen[0]!.init.headers["authorization"], `Bearer ${KEY}`);
    assert.equal(seen[0]!.init.body, audited[0]);
    assert.ok(!audited[0]!.includes(KEY));
    assert.equal(JSON.parse(audited[0]!)[p.maxField], 9);
  }
});

test("openai-compat: one retry, the key never appears in an error, nothing is sent without a key or model", async () => {
  const p = OPENAI_COMPAT[0];
  const seen: Seen[] = [];
  const b = openAiCompatBackend(p, { env: { [p.env]: KEY }, model: "m", sleep: async () => {}, fetch: fakeFetch([reply({}, 429), reply([{ error: { message: `bad ${KEY}` } }], 401)], seen) });
  await assert.rejects(b.complete(request()), (e: Error) => /401/.test(e.message) && !e.message.includes(KEY));
  assert.equal(seen.length, 2);
  const never = (async () => assert.fail("nothing may be sent")) as unknown as typeof fetch;
  await assert.rejects(openAiCompatBackend(p, { env: {}, model: "m", fetch: never }).complete(request()), /No API key/);
  await assert.rejects(openAiCompatBackend(p, { env: { [p.env]: KEY }, fetch: never }).complete(request()), /No model/);
  assert.equal((await openAiCompatBackend(p, { env: { [p.env]: KEY } }).available()).ok, false);
});

test("model discovery: bad ids are dropped, redirects refused, errors give an empty list", async () => {
  const p = findProvider("gemini-api")!;
  forgetApiModels(p.id);
  const seen: Seen[] = [];
  const ids = await discoverApiModels(p, KEY, fakeFetch([reply({ data: [{ id: "models/g-1" }, { id: "--x" }, { id: "a/../b" }, { id: "a b" }, {}] })], seen));
  assert.deepEqual(ids, ["g-1"]);
  assert.equal(seen[0]!.init.redirect, "error");
  assert.equal(seen[0]!.init.body, undefined);
  forgetApiModels(p.id);
  assert.deepEqual(await discoverApiModels(p, KEY, fakeFetch([reply({}, 401)], [])), []);
  assert.deepEqual(await discoverApiModels(p, KEY, (async () => { throw new Error("offline"); }) as unknown as typeof fetch), []);
});

test("assertNoTools: only a tool list with everything off passes", () => {
  assertNoTools(`agent\n{"tools":{"bash":false,"edit":false}}`);
  for (const bad of ["", "not json", "{}", `{"tools":null}`, `{"tools":{"bash":true}}`, `{"tools":{"bash":false,"webfetch":"ask"}}`, `{"tools":["bash"]}`]) {
    assert.throws(() => assertNoTools(bad), /Refused/, bad);
  }
});

const lines = (...v: unknown[]): string => v.map((x) => JSON.stringify(x)).join("\n");
const textEvent = { type: "text", part: { text: "OK" } };

test("opencode parser: text and usage; a tool use or an error throws even with text", () => {
  const r = parseOpencodeStream("banner\n" + lines(textEvent, { type: "step_finish", part: { tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 3, write: 4 } } } }));
  assert.equal(r.text, "OK");
  assert.deepEqual(r.usage, { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 });
  assert.equal(parseOpencodeStream(lines(textEvent)).usage.reported, false);
  assert.throws(() => parseOpencodeStream(lines(textEvent, { type: "tool_use" })), /used a tool/);
  assert.throws(() => parseOpencodeStream(lines(textEvent, { type: "message", part: { type: "tool" } })), /used a tool/);
  assert.throws(() => parseOpencodeStream(lines({ type: "error", error: { name: "AuthError" } })), /AuthError/);
  assert.throws(() => parseOpencodeStream(""), /empty/);
});

const FAKE = `
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RECORD, JSON.stringify({ args, configHome: process.env.XDG_CONFIG_HOME, config: process.env.OPENCODE_CONFIG_CONTENT,
  inherited: [process.env.OPENCODE_CONFIG, process.env.OPENCODE_CONFIG_DIR, process.env.OPENCODE_PERMISSION].filter(Boolean) }) + "\\n");
if (args[0] === "debug") console.log(JSON.stringify({ tools: { bash: process.env.TOOLS === "on" } }));
else if (args[0] === "run") { process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({ type: "text", part: { text: "OK" } }))); }
else console.log("1.17.14");
`;

test("opencode backend: locked environment; with a tool on, the model is never run", async () => {
  const cfg = tmpCfg();
  const script = join(cfg.root, "fake-opencode.cjs");
  writeFileSync(script, FAKE);
  const record = join(cfg.root, "calls.jsonl");
  const calls = () => readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const make = (tools: string) => opencodeCliBackend({
    env: { ...process.env, RECORD: record, TOOLS: tools, OPENCODE_CONFIG: "x", OPENCODE_CONFIG_DIR: "y", OPENCODE_PERMISSION: "z" },
    model: "prov/model", opencodeLauncher: { command: process.execPath, prefixArgs: [script] },
  });
  assert.equal((await make("off").complete(request())).text, "OK");
  assert.deepEqual(calls().map((c) => c.args[0]), ["debug", "run"]);
  assert.deepEqual(calls()[1].args, opencodeArgs("prov/model"));
  for (const c of calls()) {
    assert.deepEqual(c.inherited, []);
    const agent = JSON.parse(c.config).agent["guard-text"];
    assert.deepEqual([agent.tools, agent.permission], [{ "*": false }, { "*": "deny" }]);
    assert.ok(!existsSync(c.configHome), "the temporary config folder is removed");
  }
  writeFileSync(record, "");
  await assert.rejects(make("on").complete(request(() => assert.fail("nothing goes out"))), /Refused/);
  assert.deepEqual(calls().map((c) => c.args[0]), ["debug"]);
});

test("auto never picks a new provider, even when it is the only one ready", async () => {
  assert.deepEqual([...AUTO_BACKEND_IDS], ["anthropic-api", "claude-cli", "antigravity-cli"]);
  const cfg = tmpCfg();
  const script = join(cfg.root, "fake-opencode.cjs");
  writeFileSync(script, FAKE);
  const env: Record<string, string> = { RECORD: join(cfg.root, "calls.jsonl") };
  for (const p of OPENAI_COMPAT) env[p.env] = KEY;
  assert.equal(updateSettings(cfg.dataDir, { models: Object.fromEntries([...OPENAI_COMPAT.map((p) => [p.id, "m"]), ["opencode-cli", "prov/model"]]) }).ok, true);
  const o = { env, launcher: null, opencodeLauncher: { command: process.execPath, prefixArgs: [script] }, secrets: noSecrets(), secretsFor: noSecrets };
  await assert.rejects(pickBackend(cfg, o), /No model backend/);
  assert.ok(!existsSync(env["RECORD"]!), "auto does not even start OpenCode");
  assert.equal((await pickBackend(cfg, { ...o, env: { ...env, AURA_GUARD_BRAIN: "openai-api" } })).backend.id, "openai-api");
});
