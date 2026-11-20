import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_ROOT } from "../src/config.ts";
import { openDb, upsertDoc } from "../src/index/db.ts";
import type { CompleteFn, CompleteRequest } from "../src/brain/client.ts";
import { NoBackendError } from "../src/brain/select.ts";
import { sessionFolderName } from "../src/sessions/read.ts";
import { captureCommands } from "../src/cli/commands-capture.ts";
import type { CommandContext } from "../src/cli/main.ts";
import type { GuardConfig } from "../src/types.ts";
import {
  loadCaptureConfig, localDate, parseDayText, pruneRetention, readConsent, repoKeyFor, repoStatuses, spoolDir,
} from "../src/capture/spool.ts";
import { summarizeDay, parseExistingLog, CaptureError } from "../src/capture/summarize.ts";
import { fakeSecret } from "./chat-helpers.ts";

const DATE = "2026-11-20";
const NOW = new Date(2026, 10, 20, 18, 0, 0);
const at = (h: number, m: number): string => new Date(2026, 10, 20, h, m, 0).toISOString();
let counter = 0;
const nextId = (): string => (++counter).toString(16).padStart(16, "0");

interface Env { spool: string; repo: string; key: string; cfg: GuardConfig; vault: string }

function setup(opts: { consent?: boolean } = {}): Env {
  const root = mkdtempSync(join(tmpdir(), "guard-cap-"));
  const spool = join(root, "spool");
  const repo = join(root, "work", "My Repo");
  mkdirSync(join(repo, "ai-log"), { recursive: true });
  writeFileSync(join(repo, "ai-log", "README.md"), "# AI activity log\n");
  mkdirSync(spool, { recursive: true });
  const key = repoKeyFor(repo);
  if (opts.consent !== false) {
    writeFileSync(join(spool, "consent.json"), JSON.stringify({ version: 1, acceptedAt: at(9, 0), developer: "dev", repos: { [key]: true } }));
  }
  const vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  const cfg: GuardConfig = { department: "dev", dataDir: join(root, "data"), vaultDir: vault, repos: [], busyProcesses: [], root: GUARD_ROOT };
  return { spool, repo, key, cfg, vault };
}

function ev(kind: string, data: Record<string, unknown>, ts: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, id: nextId(), ts, kind, repo: "x", branch: "feature/x", dev: "dev", data, ...extra };
}

function writeDay(env: Env, date: string, lines: (Record<string, unknown> | string)[]): void {
  const d = join(env.spool, env.key);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `events-${date}.jsonl`), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

function standardDay(): Record<string, unknown>[] {
  return [
    ev("save", { path: "src/a.ts", language: "typescript", count: 3, windowStart: at(9, 50), windowEnd: at(9, 58) }, at(9, 58)),
    ev("task", { name: "npm test", exitCode: 1, ms: 4000 }, at(10, 0)),
    ev("task", { name: "npm test", exitCode: 0, ms: 3000 }, at(10, 10)),
    ev("commit", { sha: "abcdef1234567", subject: "Add retry limit", body: "Unbounded retries hid failures.", files: [{ path: "src/a.ts", added: 10, removed: 2 }] }, at(10, 12)),
    ev("decision", { text: "Use a time limit, not a retry count" }, at(10, 20)),
    ev("correction", { text: "Do not catch errors silently" }, at(10, 30)),
    ev("idea", { text: "Show retries in the job card" }, at(10, 40)),
  ];
}

const noModel = { repoPath: "", date: DATE, noModel: true, now: NOW };
const ENTRY_HEAD = /^## \d{2}:\d{2} · .+ · .+$/m;

function tree(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) out.push(join(e.parentPath, e.name) + ":" + (e.isFile() ? statSync(join(e.parentPath, e.name)).mtimeMs : "d"));
  return out.sort();
}

