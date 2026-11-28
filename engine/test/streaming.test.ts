// Token streaming of answer text and abort. No network and no model: a fake fetch, a fake program.
// (Written, not run: the owner has not cleared a test run for this change.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpCfg } from "./chat-helpers.ts";
import { maskOutgoing, unmask } from "../src/mask/mask.ts";
import { AnswerGate, CancelledError, readSse, StreamUnmasker } from "../src/brain/stream.ts";
import { postMessages } from "../src/brain/client.ts";
import { ClaudeDeltaReader, claudeArgs, runProgram } from "../src/brain/backends.ts";
import { openAiCompatBackend } from "../src/brain/openai-compat.ts";
import { createBrain } from "../src/brain/select.ts";
import { OPENAI_COMPAT } from "../src/brain/providers.ts";
import type { SecretBackend } from "../src/brain/keystore.ts";

const enc = new TextEncoder();
/** A response whose body arrives in the given pieces, as separate chunks. */
function sse(pieces: string[], status = 200): Response {
  return new Response(new ReadableStream({ start(c) { for (const p of pieces) c.enqueue(enc.encode(p)); c.close(); } }), { status, headers: { "content-type": "text/event-stream" } });
}
const noSecrets = (): SecretBackend => ({ name: "dpapi", available: async () => false, exists: async () => false, get: async () => null, set: async () => {}, remove: async () => {} });

test("StreamUnmasker: the streamed text equals unmasking the whole, whatever the chunk size, and never shows half a placeholder", () => {
  const masked = maskOutgoing("Mail anna@example.com or bob@example.org about it.");
  assert.ok(masked.ok && masked.map.size === 2);
  const [first] = [...masked.map.keys()];
  const reply = `Please write to ${first} and also ${[...masked.map.keys()][1]}, then done. ${first}_x stays.`;
  const whole = unmask(reply, masked.map);
  for (let size = 1; size <= 9; size++) {
    const u = new StreamUnmasker(masked.map);
    const shown: string[] = [];
    for (let i = 0; i < reply.length; i += size) shown.push(u.push(reply.slice(i, i + size)));
    shown.push(u.end());
    assert.equal(shown.join(""), whole, `chunk size ${size}`);
    // No piece may end inside a placeholder (a placeholder start without its end).
    let acc = "";
    for (const piece of shown) {
      acc += piece;
      assert.ok(!/EMAIL_0$/.test(acc) && !/EMAIL_$/.test(acc) && !/EMAIL$/.test(acc), `half a placeholder shown at size ${size}: ${acc.slice(-12)}`);
    }
  }
  // With nothing masked, text passes straight through.
  const plain = new StreamUnmasker(new Map());
  assert.equal(plain.push("abc"), "abc");
});

test("AnswerGate: a JSON tool request or plan is never shown as answer text; plain text and code fences are", () => {
  const run = (parts: string[]): string => {
    let out = "";
    const g = new AnswerGate((t) => { out += t; });
    for (const p of parts) g.push(p);
    g.end();
    return out;
  };
  assert.equal(run(['{"tool":', '"health"}']), "");
  assert.equal(run(["  ", '{"plan":["a"]}']), "");
  assert.equal(run(["```", "json\n", '{"tool":"health"}', "\n```"]), "");
  assert.equal(run(["Hello ", "there."]), "Hello there.");
  assert.equal(run(["```python\n", "print(1)\n```"]), "```python\nprint(1)\n```");
  assert.equal(run(["```\n", "plain code\n```"]), "```\nplain code\n```");
});

test("readSse joins data lines per event and stops when asked", async () => {
  const seen: string[] = [];
  await readSse(sse(["event: a\ndata: one\n\nda", "ta: two\ndata: lines\n\ndata: three\n\n"]), (e, d) => { seen.push(`${e}|${d}`); return seen.length < 2; });
  assert.deepEqual(seen, ["a|one", "|two\nlines"]);
});

test("Anthropic stream: text pieces arrive as they are written, usage is read, the request asks for a stream", async () => {
  const bodies: string[] = [];
  const fetchFake = (async (_u: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    return sse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1,"cache_read_input_tokens":4}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\nevent: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
    ]);
  }) as unknown as typeof fetch;
  const pieces: string[] = [];
  const r = await postMessages({ key: "k", payload: JSON.stringify({ stream: true }), fetch: fetchFake, sleep: async () => {}, onText: (t) => pieces.push(t) });
  assert.deepEqual(pieces, ["Hel", "lo"]);
  assert.equal(r.text, "Hello");
  assert.equal(r.usage.input_tokens, 11);
  assert.equal(r.usage.output_tokens, 7);
  assert.equal(r.usage.cache_read_input_tokens, 4);
  assert.match(bodies[0]!, /"stream":true/);
});

