// Proof scope, system health, unattended daily runs and desktop-test blocks.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuardConfig } from "../src/types.ts";
import { appScope, classifyChange, evaluateEvidence, fileKind } from "../src/qa/evidence_scope.ts";
import { runEvidence } from "../src/qa/evidence.ts";
import type { QaRunDetail } from "../src/qa/harness_api.ts";
import { runHealth } from "../src/health/health.ts";
import type { HealthCheck } from "../src/health/health.ts";
import { unattendedRefusal } from "../src/cli/commands-daily.ts";
import { judgeTargetWindow, selectTargetWindow, createCuaStepContext, BUILTIN_DENY_PROCESSES } from "../src/qa/cua_harness.ts";
import { CuaClient, CuaToolBlockedError } from "../src/qa/cua_client.ts";
import type { CuaWindowInfo } from "../src/qa/cua_client.ts";
import { crawlDesktopApp } from "../src/qa/desktop_crawler.ts";
import type { DesktopCrawlerTransport } from "../src/qa/desktop_crawler.ts";
import { createHybridDriver } from "../src/qa/driver.ts";
import { isSafeKey, loadForbidden, matchForbiddenText } from "../src/qa/safety.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const base = (dir: string): GuardConfig => ({ root: dir, dataDir: join(dir, "data"), vaultDir: join(dir, "vault"), repos: [], busyProcesses: [] });
function temp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "reo-ehs-"));
  const done = () => rmSync(dir, { recursive: true, force: true });
  const out = fn(dir);
  if (out instanceof Promise) return out.finally(done) as T;
  done();
  return out;
}

/* ---------- proof scope ---------- */

test("changes are classified as app, service or docs/dev-tool, and unplaced files need real proof", () => {
  assert.equal(fileKind("web/src/lib/api.ts"), "app");
  assert.equal(fileKind("src/orders/Row.tsx"), "app");
  assert.equal(fileKind("src-tauri/src/main.rs"), "app");
  assert.equal(fileKind("engine/src/server/server.ts"), "service");
  assert.equal(fileKind("something.bin"), "service");
  assert.equal(fileKind("package.json"), "service");
  for (const p of ["README.md", "docs/guide.png", "scripts/release.ps1", "web/src/lib/x.test.ts", "eslint.config.js"]) {
    assert.equal(fileKind(p), "docs-tool", p);
  }
  assert.deepEqual(classifyChange(["README.md"]).requirements.map((r) => r.id), ["check-output", "no-app-path-reason"]);
  assert.deepEqual(classifyChange(["api/x.rs", "README.md"]).requirements.map((r) => r.id), ["environment", "service-readback"]);
  const both = classifyChange(["web/src/a.tsx", "api/x.rs"]);
  assert.deepEqual(both.kinds, ["app", "service"]);
  assert.ok(both.requirements.some((r) => r.id === "service-readback") && both.requirements.some((r) => r.id === "app-video"));
});

test("previews, mock data, sample screens and test counts never complete a user flow", () => {
  const scope = appScope();
  const proofs = (["preview", "mock", "sample", "test-count"] as const).flatMap((source) =>
    scope.requirements.map((r) => ({ requirement: r.id, source, detail: "400 tests passed" })));
  const s = evaluateEvidence(scope, proofs);
  assert.equal(s.status, "incomplete");
  assert.ok(s.items.every((i) => i.state === "missing"));
  assert.ok(s.rejected.some((r) => r.includes("test count")));
  assert.equal(evaluateEvidence(classifyChange([]), []).status, "blocked");
  assert.equal(evaluateEvidence(scope, [], ["The run was blocked."]).status, "blocked");
});

function runDetail(extra: Record<string, unknown> = {}): QaRunDetail {
  return {
    result: {
      id: "run-proof-1", evidence: { uiChange: true, needed: [] },
      context: { changedFiles: [{ repo: "a", path: "web/src/a.tsx", category: "ui" }] },
      run: null, ...extra,
    },
  } as unknown as QaRunDetail;
}