// ---- repoKey ----
test("repoKey: same algorithm as the extension, with test vectors", () => {
  assert.equal(repoKeyFor("D:\\Work\\Orders App"), repoKeyFor("d:/work/orders app/"));
  assert.match(repoKeyFor("D:\\Work\\Orders App"), /^orders-app-[0-9a-f]{6}$/);
  assert.match(repoKeyFor("/home/Dev/My_Proj.v2"), /^my-proj-v2-[0-9a-f]{6}$/);
  assert.notEqual(repoKeyFor("C:/a/app"), repoKeyFor("C:/b/app"));
  assert.match(repoKeyFor("C:/"), /^c-[0-9a-f]{6}$/);
  // Test vectors, copied into docs/capture-events.md.
  assert.equal(repoKeyFor("D:\\Work\\Orders App"), "orders-app-540daa");
  assert.equal(repoKeyFor("D:\\Work\\Orders App\\"), "orders-app-540daa");
  assert.equal(repoKeyFor("C:\\Users\\Dev\\Projects\\Order-Entry_App"), "order-entry-app-b6d0f2");
  assert.equal(repoKeyFor("/home/dev/my.repo"), "my-repo-dac41a");
  assert.equal(repoKeyFor("C:/"), "c-508e9f");
});

test("spoolDir: env wins, else home folder", () => {
  assert.equal(spoolDir({ AURA_GUARD_SPOOL: "X:/s" }), "X:/s");
  assert.match(spoolDir({}), /\.aura-guard/);
});

// ---- spool reading ----
test("parseDayText: bad lines skipped and counted, sizes capped", () => {
  const cfg = loadCaptureConfig(GUARD_ROOT);
  const big = "x".repeat(5000);
  const lines = [
    JSON.stringify(ev("idea", { text: big }, at(9, 0))),
    "not json",
    JSON.stringify({ v: 2 }),
    JSON.stringify(ev("task", { name: "t", exitCode: "no", ms: 1 }, at(9, 1))),
    JSON.stringify(ev("commit", { sha: "abc1234", subject: "s", files: Array.from({ length: 80 }, (_, i) => ({ path: `f${i}`, added: 1, removed: 0 })) }, at(9, 2))),
    JSON.stringify(ev("idea", { text: "y".repeat(70_000) }, at(9, 3))),
    JSON.stringify(ev("terminal", { command: "rm -rf x", exitCode: 0, ms: 1 }, at(9, 4))),
    JSON.stringify(ev("terminal", { command: "C:\\bin\\npm.cmd test", exitCode: 0, ms: 1 }, at(9, 5))),
    "",
  ];
  const dup = JSON.stringify(ev("idea", { text: "once" }, at(9, 6)));
  const r = parseDayText([...lines, dup, dup].join("\n"), cfg);
  assert.equal(r.events.length, 4); // idea, commit, npm terminal, one "once"
  assert.equal(r.skipped, 6); // json, v2, bad exit, huge line, rm, duplicate
  const idea = r.events[0];
  assert.ok(idea && idea.kind === "idea" && idea.data.text.length === 1000);
  const commit = r.events.find((e) => e.kind === "commit");
  assert.ok(commit && commit.kind === "commit" && commit.data.files.length === 40);
});

test("parseDayText: maxEventsPerDay and disabled kinds", () => {
  const cfg = { ...loadCaptureConfig(GUARD_ROOT), maxEventsPerDay: 2, capture: { save: false } };
  const lines = [
    ev("save", { path: "a", language: "ts", count: 1, windowStart: at(9, 0), windowEnd: at(9, 1) }, at(9, 1)),
    ev("idea", { text: "1" }, at(9, 2)), ev("idea", { text: "2" }, at(9, 3)), ev("idea", { text: "3" }, at(9, 4)),
  ].map((e) => JSON.stringify(e));
  const r = parseDayText(lines.join("\n"), cfg);
  assert.equal(r.events.length, 2);
  assert.equal(r.skipped, 2);
});

