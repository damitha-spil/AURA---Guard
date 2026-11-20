import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Runner } from "../src/core/cli.ts";
import { repoKey } from "../src/core/repoKey.ts";
import { bindCapture } from "../src/vsc/capture.ts";
import { makeChatHandler } from "../src/vsc/chat.ts";
import { VirtualDocs, startCapture, stopCapture, summarizeDay, logNote, togglePause } from "../src/vsc/commands.ts";
import { Session } from "../src/vsc/session.ts";
import type { VsCode } from "../src/vsc/session.ts";

const secret = () => "ghp_" + "aB3xK9mQ2wL7pR5tY8uN4vC6zD1fG0hJ2kS3";

/** Hand-written stand-in for the `vscode` module: only what the extension touches. */
function fakeVscode(folder: string, answers: { info: (msg: string) => string | undefined; input?: () => string | undefined }) {
  const cfg: Record<string, unknown> = {};
  const handlers: Record<string, ((e: unknown) => void)[]> = {};
  const on = (name: string) => (h: (e: unknown) => void) => {
    (handlers[name] ??= []).push(h);
    return { dispose: () => void (handlers[name] = (handlers[name] ?? []).filter((x) => x !== h)) };
  };
  const messages: string[] = [];
  class WorkspaceEdit {
    ops: { type: string; uri: { fsPath: string }; contents?: Uint8Array; text?: string }[] = [];
    createFile(uri: { fsPath: string }, o: { contents?: Uint8Array }) { this.ops.push({ type: "create", uri, contents: o.contents }); }
    replace(uri: { fsPath: string }, _r: unknown, text: string) { this.ops.push({ type: "replace", uri, text }); }
  }
  const diffs: unknown[][] = [];
  const vsc = {
    Uri: { file: (p: string) => ({ fsPath: p, scheme: "file", path: p }), from: (c: { scheme: string; path: string }) => ({ ...c, fsPath: c.path }) },
    Range: class { a: unknown; b: unknown; constructor(a: unknown, b: unknown) { this.a = a; this.b = b; } },
    Position: class { l: number; c: number; constructor(l: number, c: number) { this.l = l; this.c = c; } },
    WorkspaceEdit,
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Left: 1 },
    ConfigurationTarget: { Global: 1 },
    workspace: {
      workspaceFolders: [{ uri: { scheme: "file", fsPath: folder } }],
      getConfiguration: () => ({ get: (k: string) => cfg[k], update: async () => {} }),
      onDidSaveTextDocument: on("save"),
      applyEdit: async (e: WorkspaceEdit) => {
        for (const op of e.ops) {
          mkdirSync(dirname(op.uri.fsPath), { recursive: true });
          if (op.type === "create") writeFileSync(op.uri.fsPath, op.contents ?? "");
          else writeFileSync(op.uri.fsPath, op.text ?? "");
        }
        return true;
      },
      openTextDocument: async (u: { fsPath: string }) => ({ isDirty: false, save: async () => true, getText: () => (existsSync(u.fsPath) ? readFileSync(u.fsPath, "utf8") : ""), positionAt: () => ({}), uri: u }),
      fs: { createDirectory: async (u: { fsPath: string }) => void mkdirSync(u.fsPath, { recursive: true }) },
    },
    window: {
      activeTextEditor: undefined,
      showInformationMessage: async (m: string) => { messages.push(m); return answers.info(m); },
      showWarningMessage: async (m: string) => { messages.push(m); return undefined; },
      showInputBox: async () => answers.input?.(),
      showQuickPick: async () => undefined,
      showTextDocument: async () => ({}),
      withProgress: async (_o: unknown, f: () => Promise<unknown>) => f(),
      onDidStartTerminalShellExecution: on("tstart"),
      onDidEndTerminalShellExecution: on("tend"),
    },
    tasks: { onDidStartTaskProcess: on("taskstart"), onDidEndTaskProcess: on("taskend") },
    languages: { getDiagnostics: () => [] },
    extensions: { getExtension: () => undefined },
    commands: { executeCommand: async (...a: unknown[]) => void diffs.push(a) },
  };
  return { vsc: vsc as unknown as VsCode, cfg, handlers, messages, diffs };
}

interface Rig {
  dir: string; spool: string; guard: string; calls: { file: string; args: string[] }[];
  fake: ReturnType<typeof fakeVscode>; s: Session; state: Map<string, unknown>;
}

