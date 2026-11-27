// Usage records, costs, the usage report and limit data. No real model or network calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fakeSecret, tmpCfg } from "./chat-helpers.ts";
import { createBrain } from "../src/brain/select.ts";
import { parseClaudeStream } from "../src/brain/backends.ts";
import { parseOpencodeStream } from "../src/brain/opencode.ts";
import { recordUsage, readUsage, usageFile } from "../src/usage/record.ts";
import type { UsageRecord } from "../src/usage/record.ts";
import { findPrice, loadPrices } from "../src/usage/prices.ts";
import { usageReport } from "../src/usage/report.ts";
import { limitsReport, parseDuration, saveLimits, windowsFromClaudeStream, windowsFromHeaders } from "../src/usage/limits.ts";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const prices = loadPrices(ROOT);
const noSecrets = () => ({ kind: "memory", available: async () => false, exists: async () => false, get: async () => null, set: async () => {}, remove: async () => {} }) as never;

function apiBrain(reply: () => Response) {
  const cfg = tmpCfg();
  const brain = createBrain(cfg, {
    env: { ANTHROPIC_API_KEY: "test-key", AURA_GUARD_BRAIN: "anthropic-api" },
    fetch: (async () => reply()) as typeof fetch, secrets: noSecrets(), secretsFor: noSecrets, sleep: async () => {},
  });
  return { cfg, brain };
}

const ask = { role: "chat", system: ["rules"], user: "a private question", maxTokens: 10 };

test("every sent call is recorded with counts only; rate-limit headers are kept", async () => {
  let status = 200;
  const { cfg, brain } = apiBrain(() => new Response(
    JSON.stringify(status === 200 ? { content: [{ type: "text", text: "a private reply" }], usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 3 } } : { error: { message: "bad" } }),
    { status, headers: { "anthropic-ratelimit-requests-limit": "100", "anthropic-ratelimit-requests-remaining": "25", "anthropic-ratelimit-requests-reset": "2999-01-01T00:00:00Z" } },
  ));
  await brain.complete({ ...ask, sessionId: "abc" });
  status = 400;
  await assert.rejects(brain.complete(ask));
  await assert.rejects(brain.complete({ ...ask, user: fakeSecret() }), /blocked/);
  const rows = readUsage(cfg.dataDir);
  assert.equal(rows.length, 2, "a blocked call is not sent, so not recorded");
  assert.deepEqual(
    { ...rows[0], ts: "" },
    { ts: "", backend: "anthropic-api", model: "claude-sonnet-5-5", role: "chat", session: "abc", input: 5, cacheRead: 11, cacheWrite: 3, output: 7, ok: true, reported: true },
  );
  assert.deepEqual([rows[1]!.ok, rows[1]!.reported, rows[1]!.input], [false, false, 0]);
  assert.match(rows[1]!.session, /^run-/);
  const raw = readFileSync(usageFile(cfg.dataDir), "utf8");
  assert.ok(!/private|rules|test-key/.test(raw));
  const limits = await limitsReport(cfg, { env: {}, secretsFor: noSecrets });
  assert.deepEqual(limits.providers.find((p) => p.id === "anthropic-api")!.windows, [{ label: "API requests", percentLeft: 25, resetsAt: "2999-01-01T00:00:00.000Z", elapsedPercent: null }]);
});

test("a usage file that cannot be written does not break the answer", async () => {
  const { cfg, brain } = apiBrain(() => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] })));
  mkdirSync(usageFile(cfg.dataDir), { recursive: true });
  assert.equal((await brain.complete(ask)).text, "ok");
});

