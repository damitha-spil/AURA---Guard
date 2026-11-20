import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { claudeArgs, cleanClaudeModel, CliError, findClaude, parseClaudeStream } from "../src/brain/backends.ts";
import { createBrain, describeBackends, NoBackendError } from "../src/brain/select.ts";
import { BlockedError } from "../src/brain/client.ts";
import type { GuardConfig } from "../src/types.ts";

// A fake `claude`: a node script. It records argv, stdin and cwd (+ cwd listing) to RECORD, then
// prints stream-json like the real CLI. MODE=hang makes it sleep (timeout test).
const FAKE = `
const fs = require("fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  if (process.argv.includes("--version")) { console.log("9.9.9 (Fake Claude)"); return; }
  fs.writeFileSync(process.env.RECORD, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), listing: fs.readdirSync(process.cwd()), env: { key: process.env.ANTHROPIC_API_KEY ?? null, max: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null } }));
  if (process.env.MODE === "hang") { setTimeout(() => {}, 60000); return; }
  const reply = process.env.REPLY ?? "Mail EMAIL_01 about it";
  console.log(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: reply }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: reply, usage: { input_tokens: 7, output_tokens: 3 } }));
});
`;

function setup(extraEnv: Record<string, string | undefined> = {}) {
  const root = mkdtempSync(join(tmpdir(), "guard-brain-cli-"));
  const script = join(root, "fake-claude.cjs");
  writeFileSync(script, FAKE);
  const record = join(root, "record.json");
  const cfg = { dataDir: root, vaultDir: root, repos: [], busyProcesses: [], root } as GuardConfig;
  const env: Record<string, string | undefined> = { ...process.env, RECORD: record };
  delete env.ANTHROPIC_API_KEY;
  delete env.AURA_GUARD_BRAIN;
  Object.assign(env, extraEnv);
  const launcher = { command: process.execPath, prefixArgs: [script] };
  const read = () =>
    JSON.parse(readFileSync(record, "utf8")) as {
      argv: string[]; stdin: string; cwd: string; listing: string[]; env: { key: string | null; max: string | null };
    };
  return { root, cfg, env, launcher, record, read, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const req = { role: "t", system: ["contact bob@corp-example.com", "rules"], user: "ask bob@corp-example.com", maxTokens: 50 };

test("masked placeholders reach the CLI, reply is unmasked, key is not passed on", async () => {
  const s = setup({ AURA_GUARD_BRAIN: "claude-cli", ANTHROPIC_API_KEY: "key-" + randomBytes(5).toString("hex") });
  const brain = createBrain(s.cfg, { env: s.env, launcher: s.launcher });
  const r = await brain.complete(req);
  const rec = s.read();
  assert.ok(!rec.stdin.includes("bob@corp-example.com"));
  assert.ok(rec.stdin.includes("EMAIL_01"));
  assert.equal(r.text, "Mail bob@corp-example.com about it");
  assert.equal(r.usage.output_tokens, 3);
  assert.equal(brain.backendUsed(), "claude-cli");
  assert.equal(rec.env.key, null, "plan login must not be replaced by an API key");
  assert.equal(rec.env.max, "50");
  const dir = join(s.root, "logs");
  const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
  assert.match(text, /claude-cli:claude-cli\/sonnet/);
  assert.match(text, /[0-9a-f]{64}/);
  assert.ok(!text.includes("bob@corp-example.com"));
  s.cleanup();
});

test("a secret blocks before anything is spawned", async () => {
  const s = setup({ AURA_GUARD_BRAIN: "claude-cli" });
  const fake = "sk-ant-" + "api03-" + randomBytes(24).toString("base64url");
  await assert.rejects(
    createBrain(s.cfg, { env: s.env, launcher: s.launcher }).complete({ ...req, user: "token " + fake }),
    (e: unknown) => {
      assert.ok(e instanceof BlockedError);
      assert.ok(!(e as Error).message.includes(fake));
      return true;
    },
  );
  assert.equal(existsSync(s.record), false, "the CLI must not have been started");
  s.cleanup();
});

test("no-tools flags are present and cwd is an empty temp folder", async () => {
  const s = setup({ AURA_GUARD_BRAIN: "claude-cli" });
  let cwd = "";
  await createBrain(s.cfg, { env: s.env, launcher: s.launcher, onCwd: (c) => (cwd = c) }).complete(req);
  const { argv, cwd: seen, listing } = s.read();
  const pair = (a: string, b: string) => argv.some((x, i) => x === a && argv[i + 1] === b);
  assert.ok(pair("--tools", ""));
  assert.ok(pair("--permission-mode", "dontAsk"));
  assert.ok(pair("--setting-sources", ""));
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.ok(argv.includes("--disable-slash-commands"));
  assert.ok(argv.includes("--no-session-persistence"));
  assert.ok(!argv.includes("--mcp-config") && !argv.includes("--allowedTools") && !argv.includes("--dangerously-skip-permissions"));
  assert.ok(argv.includes("-p"));
  assert.ok(!argv.some((a) => a.includes("bob@corp") || a.includes("EMAIL_01")), "the prompt goes on stdin, not the command line");
  assert.equal(seen.toLowerCase(), cwd.toLowerCase());
  assert.ok(cwd.toLowerCase().startsWith(tmpdir().toLowerCase()));
  assert.deepEqual(listing, []);
  assert.equal(existsSync(cwd), false, "temp folder is removed afterwards");
  assert.deepEqual(claudeArgs("sonnet").slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  s.cleanup();
});

test("a timeout kills the process", async () => {
  const s = setup({ AURA_GUARD_BRAIN: "claude-cli", MODE: "hang" });
  const t0 = Date.now();
  await assert.rejects(
    createBrain(s.cfg, { env: s.env, launcher: s.launcher, cliTimeoutMs: 400 }).complete(req),
    (e: unknown) => e instanceof CliError && /timed out/.test((e as Error).message),
  );
  assert.ok(Date.now() - t0 < 15_000);
  s.cleanup();
});

test("selection: key set -> api; no key + CLI -> cli; nothing -> clear error", async () => {
  const s = setup();
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "api reply" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const withKey = createBrain(s.cfg, { env: { ...s.env, ANTHROPIC_API_KEY: "k-" + randomBytes(5).toString("hex") }, launcher: s.launcher, fetch: fakeFetch });
  assert.equal((await withKey.complete(req)).text, "api reply");
  assert.equal(withKey.backendUsed(), "anthropic-api");
  assert.equal(calls.length, 1);
  assert.equal(existsSync(s.record), false);

  const noKey = createBrain(s.cfg, { env: s.env, launcher: s.launcher, fetch: fakeFetch });
  await noKey.complete(req);
  assert.equal(noKey.backendUsed(), "claude-cli");
  assert.equal(calls.length, 1);

  const none = createBrain(s.cfg, { env: s.env, launcher: null, fetch: fakeFetch, home: s.root });
  await assert.rejects(
    none.complete(req),
    (e: unknown) => e instanceof NoBackendError && /ANTHROPIC_API_KEY/.test((e as Error).message) && /Claude Code/.test((e as Error).message),
  );

  // config can pin the backend; env overrides config
  const pinned = { ...s.cfg, brain: { backend: "claude-cli" } } as GuardConfig;
  const d = await describeBackends(pinned, { env: { ...s.env, ANTHROPIC_API_KEY: "k" }, launcher: s.launcher });
  assert.equal(d.picked, "claude-cli");
  const d2 = await describeBackends(pinned, { env: { ...s.env, ANTHROPIC_API_KEY: "k", AURA_GUARD_BRAIN: "anthropic-api" }, launcher: s.launcher });
  assert.equal(d2.picked, "anthropic-api");
  assert.ok(!JSON.stringify(d2).includes('"k"'));
  s.cleanup();
});

test("discovery: PATH then ~/.local/bin; model names are cleaned", () => {
  const root = mkdtempSync(join(tmpdir(), "guard-find-"));
  const bin = join(root, "pathdir");
  mkdirSync(bin);
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  assert.equal(findClaude({ env: { PATH: bin }, home: join(root, "nohome") }), null);
  mkdirSync(join(root, "home", ".local", "bin"), { recursive: true });
  writeFileSync(join(root, "home", ".local", "bin", name), "");
  assert.equal(findClaude({ env: { PATH: bin }, home: join(root, "home") })?.command, join(root, "home", ".local", "bin", name));
  writeFileSync(join(bin, name), "");
  assert.equal(findClaude({ env: { PATH: bin }, home: join(root, "home") })?.command, join(bin, name));
  assert.equal(cleanClaudeModel("claude/opus"), "opus");
  assert.equal(cleanClaudeModel("--dangerously-skip-permissions"), "sonnet");
  assert.equal(cleanClaudeModel(undefined), "sonnet");
  rmSync(root, { recursive: true, force: true });
});

test("stream parsing: refuses tools, reports sign-in and failures plainly", () => {
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  assert.throws(() => parseClaudeStream(line({ type: "system", subtype: "init", tools: ["Bash"], mcp_servers: [] })), /Refused/);
  assert.throws(() => parseClaudeStream(line({ type: "result", is_error: true, result: "Not logged in - please run /login" })), /not signed in/);
  assert.throws(() => parseClaudeStream(line({ type: "result", is_error: true, result: "boom" })), /Claude Code failed: boom/);
  assert.equal(parseClaudeStream(line({ type: "result", subtype: "success", result: " hi " })).text, "hi");
});