test("the Anthropic request is aborted by the caller's signal", async () => {
  const ctrl = new AbortController();
  const fetchFake = ((_u: unknown, init: RequestInit) => new Promise((_res, rej) => {
    init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
  })) as unknown as typeof fetch;
  const p = postMessages({ key: "k", payload: "{}", fetch: fetchFake, sleep: async () => {}, signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(p, (e: unknown) => e instanceof CancelledError);
});

test("OpenAI-compatible: streams delta.content, reads usage from the last chunk, and asks again whole when streaming is refused", async () => {
  const p = OPENAI_COMPAT[0]!;
  const bodies: string[] = [];
  const replies = [
    sse(['data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n', 'data: {"choices":[{"delta":{"content":"there"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\n', "data: [DONE]\n\n"]),
  ];
  const fetchFake = (async (_u: unknown, init: RequestInit) => { bodies.push(String(init.body)); return replies.shift()!; }) as unknown as typeof fetch;
  const pieces: string[] = [];
  const audited: string[] = [];
  const b = openAiCompatBackend(p, { env: { [p.env]: "k".repeat(30) }, model: "m-1", fetch: fetchFake });
  const r = await b.complete({ role: "t", system: ["a"], user: "q", maxTokens: 9, audit: (t) => audited.push(t), onText: (t) => pieces.push(t) });
  assert.deepEqual(pieces, ["Hi ", "there"]);
  assert.equal(r.text, "Hi there");
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 3 });
  assert.match(bodies[0]!, /"stream":true/);
  assert.equal(b.streams, true);

  // A provider that refuses streaming (400): a second, whole request is made and also audited.
  const bodies2: string[] = [];
  const replies2 = [new Response("{}", { status: 400 }), new Response(JSON.stringify({ choices: [{ message: { content: "whole" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })];
  const audited2: string[] = [];
  const b2 = openAiCompatBackend(p, { env: { [p.env]: "k".repeat(30) }, model: "m-1", fetch: (async (_u: unknown, init: RequestInit) => { bodies2.push(String(init.body)); return replies2.shift()!; }) as unknown as typeof fetch });
  const r2 = await b2.complete({ role: "t", system: ["a"], user: "q", maxTokens: 9, audit: (t) => audited2.push(t), onText: () => {} });
  assert.equal(r2.text, "whole");
  assert.equal(bodies2.length, 2);
  assert.ok(!/"stream"/.test(bodies2[1]!));
  assert.equal(audited2.length, 2);
});

test("Claude CLI stream-json: deltas are read only after init proves no tools; the stream flag is added only for streaming", () => {
  assert.ok(!claudeArgs("sonnet").includes("--include-partial-messages"));
  assert.ok(claudeArgs("sonnet", true).includes("--include-partial-messages"));
  const delta = (t: string) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
  const got: string[] = [];
  const r = new ClaudeDeltaReader((t) => got.push(t));
  r.push(delta("early") + "\n"); // before init: not shown
  r.push(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }) + "\n" + delta("He").slice(0, 20));
  r.push(delta("He").slice(20) + "\n" + delta("llo") + "\n");
  assert.deepEqual(got, ["He", "llo"]);
  const bad: string[] = [];
  const r2 = new ClaudeDeltaReader((t) => bad.push(t));
  r2.push(JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"], mcp_servers: [] }) + "\n" + delta("x") + "\n");
  assert.deepEqual(bad, []);
});

test("runProgram: an abort signal kills the program and rejects with CancelledError", async () => {
  const ctrl = new AbortController();
  const p = runProgram({
    launcher: { command: process.execPath, prefixArgs: ["-e", "setInterval(() => {}, 1000)"] },
    args: [], stdin: "", timeoutMs: 20_000, env: { ...process.env }, signal: ctrl.signal,
  });
  setTimeout(() => ctrl.abort(), 150);
  await assert.rejects(p, (e: unknown) => e instanceof CancelledError);
});

test("the brain: masked pieces are unmasked safely, the whole reply and the audit are unchanged, abort stops the call", async () => {
  const cfg = tmpCfg();
  const replyPieces = ["Write to EMAIL_", "01 now, ", "EMAIL_01."];
  const events = replyPieces.map((t) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: t } })}\n\n`);
  let sent = "";
  const fetchFake = (async (_u: unknown, init: RequestInit) => { sent = String(init.body); return sse(events); }) as unknown as typeof fetch;
  const brain = createBrain(cfg, { env: { ANTHROPIC_API_KEY: "k".repeat(30), AURA_GUARD_BRAIN: "anthropic-api" }, fetch: fetchFake, secrets: noSecrets() });
  const shown: string[] = [];
  const r = await brain.complete({ role: "chat", system: ["rules"], user: "Mail anna@example.com", maxTokens: 50, onText: (t) => shown.push(t) });
  assert.ok(!sent.includes("anna@example.com"), "the address never leaves");
  assert.equal(r.text, "Write to anna@example.com now, anna@example.com.");
  assert.equal(shown.join(""), r.text);
  assert.ok(shown.every((p) => !/EMAIL_/.test(p)), "no placeholder is ever shown");

  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(brain.complete({ role: "chat", system: ["rules"], user: "hello", maxTokens: 5, signal: ctrl.signal }), (e: unknown) => e instanceof CancelledError);
});
