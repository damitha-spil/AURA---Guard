import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GUARD_ROOT } from "../src/config.ts";
import type { GuardConfig } from "../src/types.ts";
import type { CompleteFn } from "../src/brain/client.ts";
import { openDb } from "../src/index/db.ts";
import { ensureGraphTables } from "../src/index/graph.ts";
import { journeyProblems, loadJourneys } from "../src/qa/journeys.ts";
import { applyModelRanking, planMarkdown, planTests, uiArea, writePlan } from "../src/qa/planner.ts";
import { generateSpec, REJECTED_MARK } from "../src/qa/generate.ts";
import { runSpec } from "../src/qa/runner.ts";
import { loadVault } from "../src/vault/load.ts";

const reply = (text: string): CompleteFn => async () => ({ text, usage: { input_tokens: 1, output_tokens: 1 } });

function sh(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A temp Guard root with the real journeys, role file and forbidden list. */
function tmpGuard() {
  const root = mkdtempSync(join(tmpdir(), "guard-qa-"));
  mkdirSync(join(root, "roles"));
  cpSync(join(GUARD_ROOT, "roles", "qa-planner.yaml"), join(root, "roles", "qa-planner.yaml"));
  mkdirSync(join(root, "qa"));
  cpSync(join(GUARD_ROOT, "qa", "forbidden-actions.json"), join(root, "qa", "forbidden-actions.json"));
  cpSync(join(GUARD_ROOT, "engine", "test", "fixtures", "journeys"), join(root, "vault", "journeys"), { recursive: true });
  mkdirSync(join(root, "vault", "inbox"), { recursive: true });
  const cfg: GuardConfig = {
    department: "dev", dataDir: join(root, "data"), vaultDir: join(root, "vault"),
    repos: [{ id: "spil-aura", path: join(root, "aura repo") }], busyProcesses: [], root,
  };
  return { root, cfg, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A small repo: one base commit, then a change in orders, a new area (security), and a doc. */
function tmpRepo(path: string): { base: string } {
  mkdirSync(path, { recursive: true });
  sh(path, ["init", "-q"]);
  sh(path, ["config", "user.email", "t@example.org"]);
  sh(path, ["config", "user.name", "T"]);
  const put = (f: string, t: string) => { mkdirSync(join(path, f, ".."), { recursive: true }); writeFileSync(join(path, f), t); };
  put("apps/aura-ui/src/orders/OrdersScreen.tsx", "a\n");
  put("apps/aura-ui/src/lib/x.ts", "a\n");
  put("README.md", "a\n");
  sh(path, ["add", "."]);
  sh(path, ["commit", "-q", "-m", "base"]);
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  put("apps/aura-ui/src/orders/OrdersScreen.tsx", "a\nb\nc\n");
  put("apps/aura-ui/src/security/Gate.tsx", "new\n");
  put("apps/aura-ui/src/lib/x.ts", "a\nb\n");
  put("README.md", "b\n");
  sh(path, ["add", "."]);
  sh(path, ["commit", "-q", "-m", "change"]);
  return { base };
}

test("the fixture journeys are valid notes: proposed, qa_internal, anchored, read-only", () => {
  const fixtures = join(GUARD_ROOT, "engine", "test", "fixtures");
  const { problems } = loadVault(fixtures);
  assert.deepEqual(problems, []);
  const js = loadJourneys({ vaultDir: fixtures } as GuardConfig);
  assert.ok(js.length >= 5 && js.length <= 8, `got ${js.length}`);
  for (const j of js) {
    assert.deepEqual(journeyProblems(j), [], j.id);
    assert.equal(j.status, "proposed", j.id);
    assert.ok(j.steps.length >= 3, j.id);
    assert.ok(j.forbidden.some((f) => /read only/i.test(f)), j.id);
  }
  const text = readdirSync(join(fixtures, "journeys")).map((f) => readFileSync(join(fixtures, "journeys", f), "utf8")).join("\n");
  assert.match(text, /audience: \[qa_internal, internal_dev\]/);
});

test("planner maps changed files to journeys and finds gaps, without a model", async () => {
  const t = tmpGuard();
  try {
    const { base } = tmpRepo(t.cfg.repos[0]!.path);
    const plan = await planTests(t.cfg, null, { repo: "spil-aura", base, head: "HEAD" });
    assert.equal(plan.uiChanged, true);
    assert.equal(plan.usedModel, false);
    const ids = plan.items.map((i) => i.journey);
    assert.ok(ids.includes("journey-orders-list") && ids.includes("journey-orders-open-order"), ids.join());
    assert.ok(!ids.includes("journey-helpers-list"));
    assert.equal(plan.items[0]?.risk === "low", false);
    assert.ok(plan.items[0]!.evidence.some((e) => /800, 1100 and 1440/.test(e)));
    assert.ok(plan.items[0]!.evidence.some((e) => /walkthrough video/.test(e)));
    assert.deepEqual(plan.gaps.map((g) => g.area).sort(), ["lib", "security"]);
    // sorted by score
    for (let i = 1; i < plan.items.length; i++) assert.ok(plan.items[i - 1]!.score >= plan.items[i]!.score);
    const file = writePlan(t.cfg, plan, new Date("2026-11-20T10:00:00Z"));
    assert.ok(file.includes(join("data", "qa", "plans")));
    const md = readFileSync(file, "utf8");
    assert.match(md, /Gaps: changed screens with no journey/);
    assert.match(md, /security/);
    assert.equal(planMarkdown(plan, new Date()).includes("Status: proposed"), true);
  } finally { t.cleanup(); }
});

test("planner uses the code graph's blast radius for dependents of a changed file", async () => {
  const t = tmpGuard();
  try {
    const { base } = tmpRepo(t.cfg.repos[0]!.path);
    const db = openDb(":memory:");
    ensureGraphTables(db);
    const ins = db.prepare("INSERT INTO graph_nodes(repo,id,label,kind,path) VALUES (?,?,?,?,?)");
    ins.run("spil-aura", "x", "x", "code", "apps/aura-ui/src/lib/x.ts");
    ins.run("spil-aura", "h", "h", "code", "apps/aura-ui/src/helpers/HelpersPage.tsx");
    db.prepare("INSERT INTO graph_edges(repo,src,dst,kind) VALUES (?,?,?,?)").run("spil-aura", "h", "x", "imports");
    const plan = await planTests(t.cfg, db, { repo: "spil-aura", base, head: "HEAD" });
    const helpers = plan.items.find((i) => i.journey === "journey-helpers-list");
    assert.ok(helpers, "helpers journey reached through blast radius");
    assert.deepEqual(helpers!.indirectFiles, ["apps/aura-ui/src/lib/x.ts"]);
    assert.equal(helpers!.directFiles.length, 0);
    // the changed lib file is covered, so it is not a gap
    assert.ok(!plan.gaps.some((g) => g.files.includes("apps/aura-ui/src/lib/x.ts")));
  } finally { t.cleanup(); }
});

test("planner with a model: JSON validated by zod, unknown ids dropped; bad replies fall back to rules", async () => {
  const t = tmpGuard();
  try {
    const { base } = tmpRepo(t.cfg.repos[0]!.path);
    const good = JSON.stringify({
      ranked: [{ journey: "journey-orders-open-order", risk: "high", why: "OrdersScreen changed." }, { journey: "journey-made-up", risk: "low", why: "x" }],
      extra_checks: ["Check an order with a long customer name."],
    });
    const p1 = await planTests(t.cfg, null, { repo: "spil-aura", base }, { complete: reply(good) });
    assert.equal(p1.usedModel, true);
    assert.equal(p1.items[0]?.journey, "journey-orders-open-order");
    assert.equal(p1.items[0]?.risk, "high");
    assert.ok(!p1.items.some((i) => i.journey === "journey-made-up"));
    assert.ok(p1.items.some((i) => i.why.includes("not ranked by the model")));
    assert.deepEqual(p1.extraChecks, ["Check an order with a long customer name."]);

    const p2 = await planTests(t.cfg, null, { repo: "spil-aura", base }, { complete: reply('{"ranked": [{"journey": 5}]}') });
    assert.equal(p2.usedModel, false);
    assert.match(p2.modelNote, /rule-based ranking used/);
    assert.ok(p2.items.length > 0);

    const p3 = await planTests(t.cfg, null, { repo: "spil-aura", base }, { complete: async () => { throw new Error("offline"); } });
    assert.match(p3.modelNote, /offline/);
    assert.equal(applyModelRanking([], { ranked: [], extra_checks: [] }).length, 0);
  } finally { t.cleanup(); }
});

test("uiArea groups a changed file into a screen area", () => {
  assert.equal(uiArea("apps/aura-ui/src/areas/tools/ServersPage.tsx"), "areas/tools");
  assert.equal(uiArea("apps/aura-ui/src/orders/OrdersScreen.tsx"), "orders");
  assert.equal(uiArea("apps/aura-ui/src/copy.ts"), "copy");
});

const UNSAFE = "```ts\nimport { journey } from \"../helpers/aura.ts\";\njourney(\"j\", async ({ page, step }) => {\n  await step(\"s\", async () => {\n    await page.getByRole(\"button\", { name: \"Save\" }).click();\n  });\n});\n```";
const SAFE = "```ts\nimport { journey } from \"../helpers/aura.ts\";\njourney(\"journey-orders-list\", async ({ page, step, visible }) => {\n  await step(\"Open Orders\", async () => {\n    await page.getByRole(\"link\", { name: \"Orders\" }).click();\n    await visible(page.getByText(\"Needs you\"), \"the tile\");\n  });\n});\n```";

test("generate writes a REJECTED header when the model keeps writing an unsafe spec, and retries once with the reasons", async () => {
  const t = tmpGuard();
  try {
    const prompts: string[] = [];
    const r = await generateSpec(t.cfg, "orders-list", { complete: async (req) => { prompts.push(req.user); return { text: UNSAFE, usage: { input_tokens: 1, output_tokens: 1 } }; } });
    assert.equal(r.rejected, true);
    assert.equal(r.attempts, 2);
    assert.ok(prompts[1]!.includes("rejected by the safety check") && prompts[1]!.includes("forbidden-action"));
    const text = readFileSync(r.file, "utf8");
    assert.ok(text.startsWith(REJECTED_MARK));
    assert.ok(r.file.endsWith(join("qa", "generated", "journey-orders-list.spec.ts")));
    assert.ok(r.file.startsWith(t.root)); // never inside the Aura repo
  } finally { t.cleanup(); }
});

test("generate: unsafe first, safe second is accepted as proposed", async () => {
  const t = tmpGuard();
  try {
    let n = 0;
    const r = await generateSpec(t.cfg, "journey-orders-list", { complete: async () => ({ text: n++ === 0 ? UNSAFE : SAFE, usage: { input_tokens: 1, output_tokens: 1 } }) });
    assert.equal(r.rejected, false);
    assert.equal(r.attempts, 2);
    const text = readFileSync(r.file, "utf8");
    assert.ok(text.startsWith("// status: proposed"));
    await assert.rejects(() => generateSpec(t.cfg, "no-such", { complete: reply(SAFE) }), /No journey/);
  } finally { t.cleanup(); }
});

async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}

function writeSpec(root: string, name: string, body: string): string {
  const dir = join(root, "qa", "generated");
  mkdirSync(join(root, "qa", "helpers"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  const harness = pathToFileURL(join(GUARD_ROOT, "engine", "src", "qa", "harness.ts")).href;
  writeFileSync(join(root, "qa", "helpers", "aura.ts"), `export * from "${harness}";\n`);
  const f = join(dir, `${name}.spec.ts`);
  writeFileSync(f, body);
  return f;
}

test("runner reports a plain blocker when Aura's debugging port is closed or not set, and never runs anything", async () => {
  const t = tmpGuard();
  try {
    const spec = writeSpec(t.root, "journey-orders-list", SAFE.replace(/```(ts)?\n?/g, ""));
    const port = await closedPort();
    const r = await runSpec(t.cfg, spec, { cdpUrl: `http://127.0.0.1:${port}` });
    assert.equal(r.status, "blocked");
    assert.match(r.blocker ?? "", /Nothing answered/);
    const how = (r.howTo ?? []).join("\n");
    assert.match(how, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/);
    assert.match(how, /AURA_CDP_URL/);
    assert.match(how, new RegExp(`--remote-debugging-port=${port}`));

    const saved = process.env.AURA_CDP_URL;
    delete process.env.AURA_CDP_URL;
    try {
      const r2 = await runSpec(t.cfg, spec, {});
      assert.equal(r2.status, "blocked");
      assert.match(r2.blocker ?? "", /AURA_CDP_URL is not set/);
    } finally { if (saved !== undefined) process.env.AURA_CDP_URL = saved; }

    const r3 = await runSpec(t.cfg, spec, { cdpUrl: "http://10.0.0.5:9222" });
    assert.match(r3.blocker ?? "", /must point at this computer/);
  } finally { t.cleanup(); }
});

test("runner never runs a rejected or unsafe spec, even when Aura is reachable", async () => {
  const t = tmpGuard();
  try {
    let attached = 0;
    const deps = { probe: async () => "fake", attach: async () => { attached++; throw new Error("must not attach"); } };
    const rej = writeSpec(t.root, "journey-a", `${REJECTED_MARK}. This spec is NEVER run.\n` + UNSAFE.replace(/```(ts)?\n?/g, ""));
    const r1 = await runSpec(t.cfg, rej, { cdpUrl: "http://127.0.0.1:9" }, deps);
    assert.equal(r1.status, "rejected");
    const unsafe = writeSpec(t.root, "journey-b", UNSAFE.replace(/```(ts)?\n?/g, ""));
    const r2 = await runSpec(t.cfg, unsafe, { cdpUrl: "http://127.0.0.1:9" }, deps);
    assert.equal(r2.status, "rejected");
    assert.ok(r2.safety?.some((f) => f.rule === "forbidden-action"));
    assert.equal(attached, 0);
  } finally { t.cleanup(); }
});

function fakeAttached(failText?: string) {
  const shots: string[] = [];
  const loc = (label: string): Record<string, unknown> => ({
    click: async () => {},
    evaluate: async () => ({ tag: "a", text: label, control: true }),
    first() { return this; },
    waitFor: async () => { if (failText && label === failText) throw new Error("timeout"); },
    toString: () => `locator('${label}')`,
  });
  const page = {
    getByRole: (_r: string, o?: { name?: string }) => loc(o?.name ?? "x"),
    getByText: (t: string) => loc(t),
    url: () => "http://tauri.localhost/",
    evaluate: async () => 760,
    setViewportSize: async () => {},
    screenshot: async (o: { path: string }) => { shots.push(o.path); mkdirSync(join(o.path, ".."), { recursive: true }); writeFileSync(o.path, "png"); },
    context: () => ({ newCDPSession: async () => ({ send: async () => {} }) }),
  };
  return { shots, attached: { browser: {} as never, page: page as never, detach: async () => {} } };
}

test("runner: a passing run writes screenshots per step and a report; a failing step becomes a defect and an incident note", async () => {
  const t = tmpGuard();
  try {
    const okSpec = writeSpec(t.root, "journey-orders-list", SAFE.replace(/```(ts)?\n?/g, ""));
    const f1 = fakeAttached();
    const r1 = await runSpec(t.cfg, okSpec, { cdpUrl: "http://127.0.0.1:9", widths: [800, 1100] }, { probe: async () => "fake", attach: async () => f1.attached });
    assert.equal(r1.status, "passed");
    assert.equal(r1.widths.length, 2);
    assert.equal(f1.shots.length, 2);
    assert.ok(existsSync(r1.reportPath!) && existsSync(r1.jsonPath!));
    assert.match(readFileSync(r1.reportPath!, "utf8"), /PASS Open Orders/);
    assert.match(r1.videoNote, /No video/);

    const f2 = fakeAttached("Needs you");
    const r2 = await runSpec(t.cfg, okSpec, { cdpUrl: "http://127.0.0.1:9", widths: [1100], note: true }, { probe: async () => "fake", attach: async () => f2.attached });
    assert.equal(r2.status, "failed");
    assert.equal(r2.defects.length, 1);
    assert.match(r2.defects[0]!.actual, /did not appear/);
    assert.ok(r2.defects[0]!.screenshot);
    const notes = readdirSync(join(t.root, "vault", "inbox")).filter((f) => f.startsWith("incident-qa-"));
    assert.equal(notes.length, 1);
    const { problems } = loadVault(t.cfg.vaultDir);
    assert.deepEqual(problems, []);
  } finally { t.cleanup(); }
});
