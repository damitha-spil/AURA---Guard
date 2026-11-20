import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createGuardServer, COOKIE_NAME, MAX_BODY_BYTES } from "../src/server/server.ts";
import type { ServerDeps } from "../src/server/server.ts";
import { maskAll } from "../src/brain/client.ts";
import type { ProcessResult } from "../src/chat/commands.ts";
import { fakeSecret, seed, tmpCfg } from "./chat-helpers.ts";

const TOKEN = "t".repeat(48);
const usage = { input_tokens: 1, output_tokens: 1 };

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function http(port: number, o: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: o.path, method: o.method ?? "GET", headers: { Host: `127.0.0.1:${port}`, ...o.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}

async function start(over: Partial<ServerDeps> = {}) {
  const cfg = tmpCfg();
  const db = seed();
  const server: Server = createGuardServer(cfg, {
    token: TOKEN,
    complete: async () => ({ text: "Answer [rule-erp-create] <img src=x onerror=alert(1)>", usage }),
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
  return { cfg, port, auth, server, post, stop: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

test("token: requests without the cookie get 401; the token link sets an HttpOnly Strict cookie", async () => {
  const s = await start();
  try {
    for (const path of ["/", "/app.js", "/api/status", "/api/chats"]) assert.equal((await http(s.port, { path })).status, 401, path);
    assert.equal((await http(s.port, { path: "/?t=wrong" })).status, 401);
    assert.equal((await http(s.port, { path: "/api/status", headers: { Cookie: `${COOKIE_NAME}=nope` } })).status, 401);
    const r = await http(s.port, { path: `/?t=${TOKEN}` });
    assert.equal(r.status, 302);
    assert.equal(r.headers["location"], "/");
    const cookie = String(r.headers["set-cookie"]);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const page = await http(s.port, { path: "/", headers: s.auth });
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>SPIL AURA QA Bot<\/title>/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["content-security-policy"], "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'");
    assert.equal(page.headers["access-control-allow-origin"], undefined);
    assert.equal((await http(s.port, { path: "/api/status", method: "OPTIONS", headers: s.auth })).status, 404);
  } finally {
    await s.stop();
  }
});

test("a wrong Host (DNS rebinding) or a foreign Origin is rejected", async () => {
  const s = await start();
  try {
    for (const host of ["evil.example", `evil.example:${s.port}`, "127.0.0.1:1", `127.0.0.1.evil.test:${s.port}`]) {
      assert.equal((await http(s.port, { path: "/api/status", headers: { ...s.auth, Host: host } })).status, 403, host);
    }
    assert.equal((await http(s.port, { path: "/api/status", headers: { ...s.auth, Host: `localhost:${s.port}` } })).status, 200);
    for (const origin of ["http://evil.example", `http://127.0.0.1:${s.port + 1}`, "null"]) {
      assert.equal((await s.post("/api/chats", {}, { Origin: origin })).status, 403, origin);
    }
    assert.equal((await s.post("/api/chats", {}, { Origin: `http://127.0.0.1:${s.port}` })).status, 201);
  } finally {
    await s.stop();
  }
});

test("static files: only the allowlist is served and traversal is blocked", async () => {
  const s = await start();
  try {
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/app.js/../../package.json", "/styles.css%00.html", "/index.html", "/ui/app.js", "/..\\package.json", "/%5c..%5cpackage.json"]) {
      const r = await http(s.port, { path, headers: s.auth });
      assert.ok(r.status === 404 || r.status === 400, `${path} -> ${r.status}`);
      assert.ok(!r.body.includes('"aura-guard"'), path);
    }
    for (const p of ["/", "/app.js", "/render.js", "/styles.css"]) assert.equal((await http(s.port, { path: p, headers: s.auth })).status, 200, p);
  } finally {
    await s.stop();
  }
});

test("JSON bodies are capped and must be JSON", async () => {
  const s = await start();
  try {
    const c = JSON.parse((await s.post("/api/chats", {})).body) as { id: string };
    const big = await s.post(`/api/chats/${c.id}/ask`, { question: "x".repeat(MAX_BODY_BYTES + 10) });
    assert.equal(big.status, 413);
    const text = await http(s.port, { path: `/api/chats/${c.id}/ask`, method: "POST", headers: { ...s.auth, "Content-Type": "text/plain" }, body: "hi" });
    assert.equal(text.status, 415);
    const bad = await http(s.port, { path: `/api/chats/${c.id}/ask`, method: "POST", headers: { ...s.auth, "Content-Type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 400);
  } finally {
    await s.stop();
  }
});

test("ask: answer with cited source, stored masked, model text is returned raw for the safe renderer", async () => {
  const s = await start();
  try {
    const c = JSON.parse((await s.post("/api/chats", {})).body) as { id: string };
    const r = await s.post(`/api/chats/${c.id}/ask`, { question: "Why does the AI never get an ERP create tool?" });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body) as { ok: boolean; text: string; sources: { ref: string }[] };
    assert.equal(body.ok, true);
    assert.deepEqual(body.sources.map((x) => x.ref), ["rule-erp-create"]);
    assert.ok(body.text.includes("<img src=x"), "raw text; the page escapes it");
    const doc = JSON.parse((await http(s.port, { path: "/api/doc?ref=draft-erp-idea", headers: s.auth })).body) as { body: string; status: string };
    assert.equal(doc.status, "proposed");
    assert.ok(doc.body.includes("<img src=x"));
    assert.equal((await http(s.port, { path: "/api/doc?ref=support-only", headers: s.auth })).status, 404, "support notes are not shown");

    // A secret in the question: nothing is sent to the model, and nothing secret reaches the disk.
    let sent = 0;
    const s2 = await start({
      complete: async (req) => {
        maskAll([...req.system, req.user]); // the real brain's first step; throws BlockedError
        sent++;
        return { text: "x", usage };
      },
    });
    try {
      const c2 = JSON.parse((await s2.post("/api/chats", {})).body) as { id: string };
      const b = JSON.parse((await s2.post(`/api/chats/${c2.id}/ask`, { question: `ERP create ${fakeSecret()}` })).body) as { ok: boolean; error: string };
      assert.equal(b.ok, false);
      assert.equal(b.error, "blocked");
      assert.equal(sent, 0);
      for (const f of readdirSync(join(s2.cfg.dataDir, "chats"))) {
        assert.ok(!readFileSync(join(s2.cfg.dataDir, "chats", f), "utf8").includes(fakeSecret()));
      }
    } finally {
      await s2.stop();
    }
    const dir = join(s.cfg.dataDir, "chats");
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, files[0]!), "utf8")).messages.length, 2);
    assert.equal((await http(s.port, { path: `/api/chats/${c.id}`, method: "DELETE", headers: s.auth })).status, 200);
    assert.equal((await http(s.port, { path: `/api/chats/${c.id}`, headers: s.auth })).status, 404);
  } finally {
    await s.stop();
  }
});

test("commands: unknown names and shell characters are refused and nothing runs", async () => {
  const calls: string[][] = [];
  const s = await start({ runProcess: async (argv) => { calls.push(argv); return { code: 0, stdout: "ok", stderr: "" }; } });
  try {
    for (const line of ["/rm -rf /", "/status; calc", "/history a b && dir", "/history a $(x)", "/history a b > out", "/index --force", "calc", ""]) {
      const r = await s.post("/api/command", { line });
      assert.equal(r.status, 400, line);
    }
    assert.equal(calls.length, 0);
    const ok = await s.post("/api/command", { line: "/status" });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, [["status"]]);
    const list = JSON.parse((await http(s.port, { path: "/api/commands", headers: s.auth })).body) as { commands: { name: string; available: boolean }[] };
    assert.equal(list.commands.find((c) => c.name === "qa")?.available, true);
    assert.equal(list.commands.find((c) => c.name === "review")?.available, false);
  } finally {
    await s.stop();
  }
});

test("only one heavy command runs at a time; light ones are not blocked", async () => {
  let release: (r: ProcessResult) => void = () => {};
  const started: string[] = [];
  const s = await start({
    runProcess: (argv) => {
      started.push(argv[0]!);
      return argv[0] === "index" ? new Promise<ProcessResult>((r) => { release = r; }) : Promise.resolve({ code: 0, stdout: "light", stderr: "" });
    },
  });
  try {
    const first = s.post("/api/command", { line: "/index" });
    while (!started.includes("index")) await new Promise((r) => setTimeout(r, 5));
    const status = JSON.parse((await http(s.port, { path: "/api/status", headers: s.auth })).body) as { running: string };
    assert.equal(status.running, "index");
    const second = await s.post("/api/command", { line: "/diary" });
    assert.equal(second.status, 409);
    assert.equal((await s.post("/api/command", { line: "/check" })).status, 200);
    release({ code: 0, stdout: "indexed", stderr: "" });
    const done = JSON.parse((await first).body) as { output: string };
    assert.equal(done.output, "indexed");
    assert.equal((await s.post("/api/command", { line: "/diary" })).status, 200, "lock is released");
  } finally {
    await s.stop();
  }
});
