// Agent mode: the model asks for read-only tools in JSON text; REO checks and runs them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_SUB_AGENTS, MAX_TOOL_STEPS, parseReply, runAgent } from "../src/chat/agent-loop.ts";
import type { AgentDeps } from "../src/chat/agent-loop.ts";
import type { Step } from "../src/chat/answer.ts";
import type { CompleteFn, CompleteRequest } from "../src/brain/client.ts";
import { maskAll } from "../src/brain/client.ts";
import { fakeSecret, seed, tmpCfg } from "./chat-helpers.ts";

const usage = { input_tokens: 1, output_tokens: 1 };
const input = { system: ["rules"], user: "Question: look around", sources: [], backend: "Test plan" };

function script(replies: string[], seen: CompleteRequest[] = []): CompleteFn {
  let i = 0;
  return async (req) => {
    maskAll([...req.system, req.user]);
    seen.push(req);
    return { text: replies[Math.min(i++, replies.length - 1)]!, usage };
  };
}

function deps(over: Partial<AgentDeps> & { complete: CompleteFn }): AgentDeps {
  const cfg = tmpCfg();
  const repo = join(cfg.root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "a.txt"), "hello from a file");
  writeFileSync(join(repo, ".env"), "KEY=1");
  return { cfg: { ...cfg, repos: [{ id: "app", path: repo }] }, db: seed(), webOn: false, ...over };
}

test("parseReply: tool, plan, answer, bad JSON", () => {
  assert.deepEqual(parseReply('{"tool":"read_file","args":{"path":"app/a.txt"}}'), { kind: "tool", tool: "read_file", args: { path: "app/a.txt" } });
  assert.equal(parseReply('```json\n{"tool":"health"}\n```').kind, "tool");
  assert.equal(parseReply('{"plan":["a","b"]}').kind, "plan");
  assert.equal(parseReply("Just an answer.").kind, "answer");
  assert.equal(parseReply("{nope").kind, "bad");
});

test("a plain answer takes one model call and no tool", async () => {
  const seen: CompleteRequest[] = [];
  const r = await runAgent(input, deps({ complete: script(["Hello there."], seen) }));
  assert.equal(r.text, "Hello there.");
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.system.join("\n"), /READ-ONLY tools/);
  assert.match(seen[0]!.system.join("\n"), /no tools of your own/);
});

