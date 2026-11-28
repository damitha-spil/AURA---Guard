// The chat server's streaming replies, notes-only answers and feedback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createGuardServer, COOKIE_NAME, CSP, MAX_STREAM_CHARS } from "../src/server/server.ts";
import type { ServerDeps } from "../src/server/server.ts";
import { maskAll } from "../src/brain/client.ts";
import { feedbackFile, MAX_NOTE_CHARS } from "../src/chat/feedback.ts";
import { fakeSecret, fixtureUiDir, seed, tmpCfg } from "./chat-helpers.ts";

const TOKEN = "u".repeat(48);
const usage = { input_tokens: 1, output_tokens: 1 };
const NDJSON = "application/x-ndjson";

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

async function start(over: Partial<ServerDeps> = {}) {
  const cfg = tmpCfg();
  const db = seed();
  const server: Server = createGuardServer(cfg, {
    token: TOKEN,
    uiDir: fixtureUiDir(),
    complete: async () => ({ text: "The AI has no create tool [rule-erp-create] and [made-up-ref-1].", usage }),
    openIndex: () => ({ db, release: () => {} }),
    runProcess: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    commandTable: async () => new Set(["qa"]),
    backendInfo: async () => ({ wanted: "auto", picked: "claude-cli", label: "Claude plan" }),
    ...over,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const auth = { Cookie: `${COOKIE_NAME}=${TOKEN}` };
  const post = (path: string, obj: unknown, extra: Record<string, string> = {}) =>
    http(port, { path, method: "POST", headers: { ...auth, "Content-Type": "application/json", ...extra }, body: JSON.stringify(obj) });
  const chat = async (): Promise<string> => (JSON.parse((await post("/api/chats", {})).body) as { id: string }).id;
  return { cfg, port, auth, server, post, chat, stop: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

const events = (body: string): Record<string, any>[] => body.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

test("ndjson ask: real steps arrive in order, then the answer; the model step spans the real wait", async () => {
  const s = await start({ complete: async () => { await new Promise((r) => setTimeout(r, 60)); return { text: "The AI has no create tool [rule-erp-create] and [made-up-ref-1].", usage }; } });
  try {
    const id = await s.chat();
    const r = await s.post(`/api/chats/${id}/ask`, { question: "ERP create tool", agent: false }, { Accept: NDJSON });
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /application\/x-ndjson/);
    const ev = events(r.body);
    const steps = ev.filter((e) => e.type === "step").map((e) => `${e.step.id}:${e.step.status}`);
    assert.deepEqual(steps, ["search:running", "search:done", "found:done", "model:running", "model:done", "verify:done", "done:done"]);
    const last = ev[ev.length - 1]!;
    assert.equal(last.type, "answer");
    assert.ok(ev.slice(0, -1).every((e) => e.type === "step"), "the answer comes last");
    const found = ev.find((e) => e.step?.id === "found")!.step.label as string;
    assert.match(found, /^\d+ sources?: /);
    const model = ev.filter((e) => e.step?.id === "model");
    assert.match(model[0]!.step.label, /Asking Claude plan/);
    assert.ok(model[1]!.step.ms >= 50, "the timing is the real wait");
    assert.match(ev.find((e) => e.step?.id === "verify")!.step.label, /1 kept, 1 dropped/);
    assert.ok(!String(last.text).includes("made-up-ref-1"));
    assert.ok(last.sources.length > 0);
    // The trace is stored with the answer so the "Worked for" line survives a reload.
    const chat = JSON.parse((await http(s.port, { path: `/api/chats/${id}`, headers: s.auth })).body) as { messages: { trace?: { id: string }[] }[] };
    assert.ok((chat.messages[1]!.trace ?? []).some((t) => t.id === "model"));
  } finally {
    await s.stop();
  }
});

test("plain JSON ask is unchanged when no ndjson Accept header is sent", async () => {
  const s = await start();
  try {
    const id = await s.chat();
    const r = await s.post(`/api/chats/${id}/ask`, { question: "ERP create tool" });
    assert.match(String(r.headers["content-type"]), /application\/json/);
    const b = JSON.parse(r.body) as { ok: boolean; text: string; sources: unknown[]; chat: unknown };
    assert.equal(b.ok, true);
    assert.ok(Array.isArray(b.sources) && b.chat);
  } finally {
    await s.stop();
  }
});

test("ndjson ask: a blocked secret gives an error event, nothing is sent, and the secret is not stored", async () => {
  let sent = 0;
  const s = await start({ complete: async (req) => { maskAll([...req.system, req.user]); sent++; return { text: "x", usage }; } });
  try {
    const id = await s.chat();
    const r = await s.post(`/api/chats/${id}/ask`, { question: `ERP create ${fakeSecret()}` }, { Accept: NDJSON });
    const ev = events(r.body);
    const last = ev[ev.length - 1]!;
    assert.equal(last.type, "error");
    assert.equal(last.kind, "blocked");
    assert.match(last.message, /secret/);
    assert.ok(ev.some((e) => e.step?.id === "model" && e.step.status === "error"));
    assert.equal(sent, 0);
    assert.ok(!r.body.includes(fakeSecret()));
  } finally {
    await s.stop();
  }
});

test("notes only: retrieval is limited to vault notes; the default is unchanged", async () => {
  const seen: string[] = [];
  const s = await start({ complete: async (req) => { seen.push(req.system.join("\n")); return { text: "ok [rule-erp-create]", usage }; } });
  try {
    const id = await s.chat();
    const a = JSON.parse((await s.post(`/api/chats/${id}/ask`, { question: "ERP create guard" })).body) as { sources: { kind: string }[] };
    assert.ok(a.sources.length >= 1);
    assert.ok(seen[0]!.includes("aura@abc1234"), "default: commits are used too");
    const b = JSON.parse((await s.post(`/api/chats/${id}/ask`, { question: "ERP create guard", notesOnly: true })).body) as { sources: { kind: string }[] };
    assert.ok(!seen[1]!.includes("aura@abc1234"));
    assert.ok(b.sources.every((x) => x.kind === "note"));
    const c = await s.post(`/api/chats/${id}/ask`, { question: "ERP create guard", notesOnly: "yes" });
    assert.equal(JSON.parse(c.body).ok, true);
    assert.ok(seen[2]!.includes("aura@abc1234"), "only a real true turns it on");
  } finally {
    await s.stop();
  }
});

test("ndjson command: started, output chunks, done; plain mode stays blocking JSON", async () => {
  const s = await start({
    runProcess: async (_argv, _cwd, onChunk) => {
      onChunk?.("one\n");
      onChunk?.("two\n");
      return { code: 0, stdout: "one\ntwo\n", stderr: "" };
    },
  });
  try {
    const id = await s.chat();
    const r = await s.post("/api/command", { line: "/qa plan", chatId: id }, { Accept: NDJSON });
    const ev = events(r.body);
    assert.deepEqual(ev.map((e) => e.type), ["started", "output", "output", "done"]);
    assert.equal(ev[3]!.code, 0);
    assert.equal(ev.filter((e) => e.type === "output").map((e) => e.chunk).join(""), "one\ntwo\n");
    const plain = JSON.parse((await s.post("/api/command", { line: "/qa plan", chatId: id })).body) as { ok: boolean; output: string };
    assert.equal(plain.ok, true);
    assert.ok(plain.output.includes("one"));
    // A runner that does not stream still shows its result, and the stream is capped.
    const s2 = await start({ runProcess: async () => ({ code: 1, stdout: "x".repeat(MAX_STREAM_CHARS + 5000), stderr: "" }) });
    try {
      const r2 = events((await s2.post("/api/command", { line: "/qa plan" }, { Accept: NDJSON })).body);
      const total = r2.filter((e) => e.type === "output").reduce((n, e) => n + String(e.chunk).length, 0);
      assert.equal(total, MAX_STREAM_CHARS);
      assert.equal(r2[r2.length - 1]!.code, 1);
    } finally {
      await s2.stop();
    }
    // A refused command is still a plain 400, even in stream mode.
    const bad = await s.post("/api/command", { line: "/rm -rf" }, { Accept: NDJSON });
    assert.equal(bad.status, 400);
  } finally {
    await s.stop();
  }
});

test("feedback: auth, origin, validation, masked and capped note, one line without message text", async () => {
  const s = await start();
  try {
    const id = await s.chat();
    const body = { chatId: id, messageIndex: 1, rating: "down", note: "wrong " + "z".repeat(500) };
    assert.equal((await http(s.port, { path: "/api/feedback", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status, 401);
    assert.equal((await s.post("/api/feedback", body, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await s.post("/api/feedback", { ...body, rating: "meh" })).status, 400);
    assert.equal((await s.post("/api/feedback", { ...body, chatId: "../x" })).status, 400);
    assert.equal((await s.post("/api/feedback", { ...body, messageIndex: -1 })).status, 400);
    assert.equal((await s.post("/api/feedback", { ...body, chatId: "0123456789abcdef" })).status, 404);
    assert.equal(existsSync(feedbackFile(s.cfg.dataDir)), false, "nothing is written for refused requests");
    assert.equal((await s.post("/api/feedback", body)).status, 200);
    assert.equal((await s.post("/api/feedback", { chatId: id, messageIndex: 0, rating: "up", note: `key ${fakeSecret()}` })).status, 200);
    const lines = readFileSync(feedbackFile(s.cfg.dataDir), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]!).sort(), ["chatId", "messageIndex", "note", "rating", "ts"]);
    assert.equal(String(lines[0]!["note"]).length, MAX_NOTE_CHARS);
    assert.ok(!readFileSync(feedbackFile(s.cfg.dataDir), "utf8").includes(fakeSecret()));
    assert.equal((await s.post("/api/feedback", { chatId: id, messageIndex: 0, rating: "up" })).status, 200);
    const third = JSON.parse(readFileSync(feedbackFile(s.cfg.dataDir), "utf8").trim().split("\n")[2]!) as Record<string, unknown>;
    assert.ok(!("note" in third));
  } finally {
    await s.stop();
  }
});
