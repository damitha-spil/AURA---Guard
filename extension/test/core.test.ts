import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildEvent, DAILY_CAP } from "../src/core/events.ts";
import { GuardCli, validateGuardHome } from "../src/core/cli.ts";
import type { Runner } from "../src/core/cli.ts";
import { grantConsent, hasConsent, readConsent } from "../src/core/consent.ts";
import { appendDraft, resolveAiLogTarget } from "../src/core/draft.ts";
import { parseShow } from "../src/core/gitinfo.ts";
import { Recorder } from "../src/core/recorder.ts";
import { localDate, repoKey } from "../src/core/repoKey.ts";
import { SaveAggregator, WINDOW_MS } from "../src/core/saves.ts";
import { Spool, resolveSpoolDir } from "../src/core/spool.ts";
import { allowedCommand } from "../src/core/terminal.ts";

// Secrets are built at run time so this file holds no real-looking secret.
const secret = () => "ghp_" + "aB3xK9mQ2wL7pR5tY8uN4vC6zD1fG0hJ2kS3";
const tmp = () => mkdtempSync(join(tmpdir(), "guard-ext-"));
const base = { repo: "r-abc123", branch: "main", dev: "test" };

test("a secret drops the whole event; ordinary text and commit ids pass", () => {
  const bad = buildEvent({ ...base, kind: "idea", ts: new Date(), stableKey: "a", data: { text: `use ${secret()} here` } });
  assert.equal(bad, null);
  const nested = buildEvent({ ...base, kind: "commit", ts: new Date(), stableKey: "b", data: { sha: "x", subject: "ok", files: [{ path: `a/${secret()}`, added: 1, removed: 0 }] } });
  assert.equal(nested, null);
  const sha = "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";
  const ok = buildEvent({ ...base, kind: "commit", ts: new Date(), stableKey: sha, data: { sha, subject: "Fix the thing", files: [] } });
  assert.ok(ok);
  assert.equal(ok.data.sha, sha);
  assert.match(ok.id, /^[0-9a-f]{16}$/);
});

test("event id is the first 16 hex of sha256(kind + ts + key)", () => {
  const ts = new Date("2026-11-20T10:00:00.000Z");
  const e = buildEvent({ ...base, kind: "idea", ts, stableKey: "k", data: { text: "hi" } })!;
  assert.equal(e.id, createHash("sha256").update("idea" + ts.toISOString() + "k").digest("hex").slice(0, 16));
  assert.equal(e.v, 1);
});

test("repoKey: shape and sanitising", () => {
  const k = repoKey("D:\\Work\\My Repo!");
  assert.match(k, /^my-repo-[0-9a-f]{6}$/);
  const h = createHash("sha256").update("d:/work/my repo!").digest("hex").slice(0, 6);
  assert.equal(k, `my-repo-${h}`);
  assert.equal(repoKey("C:/x/Aura/"), `aura-${createHash("sha256").update("c:/x/aura").digest("hex").slice(0, 6)}`);
  assert.equal(repoKey("D:\\Work\\Orders App"), `orders-app-${createHash("sha256").update("d:/work/orders app").digest("hex").slice(0, 6)}`);
  // Same folder in either slash style and any case gives the same hash.
  assert.equal(repoKey("D:\\Work\\Repo"), repoKey("d:/work/repo".replace("repo", "Repo")));
});

