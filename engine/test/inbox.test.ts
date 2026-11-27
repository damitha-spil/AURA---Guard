import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import type { ServerDeps } from "../src/server/server.ts";
import { MAX_REPORT_BYTES } from "../src/server/inbox.ts";
import { openDb } from "../src/index/db.ts";
import type { Db } from "../src/index/db.ts";
import { indexVault } from "../src/index/notes.ts";
import { search } from "../src/index/search.ts";
import { parseSlash } from "../src/chat/commands.ts";
import { localToday } from "../src/rules/util.ts";
import { revertNoteStatus, setNoteStatus } from "../src/rules/manage.ts";
import { tmpCfg } from "./chat-helpers.ts";
import type { GuardConfig } from "../src/types.ts";

const TOKEN = "t".repeat(48);
const usage = { input_tokens: 1, output_tokens: 1 };
const BODY_MARK = "zebraquux-body-marker";

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

const FRONT = (id: string, type: string, status: string, source: string, eol: string): string =>
  ["---", `id: ${id}`, `type: ${type}`, `status: ${status}`, "audience:", "  - internal_dev", "department: dev", `source: ${source}`, `title: Title of ${id}`, "created: 2026-11-19", "---", ""].join(eol);

const CHECK = JSON.stringify({ kind: "co-change", if_changed: ["api/**"], then_changed: ["docs/**"], evidence: { commits: 5, ratio: 0.83, repo: "demo" } }, null, 2);

