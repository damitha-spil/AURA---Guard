// Opening Guard in a normal browser tab: no raw JSON, a friendly page, and pairing only on a real
// user navigation (Sec-Fetch headers a web page on another site cannot forge).
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import { seed, tmpCfg } from "./chat-helpers.ts";

const TOKEN = "q".repeat(48);

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function start() {
  const db = seed();
  const server = createGuardServer(tmpCfg(), {
    token: TOKEN,
    complete: async () => ({ text: "x", usage: { input_tokens: 1, output_tokens: 1 } }),
    openIndex: () => ({ db, release: () => {} }),
    commandTable: async () => new Set(),
    backendInfo: async () => ({ wanted: "auto", picked: null, label: "No model" }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, stop: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

test("an unpaired page without browser headers gets a friendly HTML page, not JSON", async () => {
  const s = await start();
  try {
    const r = await get(s.port, "/");
    assert.equal(r.status, 401);
    assert.match(String(r.headers["content-type"]), /text\/html/);
    assert.match(r.body, /Open SPIL REO/);
    assert.ok(!r.body.trim().startsWith("{"), "no raw JSON");
    assert.equal(r.headers["set-cookie"], undefined, "no cookie is given");
    assert.equal(r.headers["x-frame-options"], "DENY");
    assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.equal((await get(s.port, "/", { ...NAV, "sec-fetch-site": "cross-site" })).headers["set-cookie"], undefined, "a link from another site does not pair");
    assert.equal((await get(s.port, "/", { ...NAV, "sec-fetch-site": "same-site" })).headers["set-cookie"], undefined);
  } finally { await s.stop(); }
});

test("typing the address pairs the browser (Sec-Fetch-Site: none) with an HttpOnly Strict cookie", async () => {
  const s = await start();
  try {
    const r = await get(s.port, "/", { ...NAV, "sec-fetch-site": "none" });
    assert.equal(r.status, 302);
    const cookie = String(r.headers["set-cookie"]);
    assert.ok(cookie.includes(`${COOKIE_NAME}=${TOKEN}`) && /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie));
    const page = await get(s.port, "/", { Cookie: `${COOKIE_NAME}=${TOKEN}` });
    assert.equal(page.status, 200);
    assert.match(page.body, /<html/);
  } finally { await s.stop(); }
});

test("the Open Guard button (/pair) pairs only for a same-origin user click", async () => {
  const s = await start();
  try {
    assert.equal((await get(s.port, "/pair", { ...NAV, "sec-fetch-site": "cross-site", "sec-fetch-user": "?1" })).headers["set-cookie"], undefined);
    assert.equal((await get(s.port, "/pair", { ...NAV, "sec-fetch-site": "same-origin" })).headers["set-cookie"], undefined, "needs user activation");
    assert.equal((await get(s.port, "/pair")).status, 401);
    const ok = await get(s.port, "/pair", { ...NAV, "sec-fetch-site": "same-origin", "sec-fetch-user": "?1" });
    assert.equal(ok.status, 302);
    assert.ok(String(ok.headers["set-cookie"]).includes(COOKIE_NAME));
  } finally { await s.stop(); }
});

test("pairing never opens the API, a wrong host or a foreign origin", async () => {
  const s = await start();
  try {
    assert.equal((await get(s.port, "/api/status", { ...NAV, "sec-fetch-site": "none" })).status, 401, "the API needs the cookie");
    assert.equal((await get(s.port, "/app.js", { ...NAV, "sec-fetch-site": "none" })).status, 401, "app code needs the cookie");
    assert.equal((await get(s.port, "/", { Host: "evil.example", ...NAV, "sec-fetch-site": "none" })).status, 403, "DNS rebinding: wrong host");
    assert.equal((await get(s.port, "/", { Origin: "http://evil.example", ...NAV, "sec-fetch-site": "none" })).status, 403, "wrong origin");
    for (const f of ["/themes.css", "/pair.css", "/favicon.svg"]) assert.equal((await get(s.port, f)).status, 200, f);
  } finally { await s.stop(); }
});

test("the desktop shell link /landing.html?t=<token> pairs and lands on the app (this was the raw JSON error)", async () => {
  const s = await start();
  try {
    const r = await get(s.port, `/landing.html?t=${TOKEN}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers["location"], "/");
    assert.ok(String(r.headers["set-cookie"]).includes(`${COOKIE_NAME}=${TOKEN}`));
    const again = await get(s.port, "/landing.html", { Cookie: `${COOKIE_NAME}=${TOKEN}` });
    assert.equal(again.status, 302, "a paired browser asking for landing.html is sent to the app");
  } finally { await s.stop(); }
});

test("a wrong or old token, or an old cookie, never shows raw JSON to a page navigation", async () => {
  const s = await start();
  try {
    const wrong = await get(s.port, `/?t=${"0".repeat(48)}`, { ...NAV, "sec-fetch-site": "cross-site" });
    assert.equal(wrong.status, 401);
    assert.match(String(wrong.headers["content-type"]), /text\/html/);
    assert.match(wrong.body, /Open SPIL REO/);
    assert.equal(wrong.headers["set-cookie"], undefined, "a wrong token pairs nothing");
    const typed = await get(s.port, `/?t=${"0".repeat(48)}`, { ...NAV, "sec-fetch-site": "none" });
    assert.equal(typed.status, 302, "a typed or bookmarked address with an old token still pairs (user navigation)");
    const stale = await get(s.port, "/", { ...NAV, "sec-fetch-site": "same-origin", Cookie: `${COOKIE_NAME}=${"1".repeat(48)}` });
    assert.equal(stale.status, 401);
    assert.match(stale.body, /Open SPIL REO/);
    const other = await get(s.port, "/anything.html", { ...NAV, "sec-fetch-site": "none" });
    assert.match(String(other.headers["content-type"]), /text\/html/, "any page navigation gets the friendly page");
    const api = await get(s.port, "/api/status", { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" });
    assert.equal(api.status, 401);
    assert.match(String(api.headers["content-type"]), /application\/json/, "fetch calls still get JSON");
  } finally { await s.stop(); }
});

test("the launch token is stable across restarts and replaced when damaged", async () => {
  const { loadOrCreateToken } = await import("../src/server/launch.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = join(mkdtempSync(join(tmpdir(), "guard-token-")), "data");
  const a = loadOrCreateToken(dir);
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.equal(loadOrCreateToken(dir), a, "a restart reuses the token, so an old window or bookmark still pairs");
  writeFileSync(join(dir, "launch-token"), "not a token");
  const b = loadOrCreateToken(dir);
  assert.match(b, /^[0-9a-f]{48}$/);
  assert.notEqual(b, a);
});