test("a saved run is complete only with every real proof, and a failed run is never completed by a note", () => {
  temp((dir) => {
    const cfg = base(dir);
    const runDir = join(dir, ".artifacts", "qa", "run-proof-1");
    mkdirSync(runDir, { recursive: true });
    assert.equal(runEvidence(cfg, runDetail()).status, "incomplete");

    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("x")]);
    for (const w of [800, 1100, 1440]) writeFileSync(join(runDir, `w${w}.png`), png);
    writeFileSync(join(runDir, "walkthrough.mp4"), "video");
    const note = (source: string) => writeFileSync(join(runDir, "proof.json"), JSON.stringify({
      environment: "QA test", interaction: { source, steps: "opened the list" }, video: { source },
      screenshots: [800, 1100, 1440].map((width) => ({ source, width, path: `w${width}.png` })),
    }));
    note("mock");
    const mocked = runEvidence(cfg, runDetail());
    assert.equal(mocked.status, "incomplete");
    assert.ok(mocked.rejected.some((r) => r.includes("mock data")));

    note("real-app");
    const full = runEvidence(cfg, runDetail());
    assert.equal(full.status, "complete");
    assert.match(full.items.find((i) => i.id === "app-screenshots")!.detail, /did not verify/);

    const failed = runEvidence(cfg, runDetail({ run: { status: "failed", runs: [{ journeyId: "j", status: "failed" }], defects: [] } }));
    assert.equal(failed.status, "incomplete");
    const blocked = runEvidence(cfg, runDetail({ run: { status: "blocked", runs: [{ journeyId: "j", status: "blocked" }], defects: [] } }));
    assert.equal(blocked.status, "blocked");

    // Files outside the run folder do not count.
    writeFileSync(join(dir, "outside.png"), png);
    writeFileSync(join(runDir, "proof.json"), JSON.stringify({ screenshots: [800, 1100, 1440].map((width) => ({ source: "real-app", width, path: "../../../outside.png" })) }));
    assert.equal(runEvidence(cfg, runDetail()).items.find((i) => i.id === "app-screenshots")!.state, "missing");
  });
});

/* ---------- health ---------- */

test("health runs checks in parallel, limits each one and hides error text and secrets", async () => {
  const secret = "sk-ant-api03-" + "A".repeat(40);
  let running = 0;
  let most = 0;
  const slow = (id: string): HealthCheck => ({
    id, label: id,
    run: async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { status: "ok", detail: "fine" };
    },
  });
  const report = await runHealth(base(ROOT), {
    timeoutMs: 100,
    checks: [
      slow("a"), slow("b"),
      { id: "hang", label: "hang", run: () => new Promise(() => {}) },
      { id: "boom", label: "boom", run: async () => { throw new Error(`failed with ${secret} at C:/private/place`); } },
      { id: "leak", label: "leak", run: async () => ({ status: "warn", detail: `key ${secret}`, fix: "fix it" }) },
    ],
  });
  assert.equal(most, 2);
  const by = new Map(report.rows.map((r) => [r.id, r]));
  assert.equal(by.get("hang")!.status, "unknown");
  assert.equal(by.get("boom")!.status, "unknown");
  assert.equal(report.status, "unknown");
  const all = JSON.stringify(report);
  assert.ok(!all.includes(secret) && !all.includes("private/place"));
});

test("the real health checks call no model and put no paths or secrets in rows", async () => {
  await temp(async (dir) => {
    const secret = "sk-ant-api03-" + "B".repeat(40);
    const report = await runHealth(
      { ...base(dir), cuaDriver: { command: "no-such-driver-program" } },
      {
        brain: {
          env: { ANTHROPIC_API_KEY: secret }, launcher: null, opencodeLauncher: null,
          fetch: (() => { throw new Error("health must not use the network"); }) as unknown as typeof fetch,
          secrets: { name: "fake", available: async () => true, exists: async () => false, get: async () => { throw new Error("must not read a key"); }, set: async () => { throw new Error("no"); }, remove: async () => {} },
          secretsFor: () => ({ name: "fake", available: async () => true, exists: async () => false, get: async () => { throw new Error("must not read a key"); }, set: async () => {}, remove: async () => {} }),
        },
      },
    );
    assert.deepEqual(report.rows.map((r) => r.id), ["models", "repos", "index", "desktop-driver", "key-store", "web-build"]);
    const by = new Map(report.rows.map((r) => [r.id, r]));
    assert.equal(by.get("models")!.status, "ok");
    assert.match(by.get("models")!.detail, /not tested and no model was called/);
    assert.equal(by.get("index")!.status, "warn");
    assert.equal(by.get("web-build")!.status, "fail");
    assert.ok(report.rows.every((r) => r.status === "ok" || r.fix));
    const all = JSON.stringify(report);
    assert.ok(!all.includes(secret) && !all.includes(dir.replace(/\\/g, "\\\\")));
  });
});