// ---- consent ----
test("summarize needs consent for that repo", async () => {
  const env = setup({ consent: false });
  writeDay(env, DATE, standardDay());
  await assert.rejects(summarizeDay(env.cfg, { ...noModel, repoPath: env.repo, spoolDir: env.spool }), CaptureError);
  // Consent for another workspace does not count.
  writeFileSync(join(env.spool, "consent.json"), JSON.stringify({ version: 1, acceptedAt: at(9, 0), developer: "dev", repos: { "other-abcdef": true } }));
  await assert.rejects(summarizeDay(env.cfg, { ...noModel, repoPath: env.repo, spoolDir: env.spool }), /not switched on/);
  assert.equal(readConsent(env.spool)?.developer, "dev");
});

// ---- no-model draft ----
test("no-model draft: ai-log format, hash markers, deterministic", async () => {
  const env = setup();
  writeDay(env, DATE, standardDay());
  const o = { ...noModel, repoPath: env.repo, spoolDir: env.spool };
  const a = await summarizeDay(env.cfg, o);
  const b = await summarizeDay(env.cfg, o);
  assert.equal(a.draft, b.draft);
  assert.equal(a.backend, "none");
  assert.equal(a.file, "ai-log/2026/11/2026-11-20-dev.md");
  assert.ok(a.draft.startsWith("# 2026-11-20 · dev\n\n"));
  assert.match(a.draft, ENTRY_HEAD);
  assert.match(a.draft, /^## 10:12 · VS Code · feature\/x$/m);
  assert.match(a.draft, /- \*\*What:\*\* Add retry limit/);
  assert.match(a.draft, /- \*\*Why:\*\* Unbounded retries hid failures\./);
  assert.match(a.draft, /- \*\*Files:\*\* src\/a\.ts/);
  assert.match(a.draft, /- \*\*Commit:\*\* abcdef1$/m);
  assert.match(a.draft, /- \*\*Checks:\*\* `npm test` exit 1, then 0/);
  assert.match(a.draft, /- \*\*Decided:\*\* Use a time limit/);
  assert.match(a.draft, /- \*\*Correction:\*\* Do not catch errors silently/);
  assert.match(a.draft, /- \*\*Ideas:\*\* Show retries in the job card/);
  assert.equal((a.draft.match(/<!-- guard-capture: [0-9a-f]{12} ids:/g) ?? []).length, a.entries);
  assert.equal(a.entries, 4);
  assert.equal(a.commits, 1);
  assert.deepEqual(a.ideas, ["Show retries in the job card"]);
  assert.deepEqual(a.sources.transcriptTurns, 0);
});

test("no-model draft: a commit with no check says so", async () => {
  const env = setup();
  writeDay(env, DATE, [ev("commit", { sha: "1111111", subject: "Tidy", files: [] }, at(11, 0))]);
  const r = await summarizeDay(env.cfg, { ...noModel, repoPath: env.repo, spoolDir: env.spool });
  assert.match(r.draft, /- \*\*Not verified:\*\* No test or build run was recorded/);
});

test("dedupe: appended draft is skipped next time; commit sha already logged is skipped", async () => {
  const env = setup();
  writeDay(env, DATE, standardDay());
  const o = { ...noModel, repoPath: env.repo, spoolDir: env.spool };
  const first = await summarizeDay(env.cfg, o);
  const dir = join(env.repo, "ai-log", "2026", "11");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-11-20-dev.md"), first.draft);
  const second = await summarizeDay(env.cfg, o);
  assert.equal(second.entries, 0);
  assert.equal(second.draft, "");

  // A commit hook logged the commit by sha only.
  writeFileSync(join(dir, "2026-11-20-dev.md"), "# 2026-11-20 · dev\n\n## 10:13 · Claude Code · feature/x\n\n- **What:** hook\n- **Commit:** abcdef1\n");
  const third = await summarizeDay(env.cfg, o);
  assert.doesNotMatch(third.draft, /Add retry limit/);
  assert.ok(!third.draft.startsWith("# "), "existing file: no title line");
  assert.match(third.draft, /Show retries/);
});

test("parseExistingLog reads markers and commit shas", () => {
  const l = parseExistingLog("- **Commit:** abc1234, deadbeef0\n<!-- guard-capture: 0123456789ab ids:aa,bb -->");
  assert.deepEqual([...l.hashes], ["0123456789ab"]);
  assert.deepEqual([...l.ids], ["aa", "bb"]);
  assert.deepEqual(l.shas, ["abc1234", "deadbeef0"]);
});

// ---- model path ----
function fakeComplete(reply: unknown, seen: CompleteRequest[] = []): CompleteFn {
  return async (req) => {
    seen.push(req);
    return { text: typeof reply === "string" ? reply : JSON.stringify(reply), usage: { input_tokens: 1, output_tokens: 1 } };
  };
}

test("model draft: JSON validated, invented refs dropped, code adds files/commit/checks", async () => {
  const env = setup();
  writeDay(env, DATE, standardDay());
  const seen: CompleteRequest[] = [];
  const reply = {
    entries: [
      { cites: ["E1", "E2", "E3", "E4", "E99"], what: "Added a retry time limit", why: "Unbounded retries hid failures" },
      { cites: ["E77"], what: "Invented work that never happened" },
      { cites: [], what: "Also invented" },
    ],
    ideas: ["Show retries in the job card"],
    questions: ["Was the old retry count used elsewhere?", "q2", "q3", "q4"],
  };
  const r = await summarizeDay(env.cfg, { repoPath: env.repo, date: DATE, now: NOW, spoolDir: env.spool }, { complete: fakeComplete(reply, seen), backendUsed: () => "claude-cli" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.role, "capture-summarizer");
  assert.match(seen[0]?.system[0] ?? "", /Never invent a fact/);
  assert.match(seen[0]?.user ?? "", /^E1 .*saved src\/a\.ts/m);
  assert.equal(r.backend, "claude-cli");
  assert.doesNotMatch(r.draft, /Invented/);
  assert.match(r.draft, /- \*\*What:\*\* Added a retry time limit/);
  assert.match(r.draft, /- \*\*Commit:\*\* abcdef1/);
  assert.match(r.draft, /- \*\*Checks:\*\* `npm test` exit 1, then 0/);
  assert.match(r.draft, /- \*\*Files:\*\* src\/a\.ts/);
  // Items the model left out (decision, correction, idea) are still added without it.
  assert.match(r.draft, /Use a time limit, not a retry count/);
  assert.match(r.draft, /Do not catch errors silently/);
  assert.equal(r.questions.length, 3);
  assert.equal(r.entries, 4);
  assert.deepEqual(r.sources, { events: 7, transcriptTurns: 0 });
});

test("model reply that is not valid JSON is an error; no backend falls back and says so", async () => {
  const env = setup();
  writeDay(env, DATE, standardDay());
  const o = { repoPath: env.repo, date: DATE, now: NOW, spoolDir: env.spool };
  await assert.rejects(summarizeDay(env.cfg, o, { complete: fakeComplete("sorry no json") }), /no JSON/);
  const r = await summarizeDay(env.cfg, o, { complete: async () => { throw new NoBackendError("none"); } });
  assert.equal(r.backend, "none");
  assert.match(r.fallback ?? "", /without it/);
  assert.match(r.draft, /Add retry limit/);
});

test("nothing new: the model is not called", async () => {
  const env = setup();
  const seen: CompleteRequest[] = [];
  const r = await summarizeDay(env.cfg, { repoPath: env.repo, date: DATE, now: NOW, spoolDir: env.spool }, { complete: fakeComplete({}, seen) });
  assert.equal(seen.length, 0);
  assert.equal(r.draft, "");
});

test("a secret in an event never reaches the model or the draft", async () => {
  const env = setup();
  const secret = fakeSecret();
  writeDay(env, DATE, [
    ev("idea", { text: `use token ${secret} for tests` }, at(9, 0)),
    ev("commit", { sha: "2222222", subject: "Safe commit", files: [] }, at(9, 5)),
  ]);
  const seen: CompleteRequest[] = [];
  const r = await summarizeDay(env.cfg, { repoPath: env.repo, date: DATE, now: NOW, spoolDir: env.spool }, { complete: fakeComplete({ entries: [{ cites: ["E1"], what: "Safe commit made" }] }, seen) });
  const sent = JSON.stringify(seen);
  assert.ok(!sent.includes(secret));
  assert.ok(!r.draft.includes(secret));
  assert.ok(!JSON.stringify(r).includes(secret));
  const noM = await summarizeDay(env.cfg, { ...noModel, repoPath: env.repo, spoolDir: env.spool });
  assert.ok(!noM.draft.includes(secret));
});

// ---- Claude Code transcript turns ----
test("transcript turns: owner prompts and final answers for that day only", async () => {
  const env = setup();
  writeDay(env, DATE, [ev("commit", { sha: "3333333", subject: "Work", files: [] }, at(10, 0))]);
  const sessions = join(env.cfg.dataDir, "projects");
  mkdirSync(join(sessions, sessionFolderName(env.repo)), { recursive: true });
  const S = "22222222-aaaa-bbbb-cccc-000000000002";
  const line = (type: string, content: unknown, ts: string): string =>
    JSON.stringify({ type, sessionId: S, timestamp: ts, message: { role: type, content } });
  writeFileSync(join(sessions, sessionFolderName(env.repo), `${S}.jsonl`), [
    line("user", "Please add a retry limit", at(10, 1)),
    line("assistant", [{ type: "text", text: "Looking at the code" }], at(10, 2)),
    line("assistant", [{ type: "text", text: "Added the limit." }], at(10, 3)),
    line("user", "Old chat from another day", new Date(2026, 9, 1, 10, 0).toISOString()),
    line("user", [{ type: "tool_result", content: "tool output" }], at(10, 4)),
  ].join("\n"));
  const seen: CompleteRequest[] = [];
  const reply = { entries: [{ cites: ["T1", "T2"], what: "Owner asked for a retry limit and it was added" }] };
  const r = await summarizeDay(env.cfg, { repoPath: env.repo, date: DATE, now: NOW, spoolDir: env.spool, sessionsRoot: sessions }, { complete: fakeComplete(reply, seen), backendUsed: () => "anthropic-api" });
  assert.equal(r.sources.transcriptTurns, 2);
  const user = seen[0]?.user ?? "";
  assert.match(user, /T1 \d\d:\d\d owner: Please add a retry limit/);
  assert.match(user, /T2 \d\d:\d\d assistant answer: Added the limit\./);
  assert.doesNotMatch(user, /Looking at the code|Old chat|tool output/);
  assert.match(r.draft, /· Claude Code ·/);
  assert.match(r.draft, /ids:t-[0-9a-f]{8},t-[0-9a-f]{8}/);
  // Same turns again: already in the log, so nothing is sent.
  const dir = join(env.repo, "ai-log", "2026", "11");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-11-20-dev.md"), r.draft);
  const again = await summarizeDay(env.cfg, { repoPath: env.repo, date: DATE, now: NOW, spoolDir: env.spool, sessionsRoot: sessions }, { complete: fakeComplete(reply, seen) });
  assert.equal(again.sources.transcriptTurns, 0);
});

// ---- choice notes ----
test("decisions and corrections become proposed notes in the local vault only", async () => {
  const env = setup();
  writeDay(env, DATE, standardDay());
  const before = tree(env.repo);
  const r = await summarizeDay(env.cfg, { ...noModel, repoPath: env.repo, spoolDir: env.spool });
  assert.equal(r.notes, 2);
  assert.deepEqual(tree(env.repo), before, "the summarised repo is untouched");
  const inbox = join(env.vault, "inbox");
  const files = readdirSync(inbox);
  assert.equal(files.length, 2);
  const text = readFileSync(join(inbox, files[0] as string), "utf8");
  assert.match(text, /status: proposed/);
  assert.match(text, /type: choice/);
  assert.match(text, /title: Developer (decision|correction) on \d{4}-\d{2}-\d{2} \([0-9a-f]{6}\)/);
  const again = await summarizeDay(env.cfg, { ...noModel, repoPath: env.repo, spoolDir: env.spool });
  assert.equal(again.notes, 0);
  assert.equal(readdirSync(inbox).length, 2);
});

// ---- retention and purge ----
test("retention prunes old days; status shows the rest", async () => {
  const env = setup();
  const cfg = loadCaptureConfig(GUARD_ROOT);
  writeDay(env, "2020-01-01", [ev("idea", { text: "old" }, "2020-01-01T10:00:00.000Z")]);
  writeDay(env, DATE, standardDay());
  assert.equal(pruneRetention(env.spool, cfg, NOW), 1);
  assert.ok(!existsSync(join(env.spool, env.key, "events-2020-01-01.jsonl")));
  const rows = repoStatuses(env.spool, cfg);
  assert.deepEqual(rows, [{ repoKey: env.key, days: 1, events: 7, oldest: DATE, newest: DATE }]);
  assert.equal(localDate(new Date(2026, 0, 5)), "2026-01-05");
});

// ---- CLI: one JSON object each ----
async function cli(env: Env, args: string[], extraFlags: Record<string, string | true> = {}, cfg: GuardConfig = env.cfg): Promise<{ code: number; lines: string[]; obj: Record<string, unknown> }> {
  const lines: string[] = [];
  const [name, ...rest] = args;
  const prev = process.env.AURA_GUARD_SPOOL;
  process.env.AURA_GUARD_SPOOL = env.spool;
  try {
    const ctx: CommandContext = { rest, flags: { json: true, ...extraFlags }, out: (s) => lines.push(s), cfg };
    const code = await (captureCommands[name as string] as (c: CommandContext) => Promise<number> | number)(ctx);
    assert.equal(lines.length, 1, `exactly one output line, got: ${lines.join(" | ")}`);
    return { code, lines, obj: JSON.parse(lines[0] as string) as Record<string, unknown> };
  } finally {
    if (prev === undefined) delete process.env.AURA_GUARD_SPOOL;
    else process.env.AURA_GUARD_SPOOL = prev;
  }
}

test("CLI capture status / show / summarize / purge print one JSON object", async () => {
  const env = setup();
  const today = localDate();
  const todayEvents = standardDay().map((e, i) => ({ ...e, ts: new Date(new Date().setHours(9, i, 0, 0)).toISOString() }));
  writeDay(env, today, [...todayEvents, "garbage line"]);

  const st = await cli(env, ["capture", "status"]);
  assert.equal(st.code, 0);
  assert.equal(st.obj.ok, true);
  assert.equal(st.obj.spoolDir, env.spool);
  assert.deepEqual(st.obj.consent, { accepted: true, developer: "dev" });
  assert.deepEqual(st.obj.repos, [{ repoKey: env.key, days: 1, events: 7, oldest: today, newest: today }]);

  const sh = await cli(env, ["capture", "show"], { repo: env.repo });
  assert.equal(sh.obj.ok, true);
  assert.equal(sh.obj.date, today);
  assert.equal((sh.obj.events as unknown[]).length, 7);
  assert.equal(sh.obj.skipped, 1);

  const su = await cli(env, ["capture", "summarize"], { repo: env.repo, "no-model": true });
  assert.equal(su.obj.ok, true);
  for (const k of ["date", "file", "draft", "entries", "commits", "ideas", "questions", "sources", "backend"]) assert.ok(k in su.obj, k);
  assert.equal(su.obj.backend, "none");
  assert.match(su.obj.file as string, /^ai-log\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-dev\.md$/);

  const pg = await cli(env, ["capture", "purge"], { repo: env.repo, all: true });
  assert.deepEqual(pg.obj, { ok: true, removed: 1 });
  assert.ok(existsSync(join(env.spool, "consent.json")), "per-repo purge keeps consent");

  const noScope = await cli(env, ["capture", "purge"], { repo: env.repo });
  assert.equal(noScope.code, 1);
  assert.equal(noScope.obj.ok, false);
});

test("CLI purge --before and --all --yes", async () => {
  const env = setup();
  writeDay(env, "2026-11-01", [ev("idea", { text: "a" }, at(9, 0))]);
  writeDay(env, "2026-11-19", [ev("idea", { text: "b" }, at(9, 0))]);
  const r1 = await cli(env, ["capture", "purge"], { repo: env.repo, before: "2026-11-10" });
  assert.deepEqual(r1.obj, { ok: true, removed: 1 });
  assert.ok(existsSync(join(env.spool, env.key, "events-2026-11-19.jsonl")));
  const noYes = await cli(env, ["capture", "purge"], { all: true });
  assert.equal(noYes.code, 1);
  assert.ok(existsSync(join(env.spool, "consent.json")));
  const all = await cli(env, ["capture", "purge"], { all: true, yes: true });
  assert.deepEqual(all.obj, { ok: true, removed: 2 }); // one day file + consent
  assert.ok(!existsSync(join(env.spool, "consent.json")));
  assert.ok(existsSync(env.spool), "the spool folder itself is not deleted");
});

test("CLI errors are one JSON object with exit 1", async () => {
  const env = setup({ consent: false });
  const cases: [string[], Record<string, string | true>][] = [
    [["capture", "show"], { repo: env.repo }], // no consent
    [["capture", "show"], {}], // no repo
    [["capture", "show"], { repo: "relative/path" }],
    [["capture", "summarize"], { repo: env.repo, date: "2026-13-40", "no-model": true }],
    [["capture", "nope"], {}],
    [["answer"], {}],
  ];
  for (const [args, flags] of cases) {
    const r = await cli(env, args, flags);
    assert.equal(r.code, 1, args.join(" "));
    assert.equal(r.obj.ok, false);
    assert.equal(typeof r.obj.error, "string");
  }
});

test("CLI answer: no index, nothing found, and a blocked secret", async () => {
  const env = setup();
  const noIndex = await cli(env, ["answer", "Why is it so?"]);
  assert.equal(noIndex.code, 1);
  assert.equal(noIndex.obj.ok, false);
  assert.equal(noIndex.obj.kind, "no-index");

  mkdirSync(env.cfg.dataDir, { recursive: true });
  const db = openDb(join(env.cfg.dataDir, "guard.db"));
  upsertDoc(db, { kind: "note", ref: "rule-erp-create", title: "The AI never gets an ERP create tool", body: "The backend owns every ERP create operation.", hash: "1", status: "active", noteType: "rule", audience: "internal_dev" });
  db.close();

  const none = await cli(env, ["answer", "zzqxv wwkjh"], { "notes-only": true });
  assert.equal(none.code, 0);
  assert.equal(none.obj.ok, true);
  assert.equal(none.obj.backend, "none");
  assert.deepEqual(none.obj.sources, []);
  assert.equal(typeof none.obj.text, "string");

  const secret = fakeSecret();
  const blocked = await cli(env, ["answer", `Why does the AI never get an ERP create tool? token ${secret}`]);
  assert.equal(blocked.code, 1);
  assert.equal(blocked.obj.ok, false);
  assert.equal(blocked.obj.kind, "blocked");
  assert.ok(!blocked.lines[0]?.includes(secret));
});