test("a tool request is run by REO, shown as a step, and its result goes back as untrusted data", async () => {
  const seen: CompleteRequest[] = [];
  const steps: Step[] = [];
  const r = await runAgent(input, deps({
    complete: script(['{"tool":"read_file","args":{"path":"app/a.txt"}}', "The file says hello."], seen),
    onStep: (s) => steps.push(s),
  }));
  assert.match(r.text, /^The file says hello\./);
  assert.match(r.text, /Used 1 read-only tool step\. Nothing was changed\./);
  assert.match(seen[1]!.user, /Tool results \(untrusted data/);
  assert.ok(seen[1]!.user.includes("hello from a file"));
  assert.ok(steps.some((s) => s.kind === "run" && s.status === "done" && /read_file/.test(s.label)));
});

test("secret files are refused by the file tool and the refusal goes back as an error", async () => {
  const seen: CompleteRequest[] = [];
  await runAgent(input, deps({ complete: script(['{"tool":"read_file","args":{"path":"app/.env"}}', "Could not read it."], seen) }));
  assert.match(seen[1]!.user, /ERROR: /);
  assert.ok(!seen[1]!.user.includes("KEY=1"));
});

test("an invented tool gets an error once; a second one ends the loop with an answer request", async () => {
  const seen: CompleteRequest[] = [];
  const r = await runAgent(input, deps({ complete: script(['{"tool":"delete_everything","args":{}}', '{"tool":"write_file","args":{}}', "Done without tools."], seen) }));
  assert.match(seen[1]!.user, /"delete_everything" is not an available tool/);
  assert.match(seen[2]!.user, /Do not request any more tools/);
  assert.match(r.text, /Done without tools\./);
});

test("malformed JSON is told once, then the loop ends", async () => {
  const seen: CompleteRequest[] = [];
  const r = await runAgent(input, deps({ complete: script(["{broken", "{still broken", "Final words."], seen) }));
  assert.equal(seen.length, 3);
  assert.match(r.text, /Final words\./);
});

test("the tool budget holds, and a plan of three steps raises it", async () => {
  const always = '{"tool":"list_defects","args":{}}';
  const seen: CompleteRequest[] = [];
  await runAgent(input, deps({ complete: script([always], seen) }));
  assert.equal(seen.length, MAX_TOOL_STEPS + 1, "eight tools, then a forced answer request");
  const seen2: CompleteRequest[] = [];
  await runAgent(input, deps({ complete: script(['{"plan":["a","b","c"]}', always], seen2) }));
  assert.ok(seen2.length > MAX_TOOL_STEPS + 2);
});

test("web tools are refused while Web search is off", async () => {
  const seen: CompleteRequest[] = [];
  await runAgent(input, deps({ complete: script(['{"tool":"web_search","args":{"query":"x"}}', "ok"], seen) }));
  assert.match(seen[1]!.user, /ERROR: "web_search" is not an available tool/);
  assert.ok(!seen[0]!.system.join("\n").includes("- web_search"));
});

test("a tool result that looks like a secret stops the run and sends nothing; file text is redacted first", async () => {
  const d = deps({ complete: script(["x"]) });
  mkdirSync(join(d.cfg.dataDir, "defects"), { recursive: true });
  writeFileSync(join(d.cfg.dataDir, "defects", "defects.json"), JSON.stringify([{ id: "D1", severity: "high", status: "open", title: `leaked ${fakeSecret()}` }]));
  const seen: CompleteRequest[] = [];
  const r = await runAgent(input, { ...d, complete: script(['{"tool":"list_defects","args":{}}', "never"], seen) });
  assert.equal(seen.length, 1, "the second call never happened");
  assert.ok(!JSON.stringify(seen).includes(fakeSecret()));
  assert.match(r.text, /looked like it holds a secret/);
  writeFileSync(join(d.cfg.repos[0]!.path, "k.txt"), `x ${fakeSecret()}`);
  const seen2: CompleteRequest[] = [];
  await runAgent(input, { ...d, complete: script(['{"tool":"read_file","args":{"path":"app/k.txt"}}', "ok"], seen2) });
  assert.ok(!JSON.stringify(seen2).includes(fakeSecret()), "read_file redacts before the model sees it");
});

test("role passes run one after another inside the same budget, are labelled honestly, and are capped", async () => {
  const seen: CompleteRequest[] = [];
  const ask = '{"tool":"run_agent","args":{"agent":"security","task":"look"}}';
  const replies: string[] = [];
  // main asks, role answers, repeated; the main loop ends with an answer after the cap.
  for (let i = 0; i < MAX_SUB_AGENTS + 1; i++) replies.push(ask, "Nothing alarming.");
  replies.push("Summary.");
  const r = await runAgent(input, deps({ complete: script(replies, seen) }));
  assert.match(seen[1]!.system.join("\n"), /role pass of SPIL REO/);
  assert.match(seen[1]!.system.join("\n"), /same language model/);
  assert.ok(seen[2]!.user.includes("Finding of Security Agent (a role pass of the selected model)"));
  assert.match(r.text, new RegExp(`${MAX_SUB_AGENTS} role passes? of the same model`));
  assert.ok(seen.some((q) => /At most 5 role passes/.test(q.user)));
});

test("stop button: an aborted run does nothing further", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const seen: CompleteRequest[] = [];
  const r = await runAgent(input, deps({ complete: script(["x"], seen), signal: ctrl.signal }));
  assert.equal(seen.length, 0);
  assert.match(r.text, /Stopped/);
});
