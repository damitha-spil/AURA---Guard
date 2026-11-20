import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import type { ServerDeps } from "../src/server/server.ts";
import { ChatStore, WITHHELD } from "../src/chat/store.ts";
import { QA_RESULT_HEAD } from "../src/chat/intent.ts";
import { lastQaResult, routeQa } from "../src/chat/qa-route.ts";
import { listReports } from "../src/server/inbox.ts";
import type { GuardConfig } from "../src/types.ts";
import { fakeSecret, seed, tmpCfg } from "./chat-helpers.ts";
import { fixture } from "./review-helpers.ts";
import type { Fixture } from "./review-helpers.ts";

const TOKEN = "t".repeat(48);
const usage = { input_tokens: 1, output_tokens: 1 };

interface Res { status: number; body: string }
function http(port: number, o: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: o.path, method: o.method ?? "GET", headers: { Host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

function repoWithHistory(): Fixture {
  const f = fixture();
  f.commit({ "src/orders/OrdersScreen.tsx": "a\n", "docs/guide.md": "a\n" }, "base");
  f.commit({ "src/orders/OrdersScreen.tsx": "a\nb\nc\n" }, "Change the orders screen");
  return f;
}

const goodReply = JSON.stringify({
  summary: "Orders screen changed.", riskLevel: "medium", riskReasons: ["One screen changed"],
  areas: [{ name: "orders", why: "screen", risk: "medium" }],
  cases: [{ id: "a", title: "Open the orders screen", type: "functional", priority: "P0", cites: ["src/orders/OrdersScreen.tsx"], preconditions: [], steps: ["Open it"], expected: ["It shows orders"], automatable: false }],
  regressionChecklist: ["Orders list loads"], notCovered: [], questions: [], evidence: { uiChange: true, needed: [] },
});

async function start(cfg: GuardConfig, over: Partial<ServerDeps> = {}) {
  const db = seed();
  const calls: { role: string; user: string }[] = [];
  const server: Server = createGuardServer(cfg, {
    token: TOKEN,
    complete: async (req) => { calls.push({ role: req.role, user: req.user }); return { text: req.role === "chat" ? "Normal answer [rule-erp-create]" : goodReply, usage }; },
    openIndex: () => ({ db, release: () => {} }),
    runProcess: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    commandTable: async () => new Set(["qa"]),
    backendInfo: async () => ({ wanted: "auto", picked: "claude-cli", label: "Claude plan" }),
    ...over,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const auth = { Cookie: `${COOKIE_NAME}=${TOKEN}` };
  const post = (path: string, obj: unknown, accept?: string) =>
    http(port, { path, method: "POST", headers: { ...auth, "Content-Type": "application/json", ...(accept ? { Accept: accept } : {}) }, body: JSON.stringify(obj) });
  const newChat = async (): Promise<string> => (JSON.parse((await post("/api/chats", {})).body) as { id: string }).id;
  const events = async (id: string, body: Record<string, unknown>): Promise<Record<string, any>[]> => {
    const r = await post(`/api/chats/${id}/ask`, body, "application/x-ndjson");
    assert.equal(r.status, 200);
    return r.body.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
  };
  return { port, auth, post, newChat, events, calls, stop: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

test("ndjson: a QA request streams agent, steps, qa, then answer, in that order, and the result is stored", async () => {
  const f = repoWithHistory();
  const s = await start(f.cfg);
  try {
    const id = await s.newChat();
    const ev = await s.events(id, { question: "Can you QA the latest change" });
    const types = ev.map((e) => e["type"]);
    assert.deepEqual(ev[0], { type: "agent", agent: "qa", label: "QA agent", state: "started" });
    assert.equal(types.at(-1), "answer");
    assert.equal(types.at(-2), "qa");
    assert.deepEqual(ev.at(-3), { type: "agent", agent: "qa", label: "QA agent", state: "done" });
    const steps = ev.filter((e) => e["type"] === "step").map((e) => e["step"] as Record<string, any>);
    assert.ok(steps.length >= 8 && steps.every((x) => x["agent"] === "qa" && x["kind"] === x["id"]));
    assert.deepEqual([...new Set(steps.map((x) => x["id"]))], ["understand", "target", "context", "design", "report"]);
    // "running" always comes before "done" for the same step id.
    for (const id2 of ["target", "context", "design", "report"]) {
      const rows = steps.filter((x) => x["id"] === id2).map((x) => x["status"]);
      assert.deepEqual(rows, ["running", "done"], id2);
    }
    const qa = ev.at(-2)!["result"] as Record<string, any>;
    assert.equal(qa["modelUsed"], true);
    assert.equal(qa["backend"], "Claude plan");
    assert.match(qa["assumption"], /I assumed the latest change in demo/);
    assert.equal(qa["cases"].length, 1);
    assert.ok(qa["artifacts"]["markdownPath"].endsWith(".md") && existsSync(qa["artifacts"]["jsonPath"]));
    const answer = ev.at(-1)!;
    assert.match(answer["text"], new RegExp(`^# ${QA_RESULT_HEAD}: `));
    assert.deepEqual(answer["sources"], []);
    assert.ok(answer["chat"]);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0]!.role, "qa-agent");

    // It survives a reload: the stored assistant message holds the structured result.
    const chat = JSON.parse((await http(s.port, { path: `/api/chats/${id}`, headers: s.auth })).body) as { messages: { role: string; qa?: any; trace?: any[] }[] };
    const last = chat.messages.at(-1)!;
    assert.equal(last.qa.id, qa["id"]);
    assert.ok(last.trace!.some((t) => t.agent === "qa" && t.id === "design"));
    assert.equal(lastQaResult(chat.messages as never)?.id, qa["id"]);
    // The artifacts show up under reports.
    assert.ok(listReports(f.cfg).some((r) => r.kind === "qa-run" && r.name.endsWith(".md")));
  } finally { await s.stop(); f.cleanup(); }
});

test("ndjson: 'Can you QA it' with no resolvable target asks (needs-input, then answer) and runs nothing", async () => {
  const f = repoWithHistory();
  const none: GuardConfig = { ...f.cfg, repos: [] };
  const s = await start(none);
  try {
    const id = await s.newChat();
    const ev = await s.events(id, { question: "Can you QA it" });
    const types = ev.map((e) => e["type"]);
    assert.deepEqual(types.filter((t) => t !== "step"), ["agent", "agent", "needs-input", "answer"]);
    const ni = ev.find((e) => e["type"] === "needs-input")!;
    assert.match(ni["question"], /no code repository/);
    assert.ok(ni["options"].length >= 2 && ni["options"].length <= 4);
    assert.ok(Object.keys(ni["options"][0]).sort().join() === "id,label,value");
    const answer = ev.at(-1)!;
    assert.match(answer["text"], /^QA needs one answer before I start/);
    assert.equal(s.calls.length, 0);
    const chat = JSON.parse((await http(s.port, { path: `/api/chats/${id}`, headers: s.auth })).body) as { messages: { needsInput?: any }[] };
    assert.equal(chat.messages.at(-1)!.needsInput.options.length, ni["options"].length);
    // A short reply then counts as the answer and starts QA from the description.
    const ev2 = await s.events(id, { question: "the refund flow" });
    assert.equal(ev2[0]!["type"], "agent");
    assert.ok(ev2.some((e) => e["type"] === "qa"));
  } finally { await s.stop(); f.cleanup(); }
});

test("ndjson: an ordinary question, even about tests, still goes to normal answering", async () => {
  const f = repoWithHistory();
  const s = await start(f.cfg);
  try {
    const id = await s.newChat();
    for (const q of ["why does the ERP create tool not exist?", "where are the tests for orders?"]) {
      const ev = await s.events(id, { question: q });
      assert.ok(!ev.some((e) => e["type"] === "agent" || e["type"] === "qa" || e["type"] === "needs-input"), q);
      assert.ok(ev.every((e) => e["type"] !== "step" || e["step"].agent === undefined));
      assert.equal(ev.at(-1)!["type"], "answer");
    }
    assert.ok(s.calls.every((c) => c.role === "chat"));
    // mode:"ask" forces the normal path even for a QA phrase; mode:"qa" forces QA.
    const forced = await s.events(id, { question: "Can you QA it", mode: "ask" });
    assert.ok(!forced.some((e) => e["type"] === "agent"));
    const forcedQa = await s.events(id, { question: "hello there", mode: "qa" });
    assert.equal(forcedQa[0]!["type"], "agent");
  } finally { await s.stop(); f.cleanup(); }
});

test("plain JSON mode (no ndjson): same result in one reply", async () => {
  const f = repoWithHistory();
  const s = await start(f.cfg);
  try {
    const id = await s.newChat();
    const r = await s.post(`/api/chats/${id}/ask`, { question: "QA the latest change" });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body) as Record<string, any>;
    assert.equal(j["ok"], true);
    assert.equal(j["agent"], "qa");
    assert.equal(j["qa"]["version"], 1);
    assert.match(j["text"], /^# QA result/);
    assert.ok(j["trace"].every((t: any) => t.agent === "qa"));
    assert.deepEqual(j["sources"], []);
    const r2 = await s.post(`/api/chats/${await s.newChat()}/ask`, { question: "QA it" });
    const j2 = JSON.parse(r2.body) as Record<string, any>;
    assert.ok(j2["qa"] || j2["needsInput"]);
  } finally { await s.stop(); f.cleanup(); }
});

test("a secret in the question: the usual blocked message, no model call, nothing written", async () => {
  const f = repoWithHistory();
  const s = await start(f.cfg);
  try {
    const id = await s.newChat();
    const ev = await s.events(id, { question: `QA it, key ${fakeSecret()}` });
    const err = ev.find((e) => e["type"] === "error")!;
    assert.equal(err["kind"], "blocked");
    assert.match(err["message"], /looks like it contains a secret.*Nothing was sent/);
    assert.equal(s.calls.length, 0);
    assert.equal(existsSync(join(f.cfg.dataDir, "qa")), false);
    const stored = JSON.stringify(JSON.parse((await http(s.port, { path: `/api/chats/${id}`, headers: s.auth })).body));
    assert.ok(!stored.includes(fakeSecret()));
    assert.ok(!ev.some((e) => JSON.stringify(e).includes(fakeSecret())));
  } finally { await s.stop(); f.cleanup(); }
});

test("run: a journey run is never started by a QA request; runJourneys without a result is refused", async () => {
  const f = repoWithHistory();
  const s = await start(f.cfg);
  try {
    const id = await s.newChat();
    const ev = await s.events(id, { question: "run the journeys", runJourneys: true });
    assert.ok(ev.some((e) => e["type"] === "error"));
    assert.equal(s.calls.length, 0);
    // routeQa itself: no prior result means no confirmation, whatever the words.
    const out = await routeQa(
      { cfg: f.cfg, db: null, backend: "x", writeArtifacts: false },
      { message: "yes, run them", history: [], lastQa: null, noModel: true },
    );
    assert.ok(out.kind === "result", "without a prior result it is just a new QA request, never a run");
    if (out.kind === "result") assert.equal(out.result.run, null);
  } finally { await s.stop(); f.cleanup(); }
});

test("store: the structured result is stored masked and capped; a secret inside is withheld, never kept", () => {
  const cfg = tmpCfg();
  const store = new ChatStore(cfg.dataDir);
  const chat = store.create();
  const qa = {
    version: 1, id: "2026-11-20-abc123", summary: `Leaked ${fakeSecret()} in a summary`, cases: [{ id: "TC-001", title: "ok", steps: [`use ${fakeSecret()}`] }],
    target: { repos: [{ repo: "demo", baseSha: "0123456789abcdef0123456789abcdef01234567" }] },
  };
  const updated = store.append(chat.id, { role: "assistant", text: "# QA result: x", qa, needsInput: { question: "Which?", options: [{ id: "a", label: "A", value: "QA PR " }] } });
  const msg = updated!.messages[0]!;
  const raw = JSON.stringify(msg);
  assert.ok(!raw.includes(fakeSecret()));
  assert.equal((msg.qa as typeof qa).summary, WITHHELD);
  assert.equal((msg.qa as typeof qa).cases[0]!.steps[0], WITHHELD);
  assert.equal((msg.qa as typeof qa).target.repos[0]!.baseSha, "0123456789abcdef0123456789abcdef01234567", "a SHA is not mistaken for a secret");
  assert.equal(store.get(chat.id)!.messages[0]!.needsInput!.options[0]!.value, "QA PR ");
  // Too big to keep: dropped, the Markdown text stays.
  const big = store.append(chat.id, { role: "assistant", text: "# QA result: big", qa: { blob: "x".repeat(300_000) } });
  assert.equal(big!.messages[1]!.qa, undefined);
  assert.equal(readdirSync(store.dir).length, 1);
});
