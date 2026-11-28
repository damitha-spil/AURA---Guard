// POST /api/open-external: only https links to the known code hosts reach the OS. The launch is a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fixtureUiDir, tmpCfg } from "./chat-helpers.ts";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import { browserCommand, externalUrl } from "../src/repos/routes.ts";

const GOOD = [
  "https://dev.azure.com/org/project/_git/repo/pullrequest/1",
  "https://org.visualstudio.com/project/_git/repo/pullrequest/2",
  "https://github.com/owner/repo/pull/3?a=1&b=2#x",
];
const BAD: unknown[] = [
  "http://github.com/o/r/pull/1", "file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-settings:", "\\\\host\\share",
  "https://evil.example/pull/1", "https://github.com.evil.example/x", "https://evilgithub.com/x", "https://dev.azure.com.evil.example/x",
  "https://visualstudio.com/x", "https://a.b.visualstudio.com/x", "https://evilvisualstudio.com/x", "https://github.com@evil.example/x",
  "https://user:pw@github.com/x", "https://github.com:8443/x", "https://gıthub.com/x", "https://github.com\\@evil.example/",
  "https://github.com/a b", "https://github.com/a\r\nb", " https://github.com/x", `https://github.com/${"a".repeat(2100)}`,
  "github.com/o/r", "", 5, null, undefined, ["https://github.com/x"],
];

test("externalUrl allows only https on the known hosts, and never returns spaces or quotes", () => {
  for (const u of GOOD) assert.equal(externalUrl(u), u, u);
  for (const u of BAD) assert.equal(externalUrl(u), null, String(u));
  assert.ok(!/["\s]/.test(externalUrl(`https://github.com/a"b?q="c`)!));
});

test("browserCommand: a program and an argument list, no shell", () => {
  const url = GOOD[2]!;
  const win = browserCommand(url, "win32", { SystemRoot: "W" });
  assert.match(win.command, /rundll32\.exe$/);
  assert.deepEqual(win.args, ["url.dll,FileProtocolHandler", url]);
  assert.deepEqual(browserCommand(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(browserCommand(url, "linux"), { command: "xdg-open", args: [url] });
});

test("route: needs the cookie and our Origin; refused links never launch", async () => {
  const launched: string[][] = [];
  const TOKEN = "o".repeat(48);
  const server = createGuardServer(tmpCfg(), {
    token: TOKEN, uiDir: fixtureUiDir(), openIndex: () => null, complete: async () => assert.fail("no model call"),
    repos: { launch: async (command, args) => { launched.push([command, ...args]); } },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (url: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/open-external`, {
    method: "POST", headers: { Cookie: `${COOKIE_NAME}=${TOKEN}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify({ url }),
  });
  try {
    assert.equal((await send(GOOD[0], { Cookie: "" })).status, 401);
    assert.equal((await send(GOOD[0], { Origin: "https://evil.example" })).status, 403);
    assert.equal((await send(GOOD[0], { "Content-Type": "text/plain" })).status, 415);
    for (const u of BAD) assert.equal((await send(u)).status, 400, String(u));
    assert.equal(launched.length, 0);
    assert.equal((await send(GOOD[0])).status, 200);
    assert.equal(launched.length, 1);
    assert.equal(launched[0]!.at(-1), GOOD[0]);
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  }
});
