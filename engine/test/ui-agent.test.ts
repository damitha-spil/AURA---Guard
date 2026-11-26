// The agent-style chat window: streaming events, feedback, notes-only, static files, and the
// pure UI modules (steps, reveal, titles, marks, style descriptors, preferences).
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGuardServer, COOKIE_NAME, CSP, MAX_STREAM_CHARS } from "../src/server/server.ts";
import type { ServerDeps } from "../src/server/server.ts";
import { maskAll } from "../src/brain/client.ts";
import { feedbackFile, MAX_NOTE_CHARS } from "../src/chat/feedback.ts";
import { fakeSecret, seed, tmpCfg } from "./chat-helpers.ts";

const TOKEN = "u".repeat(48);
const usage = { input_tokens: 1, output_tokens: 1 };
const NDJSON = "application/x-ndjson";
const uiDir = join(import.meta.dirname, "..", "..", "ui");
const ui = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(uiDir, file)).href)) as T;

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
    const r = await s.post(`/api/chats/${id}/ask`, { question: "ERP create tool" }, { Accept: NDJSON });
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

test("static: favicon and the new UI modules are served; the CSP still forbids inline code", async () => {
  const s = await start();
  try {
    const f = await http(s.port, { path: "/favicon.svg", headers: s.auth });
    assert.equal(f.status, 200);
    assert.match(String(f.headers["content-type"]), /image\/svg\+xml/);
    assert.ok(f.body.includes("<svg"));
    assert.equal((await http(s.port, { path: "/favicon.svg" })).status, 200, "the icon is public so the pairing page can show it");
    assert.equal((await http(s.port, { path: "/app.js" })).status, 401, "the app code still needs the cookie");
    for (const icon of ["/favicon-16.png", "/favicon-32.png", "/favicon-48.png", "/favicon-256.png", "/apple-touch-icon.png", "/favicon.ico"]) assert.equal((await http(s.port, { path: icon, headers: s.auth })).status, 200, icon);
    for (const p of ["/theme.js", "/themes.css", "/marks.js", "/steps.js", "/reveal.js", "/titles.js"]) assert.equal((await http(s.port, { path: p, headers: s.auth })).status, 200, p);
    const page = await http(s.port, { path: "/", headers: s.auth });
    assert.match(page.body, /<link rel="icon" type="image\/svg\+xml" href="\/favicon.svg">/);
    assert.equal(page.headers["content-security-policy"], CSP);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(CSP));
    assert.ok(CSP.includes("default-src 'self'"));
    // No inline script, inline style block or style attribute in the page itself.
    assert.ok(!/<style[\s>]/i.test(page.body));
    assert.ok(!/\sstyle\s*=/i.test(page.body));
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(page.body));
    assert.ok(!/\son[a-z]+\s*=/i.test(page.body));
  } finally {
    await s.stop();
  }
});

