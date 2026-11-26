// GET /api/overview and GET /api/search: read-only summaries for the home screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import { buildOverview, OVERVIEW_DAYS } from "../src/server/overview.ts";
import { upsertDoc } from "../src/index/db.ts";
import { seed, tmpCfg } from "./chat-helpers.ts";

const TOKEN = "o".repeat(48);

function get(port: number, path: string, cookie = true): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };
    if (cookie) headers["Cookie"] = `${COOKIE_NAME}=${TOKEN}`;
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("buildOverview: a day series of fixed length, real counts only, empty index is honest", () => {
  const cfg = tmpCfg();
  const now = Date.parse("2026-11-20T12:00:00Z");
  const empty = buildOverview(cfg, null, now);
  assert.equal(empty.commitsPerDay.length, OVERVIEW_DAYS);
  assert.ok(empty.commitsPerDay.every((d) => d.n === 0));
  assert.deepEqual(empty.recentCommits, []);
  assert.equal(empty.qa.totalRuns, 0);
  assert.equal(empty.qa.passRate, null);

  const db = seed();
  upsertDoc(db, { kind: "commit", ref: "aura@d1", title: "Newer", body: "x", hash: "a1", audience: "internal_dev", repo: "aura", date: "2026-11-19T08:00:00+00:00" });
  upsertDoc(db, { kind: "commit", ref: "aura@d2", title: "Same day", body: "x", hash: "a2", audience: "internal_dev", repo: "aura", date: "2026-11-19T09:00:00+00:00" });
  upsertDoc(db, { kind: "commit", ref: "aura@d3", title: "Too old", body: "x", hash: "a3", audience: "internal_dev", repo: "aura", date: "2020-01-01T00:00:00+00:00" });
  const o = buildOverview(cfg, db, now);
  assert.equal(o.commitsPerDay.find((d) => d.day === "2026-11-19")?.n, 2);
  assert.equal(o.commitsPerDay.reduce((s, d) => s + d.n, 0), 2, "commits outside the window are not counted");
  assert.equal(o.recentCommits[0]?.title, "Same day");
  assert.ok(o.noteTypes.some((t) => t.type === "rule"));
});

test("GET /api/overview and /api/search need the token and return the documented shape", async () => {
  const cfg = tmpCfg();
  const db = seed();
  const server = createGuardServer(cfg, {
    token: TOKEN,
    complete: async () => ({ text: "x", usage: { input_tokens: 1, output_tokens: 1 } }),
    openIndex: () => ({ db, release: () => {} }),
    commandTable: async () => new Set(),
    backendInfo: async () => ({ wanted: "auto", picked: null, label: "No model" }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal((await get(port, "/api/overview", false)).status, 401);
    const o = await get(port, "/api/overview");
    assert.equal(o.status, 200);
    const body = JSON.parse(o.body) as Record<string, unknown>;
    for (const k of ["commitsPerDay", "recentCommits", "recentNotes", "noteTypes", "inbox", "qa"]) assert.ok(k in body, k);
    const s = await get(port, "/api/search?q=ERP%20create");
    assert.equal(s.status, 200);
    const hits = (JSON.parse(s.body) as { hits: { ref: string }[] }).hits;
    assert.ok(hits.some((h) => h.ref === "rule-erp-create"));
    assert.ok(!hits.some((h) => h.ref === "support-only"), "customer-support notes are not shown");
    assert.deepEqual(JSON.parse((await get(port, "/api/search?q=")).body), { hits: [] });
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  }
});
