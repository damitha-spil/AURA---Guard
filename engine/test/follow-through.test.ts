// Memory, follow-through, approval cards and background missions. No model and no network (written, not run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpCfg, fakeSecret, seed } from "./chat-helpers.ts";
import { addMemory, listMemory, MAX_MEMORIES, memoryBlock, memoryProblem, parseRemember, removeMemory, updateMemory } from "../src/chat/memory.ts";
import { CreationLog, MAX_CREATED_PER_MESSAGE, MAX_NOTES_PER_MESSAGE, runCreateTool } from "../src/chat/follow-through.ts";
import { ApprovalHub } from "../src/chat/approvals.ts";
import { MissionManager, MAX_MISSIONS_RUNNING } from "../src/chat/missions.ts";
import { runAgent } from "../src/chat/agent-loop.ts";
import type { CompleteFn } from "../src/brain/client.ts";
import { listFollowups } from "../src/followups/store.ts";
import { listDefects } from "../src/defects/store.ts";

const usage = { input_tokens: 1, output_tokens: 1 };
const script = (replies: string[]): CompleteFn => { let i = 0; return async () => ({ text: replies[Math.min(i++, replies.length - 1)]!, usage }); };

test("parseRemember: only a message that starts with remember", () => {
  assert.equal(parseRemember("remember that I prefer short answers"), "I prefer short answers");
  assert.equal(parseRemember("Please remember: tests use node:test"), "tests use node:test");
  assert.equal(parseRemember("do you remember when we fixed it?"), null);
  assert.equal(parseRemember("remember when the build failed?"), null);
});

test("memory: capped, refuses secrets and private values, edits, deletes, and is masked into a budgeted block", () => {
  const dir = tmpCfg().dataDir;
  assert.ok(memoryProblem(`my token is ${fakeSecret()}`));
  assert.ok(memoryProblem("mail anna@example.com about it"));
  assert.ok(memoryProblem("x".repeat(400)));
  const a = addMemory(dir, "I prefer short answers");
  assert.ok(a.ok);
  assert.ok(addMemory(dir, "i prefer short answers").ok && listMemory(dir).length === 1, "same text is not stored twice");
  assert.equal(addMemory(dir, `key ${fakeSecret()}`).ok, false);
  assert.ok(!existsSync(join(dir, "memory", "memory.json")) || !readFileSync(join(dir, "memory", "memory.json"), "utf8").includes("ghp_"));
  if (a.ok) {
    const u = updateMemory(dir, a.entry.id, "I prefer long answers");
    assert.ok(u && u.ok && u.entry.text === "I prefer long answers");
    assert.equal(updateMemory(dir, a.entry.id, `x ${fakeSecret()}`)?.ok, false);
  }
  assert.match(memoryBlock(dir), /not sources/);
  assert.equal(memoryBlock(dir, 20), "", "a budget too small for any entry gives nothing");
  for (let i = 0; listMemory(dir).length < MAX_MEMORIES; i++) addMemory(dir, `fact number ${i}`);
  assert.equal(addMemory(dir, "one more").ok, false);
  const first = listMemory(dir)[0]!;
  assert.ok(removeMemory(dir, first.id));
  assert.equal(removeMemory(dir, first.id), false);
});

test("follow-through creates only REO's own items, within caps, and refuses secrets", () => {
  const cfg = tmpCfg();
  const log = new CreationLog();
  const ctx = { cfg, chatId: "a".repeat(16), log };
  assert.match(runCreateTool("create_followup", { text: "Check the build", due: "2026-12-31" }, ctx), /Created follow-up/);
  assert.match(runCreateTool("create_task", { text: "Read the log" }, ctx), /Created task/);
  assert.match(runCreateTool("draft_defect", { title: "Button does nothing", severity: "high" }, ctx), /defect draft/);
  assert.equal(listFollowups(cfg.dataDir).length, 1);
  assert.equal(listDefects(cfg.dataDir)[0]?.status, "open");
  assert.match(runCreateTool("propose_note", { type: "pattern", title: "A pattern", body: "Plain body." }, ctx), /status proposed/);
  const note = readFileSync(join(cfg.vaultDir, "patterns", "pattern-a-pattern.md"), "utf8");
  assert.match(note, /status: proposed/);
  assert.throws(() => runCreateTool("propose_note", { type: "rule", title: "x", body: "y" }, ctx), /must be one of/);
  assert.throws(() => runCreateTool("create_followup", { text: `use ${fakeSecret()}` }, ctx), /secret/);
  assert.equal(log.count(), 4);
  runCreateTool("propose_note", { type: "domain", title: "Second", body: "b" }, ctx);
  assert.throws(() => runCreateTool("propose_note", { type: "domain", title: "Third", body: "b" }, ctx), new RegExp(`${MAX_NOTES_PER_MESSAGE}|${MAX_CREATED_PER_MESSAGE}`));
});

