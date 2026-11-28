// The pull request list, with injected fetch, sign-in and gh. No real network or program runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fixtureUiDir, tmpCfg } from "./chat-helpers.ts";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import { createPullLister } from "../src/prs/pulls.ts";
import type { PullDeps } from "../src/prs/pulls.ts";
import { classifyRemote } from "../src/repos/hosts.ts";
import type { GuardConfig } from "../src/types.ts";

function cfgWith(): GuardConfig {
  const cfg = tmpCfg();
  return { ...cfg, repos: ["az", "gh", "other"].map((id) => ({ id, path: cfg.root })).concat({ id: "gone", path: `${cfg.root}-missing` }) };
}
const REMOTES: Record<string, string> = { az: "https://org.visualstudio.com/Proj/_git/App", gh: "https://github.com/o/r.git", other: "https://git.example.com/o/r.git" };

function deps(cfg: GuardConfig, over: Partial<PullDeps> = {}) {
  const seen: { url: string; auth: string; method: string }[] = [];
  let i = 0;
  const d: PullDeps = {
    env: { GH_TOKEN: "gh-token-value", AZURE_DEVOPS_PAT: "az-pat-value" },
    remote: async () => classifyRemote(REMOTES[cfg.repos[i++ % 3]!.id]!),
    fetch: (async (url: string, init: RequestInit) => {
      const auth = String((init.headers as Record<string, string>).Authorization ?? (init.headers as Record<string, string>).authorization);
      seen.push({ url: String(url), auth, method: String(init.method) });
      const body = String(url).startsWith("https://api.github.com/")
        ? [{ number: 5, title: "<b>t</b>", user: { login: "dev" }, state: "open", draft: true, head: { ref: "f" }, base: { ref: "main" }, created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-03T00:00:00Z", labels: [{ name: "bug" }] }]
        : { value: [{ pullRequestId: 7, title: "Fix", status: "active", isDraft: false, createdBy: { displayName: "A Dev" }, creationDate: "2026-11-01T00:00:00Z", sourceRefName: "refs/heads/f", targetRefName: "refs/heads/development" }] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    ...over,
  };
  return { d, seen };
}

test("both hosts are listed, one bad repo does not hide others, and tokens only go to their own host", async () => {
  const cfg = cfgWith();
  const { d, seen } = deps(cfg);
  const r = await createPullLister(d)(cfg, "open");
  assert.deepEqual(r.pulls.map((p) => [p.id, p.host, p.state, p.draft, p.sourceBranch]), [["gh#5", "github", "open", true, "f"], ["az#7", "azure-devops", "open", false, "f"]]);
  assert.equal(r.pulls[1]!.url, "https://org.visualstudio.com/Proj/_git/App/pullrequest/7");
  assert.deepEqual(r.sources.map((s) => [s.repoId, s.ok]), [["az", true], ["gh", true], ["other", false], ["gone", false]]);
  for (const c of seen) {
    assert.equal(c.method, "GET");
    const host = new URL(c.url).host;
    if (host === "api.github.com") assert.equal(c.auth, "Bearer gh-token-value");
    else {
      assert.equal(host, "org.visualstudio.com");
      assert.equal(c.auth, "Basic " + Buffer.from(":az-pat-value").toString("base64"));
    }
  }
  assert.ok(!/token-value|pat-value/.test(JSON.stringify(r)));
});

test("results are cached until refresh", async () => {
  const cfg = cfgWith();
  const { d, seen } = deps(cfg);
  const list = createPullLister(d);
  await list(cfg, "open");
  const n = seen.length;
  await list(cfg, "open");
  assert.equal(seen.length, n);
  await list(cfg, "open", true);
  assert.equal(seen.length, n * 2);
});

test("gh is used without a token; missing sign-ins explain how to fix and leak nothing", async () => {
  const cfg = { ...cfgWith(), repos: cfgWith().repos.slice(0, 2) };
  const ghCalls: string[][] = [];
  const base = deps(cfg);
  const r = await createPullLister({
    ...base.d, env: {}, credentials: async () => undefined, ghPath: () => "gh.exe",
    remote: (() => { let i = 0; return async () => classifyRemote(REMOTES[["az", "gh"][i++]!]!); })(),
    runGh: async (_e, args) => { ghCalls.push(args); return JSON.stringify([{ number: 1, state: "closed", merged_at: "2026-11-01T00:00:00Z", created_at: "2026-11-01T00:00:00Z" }]); },
  })(cfg, "merged");
  assert.deepEqual(ghCalls[0]!.slice(0, 5), ["api", "--hostname", "github.com", "--method", "GET"]);
  assert.deepEqual(r.pulls.map((p) => [p.number, p.state]), [[1, "merged"]]);
  assert.match(r.sources[0]!.error!, /AZURE_DEVOPS_PAT/);

  const none = await createPullLister({ env: {}, ghPath: () => null, remote: async () => classifyRemote(REMOTES.gh!) })({ ...cfg, repos: [cfg.repos[1]!] }, "open");
  assert.match(none.sources[0]!.error!, /gh auth login/);
});

test("routes: cookie needed, state checked, source control reports without secrets", async () => {
  const cfg = cfgWith();
  const TOKEN = "p".repeat(48);
  const { d } = deps(cfg);
  const server: Server = createGuardServer(cfg, { token: TOKEN, uiDir: fixtureUiDir(), openIndex: () => null, complete: async () => assert.fail("no model call"), repos: { pulls: d } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Cookie: `${COOKIE_NAME}=${TOKEN}` };
  try {
    assert.equal((await fetch(`${base}/api/pulls`)).status, 401);
    assert.equal((await fetch(`${base}/api/pulls?state=x`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/pulls`, { headers })).status, 200);
    const text = await (await fetch(`${base}/api/source-control`, { headers })).text();
    const sc = JSON.parse(text) as { git: { available: boolean }; providers: { id: string; status: string }[] };
    assert.equal(sc.git.available, true);
    assert.deepEqual(sc.providers.map((p) => [p.id, p.status]), [["github", "ready"], ["azure-devops", "ready"]]);
    assert.ok(!/token-value|pat-value/.test(text));
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  }
});