test("repoKey matches the published vectors when docs/capture-events.md has them", (t) => {
  const f = join(import.meta.dirname, "..", "..", "docs", "capture-events.md");
  if (!existsSync(f)) return t.skip("docs/capture-events.md not written yet; vectors unchecked");
  const rows = [...readFileSync(f, "utf8").matchAll(/`([^`\n]+)`\s*(?:->|→|=>|\|)\s*`([a-z0-9-]+-[0-9a-f]{6})`/g)];
  if (rows.length === 0) return t.skip("no test vectors found in docs/capture-events.md");
  for (const [, path, key] of rows) assert.equal(repoKey(path!), key, path);
});

test("saves aggregate per file per 5-minute window and never hold contents", () => {
  const a = new SaveAggregator();
  const t0 = Math.floor(Date.UTC(2026, 10, 20, 10, 0) / WINDOW_MS) * WINDOW_MS;
  a.add("a.ts", "typescript", t0 + 1000);
  a.add("a.ts", "typescript", t0 + 200_000);
  a.add("b.ts", "typescript", t0 + 5000);
  a.add("a.ts", "typescript", t0 + WINDOW_MS + 1);
  assert.deepEqual(a.flush(t0 + 1000), []);
  const done = a.flush(t0 + WINDOW_MS);
  assert.equal(done.length, 2);
  assert.equal(done.find((b) => b.path === "a.ts")!.count, 2);
  assert.deepEqual(Object.keys(done[0]!).sort(), ["count", "language", "path", "windowEnd", "windowStart"]);
  assert.equal(a.flush(0, true).length, 1); // the open window
});

test("terminal allowlist and argument masking", () => {
  for (const c of ["git status", "cargo test -p x", "npm.cmd run build", "& \"C:\\Program Files\\nodejs\\node.exe\" a.js", "pnpm i"]) assert.ok(allowedCommand(c), c);
  for (const c of ["curl http://x", "rm -rf /", "ssh host", "", "echo git"]) assert.equal(allowedCommand(c), null, c);
  const withSecret = allowedCommand(`git push https://user:${secret()}@host/x`)!;
  const ev = buildEvent({ ...base, kind: "terminal", ts: new Date(), stableKey: "t", data: { command: withSecret, exitCode: 0, ms: 5 } });
  assert.equal(ev, null);
});