test("agent loop: a creation tool makes the item, the answer lists it, and a role pass cannot use it", async () => {
  const cfg = tmpCfg();
  const creations = new CreationLog();
  const r = await runAgent({ system: ["rules"], user: "Question: track this", sources: [], backend: "Test" }, {
    cfg, db: seed(), webOn: false, creations, chatId: "b".repeat(16),
    complete: script(['{"tool":"create_followup","args":{"text":"Look at the flaky test"}}', "Saved it."]),
  });
  assert.equal(r.created?.length, 1);
  assert.match(r.text, /Created in REO: 1 follow-up/);
  assert.match(r.text, /1 item was created in REO's own data/);
  assert.equal(listFollowups(cfg.dataDir).length, 1);
  // Without a CreationLog the tool does not exist.
  const cfg2 = tmpCfg();
  const r2 = await runAgent({ system: ["rules"], user: "Q", sources: [], backend: "T" }, {
    cfg: cfg2, db: seed(), webOn: false, complete: script(['{"tool":"create_followup","args":{"text":"x"}}', "ok"]),
  });
  assert.equal(listFollowups(cfg2.dataDir).length, 0);
  assert.ok(!r2.created);
});

test("approval cards: nothing runs until Approve, a card runs once, decline and timeout do nothing, stop expires it", async () => {
  const hub = new ApprovalHub(60);
  let ran = 0;
  const run = async () => { ran++; return "did it"; };
  const cards: string[] = [];
  const p = hub.request({ chatId: null, kind: "open_link", title: "t", detail: "https://github.com/x", run, onCard: (c) => cards.push(c.id) });
  assert.equal(ran, 0);
  assert.equal(hub.pending(), 1);
  const [a, b] = await Promise.all([hub.decide(cards[0]!, true), hub.decide(cards[0]!, true)]);
  assert.ok(a && !b, "the second click finds nothing pending");
  assert.deepEqual(await p, { state: "approved", result: "did it" });
  assert.equal(ran, 1);
  const d = hub.request({ chatId: null, kind: "open_link", title: "t", detail: "d", run, onCard: (c) => cards.push(c.id) });
  await hub.decide(cards[1]!, false);
  assert.equal((await d).state, "declined");
  assert.equal(ran, 1);
  assert.equal((await hub.request({ chatId: null, kind: "open_attachment", title: "t", detail: "d", run })).state, "expired");
  const ctrl = new AbortController();
  const s = hub.request({ chatId: null, kind: "open_link", title: "t", detail: "d", run, signal: ctrl.signal });
  ctrl.abort();
  assert.equal((await s).state, "expired");
  assert.equal(ran, 1);
  assert.equal((await hub.request({ chatId: null, kind: "git_push" as never, title: "t", detail: "d", run })).state, "declined");
});

test("agent loop: open_link needs the owner's approval; a decline is a plain result; unknown hosts are refused", async () => {
  const cfg = tmpCfg();
  let opened = 0;
  const actions = (answer: "approved" | "declined") => ({
    approve: async (r: { run: () => Promise<string> }) => (answer === "approved" ? { state: "approved" as const, result: await r.run() } : { state: "declined" as const, result: "no" }),
    attachments: () => [],
    openLink: async () => { opened++; },
  });
  const link = '{"tool":"open_link","args":{"url":"https://github.com/o/r/pull/1"}}';
  const base = { cfg, db: null, webOn: false };
  const yes = await runAgent({ system: ["r"], user: "Q", sources: [], backend: "T" }, { ...base, actions: actions("approved"), complete: script([link, "Opened."]) });
  assert.equal(opened, 1);
  assert.match(yes.text, /1 action you approved was done/);
  const no = await runAgent({ system: ["r"], user: "Q", sources: [], backend: "T" }, { ...base, actions: actions("declined"), complete: script([link, "Skipped."]) });
  assert.equal(opened, 1);
  assert.match(no.text, /^Skipped\./);
  const evil = await runAgent({ system: ["r"], user: "Q", sources: [], backend: "T" }, { ...base, actions: actions("approved"), complete: script(['{"tool":"open_link","args":{"url":"https://evil.example/x"}}', "Fine."]) });
  assert.equal(opened, 1);
  assert.ok(evil.ok);
});

test("missions: one per chat, two in total, cancel aborts, the chat gets the final reply", async () => {
  const m = new MissionManager();
  const finished: string[] = [];
  const gate: (() => void)[] = [];
  const hold = (ctx: { signal: AbortSignal }) => new Promise<{ ok: boolean; text: string; sources: never[] }>((res) => {
    gate.push(() => res({ ok: true, text: "done", sources: [] }));
    ctx.signal.addEventListener("abort", () => res({ ok: true, text: "Stopped.", sources: [] }));
  });
  const start = (chat: string) => m.start({ chatId: chat, title: "t", run: hold, onFinish: (v) => finished.push(`${v.chatId}:${v.status}`) });
  const one = start("1".repeat(16));
  assert.ok(one.ok);
  assert.equal(start("1".repeat(16)).ok, false, "one per chat");
  assert.ok(start("2".repeat(16)).ok);
  assert.equal(start("3".repeat(16)).ok, false, `at most ${MAX_MISSIONS_RUNNING} at once`);
  if (one.ok) m.cancel(one.mission.id);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(finished.includes(`${"1".repeat(16)}:cancelled`));
  assert.ok(start("3".repeat(16)).ok, "a slot is free again");
  gate.forEach((g) => g());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(m.list().filter((x) => x.status === "running").length, 0);
});