test("UI source never sets an inline style attribute or loads anything from outside", () => {
  for (const f of ["app.js", "review.js", "marks.js", "theme.js", "titles.js", "brand.js", "index.html", "styles.css", "themes.css"]) {
    const t = readFileSync(join(uiDir, f), "utf8");
    assert.ok(!/setAttribute\(\s*["']style["']/.test(t), `${f}: no style attribute`);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(t.replace(/\/\/ .*$/gm, "")), `${f}: no external address`);
    assert.ok(!/@import|@font-face/.test(t), `${f}: no webfonts or imports`);
  }
});

test("steps: the reducer keeps order, updates by id and summarises", async () => {
  const m = await ui<{ applyStep: Function; summarize: Function; workSteps: Function; formatDuration: Function; splitEvents: Function; totalMs: Function }>("steps.js");
  let list: { id: string; status: string; kind: string; ms?: number }[] = [];
  list = m.applyStep(list, { id: "search", kind: "search", status: "running", label: "a" }, 1);
  list = m.applyStep(list, { id: "found", kind: "found", status: "done", label: "b" }, 2);
  list = m.applyStep(list, { id: "search", kind: "search", status: "done", label: "a2", ms: 5 }, 3);
  assert.deepEqual(list.map((s) => s.id), ["search", "found"]);
  assert.equal(list[0]!.status, "done");
  assert.equal((list[0] as unknown as { startedAt: number }).startedAt, 1);
  list = m.applyStep(list, { id: "done", kind: "done", status: "done", label: "Done", ms: 4200 }, 4);
  assert.equal(m.workSteps(list).length, 2);
  assert.equal(m.summarize(list, m.totalMs(list)), "Worked for 4 s · 2 steps");
  assert.equal(m.summarize(list.slice(0, 1), 100), "Worked for under 1 s · 1 step");
  assert.equal(m.formatDuration(65_000), "1 min 5 s");
  const { events, rest } = m.splitEvents('{"a":1}\nnot json\n{"b":2}\n{"c"');
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
  assert.equal(rest, '{"c"');
});

test("reveal: whole words, never longer than the cap, instant when disabled", async () => {
  const m = await ui<{ planReveal: Function; revealedLength: Function; shouldReveal: Function; MAX_REVEAL_MS: number }>("reveal.js");
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const plan = m.planReveal(long);
  assert.ok(plan.total <= m.MAX_REVEAL_MS);
  assert.equal(m.revealedLength(plan, 0), 0);
  assert.equal(m.revealedLength(plan, plan.total + 1), long.length);
  const mid = m.revealedLength(plan, plan.total / 2) as number;
  assert.ok(mid > 0 && mid < long.length);
  assert.ok(plan.ends.includes(mid), "stops on a word end");
  const short = m.planReveal("one two three");
  assert.equal(short.total, Math.round(short.interval * 3));
  assert.equal(m.revealedLength(m.planReveal(""), 5), 0);
  assert.equal(m.shouldReveal({ reducedMotion: true, text: "hello" }), false);
  assert.equal(m.shouldReveal({ reducedMotion: false, text: "  " }), false);
  assert.equal(m.shouldReveal({ reducedMotion: false, text: "hello" }), true);
});

test("titles: short, readable, no trailing punctuation", async () => {
  const m = await ui<{ shortTitle: (s: string, n?: number) => string }>("titles.js");
  assert.equal(m.shortTitle("why does the AI never get an ERP create tool?"), "Why does the AI never get an ERP...");
  assert.equal(m.shortTitle("  Hello   there!! "), "Hello there");
  assert.equal(m.shortTitle(""), "New chat");
  assert.equal(m.shortTitle("???"), "New chat");
  assert.ok(m.shortTitle("x".repeat(200)).length <= 41);
});

test("marks and style descriptors: every style has its own mark, rule set and descriptor", async () => {
  const m = await ui<{ STYLES: string[]; STATES: string[]; markKind: (s: string) => string; markShapes: (s: string) => unknown[]; styleDescriptor: (s: string) => Record<string, unknown>; DEFAULT_STYLE: string; WORK_DEFAULTS: Record<string, { live: boolean; expanded: boolean }>; buildMark: Function; isState: (s: string) => boolean }>("marks.js");
  assert.deepEqual([...m.STYLES].sort(), ["aurora", "dots", "noir", "pulse"]);
  assert.deepEqual(m.STATES, ["idle", "thinking", "error", "done"]);
  assert.equal(m.DEFAULT_STYLE, "noir");
  const kinds = new Set(m.STYLES.map((s) => m.markKind(s)));
  assert.equal(kinds.size, 4, "four different marks");
  assert.equal(m.markShapes("dots").length, 9);
  assert.equal(m.markShapes("noir").length, 9);
  assert.equal(m.markShapes("pulse").length, 1);
  assert.equal(m.markShapes("aurora").length, 4);
  const d = Object.fromEntries(m.STYLES.map((s) => [s, m.styleDescriptor(s)]));
  assert.equal(d["noir"]!["workExpanded"], true);
  assert.equal(d["pulse"]!["workLive"], false);
  assert.equal(d["pulse"]!["topbar"], false);
  assert.equal(d["pulse"]!["sidebarDefault"], "collapsed");
  assert.equal(d["noir"]!["messages"], "rows");
  assert.deepEqual(new Set(m.STYLES.map((s) => d[s]!["empty"])).size, 4);
  assert.deepEqual(new Set(m.STYLES.map((s) => d[s]!["messages"])).size, 4);
  assert.equal(d["noir"]!["columnPx"], 800);
  assert.equal(d["pulse"]!["columnPx"], 680);
  assert.equal(d["dots"]!["columnPx"], 760);
  for (const s of m.STYLES) {
    assert.equal(d[s]!["mark"], m.markKind(s));
    assert.equal(m.WORK_DEFAULTS[s]!.live, d[s]!["workLive"]);
    assert.equal(m.WORK_DEFAULTS[s]!.expanded, d[s]!["workExpanded"]);
  }
  assert.equal(m.styleDescriptor("nonsense")["id"], "noir", "unknown styles fall back to Noir");
  // The CSS has a rule set for every style, in both the colour file and the structure file.
  const css = readFileSync(join(uiDir, "styles.css"), "utf8");
  const themes = readFileSync(join(uiDir, "themes.css"), "utf8");
  // The four old looks were replaced by light and dark colour modes: only Noir keeps structure rules,
  // and themes.css has one token set per mode.
  assert.ok(css.includes(`[data-style="noir"] .msg`) || css.includes(`[data-style="noir"] .`), "noir: structure rules");
  assert.ok(themes.includes(`:root[data-mode="dark"]`) && themes.includes(`:root[data-mode="light"]`), "light and dark colours");
  // A tiny fake document proves marks build without a browser.
  const made: string[] = [];
  const doc = {
    createElement: (t: string) => node(t),
    createElementNS: (_ns: string, t: string) => node(t),
  };
  function node(t: string): Record<string, unknown> {
    const n: Record<string, unknown> = { t, attrs: {} as Record<string, string>, children: [] as unknown[], className: "" };
    n["setAttribute"] = (k: string, v: string) => { (n["attrs"] as Record<string, string>)[k] = v; };
    n["appendChild"] = (c: unknown) => { (n["children"] as unknown[]).push(c); made.push(t); };
    return n;
  }
  const el = m.buildMark(doc, "aurora", "thinking") as { attrs: Record<string, string>; children: unknown[] };
  assert.equal(el.attrs["data-state"], "thinking");
  assert.equal(el.attrs["data-kind"], "orb");
  assert.equal(el.children.length, 4);
  assert.equal((m.buildMark(doc, "dots", "bogus") as { attrs: Record<string, string> }).attrs["data-state"], "idle");
});

test("preferences: Noir is the default; bad or throwing storage never breaks; saved choices round-trip", async () => {
  await ui("theme.js");
  const P = (globalThis as unknown as { GuardPrefs: Record<string, any> }).GuardPrefs;
  assert.ok(P, "theme.js publishes GuardPrefs");
  assert.equal(P["DEFAULTS"].style, "noir");
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(P["load"](throwing), P["DEFAULTS"]);
  assert.equal(P["save"](throwing, { style: "aurora" }), false);
  assert.deepEqual(P["load"](null), P["DEFAULTS"]);
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(P["load"](store).style, "noir", "empty storage gives Noir");
  assert.equal(P["save"](store, { style: "pulse", mode: "dark", motion: "reduced", showWork: "on" }), true);
  assert.deepEqual(P["load"](store), { style: "noir", mode: "dark", motion: "reduced", showWork: "on" }, "old styles migrate to the one layout");
  assert.equal(P["DEFAULTS"].mode, "light", "light is the default theme");
  mem.set(P["KEY"], "{not json");
  assert.equal(P["load"](store).style, "noir");
  mem.set(P["KEY"], JSON.stringify({ style: "<script>", mode: 5, motion: null, showWork: {} }));
  assert.deepEqual(P["load"](store), P["DEFAULTS"], "unknown values fall back");
  const attrs: Record<string, string> = {};
  P["apply"]({ style: "aurora", mode: "light" }, { setAttribute: (k: string, v: string) => { attrs[k] = v; } });
  assert.deepEqual(attrs, { "data-style": "noir", "data-mode": "light", "data-motion": "auto" });
  // A first visit opens in Noir before any script runs.
  const html = readFileSync(join(uiDir, "index.html"), "utf8");
  assert.match(html, /<html lang="en" data-style="noir"/);
  assert.ok(html.indexOf('src="/theme.js"') < html.indexOf('href="/styles.css"'), "theme script runs before the stylesheet paints");
});

test("chat list helpers: Today / Yesterday / Earlier by local date, plain relative times, search only in long lists", async () => {
  const m = await ui<{ groupChats: Function; relativeTime: Function; showChatSearch: (n: number) => boolean; filterChats: Function; daysAgo: Function }>("titles.js");
  const now = new Date(2026, 10, 20, 15, 30); // 20 Nov 2026, local time
  const at = (d: number, h: number, mi = 0): string => new Date(2026, 10, d, h, mi).toISOString();
  const chats = [
    { id: "old", title: "Old one", updated: at(2, 9) },
    { id: "late", title: "Late yesterday", updated: at(19, 23, 59) },
    { id: "now", title: "This morning", updated: at(20, 8) },
    { id: "early", title: "Early today", updated: at(20, 0, 1) },
    { id: "bad", title: "No date", updated: "not a date" },
  ];
  const groups = m.groupChats(chats, now) as { label: string; chats: { id: string }[] }[];
  assert.deepEqual(groups.map((g) => g.label), ["Today", "Yesterday", "Earlier"]);
  assert.deepEqual(groups[0]!.chats.map((c) => c.id), ["now", "early"], "newest first");
  assert.deepEqual(groups[1]!.chats.map((c) => c.id), ["late"]);
  assert.deepEqual(groups[2]!.chats.map((c) => c.id).sort(), ["bad", "old"]);
  assert.deepEqual((m.groupChats([chats[2]], now) as unknown[]).length, 1, "empty groups are left out");
  assert.deepEqual(m.groupChats([], now), []);
  assert.equal(m.daysAgo(at(20, 1), now), 0);
  assert.equal(m.daysAgo(at(19, 23, 59), now), 1, "calendar days, not 24-hour spans");
  assert.equal(m.relativeTime(at(20, 15, 30), now), "Just now");
  assert.equal(m.relativeTime(at(20, 15, 5), now), "25 min ago");
  assert.equal(m.relativeTime(at(20, 8), now), "7 h ago");
  assert.equal(m.relativeTime(at(19, 23, 59), now), "Yesterday");
  assert.equal(m.relativeTime(at(16, 12), now), "4 d ago");
  assert.equal(m.relativeTime(at(3, 12), now), "Nov 3");
  assert.equal(m.relativeTime("nonsense", now), "");
  assert.equal(m.showChatSearch(8), false);
  assert.equal(m.showChatSearch(9), true);
  assert.deepEqual((m.filterChats(chats, "  LATE ") as { id: string }[]).map((c) => c.id), ["late"]);
  assert.equal((m.filterChats(chats, "") as unknown[]).length, 5);
});

test("Show work toggle and error cards: the click flips what is shown; failures get a plain title", async () => {
  const m = await ui<{ flipWork: Function; currentWork: Function; errorInfo: Function; initialOf: Function }>("titles.js");
  assert.equal(m.currentWork("auto", true), true);
  assert.equal(m.currentWork("auto", false), false);
  assert.equal(m.currentWork("on", false), true);
  assert.equal(m.currentWork("off", true), false);
  assert.equal(m.flipWork("auto", true), "off", "a style that shows work by default turns it off");
  assert.equal(m.flipWork("auto", false), "on");
  assert.equal(m.flipWork("on", false), "off");
  assert.equal(m.flipWork("off", true), "on");
  assert.deepEqual(m.errorInfo("Your message looks like it contains a secret (HIGH_ENTROPY x2). Nothing was sent."), { title: "Message not sent", retry: false });
  assert.deepEqual(m.errorInfo("Stopped waiting. If the answer arrives..."), { title: "Stopped waiting", retry: true });
  assert.deepEqual(m.errorInfo("Could not reach AURA QA. Is its window still running?"), { title: "Cannot reach AURA QA", retry: true });
  assert.deepEqual(m.errorInfo("The model said no."), { title: "AURA QA could not answer", retry: true });
  assert.equal(m.initialOf("  alex"), "A");
  assert.equal(m.initialOf(""), "?");
});

test("chat screen markup: the new workspace controls exist and nothing inline sneaks in", () => {
  const html = readFileSync(join(uiDir, "index.html"), "utf8");
  for (const id of ["brand-tile", "new-chat", "tab-inbox", "tab-reports", "chat-search", "status-toggle", "status-detail", "backend-name", "pill-work", "pill-notes", "top-work", "send", "stop"]) assert.ok(html.includes(id), `${id} is in the page`);
  assert.match(html, /id="top-work" role="switch" aria-checked="false"/);
  assert.match(html, /id="send"[^>]*disabled/, "send starts disabled until there is text");
  const css = readFileSync(join(uiDir, "styles.css"), "utf8");
  assert.match(css, /prefers-color-scheme|data-style/);
  assert.ok(!/\.sidebar[^{]*\{[^}]*font:[^}]*var\(--mono\)/.test(css), "no monospace in the sidebar");
});
