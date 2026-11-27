import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fakeSecret, seed, tmpCfg } from "./chat-helpers.ts";
import { answer, describeError, NOTHING_FOUND, stripInvented } from "../src/chat/answer.ts";
import { ChatStore, WITHHELD } from "../src/chat/store.ts";
import { COMMANDS, HeavyLock, parseSlash } from "../src/chat/commands.ts";
import { ApiError, BlockedError, maskAll, MissingKeyError } from "../src/brain/client.ts";
import type { CompleteFn, CompleteRequest } from "../src/brain/client.ts";

const cfg = tmpCfg();
const usage = { input_tokens: 1, output_tokens: 1 };

test("answer cites only provided sources and strips invented refs", async () => {
  const db = seed();
  const complete: CompleteFn = async () => ({
    text: "The AI has no create tool [rule-erp-create]. Also see [invented-ref-9] and [ok] and [rule-erp-create].",
    usage,
  });
  const r = await answer(cfg, db, { history: [], question: "Why does the AI never get an ERP create tool?" }, { complete });
  assert.equal(r.ok, true);
  assert.ok(r.text.includes("[rule-erp-create]"));
  assert.ok(r.text.includes("[ok]"), "plain brackets stay");
  assert.ok(!r.text.includes("invented-ref-9"));
  assert.deepEqual(r.sources.map((s) => s.ref), ["rule-erp-create"]);
});

test("support-only notes are never used as sources", async () => {
  const db = seed();
  let seen: CompleteRequest | undefined;
  const complete: CompleteFn = async (req) => {
    seen = req;
    return { text: "ok", usage };
  };
  await answer(cfg, db, { history: [], question: "ERP create" }, { complete });
  assert.ok(seen);
  assert.ok(!seen.system.join("\n").includes("support-only"));
});

test("proposed notes are labelled UNAPPROVED in the sources and the result", async () => {
  const db = seed();
  let seen: CompleteRequest | undefined;
  const complete: CompleteFn = async (req) => {
    seen = req;
    return { text: "A draft says maybe [draft-erp-idea].", usage };
  };
  const r = await answer(cfg, db, { history: [], question: "ERP create tool for drafts" }, { complete });
  const block = seen!.system.join("\n");
  assert.match(block, /\[draft-erp-idea\] \(note, status proposed, UNAPPROVED\)/);
  assert.match(seen!.system[0]!, /UNAPPROVED/);
  assert.equal(r.sources.find((s) => s.ref === "draft-erp-idea")?.status, "proposed");
});

test("history is capped to the last turns", async () => {
  const db = seed();
  let seen: CompleteRequest | undefined;
  const complete: CompleteFn = async (req) => {
    seen = req;
    return { text: "ok", usage };
  };
  const history = Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, text: `turn-${i}` }));
  await answer(cfg, db, { history, question: "ERP create" }, { complete });
  assert.ok(!seen!.user.includes("turn-0"));
  assert.ok(seen!.user.includes("turn-19"));
  assert.ok(seen!.user.endsWith("Question: ERP create"));
});

test("no sources: says it does not know and calls no model", async () => {
  const db = seed();
  let calls = 0;
  const complete: CompleteFn = async () => {
    calls++;
    return { text: "x", usage };
  };
  const r = await answer(cfg, db, { history: [], question: "zzzzqqqq" }, { complete });
  assert.equal(calls, 0);
  assert.equal(r.text, NOTHING_FOUND);
});

test("a secret in the question sends nothing and names the kinds", async () => {
  const db = seed();
  const sent: string[] = [];
  // Same masking step the real brain runs before anything leaves the machine.
  const complete: CompleteFn = async (req) => {
    maskAll([...req.system, req.user]);
    sent.push(req.user);
    return { text: "should not happen", usage };
  };
  const r = await answer(cfg, db, { history: [], question: `ERP create tool, my token is ${fakeSecret()}` }, { complete });
  assert.equal(r.ok, false);
  assert.equal(r.error, "blocked");
  assert.equal(sent.length, 0);
  assert.match(r.text, /Nothing was sent/);
  assert.ok(r.blockedKinds && r.blockedKinds.length > 0);
  assert.ok(!r.text.includes(fakeSecret()));
});

test("backend errors become plain messages", () => {
  assert.equal(describeError(new MissingKeyError())?.error, "no-key");
  assert.equal(describeError(new ApiError(500, "boom"))?.error, "api");
  assert.equal(describeError(new Error("other")), null);
  assert.equal(describeError(new BlockedError([{ kind: "X", count: 1 }]))?.error, "blocked");
});

test("stripInvented keeps links and checkboxes", () => {
  const out = stripInvented("[x] done [docs](guard:a-b) [fake-ref]", new Set());
  assert.equal(out, "[x] done [docs](guard:a-b)");
});

test("chat history is stored masked; a secret is never written to disk", () => {
  const c = tmpCfg();
  const store = new ChatStore(c.dataDir);
  const chat = store.create();
  store.append(chat.id, { role: "user", text: `use ${fakeSecret()} please` });
  store.append(chat.id, { role: "assistant", text: "fine" });
  const files = readdirSync(store.dir);
  assert.equal(files.length, 1);
  const raw = readFileSync(join(store.dir, files[0]!), "utf8");
  assert.ok(!raw.includes(fakeSecret()));
  assert.ok(raw.includes(WITHHELD));
  assert.equal(store.get(chat.id)?.messages.length, 2);
  assert.equal(store.list().length, 1);
  assert.equal(store.delete(chat.id), true);
  assert.equal(existsSync(join(store.dir, files[0]!)), false);
});

test("chat ids cannot escape the chats folder", () => {
  const store = new ChatStore(tmpCfg().dataDir);
  assert.equal(store.get("../../etc/passwd"), null);
  assert.equal(store.delete("..\\x"), false);
});

test("slash allowlist: known commands build argv, unknown and shell characters are refused", () => {
  const none = new Set<string>();
  const ok = parseSlash("/history spil-aura apps/aura-ui/src", none);
  assert.ok(ok.ok && ok.argv.join(" ") === "history spil-aura apps/aura-ui/src");
  const blast = parseSlash("/blast spil-aura src/a.ts", none);
  assert.ok(blast.ok && blast.argv[0] === "graph" && blast.argv[1] === "blast");
  const bads = ["/rm -rf x", "/status; calc", "/history a b && dir", "/history a `b`", "/history a $(x)", "/history a b|c", '/history a "b"', "/status extra", "status", "/index --force", "/history --x y", "/diary tomorrow"];
  for (const bad of bads) assert.equal(parseSlash(bad, none).ok, false, bad);
  assert.equal(parseSlash("/review", none).ok, false, "review needs the command table");
  assert.equal(parseSlash("/review", new Set(["review"])).ok, true);
  assert.equal(parseSlash("/review --force", new Set(["review"])).ok, false);
  const qa = parseSlash("/qa plan", new Set(["qa"]));
  assert.ok(qa.ok && qa.argv.join(" ") === "qa plan" && qa.heavy === false);
  const qaRun = parseSlash("/qa run", new Set(["qa"]));
  assert.ok(qaRun.ok && qaRun.heavy === true);
  assert.equal(parseSlash("/qa rm", new Set(["qa"])).ok, false);
  assert.ok(COMMANDS.every((c) => c.usage.startsWith("/" + c.name)));
});

test("heavy lock allows one at a time", () => {
  const l = new HeavyLock();
  assert.equal(l.tryAcquire("index"), true);
  assert.equal(l.tryAcquire("diary"), false);
  l.release();
  assert.equal(l.tryAcquire("diary"), true);
});