/* ---------- unattended daily runs ---------- */

test("unattended runs allow only read-only steps; everything else is refused with a reason", () => {
  const file = JSON.parse(readFileSync(join(ROOT, "roles", "daily.json"), "utf8")) as { steps: { id: string; argv: string[]; needsModel?: boolean }[] };
  for (const s of file.steps) {
    const why = unattendedRefusal(s.argv, s.needsModel === true);
    if (s.needsModel) assert.match(why!, /model/, s.id);
    else assert.equal(why, null, s.id);
  }
  for (const id of ["health", "qa-backend", "qa-pr-readiness", "logcheck"]) assert.ok(file.steps.some((s) => s.id === id), id);
  const refused = [
    ["index", "--force"], ["qa", "run", "journey-x"], ["qa", "crawl"], ["qa", "explore", "home"],
    ["qa", "agent", "run it"], ["rules", "approve", "r1"], ["capture", "purge"], ["brain", "key", "set"],
    ["qa", "security", "http://127.0.0.1:1"], ["mine", "--max", "all"], ["qa", "pr-readiness", "a", "b"],
  ];
  for (const argv of refused) assert.match(unattendedRefusal(argv, false)!, /needs confirmation/, argv.join(" "));
});

/* ---------- desktop-test safety ---------- */

const win = (processName: string, more: Partial<CuaWindowInfo> = {}): CuaWindowInfo => ({ pid: 4242, windowId: "w1", title: "App under test", processName, ...more });
const allow = (...allowedApps: string[]): GuardConfig => ({ ...base(ROOT), cuaDriver: { allowedApps } });

test("only an exactly named app is allowed; an empty list allows nothing", () => {
  assert.match(judgeTargetWindow(win("personal-agent.exe"), base(ROOT))!, /no app is allowed/);
  assert.match(judgeTargetWindow(win("personal-agent.exe"), allow("", " "))!, /no app is allowed/);
  assert.equal(judgeTargetWindow(win("Personal-Agent.EXE"), allow("personal-agent")), null);
  assert.ok(judgeTargetWindow(win("personal-agent-helper.exe"), allow("personal-agent.exe")));
  // A window title is not an app name.
  assert.ok(judgeTargetWindow(win("notes.exe", { title: "personal-agent.exe" }), allow("personal-agent.exe")));
  assert.throws(() => selectTargetWindow([win("a.exe")], base(ROOT)), /No app is allowed yet/);
});

test("shells, terminals, elevated, unknown and REO's own windows are refused even when allowed locally", () => {
  const names = ["powershell", "pwsh.exe", "cmd", "bash.exe", "wsl.exe", "mintty.exe", "conhost.exe", "alacritty.exe", "Code.exe", "wscript.exe", "explorer.exe", "spil-reo-desktop.exe", ...BUILTIN_DENY_PROCESSES, "", ".exe", "unknown.exe"];
  for (const n of names) assert.ok(judgeTargetWindow(win(n), allow(n)), `must refuse "${n}"`);
  assert.ok(judgeTargetWindow(win("msedge.exe", { title: "SPIL REO" }), allow("msedge.exe")));
  assert.ok(judgeTargetWindow(win("app.exe", { pid: process.pid }), allow("app.exe")));
  assert.ok(judgeTargetWindow(win("app.exe", { pid: 0 }), allow("app.exe")));
  assert.match(judgeTargetWindow(win("app.exe", { elevated: true }), allow("app.exe"))!, /administrator/);
  assert.match(judgeTargetWindow(win("app.exe", { elevated: "unknown" }), allow("app.exe"))!, /could not be checked/);
  assert.equal(judgeTargetWindow(win("refresh.exe", { elevated: false }), allow("refresh.exe")), null);
  const denied: GuardConfig = { ...base(ROOT), cuaDriver: { allowedApps: ["app.exe"], denyApps: ["app"] } };
  assert.match(judgeTargetWindow(win("app.exe"), denied)!, /denylist/);
});