test("spool appends whole lines, one per event, and stops at the daily cap", () => {
  const dir = tmp();
  try {
    const sp = new Spool(dir, 3);
    for (let i = 0; i < 5; i++) {
      const e = buildEvent({ ...base, kind: "idea", ts: new Date(2026, 10, 20, 9, i), stableKey: String(i), data: { text: `idea ${i}` } })!;
      assert.equal(sp.append(e, "2026-11-20"), i < 3 ? "written" : "cap");
    }
    const lines = readFileSync(sp.file("r-abc123", "2026-11-20"), "utf8").split("\n");
    assert.equal(lines.pop(), "");
    assert.equal(lines.length, 3);
    for (const l of lines) assert.equal(JSON.parse(l).kind, "idea");
    assert.equal(new Spool(dir, 3).count("r-abc123", "2026-11-20"), 3); // survives a restart
    assert.equal(DAILY_CAP, 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("consent file: write, read, per workspace", () => {
  const dir = tmp();
  try {
    assert.equal(readConsent(dir), null);
    grantConsent(dir, "alex", "aura-111111", new Date("2026-11-20T08:00:00Z"));
    const c = grantConsent(dir, "alex", "guard-222222", new Date("2026-11-21T08:00:00Z"));
    assert.equal(c.acceptedAt, "2026-11-20T08:00:00.000Z");
    const back = JSON.parse(readFileSync(join(dir, "consent.json"), "utf8"));
    assert.deepEqual(back, { version: 1, acceptedAt: "2026-11-20T08:00:00.000Z", developer: "alex", repos: { "aura-111111": true, "guard-222222": true } });
    assert.ok(hasConsent(readConsent(dir), "aura-111111"));
    assert.ok(!hasConsent(readConsent(dir), "other-000000"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recorder: no consent, paused, source off, secret counter", () => {
  const dir = tmp();
  try {
    let consent = null as ReturnType<typeof readConsent>;
    let paused = false;
    let on = true;
    const r = new Recorder({
      spool: new Spool(dir), repo: "r-abc123", dev: "t", getConsent: () => consent, isPaused: () => paused, sourceOn: () => on, branch: () => "main", now: () => new Date(2026, 10, 20, 9),
    });
    assert.equal(r.record("idea", { text: "x" }, "1"), "no-consent");
    consent = grantConsent(dir, "t", "r-abc123", new Date());
    paused = true;
    assert.equal(r.record("idea", { text: "x" }, "1"), "paused");
    paused = false;
    on = false;
    assert.equal(r.record("task", { name: "x", exitCode: 0, ms: 1 }, "1"), "source-off");
    on = true;
    assert.equal(r.record("idea", { text: secret() }, "2"), "secret");
    assert.equal(r.dropped, 1);
    assert.equal(r.record("idea", { text: "fine" }, "3"), "written");
    assert.equal(r.today, 1);
    assert.ok(!readFileSync(join(dir, "r-abc123", `events-${localDate(new Date(2026, 10, 20))}.jsonl`), "utf8").includes("ghp_"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spool dir: setting, env, default; refuses network paths", () => {
  assert.equal(resolveSpoolDir("", {}, "/home/x").replace(/\\/g, "/"), "/home/x/.aura-guard/spool");
  assert.equal(resolveSpoolDir("", { AURA_GUARD_SPOOL: process.cwd() }), process.cwd());
  assert.throws(() => resolveSpoolDir("\\\\server\\share", {}));
  assert.throws(() => resolveSpoolDir("https://x/y", {}));
  assert.throws(() => resolveSpoolDir("relative/dir", {}));
});

test("git show output parsing: files capped, merges flagged, trailers removed", () => {
  const files = Array.from({ length: 50 }, (_, i) => `${i}\t1\tf${i}.ts`).join("\n");
  const out = `abc\x1fp1\x1fSubject\x1fBody text\nCo-Authored-By: X <x@y>\x1e\n\n${files}\n-\t-\timg.png\n`;
  const c = parseShow(out)!;
  assert.equal(c.files.length, 40);
  assert.equal(c.body, "Body text");
  assert.equal(c.isMerge, false);
  assert.equal(parseShow(`abc\x1fp1 p2\x1fMerge\x1f\x1e\n`)!.isMerge, true);
});

test("ai-log target must be an ai-log file inside the repo", () => {
  const root = tmp();
  try {
    assert.ok(resolveAiLogTarget(root, "ai-log/2026/11/2026-11-20-alex.md"));
    for (const bad of ["../x.md", "ai-log/../../x.md", "src/a.md", "ai-log/2026/11/x.md", "/etc/passwd"]) assert.equal(resolveAiLogTarget(root, bad), null, bad);
    assert.equal(appendDraft(null, "## a\n"), "## a\n");
    assert.equal(appendDraft("# t\n", "## a"), "# t\n\n## a\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guard CLI calls use argument arrays and --json", async () => {
  const calls: { file: string; args: string[]; timeout: number }[] = [];
  const run: Runner = async (file, args, o) => {
    calls.push({ file, args, timeout: o.timeout });
    return { stdout: JSON.stringify({ ok: true, date: "d", file: "f", draft: "", entries: 0, commits: 0, ideas: [], questions: [], sources: {}, backend: "x", removed: 0, text: "t", sources2: [] }) };
  };
  const cli = new GuardCli("/g", "/n/node", run);
  await cli.status();
  await cli.show("/w", "2026-11-20");
  await cli.summarize("/w", undefined, true);
  await cli.purge("/w", { all: true });
  await cli.purge("/w", { before: "2026-01-01" });
  await cli.answer("why; rm -rf /");
  await cli.answer("-x");
  const g = (p: string[]) => [join("/g", "bin", "aura-guard.mjs"), ...p, "--json"];
  assert.deepEqual(calls.map((c) => c.args), [
    g(["capture", "status"]),
    g(["capture", "show", "--repo", "/w", "--date", "2026-11-20"]),
    g(["capture", "summarize", "--repo", "/w", "--no-model"]),
    g(["capture", "purge", "--repo", "/w", "--all"]),
    g(["capture", "purge", "--repo", "/w", "--before", "2026-01-01"]),
    g(["answer", "why; rm -rf /"]),
    g(["answer", "Q: -x"]),
  ]);
  assert.ok(calls.every((c) => c.file === "/n/node" && c.timeout > 0));
  const failing = new GuardCli("/g", "", async () => ({ stdout: '{"ok":false,"error":"nope"}' }));
  await assert.rejects(failing.status(), /nope/);
  await assert.rejects(new GuardCli("/g", "", async () => ({ stdout: "garbage" })).status(), /JSON/);
});

test("guardHome validation", () => {
  const home = tmp();
  try {
    assert.match(validateGuardHome("")!, /Set auraGuard/);
    assert.match(validateGuardHome(join(home, "nope"))!, /does not exist/);
    assert.match(validateGuardHome(home)!, /not an SPIL Quality Support Bot clone/);
    mkdirSync(join(home, "engine", "src", "cli"), { recursive: true });
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "engine", "src", "cli", "main.ts"), "");
    writeFileSync(join(home, "bin", "aura-guard.mjs"), "");
    assert.equal(validateGuardHome(home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