test("token fields from the CLI streams", () => {
  const claude = parseClaudeStream([
    JSON.stringify({ type: "assistant", message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "OK" }] } }),
    JSON.stringify({ type: "result", result: "OK", usage: { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 687, cache_read_input_tokens: 1 } }),
  ].join("\n"));
  assert.equal(claude.model, "claude-haiku-5-5");
  assert.deepEqual(claude.usage, { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 687, cache_read_input_tokens: 1 });
  const open = parseOpencodeStream([
    JSON.stringify({ type: "text", part: { text: "OK" } }),
    JSON.stringify({ type: "step_finish", part: { tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 9, write: 4 } } } }),
  ].join("\n"));
  assert.deepEqual(open.usage, { input_tokens: 3, output_tokens: 3, cache_read_input_tokens: 9, cache_creation_input_tokens: 4 });
  assert.equal(parseOpencodeStream(JSON.stringify({ type: "text", part: { text: "OK" } })).usage.reported, false);
});

test("prices: known models only", () => {
  for (const m of ["claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", "claude-sonnet-5-5-medium", "claude-haiku-4-5-20251001"]) assert.ok(findPrice(prices, m), m);
  for (const m of ["claude-fable-5-2", "claude-sonnet-5-5-fast", "gpt-oss-120b-medium", "sonnet", "", "constructor"]) assert.equal(findPrice(prices, m), null, m);
});

const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  ts: "2026-11-28T10:30:00.000Z", backend: "claude-cli", model: "claude-sonnet-5-5", role: "chat", session: "s1",
  input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 100_000, ok: true, reported: true, ...over,
});

test("report: totals, unknown costs stay null, every bucket is present", () => {
  const now = new Date("2026-11-28T11:00:00.000Z");
  const r = usageReport([
    rec({}),
    rec({ backend: "antigravity-cli", model: "gemini-x", session: "s2", input: 0, cacheRead: 0, output: 0, reported: false }),
    rec({ backend: "opencode-cli", model: "unknown/model", input: 10, cacheRead: 0, output: 1 }),
    rec({ ts: "2026-09-01T00:00:00.000Z" }),
  ], "7d", prices, now);
  assert.deepEqual([r.calls, r.sessions, r.unreportedCalls, r.unpricedCalls], [3, 2, 1, 1]);
  assert.ok(Math.abs(r.cost! - 3.2) < 1e-9);
  assert.ok(Math.abs(r.totals.cacheSavings! - 1.8) < 1e-9);
  assert.equal(r.totals.processed, 2_100_011);
  assert.equal(r.providers.find((p) => p.id === "antigravity-cli")!.cost, null);
  assert.equal(r.models.find((m) => m.model === "unknown/model")!.cost, null);
  assert.equal(r.daily.length, 7);
  assert.equal(r.days.length, 7);
  const day = usageReport([rec({})], "24h", prices, now);
  assert.equal(day.daily.length, 24);
  assert.equal(day.daily.find((d) => d.date === "2026-11-28T10:00:00.000Z")!.byProvider["claude-cli"]!.tokens, 2_100_000);
  assert.equal(usageReport([], "90d", prices, now).daily.length, 90);
  assert.equal(usageReport([], "30d", prices, now).cost, 0);
  assert.equal(usageReport([rec({ model: "x" })], "30d", prices, now).cost, null);
});