test("drivers refuse a protected window, unknown tools and keys that can press a button", async () => {
  const client = new CuaClient({ callTool: async () => ({ content: [] }), close: async () => {} });
  const invoke = (client as unknown as { invoke: (t: string, a: object) => Promise<unknown> }).invoke.bind(client);
  await assert.rejects(() => invoke("run_command", {}), CuaToolBlockedError);
  const forbidden = loadForbidden(ROOT);
  const parts = { client, forbidden, shotDir: tmpdir(), record: () => {} };
  assert.throws(() => createCuaStepContext({ ...parts, window: win("pwsh.exe") }), /denylist/);
  assert.throws(() => createHybridDriver({ cfg: base(ROOT), cuaClient: client, window: win("app.exe"), forbidden, shotDir: tmpdir() }), /no app is allowed/);
  const ctx = createCuaStepContext({ ...parts, window: win("app.exe") });
  await assert.rejects(() => ctx.pressKey("Space"), /not a navigation key/);
  const driver = createHybridDriver({ cfg: allow("app.exe"), cuaClient: client, window: win("app.exe"), forbidden, shotDir: tmpdir() });
  await assert.rejects(() => driver.press("Space"), /not a navigation key/);
  assert.ok(isSafeKey("Tab") && isSafeKey("Escape") && !isSafeKey("Space") && !isSafeKey("a"));
});

function fakeCrawler(names: string[], later?: Partial<CuaWindowInfo>): { t: DesktopCrawlerTransport; clicked: string[] } {
  const clicked: string[] = [];
  let listed = 0;
  return {
    clicked,
    t: {
      backendName: "fake",
      listWindows: async () => [win("app.exe", listed++ ? later : undefined)],
      inspectTree: async () => names.map((name, i) => ({ token: `t${i}`, role: "button", name, enabled: true, offscreen: false, safetyTier: 0 as const })),
      click: async (_p, name) => { clicked.push(name); },
      type: async () => { throw new Error("the crawler must not type"); },
    },
  };
}

test("the crawler keeps its click cap with a bad number and re-checks the window before each click", async () => {
  const names = Array.from({ length: 30 }, (_, i) => `Tab ${i}`);
  const a = fakeCrawler(names);
  await crawlDesktopApp(allow("app.exe"), { dryRun: false, maxActions: Number.NaN }, a.t);
  assert.equal(a.clicked.length, 5);
  const b = fakeCrawler(names, { elevated: true });
  await assert.rejects(() => crawlDesktopApp(allow("app.exe"), { dryRun: false }, b.t), /administrator/);
  assert.equal(b.clicked.length, 0);
});

test("local extras cannot widen the lists, and a root without the list still blocks", () => {
  temp((dir) => {
    assert.ok(matchForbiddenText("Delete order", loadForbidden(dir)));
    mkdirSync(join(dir, "qa"), { recursive: true });
    writeFileSync(join(dir, "qa", "forbidden-actions.local.json"), JSON.stringify({ allowedHosts: ["example.com"], allowedUploadDirs: ["/"], tier1SafeNames: ["delete"], names: [] }));
    const list = loadForbidden(dir);
    assert.ok(!list.allowedHosts.includes("example.com") && !list.allowedUploadDirs.includes("/"));
    assert.ok(!(list.tier1SafeNames ?? []).includes("delete"));
    assert.ok(matchForbiddenText("Delete order", list));
  });
});