async function rig(opts: { consent: boolean; paused?: boolean; answerInfo?: (m: string) => string | undefined; summarize?: object }): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "guard-ws-"));
  mkdirSync(join(dir, "ai-log"));
  writeFileSync(join(dir, "ai-log", "README.md"), "# log");
  const spool = join(dir, "..", `spool-${Math.random().toString(16).slice(2)}`);
  const guard = mkdtempSync(join(tmpdir(), "guard-home-"));
  mkdirSync(join(guard, "engine", "src", "cli"), { recursive: true });
  mkdirSync(join(guard, "bin"));
  writeFileSync(join(guard, "engine", "src", "cli", "main.ts"), "");
  writeFileSync(join(guard, "bin", "aura-guard.mjs"), "");
  const calls: Rig["calls"] = [];
  const runner: Runner = async (file, args) => {
    calls.push({ file, args });
    if (file === "git") return { stdout: "Test User\n" };
    if (args.includes("summarize")) return { stdout: JSON.stringify(opts.summarize ?? { ok: true, date: "2026-11-20", file: "ai-log/2026/11/2026-11-20-test.md", draft: "## 09:00 · VS Code\n\n- **What:** did a thing\n", entries: 1, commits: 0, ideas: [], questions: [], sources: {}, backend: "none" }) };
    if (args.includes("answer")) return { stdout: JSON.stringify({ ok: true, text: "ok", sources: [], backend: "x" }) };
    return { stdout: '{"ok":true}' };
  };
  const state = new Map<string, unknown>();
  if (opts.paused) state.set("paused", true);
  const fake = fakeVscode(dir, { info: opts.answerInfo ?? ((m) => (m.includes("wants to record") && opts.consent ? "Accept and start capturing" : undefined)) });
  fake.cfg.guardHome = guard;
  const s = new Session({
    vsc: fake.vsc,
    workspaceState: { get: <T>(k: string) => state.get(k) as T | undefined, update: async (k, v) => void state.set(k, v) },
    log: () => {},
    runner,
    env: { AURA_GUARD_SPOOL: spool },
  });
  await s.init();
  return { dir, spool, guard, calls, fake, s, state };
}
const cleanup = (r: Rig) => [r.dir, r.spool, r.guard].forEach((p) => rmSync(p, { recursive: true, force: true }));
const fire = (r: Rig, name: string, e: unknown) => r.fake.handlers[name]?.forEach((h) => h(e));
const spoolFiles = (r: Rig) => (existsSync(join(r.spool, repoKey(r.dir))) ? readdirSync(join(r.spool, repoKey(r.dir))) : []);
const taskEnd = { execution: { task: { name: "build" } }, exitCode: 0 };

test("an opted-in workspace without consent captures nothing and needs consent", async () => {
  const r = await rig({ consent: false });
  try {
    assert.equal(r.s.state, "needs-consent");
    startCapture(r.s); // refuses: no consent
    assert.equal(r.fake.handlers.taskend, undefined);
    // Even if something bound anyway, the recorder gate stops every event.
    const subs = bindCapture(r.s);
    fire(r, "taskend", taskEnd);
    subs.forEach((d) => d.dispose());
    assert.deepEqual(spoolFiles(r), []);
    assert.equal(existsSync(join(r.spool, "consent.json")), false);
  } finally {
    cleanup(r);
  }
});

test("a workspace that is not opted in stays off", async () => {
  const r = await rig({ consent: true });
  try {
    rmSync(join(r.dir, "ai-log"), { recursive: true });
    const s2 = new Session({ vsc: r.fake.vsc, workspaceState: { get: () => undefined, update: async () => {} }, log: () => {}, runner: async () => ({ stdout: "" }), env: { AURA_GUARD_SPOOL: r.spool } });
    await s2.init();
    assert.equal(s2.state, "off");
    r.fake.cfg.workspaces = [r.dir];
    await s2.init();
    assert.equal(s2.state, "needs-consent"); // listed explicitly
  } finally {
    cleanup(r);
  }
});

test("after the developer accepts, consent.json is written and events are captured", async () => {
  const r = await rig({ consent: true });
  try {
    assert.equal(await r.s.askConsent(), true);
    const c = JSON.parse(readFileSync(join(r.spool, "consent.json"), "utf8"));
    assert.equal(c.developer, "test");
    assert.equal(c.repos[repoKey(r.dir)], true);
    assert.equal(r.s.state, "capturing");
    startCapture(r.s);
    fire(r, "taskend", taskEnd);
    const files = spoolFiles(r);
    assert.equal(files.length, 1);
    const line = JSON.parse(readFileSync(join(r.spool, repoKey(r.dir), files[0]!), "utf8").trim());
    assert.equal(line.kind, "task");
    assert.equal(line.data.name, "build");
    assert.equal(line.dev, "test");
    stopCapture(r.s);
  } finally {
    cleanup(r);
  }
});

test("terminal: allow-listed commands only, masked; paused captures nothing", async () => {
  const r = await rig({ consent: true });
  try {
    await r.s.askConsent();
    startCapture(r.s);
    const ev = (c: string) => ({ execution: { commandLine: { value: c } }, exitCode: 0 });
    fire(r, "tend", ev("curl http://x"));
    fire(r, "tend", ev(`git push https://u:${secret()}@h/x`));
    assert.equal(r.s.recorder!.dropped, 1);
    fire(r, "tend", ev("cargo test"));
    assert.equal(r.s.recorder!.today, 1);
    await togglePause(r.s);
    assert.equal(r.s.state, "paused");
    fire(r, "taskend", taskEnd);
    fire(r, "tend", ev("git status"));
    assert.equal(r.s.recorder!.today, 1);
    stopCapture(r.s);
  } finally {
    cleanup(r);
  }
});