test("limit data: Claude CLI events, API headers, and nothing invented", async () => {
  const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 4_000_000_000, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.27, resetsAt: 4_000_000_000 }, seven_day: { utilization: 0.19, resetsAt: 4_000_000_000 } } } });
  assert.deepEqual(windowsFromClaudeStream(line).map((w) => [w.label, w.percentLeft]), [["5-hour limit", 73], ["Weekly limit", 81]]);
  assert.deepEqual(windowsFromClaudeStream(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1, rateLimitType: "five_hour" } })), []);
  assert.equal(parseDuration("6m0s"), 360_000);
  assert.equal(parseDuration("soon"), null);
  const h = windowsFromHeaders(new Headers({ "x-ratelimit-limit-tokens": "200", "x-ratelimit-remaining-tokens": "50", "x-ratelimit-reset-tokens": "1s" }), new Date(0));
  assert.deepEqual(h, [{ label: "API tokens", percentLeft: 25, resetsAt: "1970-01-01T00:00:01.000Z", windowSeconds: null }]);
  assert.deepEqual(windowsFromHeaders(new Headers({ "x-ratelimit-remaining-tokens": "50" })), []);

  const cfg = tmpCfg();
  saveLimits(cfg.dataDir, "claude-cli", [{ label: "5-hour limit", percentLeft: 73, resetsAt: new Date(3_600_000).toISOString(), windowSeconds: 18_000 }], new Date(0));
  const live = await limitsReport(cfg, { env: {}, secretsFor: noSecrets, now: () => new Date(0) });
  assert.equal(live.providers.find((p) => p.id === "claude-cli")!.windows[0]!.elapsedPercent, 80);
  const later = await limitsReport(cfg, { env: {}, secretsFor: noSecrets, now: () => new Date(7_200_000) });
  assert.deepEqual(later.providers.find((p) => p.id === "claude-cli")!.windows, []);
  for (const p of later.providers) assert.ok(p.windows.length === 0 && p.note, p.id);
});

test("OpenRouter: the key goes only to the official key endpoint; no limit means no window", async () => {
  const seen: string[] = [];
  let limit: number | null = 10;
  const options = {
    env: { OPENROUTER_API_KEY: "or-key" }, secretsFor: noSecrets,
    fetch: (async (url: string) => { seen.push(url); return new Response(JSON.stringify({ data: { limit, limit_remaining: 4 } })); }) as typeof fetch,
  };
  const a = (await limitsReport(tmpCfg(), options)).providers.find((p) => p.id === "openrouter-api")!;
  assert.equal(a.windows[0]!.percentLeft, 40);
  limit = null;
  const b = (await limitsReport(tmpCfg(), options)).providers.find((p) => p.id === "openrouter-api")!;
  assert.deepEqual(b.windows, []);
  assert.match(b.note!, /No spending limit/);
  assert.deepEqual([...new Set(seen)], ["https://openrouter.ai/api/v1/key"]);
});

test("routes: usage needs the cookie, checks the range, and chat calls carry the chat id", async () => {
  const cfg = { ...tmpCfg(), root: ROOT };
  mkdirSync(cfg.dataDir, { recursive: true });
  writeFileSync(usageFile(cfg.dataDir), "not json\n");
  recordUsage(cfg.dataDir, rec({ ts: new Date().toISOString() }));
  const sessions: (string | undefined)[] = [];
  const TOKEN = "v".repeat(48);
  const server: Server = createGuardServer(cfg, {
    token: TOKEN, openIndex: () => null, limits: { env: {}, secretsFor: noSecrets },
    complete: async (req) => { sessions.push(req.sessionId); return { text: "ok", usage: { input_tokens: 1, output_tokens: 1 } }; },
    backendInfo: async () => ({ wanted: "auto", picked: null, label: "No model" }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Cookie: `${COOKIE_NAME}=${TOKEN}`, "Content-Type": "application/json" };
  try {
    assert.equal((await fetch(`${base}/api/usage`)).status, 401);
    assert.equal((await fetch(`${base}/api/usage?range=1y`, { headers })).status, 400);
    const r = (await (await fetch(`${base}/api/usage?range=30d`, { headers })).json()) as { calls: number };
    assert.equal(r.calls, 1);
    const l = (await (await fetch(`${base}/api/usage/limits`, { headers })).json()) as { providers: unknown[] };
    assert.equal(l.providers.length, 4);
    const chat = (await (await fetch(`${base}/api/chats`, { method: "POST", headers, body: "{}" })).json()) as { id: string };
    await fetch(`${base}/api/chats/${chat.id}/ask`, { method: "POST", headers, body: JSON.stringify({ question: "How does a lock work?" }) });
    assert.deepEqual(sessions, [chat.id]);
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  }
});
