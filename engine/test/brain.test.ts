import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createBrain, BlockedError, MissingKeyError, ApiError } from "../src/brain/client.ts";
import type { GuardConfig } from "../src/types.ts";

const KEY = "test-key-" + randomBytes(6).toString("hex");

function ok(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200 });
}
function status(code: number): Response {
  return new Response(JSON.stringify({ error: { message: "nope" } }), { status: code });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "guard-brain-"));
  const cfg = { dataDir: root, vaultDir: root, repos: [], busyProcesses: [], root } as GuardConfig;
  const calls: { url: string; init: RequestInit }[] = [];
  const queue: Response[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return queue.shift() ?? ok("fine");
  }) as unknown as typeof fetch;
  const brain = createBrain(cfg, {
    fetch: fakeFetch, env: { ANTHROPIC_API_KEY: KEY }, sleep: async () => {}, now: () => new Date("2026-11-20T10:00:00Z"),
  });
  return { root, cfg, calls, queue, brain, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const req = { role: "t", system: ["stable one", "stable two"], user: "hi", maxTokens: 50 };

test("a secret blocks the call and nothing is sent", async () => {
  const s = setup();
  const fake = "sk-ant-" + "api03-" + randomBytes(24).toString("base64url");
  await assert.rejects(s.brain.complete({ ...req, user: "token is " + fake }), (e: unknown) => {
    assert.ok(e instanceof BlockedError);
    assert.ok(!(e as Error).message.includes(fake));
    assert.ok(e.blocked.length > 0);
    return true;
  });
  assert.equal(s.calls.length, 0);
  s.cleanup();
});

test("placeholders go out, answer is unmasked, shared map across blocks", async () => {
  const s = setup();
  s.queue.push(ok("Mail EMAIL_01 about it"));
  const r = await s.brain.complete({ ...req, system: ["contact bob@corp-example.com", "x"], user: "ask bob@corp-example.com" });
  const sent = String(s.calls[0]!.init.body);
  assert.ok(!sent.includes("bob@corp-example.com"));
  assert.ok(sent.includes("EMAIL_01"));
  assert.equal(r.text, "Mail bob@corp-example.com about it");
  assert.equal(r.usage.output_tokens, 2);
  s.cleanup();
});

test("cache_control on the last system block only; headers set", async () => {
  const s = setup();
  await s.brain.complete(req);
  const body = JSON.parse(String(s.calls[0]!.init.body));
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.system[0].cache_control, undefined);
  assert.deepEqual(body.system[1].cache_control, { type: "ephemeral" });
  const h = s.calls[0]!.init.headers as Record<string, string>;
  assert.equal(h["anthropic-version"], "2023-06-01");
  s.cleanup();
});

test("audit line is written without original values", async () => {
  const s = setup();
  await s.brain.complete({ ...req, user: "mail bob@corp-example.com" });
  const dir = join(s.root, "logs");
  const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
  const line = JSON.parse(text.trim().split("\n")[0]!);
  assert.equal(line.role, "t");
  assert.match(line.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!text.includes("bob@corp-example.com"));
  assert.ok(!text.includes(KEY));
  s.cleanup();
});

test("missing key gives a plain error without a key", async () => {
  const s = setup();
  const brain = createBrain(s.cfg, { fetch: (async () => ok("x")) as unknown as typeof fetch, env: {} });
  await assert.rejects(brain.complete(req), (e: unknown) => e instanceof MissingKeyError && /ANTHROPIC_API_KEY is not set/.test((e as Error).message));
  s.cleanup();
});

test("400 is not retried; 529 is retried once", async () => {
  const s = setup();
  s.queue.push(status(400));
  await assert.rejects(s.brain.complete(req), (e: unknown) => e instanceof ApiError && e.status === 400);
  assert.equal(s.calls.length, 1);
  s.queue.push(status(529), ok("later"));
  const r = await s.brain.complete(req);
  assert.equal(r.text, "later");
  assert.equal(s.calls.length, 3);
  s.queue.push(status(529), status(529));
  await assert.rejects(s.brain.complete(req), (e: unknown) => e instanceof ApiError && e.status === 529);
  assert.equal(s.calls.length, 5);
  s.cleanup();
});