test("log an idea: stored masked; a secret is refused with a plain message", async () => {
  const r = await rig({ consent: true });
  try {
    await r.s.askConsent();
    let text: string | undefined = "Try caching the shapes";
    r.fake.vsc.window.showInputBox = (async () => text) as never;
    await logNote(r.s, "idea");
    assert.equal(r.s.recorder!.today, 1);
    text = `token ${secret()}`;
    await logNote(r.s, "decision");
    assert.equal(r.s.recorder!.today, 1);
    assert.equal(r.s.recorder!.dropped, 1);
    assert.ok(r.fake.messages.some((m) => m.includes("looks like it contains a secret")));
    const all = readdirSync(join(r.spool, repoKey(r.dir))).map((f) => readFileSync(join(r.spool, repoKey(r.dir), f), "utf8")).join("");
    assert.ok(!all.includes("ghp_"));
  } finally {
    cleanup(r);
  }
});

test("summarize builds the right execFile arguments and applies only after confirmation", async () => {
  let answer: string | undefined = "Cancel";
  const r = await rig({ consent: true, answerInfo: (m) => (m.includes("wants to record") ? "Accept and start capturing" : m.startsWith("Add these") ? answer : undefined) });
  try {
    await r.s.askConsent();
    const target = join(r.dir, "ai-log", "2026", "11", "2026-11-20-test.md");
    const docs = new VirtualDocs();
    await summarizeDay(r.s, docs);
    const call = r.calls.find((c) => c.args.includes("summarize"))!;
    assert.deepEqual(call.args, [join(r.guard, "bin", "aura-guard.mjs"), "capture", "summarize", "--repo", r.dir, "--json"]);
    assert.equal(call.file, "node");
    assert.equal(r.fake.diffs.length, 1); // the diff was shown
    assert.equal(existsSync(target), false); // cancelled: nothing written
    answer = "Apply";
    await summarizeDay(r.s, docs);
    assert.ok(readFileSync(target, "utf8").includes("did a thing"));
    // A draft aimed outside ai-log is refused.
    const r2 = await rig({ consent: true, summarize: { ok: true, date: "d", file: "../evil.md", draft: "x", entries: 1, commits: 0, ideas: [], questions: [], sources: {}, backend: "n" }, answerInfo: (m) => (m.includes("wants to record") ? "Accept and start capturing" : "Apply") });
    await r2.s.askConsent();
    await summarizeDay(r2.s, docs);
    assert.equal(existsSync(join(r2.dir, "..", "evil.md")), false);
    cleanup(r2);
  } finally {
    cleanup(r);
  }
});

test("@guard refuses a secret question and sends nothing; answers others", async () => {
  const r = await rig({ consent: true });
  try {
    await r.s.askConsent();
    const out: string[] = [];
    const stream = { markdown: (t: string) => void out.push(t), progress: () => {} } as never;
    const h = makeChatHandler(r.s);
    const before = r.calls.length;
    await h({ prompt: `why ${secret()}`, command: undefined } as never, {} as never, stream, {} as never);
    assert.equal(r.calls.length, before);
    assert.match(out.join(""), /contains a secret/);
    await h({ prompt: "", command: "help" } as never, {} as never, stream, {} as never);
    assert.match(out.join(""), /@guard/);
    await h({ prompt: "why X?", command: undefined } as never, {} as never, stream, {} as never);
    const ans = r.calls.find((c) => c.args.includes("answer"))!;
    assert.deepEqual(ans.args, [join(r.guard, "bin", "aura-guard.mjs"), "answer", "why X?", "--json"]);
    const day = readdirSync(join(r.spool, repoKey(r.dir)))[0]!;
    assert.equal(JSON.parse(readFileSync(join(r.spool, repoKey(r.dir), day), "utf8").trim()).kind, "chat");
  } finally {
    cleanup(r);
  }
});

test("manifest: commands, settings and minimal activation events are declared", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  const cmds = pkg.contributes.commands.map((c: { command: string }) => c.command);
  for (const c of ["logIdea", "logDecision", "logCorrection", "showToday", "summarizeDay", "togglePause", "deleteData", "openChat", "setup", "menu"]) assert.ok(cmds.includes(`auraGuard.${c}`), c);
  assert.ok(pkg.contributes.commands.every((c: { title: string }) => c.title.startsWith("Guard:")));
  const props = Object.keys(pkg.contributes.configuration.properties);
  for (const p of ["guardHome", "nodePath", "spoolDir", "workspaces", "developerName", "capture.commits", "capture.saves", "capture.tasks", "capture.terminal", "capture.diagnostics", "capture.chat"]) assert.ok(props.includes(`auraGuard.${p}`), p);
  assert.ok(!pkg.activationEvents.includes("*"));
  assert.ok(pkg.activationEvents.length <= 3);
  assert.ok(pkg.contributes.chatParticipants.some((p: { name: string }) => p.name === "guard"));
  assert.match(pkg.engines.vscode, /1\.(9[3-9]|[1-9]\d\d)/);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
});
