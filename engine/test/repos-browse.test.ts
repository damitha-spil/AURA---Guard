// The folder picker route: directories only, local paths only, behind the same guards as other routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fixtureUiDir, tmpCfg } from "./chat-helpers.ts";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import { MAX_BROWSE_ENTRIES, browseFolders } from "../src/repos/browse.ts";

const TOKEN = "b".repeat(48);

function tree() {
  const cfg = tmpCfg();
  const root = join(cfg.root, "browse root");
  for (const d of ["alpha/.git", "beta", "gamma", ".hidden", "target/inside"]) mkdirSync(join(root, d), { recursive: true });
  // A worktree has a .git file, not a folder.
  writeFileSync(join(root, "gamma", ".git"), "gitdir: elsewhere\n");
  writeFileSync(join(root, "secret-file.txt"), "file-content-marker");
  symlinkSync(join(root, "target"), join(root, "link"), "junction");
  cfg.repos = [{ id: "alpha", path: join(root, "alpha").replace(/\\/g, "/") }];
  return { cfg, root };
}

test("browse: folders only, with git and already-added marks; links are not listed", () => {
  const { cfg, root } = tree();
  const r = browseFolders(cfg, root);
  assert.deepEqual(r.entries.map((e) => [e.name, e.isGit, e.added]), [["alpha", true, true], ["beta", false, false], ["gamma", true, false], ["target", false, false]]);
  assert.equal(r.parent, cfg.root);
  assert.equal(r.truncated, false);
  assert.doesNotMatch(JSON.stringify(r), /secret-file|file-content-marker/);
  const alpha = browseFolders(cfg, join(root, "alpha"));
  assert.deepEqual([alpha.isGit, alpha.added, alpha.entries.length], [true, true, 0]);
  // A link typed on purpose is followed when it stays on this computer.
  assert.deepEqual(browseFolders(cfg, join(root, "link")).entries.map((e) => e.name), ["inside"]);
});

test("browse: suggestions list home and the parents of loaded repos", () => {
  const { cfg, root } = tree();
  const r = browseFolders(cfg, "", cfg.root);
  assert.equal(r.path, null);
  assert.deepEqual(r.suggestions.filter((s) => s.kind !== "drive").map((s) => [s.kind, s.path]), [["projects", root], ["home", cfg.root]]);
  assert.ok(r.suggestions.some((s) => s.kind === "drive"));
});

test("browse: relative, network, device, missing and file paths are refused", () => {
  const { cfg, root } = tree();
  const refused = ["relative/dir", "..", "\\\\server\\share", "//server/share", "\\\\?\\C:\\", "\\\\.\\pipe\\x", `${root}\0x`, "a".repeat(2000)];
  if (process.platform === "win32") refused.push("\\rooted", "C:relative", "C:\\NUL", "C:\\x\\file:stream");
  for (const path of refused) assert.throws(() => browseFolders(cfg, path), { status: 400 }, JSON.stringify(path.slice(0, 40)));
  assert.throws(() => browseFolders(cfg, join(root, "missing")), { status: 404 });
  assert.throws(() => browseFolders(cfg, join(root, "secret-file.txt")), (e: any) => e.status === 400 || e.status === 404);
});

test("browse: a long listing is cut short and says so", () => {
  const { cfg } = tree();
  const many = join(cfg.root, "many");
  for (let i = 0; i <= MAX_BROWSE_ENTRIES; i++) mkdirSync(join(many, `d${i}`), { recursive: true });
  const r = browseFolders(cfg, many);
  assert.deepEqual([r.entries.length, r.truncated], [MAX_BROWSE_ENTRIES, true]);
});

test("browse route: needs the cookie, refuses a foreign origin and answers a signed-in request", async () => {
  const { cfg, root } = tree();
  const server = createGuardServer(cfg, { token: TOKEN, uiDir: fixtureUiDir(), openIndex: () => null, complete: async () => ({ text: "", usage: { input_tokens: 0, output_tokens: 0 } }) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/repos/browse?path=${encodeURIComponent(root)}`;
    const Cookie = `${COOKIE_NAME}=${TOKEN}`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Cookie, Origin: "http://evil.example" } })).status, 403);
    const ok = await fetch(url, { headers: { Cookie } });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { entries: unknown[] }).entries.length, 4);
    const unc = await fetch(url.replace(/path=.*/, `path=${encodeURIComponent("\\\\server\\share")}`), { headers: { Cookie } });
    assert.equal(unc.status, 400);
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  }
});
