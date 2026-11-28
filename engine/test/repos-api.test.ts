// The repo routes, against temporary git repos. A hostile repo must not get a program run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fakeSecret, fixtureUiDir, tmpCfg } from "./chat-helpers.ts";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import type { CompleteRequest } from "../src/brain/client.ts";
import { safeGit } from "../src/repos/safe-git.ts";
import { classifyRemote } from "../src/repos/hosts.ts";
import { openCommand } from "../src/repos/routes.ts";

const TOKEN = "r".repeat(48);

function makeRepo(root: string) {
  const dir = join(root, "work repo");
  mkdirSync(join(dir, "src"), { recursive: true });
  const git = (...a: string[]): string => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...a], { cwd: dir, encoding: "utf8" });
  const put = (p: string, text: string): void => writeFileSync(join(dir, p), text);
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  put("src/a.ts", "export const a = 1;\n");
  put("src/space.ts", "export const s = 1;\n");
  put(".env", "X=1\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  git("checkout", "-q", "-b", "feature");
  put("src/a.ts", "export const a = 2;\nexport const b = 3;\n");
  put("src/space.ts", "export   const s = 1;   \n");
  put(".env", "X=2\n");
  put("src/key.ts", `const token = "${fakeSecret()}";\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "second");
  return { dir, git, put };
}

async function start() {
  const cfg = tmpCfg();
  const repo = makeRepo(cfg.root);
  const calls: CompleteRequest[] = [];
  const launched: string[][] = [];
  const server: Server = createGuardServer(cfg, {
    token: TOKEN, uiDir: fixtureUiDir(), openIndex: () => null,
    complete: async (req) => {
      calls.push(req);
      return { text: JSON.stringify({ findings: [{ file: "src/a.ts", line: 2, severity: "risk", issue: "b is unused", why: "dead code" }] }), usage: { input_tokens: 1, output_tokens: 1 } };
    },
    repos: { launch: async (c, a) => void launched.push([c, ...a]) },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Cookie: `${COOKIE_NAME}=${TOKEN}`, "Content-Type": "application/json" };
  const call = async (method: string, path: string, body?: object, extra: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, text, json: (extra.Accept ? null : JSON.parse(text)) as any };
  };
  return { cfg, repo, calls, launched, base, call, stop: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

test("repos: add, state, branches, commits, remove; config keeps other keys and no files are deleted", async () => {
  const s = await start();
  try {
    assert.equal((await fetch(`${s.base}/api/repos`)).status, 401);
    assert.equal((await s.call("POST", "/api/repos", { path: s.repo.dir }, { Origin: "http://evil.example" })).status, 403);
    for (const path of ["relative/dir", "\\\\server\\share", join(s.cfg.root, "missing"), s.cfg.root]) {
      assert.equal((await s.call("POST", "/api/repos", { path })).status, 400, path);
    }
    const file = join(s.cfg.root, "guard.config.local.json");
    writeFileSync(file, JSON.stringify({ vaultDir: "v", custom: { keep: true }, repos: [] }));
    const added = await s.call("POST", "/api/repos", { path: join(s.repo.dir, "src"), id: "app" });
    assert.equal(added.status, 201, added.text);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual([saved.custom, saved.vaultDir, saved.repos.length], [{ keep: true }, "v", 1]);
    assert.equal(realpathSync.native(saved.repos[0].path), realpathSync.native(s.repo.dir));
    assert.equal((await s.call("POST", "/api/repos", { path: s.repo.dir })).status, 409);

    s.repo.put("new.txt", "n\n");
    const info = (await s.call("GET", "/api/repos")).json.repos[0];
    assert.deepEqual(
      [info.id, info.exists, info.isGit, info.branch, info.dirtyFiles, info.ahead, info.behind, info.host, info.lastCommit.subject, info.error],
      ["app", true, true, "feature", 1, null, null, "unknown", "second", null],
    );
    const branches = (await s.call("GET", "/api/repos/app/branches")).json;
    assert.equal(branches.current, "feature");
    assert.deepEqual(branches.branches.map((b: any) => b.name).sort(), ["feature", "main"]);
    assert.deepEqual((await s.call("GET", "/api/repos/app/commits?ref=main&limit=5")).json.commits.map((c: any) => c.subject), ["first"]);
    for (const q of ["commits?ref=--all", "commits?ref=nope", "commits?ref=main~1", "diff?base=--output%3Dx&head=main", "diff?base=main&head=WORKTREE..", "diff?base=WORKTREE&head=main"]) {
      assert.equal((await s.call("GET", `/api/repos/app/${q}`)).status, 400, q);
    }
    assert.equal((await s.call("GET", "/api/repos/nope/branches")).status, 404);
    assert.equal((await s.call("POST", "/api/repos/app/open", { app: "calc" })).status, 400);
    assert.equal((await s.call("POST", "/api/repos/app/open", { app: "explorer", path: "C:/Windows" })).status, 200);
    assert.equal(realpathSync.native(s.launched[0]![1]!), realpathSync.native(s.repo.dir));

    assert.equal((await s.call("DELETE", "/api/repos/app")).status, 200);
    assert.deepEqual((await s.call("GET", "/api/repos")).json.repos, []);
    assert.ok(existsSync(join(s.repo.dir, "src", "a.ts")));
  } finally {
    await s.stop();
  }
});

test("diff: counts, withheld secrets, whitespace setting and the working tree", async () => {
  const s = await start();
  try {
    await s.call("POST", "/api/repos", { path: s.repo.dir, id: "app" });
    const full = (await s.call("GET", "/api/repos/app/diff?base=main&head=feature")).json;
    const by = (d: any, p: string) => d.files.find((f: any) => f.path === p);
    assert.deepEqual([by(full, "src/a.ts").additions, by(full, "src/a.ts").deletions], [2, 1]);
    assert.match(by(full, "src/a.ts").patch, /\+export const b = 3;/);
    assert.deepEqual([by(full, ".env").patch, by(full, ".env").withheld], [null, "secret-like file"]);
    assert.equal(by(full, "src/key.ts").patch, null);
    assert.ok(!JSON.stringify(full).includes(fakeSecret()));
    assert.ok(by(full, "src/space.ts"));

    const w = (await s.call("GET", "/api/repos/app/diff?base=main&head=feature&ignoreWhitespace=1")).json;
    assert.equal(by(w, "src/space.ts"), undefined);
    assert.equal(w.additions, w.files.reduce((n: number, f: any) => n + f.additions, 0));
    assert.equal(w.additions, full.additions - 1);
    assert.equal(w.deletions, full.deletions - 1);

    s.repo.put("src/a.ts", "export const a = 9;\n");
    s.repo.put("untracked.txt", "one\ntwo\n");
    s.repo.put("server.pem", "x\n");
    const wt = (await s.call("GET", "/api/repos/app/diff?base=HEAD&head=WORKTREE")).json;
    assert.deepEqual([by(wt, "untracked.txt").status, by(wt, "untracked.txt").additions], ["added", 2]);
    assert.equal(by(wt, "server.pem").patch, null);
    assert.ok(by(wt, "src/a.ts").patch.includes("a = 9"));
  } finally {
    await s.stop();
  }
});

test("review: fixed checks without a model; with ai the diff is sent as untrusted data without secret files", async () => {
  const s = await start();
  try {
    await s.call("POST", "/api/repos", { path: s.repo.dir, id: "app" });
    const plain = await s.call("POST", "/api/repos/app/review", { base: "main", head: "feature", ai: false });
    assert.equal(plain.status, 200, plain.text);
    assert.deepEqual([plain.json.ai, s.calls.length], [false, 0]);
    assert.ok(plain.json.findings.some((f: any) => f.file === "src/key.ts"));
    assert.ok(!plain.text.includes(fakeSecret()));

    const ai = (await s.call("POST", "/api/repos/app/review", { base: "main", head: "feature", ai: true })).json;
    assert.equal(ai.ai, true);
    assert.ok(ai.findings.some((f: any) => f.title === "b is unused" && f.line === 2));
    const sent = s.calls[0]!.system.join("\n") + s.calls[0]!.user;
    assert.match(sent, /untrusted data/);
    assert.ok(!sent.includes(fakeSecret()) && !sent.includes("X=2"));
    assert.match(ai.note, /not sent to the model/);

    const stream = await s.call("POST", "/api/repos/app/review", { base: "main", head: "feature", ai: false }, { Accept: "application/x-ndjson" });
    const events = stream.text.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(events[0].type, "step");
    assert.equal(events.at(-1).type, "result");
    assert.equal((await s.call("POST", "/api/repos/app/review", { base: "-x", head: "main" }, {})).status, 400);
  } finally {
    await s.stop();
  }
});

test("a hostile repo config cannot run programs, and only read commands are allowed", async () => {
  const cfg = tmpCfg();
  const { dir, git, put } = makeRepo(cfg.root);
  const marker = join(cfg.root, "ran.txt").replace(/\\/g, "/");
  const evil = `sh -c 'echo ran >> "${marker}"; cat'`;
  put(".gitattributes", "*.ts filter=evil diff=evil\n");
  for (const [k, v] of [["filter.evil.clean", evil], ["filter.evil.smudge", evil], ["filter.evil.required", "true"], ["diff.evil.textconv", evil], ["diff.evil.command", evil], ["diff.external", evil], ["core.fsmonitor", evil]]) {
    git("config", k!, v!);
  }
  // Same length and a fresh time, so git has to look at the content.
  put("src/a.ts", "export const a = 7;\nexport const b = 3;\n");
  await safeGit(dir, ["status", "--porcelain"]);
  await safeGit(dir, ["diff", "HEAD", "--"]);
  await safeGit(dir, ["diff", "main", "feature", "--"]);
  await safeGit(dir, ["log", "-p", "-2"]);
  await safeGit(dir, ["show", "HEAD"]);
  assert.equal(existsSync(marker), false, "a repo-configured program ran");
  for (const args of [["fetch"], ["checkout", "main"], ["config", "user.name", "x"], ["diff", "--output=x"], ["branch", "-D", "main"], ["-c", "a=b", "log"]]) {
    await assert.rejects(safeGit(dir, args), /not allowed|Only reading/, args.join(" "));
  }
});

test("remote addresses: only the official hosts; sign-in parts are dropped", () => {
  const gh = classifyRemote("https://user:secretpart@github.com/o/r.git");
  assert.deepEqual(gh, { host: "github", owner: "o", repo: "r" });
  assert.equal(classifyRemote("git@github.com:o/r.git").host, "github");
  for (const u of ["https://org.visualstudio.com/P/_git/R", "https://dev.azure.com/o/p/_git/r", "git@ssh.dev.azure.com:v3/o/p/r"]) assert.equal(classifyRemote(u).host, "azure-devops", u);
  for (const u of ["https://github.com.evil.example/o/r", "https://evil.example/o/p/_git/r", "https://evilazure.com/o/p/_git/r", "http://dev.azure.com/o/p/_git/r", "C:/local/repo", ""]) {
    assert.equal(classifyRemote(u).host, "unknown", u);
  }
  assert.throws(() => openCommand("vscode", "C:/x", {}, () => false), /not found/);
});