function note(cfg: GuardConfig, rel: string, text: string): string {
  const f = join(cfg.vaultDir, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
  return f;
}

function fixture(cfg: GuardConfig) {
  const crlf = FRONT("choice-crlf", "choice", "proposed", "session", "\r\n") + `\r\n# Choice\r\n\r\nThe owner said ${BODY_MARK}. <img src=x onerror=alert(1)>\r\n\r\n<!-- session: s1 -->\r\n`;
  const lf = FRONT("pattern-lf", "pattern", "proposed", "commit", "\n") + `\n# Pattern\n\nWhen api changes, docs change.\n\n\`\`\`json\n${CHECK}\n\`\`\`\n`;
  const act = FRONT("adr-active", "adr", "active", "owner-answer", "\n") + "\n# Active one\n\nAlready approved.\n";
  const dep = FRONT("diary-dead", "diary", "deprecated", "session", "\n") + "\n# Old\n\nGone.\n";
  const sh = FRONT("rule-shadow", "rule", "shadow", "evidence", "\n") + "\n# Shadow\n\nWatching.\n";
  const badCheck = FRONT("pattern-badcheck", "pattern", "proposed", "commit", "\n") + "\n# Bad\n\n```json\n{\"kind\":\"co-change\"}\n```\n";
  const files = {
    crlf: note(cfg, "inbox/choice-crlf.md", crlf),
    lf: note(cfg, "patterns/pattern-lf.md", lf),
    act: note(cfg, "adr/adr-active.md", act),
    dep: note(cfg, "diary/diary-dead.md", dep),
    sh: note(cfg, "rules/rule-shadow.md", sh),
    bad: note(cfg, "inbox/pattern-badcheck.md", badCheck),
  };
  return { files, crlf, lf };
}

async function start(over: Partial<ServerDeps> = {}) {
  const cfg = tmpCfg();
  const fx = fixture(cfg);
  const db: Db = openDb(":memory:");
  indexVault(db, cfg.vaultDir);
  const server: Server = createGuardServer(cfg, {
    token: TOKEN,
    complete: async () => ({ text: "x", usage }),
    openIndex: () => ({ db, release: () => {} }),
    runProcess: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    commandTable: async () => new Set(["qa"]),
    backendInfo: async () => ({ wanted: "auto", picked: "claude-cli", label: "Claude plan" }),
    ...over,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const auth = { Cookie: `${COOKIE_NAME}=${TOKEN}` };
  const get = (path: string, extra: Record<string, string> = {}) => http(port, { path, headers: { ...auth, ...extra } });
  const post = (path: string, obj: unknown, extra: Record<string, string> = {}) =>
    http(port, { path, method: "POST", headers: { ...auth, "Content-Type": "application/json", ...extra }, body: JSON.stringify(obj) });
  return { cfg, fx, db, port, auth, get, post, stop: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

test("endpoints need the cookie, the right Host and the right Origin", async () => {
  const s = await start();
  try {
    for (const p of ["/api/inbox", "/api/reports", "/api/report?path=daily/x.md", "/api/inbox/note?id=choice-crlf"]) {
      assert.equal((await http(s.port, { path: p })).status, 401, p);
    }
    assert.equal((await http(s.port, { path: "/api/notes/choice-crlf/status", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "active" }) })).status, 401);
    assert.equal((await s.get("/api/inbox", { Host: "evil.example" })).status, 403);
    assert.equal((await s.post("/api/notes/choice-crlf/status", { to: "active" }, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await s.post("/api/notes/choice-crlf/status", { to: "active" }, { Host: "evil.example" })).status, 403);
    assert.match(readFileSync(s.fx.files.crlf, "utf8"), /status: proposed/, "nothing changed");
  } finally {
    await s.stop();
  }
});

test("inbox lists only proposed and shadow notes, grouped by type, with evidence for patterns", async () => {
  const s = await start();
  try {
    const r = await s.get("/api/inbox");
    assert.equal(r.status, 200);
    const d = JSON.parse(r.body) as { total: number; groups: { type: string; count: number; items: Record<string, unknown>[] }[] };
    assert.equal(d.total, 4);
    assert.deepEqual(d.groups.map((g) => g.type), ["choice", "pattern", "rule"]);
    const all = d.groups.flatMap((g) => g.items);
    assert.ok(!all.some((i) => i["id"] === "adr-active" || i["id"] === "diary-dead"));
    const pat = all.find((i) => i["id"] === "pattern-lf")!;
    assert.deepEqual(pat["evidence"], { commits: 5, ratio: 0.83, repo: "demo", ifChanged: ["api/**"], thenChanged: ["docs/**"] });
    assert.equal(all.find((i) => i["id"] === "pattern-badcheck")!["checkInvalid"], true);
    const ch = all.find((i) => i["id"] === "choice-crlf")!;
    assert.equal(ch["source"], "session");
    assert.equal(ch["file"], "inbox/choice-crlf.md");
    assert.ok(String(ch["preview"]).includes(BODY_MARK));
    assert.ok(!String(ch["preview"]).includes("<!--"));
    assert.ok(String(ch["preview"]).length <= 404);
    assert.equal(typeof ch["anchors"], "number");
    const full = JSON.parse((await s.get("/api/inbox/note?id=choice-crlf")).body) as { body: string };
    assert.ok(full.body.includes("<img src=x"), "raw text; the page escapes it");
    assert.equal((await s.get("/api/inbox/note?id=nope-nope")).status, 404);
    assert.equal((await s.get("/api/inbox/note?id=..%2f..%2fx")).status, 400);
  } finally {
    await s.stop();
  }
});

test("bad ids are refused, unknown ids are 404, a bad `to` is 400", async () => {
  const s = await start();
  try {
    const bad = ["..", "..%2f..%2fetc", "a%2fb", "%2e%2e", "a".repeat(500), "ABC", "has%20space", "x_y", "a--b", "-a", "choice-crlf%00", "C%3A%5Cx"];
    for (const id of bad) {
      const r = await s.post(`/api/notes/${id}/status`, { to: "active" });
      assert.ok(r.status === 400 || r.status === 404, `${id.slice(0, 20)} -> ${r.status}`);
    }
    assert.equal((await s.post("/api/notes/a/b/status", { to: "active" })).status, 404);
    assert.equal((await s.post("/api/notes/no-such-note/status", { to: "active" })).status, 404);
    for (const to of ["proposed", "stale", "", 5, null, "ACTIVE", ["active"]]) {
      assert.equal((await s.post("/api/notes/choice-crlf/status", { to })).status, 400, JSON.stringify(to));
    }
    assert.equal((await s.post("/api/notes/choice-crlf/status", { to: "active", from: "bogus" })).status, 400);
    assert.equal((await s.post("/api/notes/choice-crlf/status", { to: "active", from: "active" })).status, 409, "stale screen");
    assert.equal((await http(s.port, { path: "/api/notes/choice-crlf/status", method: "POST", headers: { ...s.auth, "Content-Type": "text/plain" }, body: "x" })).status, 415);
    assert.match(readFileSync(s.fx.files.crlf, "utf8"), /status: proposed/);
  } finally {
    await s.stop();
  }
});

test("approve edits only the status and reviewed lines, byte for byte, and keeps CRLF", async () => {
  const s = await start();
  try {
    const today = localToday();
    const r = await s.post("/api/notes/choice-crlf/status", { to: "active" });
    assert.equal(r.status, 200);
    const out = JSON.parse(r.body) as { from: string; to: string; fields: string[]; undoable: boolean };
    assert.deepEqual([out.from, out.to, out.undoable], ["proposed", "active", true]);
    assert.deepEqual(out.fields.sort(), ["reviewed", "status"]);
    const after = readFileSync(s.fx.files.crlf, "utf8");
    const expected = s.fx.crlf.replace("status: proposed\r\n", "status: active\r\n").replace("created: 2026-11-19\r\n", `created: 2026-11-19\r\nreviewed: ${today}\r\n`);
    assert.equal(after, expected);
    assert.ok(!/[^\r]\n/.test(after), "no bare LF was introduced");

    const d = await s.post("/api/notes/pattern-lf/status", { to: "deprecated" });
    assert.equal(d.status, 200);
    const lf = readFileSync(s.fx.files.lf, "utf8");
    assert.equal(lf, s.fx.lf.replace("status: proposed\n", "status: deprecated\n").replace("created: 2026-11-19\n", `created: 2026-11-19\nreviewed: ${today}\n`));
    assert.ok(!lf.includes("\r"));
  } finally {
    await s.stop();
  }
});

test("refused changes: already active, deprecated back to active, invalid check block", async () => {
  const s = await start();
  try {
    const before = readFileSync(s.fx.files.act, "utf8");
    assert.equal((await s.post("/api/notes/adr-active/status", { to: "active" })).status, 409);
    assert.equal((await s.post("/api/notes/diary-dead/status", { to: "active" })).status, 409);
    assert.equal((await s.post("/api/notes/diary-dead/status", { to: "deprecated" })).status, 409);
    assert.equal((await s.post("/api/notes/pattern-badcheck/status", { to: "active" })).status, 422);
    assert.equal(readFileSync(s.fx.files.act, "utf8"), before);
    // active -> deprecated is allowed; the other way is not (and `to: proposed` is not accepted at all).
    assert.equal((await s.post("/api/notes/adr-active/status", { to: "deprecated" })).status, 200);
    assert.equal((await s.post("/api/notes/adr-active/status", { to: "active" })).status, 409);
    // the same limits hold in the function itself
    assert.equal(setNoteStatus(s.cfg, "adr-active", "active").code, "transition");
    assert.equal(setNoteStatus(s.cfg, "missing-note", "active").code, "not-found");
    // a note that fails validation cannot be changed
    note(s.cfg, "inbox/broken.md", "---\nid: broken\ntype: choice\nstatus: proposed\n---\n\nbody\n");
    assert.equal(setNoteStatus(s.cfg, "broken", "active").code, "not-found");
  } finally {
    await s.stop();
  }
});

test("a shadow note of any type can be approved", async () => {
  const s = await start();
  try {
    assert.equal((await s.post("/api/notes/rule-shadow/status", { to: "active" })).status, 200);
    assert.match(readFileSync(s.fx.files.sh, "utf8"), /status: active/);
  } finally {
    await s.stop();
  }
});

test("the audit line holds ids and statuses only", async () => {
  const s = await start();
  try {
    await s.post("/api/notes/choice-crlf/status", { to: "active" });
    await s.post("/api/notes/pattern-lf/status", { to: "deprecated" });
    const raw = readFileSync(join(s.cfg.dataDir, "approvals.jsonl"), "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]!).sort(), ["from", "id", "to", "ts", "via"]);
    assert.deepEqual([lines[0]!["id"], lines[0]!["from"], lines[0]!["to"], lines[0]!["via"]], ["choice-crlf", "proposed", "active", "chat"]);
    assert.ok(!raw.includes(BODY_MARK) && !raw.includes("Title of"), "no note text in the audit");
    assert.ok(!Number.isNaN(Date.parse(String(lines[0]!["ts"]))));
  } finally {
    await s.stop();
  }
});

test("after approve the index is refreshed: the note is searchable as active", async () => {
  const s = await start();
  try {
    assert.equal(search(s.db, BODY_MARK)[0]?.status, "proposed");
    await s.post("/api/notes/choice-crlf/status", { to: "active" });
    const hit = search(s.db, BODY_MARK).find((h) => h.ref === "choice-crlf");
    assert.equal(hit?.status, "active");
  } finally {
    await s.stop();
  }
});

test("undo puts the file back exactly, only for a change made by this server, and not after another edit", async () => {
  const s = await start();
  try {
    const original = readFileSync(s.fx.files.crlf, "utf8");
    assert.equal((await s.post("/api/notes/choice-crlf/undo", {})).status, 409, "nothing to undo yet");
    await s.post("/api/notes/choice-crlf/status", { to: "active" });
    const u = await s.post("/api/notes/choice-crlf/undo", {});
    assert.equal(u.status, 200);
    assert.equal(readFileSync(s.fx.files.crlf, "utf8"), original);
    assert.equal(search(s.db, BODY_MARK).find((h) => h.ref === "choice-crlf")?.status, "proposed");
    assert.equal((await s.post("/api/notes/choice-crlf/undo", {})).status, 409, "only once");
    // a note changed from outside (CLI, an editor) is not overwritten
    await s.post("/api/notes/pattern-lf/status", { to: "active" });
    appendFileSync(s.fx.files.lf, "\nEdited by hand.\n");
    assert.equal((await s.post("/api/notes/pattern-lf/undo", {})).status, 409);
    assert.match(readFileSync(s.fx.files.lf, "utf8"), /Edited by hand/);
    // a note this server did not change has nothing to undo
    assert.equal((await s.post("/api/notes/adr-active/undo", {})).status, 409);
    const log = readFileSync(join(s.cfg.dataDir, "approvals.jsonl"), "utf8");
    assert.match(log, /"undo":true/);
    assert.equal(revertNoteStatus(s.cfg, { id: "pattern-lf", file: "patterns/pattern-lf.md", from: "proposed", to: "active", before: "x", after: "y" }).ok, false);
  } finally {
    await s.stop();
  }
});

function reports(cfg: GuardConfig) {
  const w = (rel: string, text: string): void => {
    const f = join(cfg.dataDir, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  };
  w("reviews/spil/2026-11-20-a.md", "# Review\n\nLooks <b>fine</b>.\n");
  w("reviews/replay-2026-11-20.md", "# Replay\n");
  w("reviews/patch.patch", "diff --git a/x b/x\n");
  w("qa/plans/plan-1.md", "# Plan\n");
  w("qa/other.md", "not a plan folder");
  w("daily/2026-11-20.md", "# Daily\n");
  w("quiz/q.md", "# Quiz\n");
  w("quiz/q.json", "{}");
  w("logcheck/l.md", "# Log\n");
  w("support-export/s.md", "# Support\n");
  w("chats/secret.md", "chat text that must not be served");
  w("big/huge.md", "x");
  w("reviews/huge.md", "a".repeat(MAX_REPORT_BYTES + 5000));
  writeFileSync(join(cfg.dataDir, "guard.db"), "binary");
}

test("reports: lists only allowed folders and .md files; reads them back; caps size", async () => {
  const s = await start();
  try {
    reports(s.cfg);
    const r = await s.get("/api/reports");
    assert.equal(r.status, 200);
    const list = (JSON.parse(r.body) as { reports: { path: string; name: string; kind: string; mtime: string; size: number }[] }).reports;
    const paths = list.map((x) => x.path).sort();
    assert.deepEqual(paths, [
      "daily/2026-11-20.md", "logcheck/l.md", "qa/plans/plan-1.md", "quiz/q.md", "reviews/huge.md", "reviews/replay-2026-11-20.md",
      "reviews/spil/2026-11-20-a.md", "support-export/s.md",
    ]);
    assert.deepEqual(new Set(list.map((x) => x.kind)), new Set(["review", "qa-plan", "daily", "quiz", "logcheck", "support-export"]));
    const times = list.map((x) => x.mtime);
    assert.deepEqual(times, [...times].sort().reverse(), "newest first");
    assert.ok(list.every((x) => typeof x.size === "number" && x.name.endsWith(".md")));

    const one = JSON.parse((await s.get("/api/report?path=reviews/spil/2026-11-20-a.md")).body) as { text: string; truncated: boolean };
    assert.ok(one.text.includes("<b>fine</b>"), "raw Markdown; the page escapes it");
    assert.equal(one.truncated, false);
    const big = JSON.parse((await s.get("/api/report?path=reviews/huge.md")).body) as { text: string; truncated: boolean };
    assert.equal(big.truncated, true);
    assert.equal(Buffer.byteLength(big.text), MAX_REPORT_BYTES);
  } finally {
    await s.stop();
  }
});

test("reports: traversal, absolute paths, other extensions and links are refused", async () => {
  const s = await start();
  try {
    reports(s.cfg);
    const abs = join(s.cfg.dataDir, "chats", "secret.md");
    const attempts = [
      "../chats/secret.md", "reviews/../chats/secret.md", "reviews/%2e%2e/chats/secret.md", "reviews/..%2fchats/secret.md",
      "/chats/secret.md", abs, abs.replace(/\\/g, "/"), "C:/Windows/win.ini", "reviews\\spil\\2026-11-20-a.md", "reviews/spil/..\\..\\chats\\secret.md",
      "chats/secret.md", "big/huge.md", "qa/other.md", "guard.db", "reviews/patch.patch", "quiz/q.json", "reviews", "reviews/", "reviews//x.md",
      "reviews/./replay-2026-11-20.md", "reviews/replay-2026-11-20.md%00.txt", "reviews/replay-2026-11-20.md.", "", "reviews/spil/",
      "a".repeat(400) + ".md", "reviews/spil/2026-11-20-a.md::$DATA", "reviews/NUL.md",
    ];
    for (const p of attempts) {
      const r = await s.get(`/api/report?path=${encodeURIComponent(p)}`);
      assert.equal(r.status, 404, `${p.slice(0, 40)} -> ${r.status}`);
      assert.ok(!r.body.includes("chat text that must not"), p);
    }
    assert.equal((await s.get("/api/report")).status, 404);
    // a link inside an allowed folder that points outside is not followed
    let linked = false;
    try {
      symlinkSync(join(s.cfg.dataDir, "chats", "secret.md"), join(s.cfg.dataDir, "reviews", "link.md"));
      linked = true;
    } catch {
      /* creating links may need a privilege; the folder walk and path check skip links anyway */
    }
    if (linked) {
      assert.equal((await s.get("/api/report?path=reviews/link.md")).status, 404);
      const names = (JSON.parse((await s.get("/api/reports")).body) as { reports: { name: string }[] }).reports.map((x) => x.name);
      assert.ok(!names.includes("link.md"));
    }
  } finally {
    await s.stop();
  }
});

/* ---------------- slash commands added for the merged read-only tools ---------------- */

test("slash allowlist: the new read-only commands run, everything else is refused", () => {
  const all = new Set(["qa", "quiz", "logcheck", "rules", "prs", "daily", "review", "refactor"]);
  const ok = (line: string): string[] => {
    const p = parseSlash(line, all);
    assert.ok(p.ok, `${line}: ${"error" in p ? p.error : ""}`);
    return p.ok ? p.argv : [];
  };
  assert.deepEqual(ok("/quiz list"), ["quiz", "list"]);
  assert.deepEqual(ok("/quiz run --no-model"), ["quiz", "run", "--no-model"]);
  assert.deepEqual(ok("/logcheck"), ["logcheck"]);
  assert.deepEqual(ok("/logcheck spil-aura --since 2026-11-01"), ["logcheck", "spil-aura", "--since", "2026-11-01"]);
  assert.deepEqual(ok("/rules list --status proposed"), ["rules", "list", "--status", "proposed"]);
  assert.deepEqual(ok("/qa status"), ["qa", "status"]);
  assert.deepEqual(ok("/qa plan"), ["qa", "plan"]);
  assert.deepEqual(ok("/prs status"), ["prs", "status"]);
  assert.deepEqual(ok("/daily"), ["daily"]);
  const light = (l: string): boolean => (parseSlash(l, all) as { heavy: boolean }).heavy === false;
  assert.ok(light("/qa status") && light("/quiz list") && light("/rules list"));
  assert.equal((parseSlash("/daily", all) as { heavy: boolean }).heavy, true);
  assert.equal((parseSlash("/qa run x", all) as { heavy: boolean }).heavy, true);

  for (const bad of [
    "/quiz run", "/quiz run --judge --no-model", "/quiz", "/quiz delete", "/rules approve x", "/rules dismiss x", "/rules propose", "/rules export", "/rules",
    "/prs sync", "/prs mine", "/prs dataset", "/prs status --force", "/daily --force", "/daily -f", "/qa run --force", "/quiz list --force",
    "/logcheck --since", "/logcheck --since tomorrow", "/logcheck a b", "/logcheck ;rm", "/rules list && dir", "/daily `x`", "/daily $(x)", "/daily a|b",
    "/daily a;b", "/prs status a&b", "/qa status >x", "/rules list --status \"x\"", "/shell", "/support draft x",
  ]) {
    assert.equal(parseSlash(bad, all).ok, false, bad);
  }
  assert.equal(parseSlash("/quiz list", new Set()).ok, false, "not installed");
});
