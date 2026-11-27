// One project: the single config, GET /api/project, GET /api/suggestions, and the ignored `dept` parameter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { PRODUCT_NAME, PRODUCT_SHORT } from "../src/brand.ts";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import { GENERIC_SUGGESTIONS, MAX_SUGGESTIONS } from "../src/server/project.ts";
import { seed, tmpCfg } from "./chat-helpers.ts";
import type { GuardConfig } from "../src/types.ts";

const TOKEN = "p".repeat(48);
const usage = { input_tokens: 1, output_tokens: 1 };

function http(port: number, path: string, o: { method?: string; cookie?: boolean; body?: unknown } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };
    if (o.cookie !== false) headers["Cookie"] = `${COOKIE_NAME}=${TOKEN}`;
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(o.body !== undefined ? JSON.stringify(o.body) : undefined);
  });
}

async function start(cfg: GuardConfig) {
  const db = seed();
  const server = createGuardServer(cfg, {
    token: TOKEN,
    complete: async () => ({ text: "Answer [rule-erp-create]", usage }),
    openIndex: () => ({ db, release: () => {} }),
    commandTable: async () => new Set(),
    backendInfo: async () => ({ wanted: "auto", picked: null, label: "No model" }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { port, stop: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

function note(cfg: GuardConfig, id: string, type: string, status: string, title: string): void {
  mkdirSync(join(cfg.vaultDir, "rules"), { recursive: true });
  writeFileSync(join(cfg.vaultDir, "rules", `${id}.md`), `---\nid: ${id}\ntype: ${type}\nstatus: ${status}\naudience: [internal_dev]\ndepartment: dev\nsource: owner-answer\ncreated: 2026-01-0${1 + (id.length % 8)}\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n\nBody.\n`);
}

// ---------- config ----------

test("config: one project from the local file; a leftover departments registry is ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "guard-cfg-"));
  writeFileSync(join(root, "guard.config.local.json"), JSON.stringify({
    department: "old", dataDir: "d", vaultDir: "v", repos: [{ id: "a", path: "X:/some/a" }],
    docSources: [{ id: "docs", path: "X:/docs" }],
  }));
  mkdirSync(join(root, "d", "departments"), { recursive: true });
  writeFileSync(join(root, "d", "departments", "registry.json"), "{ not json");
  const cfg = loadConfig(root) as GuardConfig & Record<string, unknown>;
  assert.equal(cfg.dataDir, join(root, "d"));
  assert.equal(cfg.vaultDir, join(root, "v"));
  assert.deepEqual(cfg.repos.map((r) => r.id), ["a"]);
  assert.deepEqual(cfg.docSources?.map((s) => s.id), ["docs"]);
  for (const k of ["department", "departmentId", "departmentName", "roles"]) assert.ok(!(k in cfg), k);
});

test("brand: the product names", () => {
  assert.equal(PRODUCT_NAME, "SPIL REO");
  assert.equal(PRODUCT_SHORT, "REO");
});

// ---------- /api/project ----------

test("GET /api/project: needs the token; has the documented shape; shows only the last folder segment", async () => {
  const cfg = tmpCfg();
  cfg.repos = [{ id: "aura", path: join(cfg.root, "work", "aura-app") }];
  note(cfg, "rule-one", "rule", "active", "Rule one");
  note(cfg, "rule-two", "rule", "proposed", "Rule two");
  mkdirSync(join(cfg.dataDir, "daily"), { recursive: true });
  writeFileSync(join(cfg.dataDir, "daily", "2026-11-19.md"), "x");
  writeFileSync(join(cfg.dataDir, "daily", "2026-11-20.md"), "x");
  const s = await start(cfg);
  try {
    assert.equal((await http(s.port, "/api/project", { cookie: false })).status, 401);
    const r = await http(s.port, "/api/project");
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(j).sort(), ["inbox", "index", "lastDaily", "productName", "productShort", "repos", "vault"]);
    assert.equal(j["productName"], PRODUCT_NAME);
    assert.equal(j["productShort"], PRODUCT_SHORT);
    const repos = j["repos"] as Record<string, unknown>[];
    assert.equal(repos.length, 1);
    assert.deepEqual(Object.keys(repos[0] as object).sort(), ["branch", "commits", "id", "indexedAt", "label", "lastCommitAt"]);
    assert.equal(repos[0]?.["label"], "aura-app");
    assert.equal(repos[0]?.["commits"], 1);
    assert.deepEqual(Object.keys(j["index"] as object).sort(), ["commits", "files", "indexedAt", "notes"]);
    const v = j["vault"] as Record<string, number>;
    assert.equal(v["notes"], 2);
    assert.equal(v["active"], 1);
    assert.equal(v["proposed"], 1);
    assert.equal(v["stale"], 0);
    assert.equal(v["problems"], 0);
    assert.deepEqual(j["inbox"], { pending: 1 });
    assert.equal(j["lastDaily"], "2026-11-20");
    // No paths, no secrets, no note text.
    assert.ok(!r.body.includes(cfg.root) && !r.body.includes(basename(cfg.root)));
    assert.ok(!/token|apikey|api_key|password/i.test(r.body));
    assert.ok(!r.body.includes("Body."));
  } finally { await s.stop(); }
});

// ---------- /api/suggestions ----------

test("GET /api/suggestions: generic when the vault has no rules; needs the token", async () => {
  const s = await start(tmpCfg());
  try {
    assert.equal((await http(s.port, "/api/suggestions", { cookie: false })).status, 401);
    const r = await http(s.port, "/api/suggestions");
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body) as { suggestions: string[] };
    assert.deepEqual(j.suggestions, [...GENERIC_SUGGESTIONS]);
    assert.equal(j.suggestions.length, MAX_SUGGESTIONS);
  } finally { await s.stop(); }
});

test("GET /api/suggestions: questions come from active and proposed rule notes, at most 4, no markup", async () => {
  const cfg = tmpCfg();
  note(cfg, "rule-a", "rule", "active", "Never guess a price");
  note(cfg, "rule-b", "rule", "proposed", "Check <img src=x onerror=alert(1)> first");
  note(cfg, "rule-c", "rule", "deprecated", "Old retired rule");
  note(cfg, "pattern-d", "pattern", "active", "Not a rule");
  for (const n of ["e", "ee", "eee", "eeee", "eeeee"]) note(cfg, `rule-${n}`, "rule", "active", `Extra rule ${n}`);
  const s = await start(cfg);
  try {
    const j = JSON.parse((await http(s.port, "/api/suggestions")).body) as { suggestions: string[] };
    assert.equal(j.suggestions.length, MAX_SUGGESTIONS);
    for (const q of j.suggestions) {
      assert.match(q, /^What is the rule: .+\?$/);
      assert.ok(!/[<>]/.test(q), q);
    }
    assert.ok(!j.suggestions.some((q) => q.includes("Old retired") || q.includes("Not a rule")));
    // Proposed rules still count when there is room.
    const small = tmpCfg();
    note(small, "rule-x", "rule", "proposed", "Check <b>bold</b> first");
    const s2 = await start(small);
    try {
      const k = JSON.parse((await http(s2.port, "/api/suggestions")).body) as { suggestions: string[] };
      assert.deepEqual(k.suggestions, ["What is the rule: Check b bold /b first?"]);
    } finally { await s2.stop(); }
  } finally { await s.stop(); }
});

// ---------- stray dept ----------

test("a stray `dept` (query or body) is ignored: no 404, no 410, same project", async () => {
  const s = await start(tmpCfg());
  try {
    const plain = await http(s.port, "/api/status");
    const stray = await http(s.port, "/api/status?dept=nope");
    assert.equal(plain.status, 200);
    assert.equal(stray.status, 200);
    assert.ok(!("department" in (JSON.parse(stray.body) as object)));
    assert.equal((await http(s.port, "/api/chats?dept=x")).status, 200);
    const c = JSON.parse((await http(s.port, "/api/chats?dept=x", { method: "POST", body: { dept: "x" } })).body) as { id: string };
    const a = await http(s.port, `/api/chats/${c.id}/ask?dept=gone`, { method: "POST", body: { question: "why does the AI never get an ERP create tool", dept: "gone" } });
    assert.equal(a.status, 200);
    assert.equal((await http(s.port, "/api/departments")).status, 404);
  } finally { await s.stop(); }
});
