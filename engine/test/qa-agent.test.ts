import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { GUARD_ROOT } from "../src/config.ts";
import { ApiError, BlockedError } from "../src/brain/client.ts";
import type { CompleteFn } from "../src/brain/client.ts";
import { NoBackendError } from "../src/brain/select.ts";
import { runQaAgent } from "../src/qa/agent.ts";
import type { QaResult, QaStep } from "../src/qa/agent.ts";
import { MAX_CASES, deterministicPlan } from "../src/qa/cases.ts";
import { PROJECT_NAME } from "../src/brand.ts";
import { buildContext } from "../src/qa/context.ts";
import { designPlan } from "../src/qa/design.ts";
import { findRunnable, runConfirmed } from "../src/qa/run.ts";
import { LATEST_FALLBACK_COMMITS, resolveTarget } from "../src/qa/target.ts";
import type { Target } from "../src/qa/target.ts";
import type { GuardConfig } from "../src/types.ts";
import { fakeSecret } from "./chat-helpers.ts";
import { fixture, git } from "./review-helpers.ts";
import type { Fixture } from "./review-helpers.ts";

const usage = { input_tokens: 1, output_tokens: 1 };
const reply = (text: string): CompleteFn => async () => ({ text, usage });

/** A repo with a base commit and two later commits: UI + API, then docs only. */
function repoWithHistory(): Fixture {
  const f = fixture();
  f.commit({ "src/orders/OrdersScreen.tsx": "a\n", "src/api/orders.ts": "a\n", "docs/guide.md": "a\n", "package.json": "{}\n" }, "base");
  f.commit({ "src/orders/OrdersScreen.tsx": "a\nb\nc\n", "src/api/orders.ts": "a\nb\n" }, "Change the orders screen and endpoint");
  f.commit({ "docs/guide.md": "a\nb\n" }, "Update the guide");
  return f;
}

/** The whole tree of a folder as "relative path -> mtime+size", `.git` excluded and `skip` excluded. */
function snapshot(dir: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.name === ".git" || skip.includes(p)) continue;
      if (e.isDirectory()) walk(p);
      else { const s = statSync(p); out[relative(dir, p)] = `${s.mtimeMs}:${s.size}`; }
    }
  };
  walk(dir);
  return out;
}

function validReply(cites: string[]): string {
  return JSON.stringify({
    summary: "The orders screen and endpoint changed.", riskLevel: "medium", riskReasons: ["Two user-facing files changed"],
    areas: [{ name: "orders", why: "screen changed", risk: "medium" }],
    cases: [
      { id: "x1", title: "Open the orders screen", type: "functional", priority: "P0", cites, preconditions: ["test data"], steps: ["Open the screen"], expected: ["Orders show"], automatable: true },
      { id: "x1", title: "Empty orders list", type: "edge", priority: "P1", cites, preconditions: [], steps: ["Open with no orders"], expected: ["A plain empty message"], automatable: false, journeyId: "journey-not-mine" },
    ],
    regressionChecklist: ["The order list still loads"], notCovered: ["Performance"], questions: ["a", "b", "c", "d"],
    evidence: { uiChange: false, needed: ["Extra: keep the order id"] },
  });
}

// ---------- target resolution ----------

test("target: default is the latest change, with the assumption stated; HEAD~N without origin/development", () => {
  const f = repoWithHistory();
  try {
    const r = resolveTarget(f.cfg, { message: "Can you QA it", history: [] });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.target.kind, "latest");
    assert.match(r.target.assumption ?? "", /I assumed the latest change in demo/);
    assert.match(r.target.assumption ?? "", /Update the guide/);
    assert.match(r.target.correction ?? "", /QA PR 123/);
    assert.equal(r.target.repos[0]?.rangeLabel, `HEAD~${LATEST_FALLBACK_COMMITS}..HEAD`);
    // Same for an explicit "latest change": the chat is not searched.
    const r2 = resolveTarget(f.cfg, { message: "QA the latest change in this project", history: [{ role: "user", text: "QA PR 5" }] });
    assert.ok(r2.ok && r2.target.kind === "latest");
  } finally { f.cleanup(); }
});

test("target: with origin/development the base is the merge-base", () => {
  const f = repoWithHistory();
  try {
    const first = git(f.repo, ["rev-list", "--max-parents=0", "HEAD"]).trim();
    git(f.repo, ["update-ref", "refs/remotes/origin/development", first]);
    const r = resolveTarget(f.cfg, { message: "QA it", history: [] });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.target.repos[0]?.rangeLabel, "origin/development..HEAD");
    assert.equal(r.target.repos[0]?.baseSha, first);
    assert.equal(r.target.repos[0]?.commits.length, 2);
  } finally { f.cleanup(); }
});

test("target: PR number from stored data, branch, commit range, last N commits, file paths", () => {
  const f = repoWithHistory();
  try {
    const c2 = git(f.repo, ["rev-parse", "HEAD~1"]).trim();
    const c1 = git(f.repo, ["rev-parse", "HEAD~2"]).trim();
    git(f.repo, ["branch", "feature/orders", c2]);
    mkdirSync(join(f.cfg.dataDir, "prs", "demo"), { recursive: true });
    writeFileSync(join(f.cfg.dataDir, "prs", "demo", "42.json"), JSON.stringify({
      id: 42, title: "Orders rework", status: "completed", source: "feature/orders", target: "main", mergeCommit: c2,
      files: ["src/orders/OrdersScreen.tsx"], filesTruncated: false, threads: [],
    }));
    const pr = resolveTarget(f.cfg, { message: "QA PR 42", history: [] });
    assert.ok(pr.ok && pr.target.kind === "pr");
    if (pr.ok) {
      assert.equal(pr.target.pr?.title, "Orders rework");
      assert.equal(pr.target.assumption, null);
      assert.equal(pr.target.repos[0]?.headSha, c2);
    }
    const pr2 = resolveTarget(f.cfg, { message: "test #42 please", history: [] });
    assert.ok(pr2.ok && pr2.target.kind === "pr");

    const unknown = resolveTarget(f.cfg, { message: "QA PR 999", history: [] });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.question, /PR|pull request 999/i);

    const br = resolveTarget(f.cfg, { message: "QA branch feature/orders", history: [] });
    assert.ok(br.ok && br.target.kind === "branch");
    const br2 = resolveTarget(f.cfg, { message: "test feature/orders", history: [] });
    assert.ok(br2.ok && br2.target.kind === "branch");

    const range = resolveTarget(f.cfg, { message: `QA ${c1.slice(0, 8)}..${c2.slice(0, 8)}`, history: [] });
    assert.ok(range.ok && range.target.kind === "range");
    if (range.ok) assert.equal(range.target.repos[0]?.commits.length, 1);

    const last = resolveTarget(f.cfg, { message: "QA the last 2 commits", history: [] });
    assert.ok(last.ok && last.target.kind === "commits");
    if (last.ok) assert.equal(last.target.repos[0]?.commits.length, 2);

    const paths = resolveTarget(f.cfg, { message: "test src/orders/OrdersScreen.tsx and src/api/orders.ts", history: [] });
    assert.ok(paths.ok && paths.target.kind === "paths");
    if (paths.ok) assert.deepEqual(paths.target.repos[0]?.files, ["src/orders/OrdersScreen.tsx", "src/api/orders.ts"]);
  } finally { f.cleanup(); }
});

test("target: a feature description (pasted text too) is the requirement; 'it' is read from the chat", () => {
  const f = repoWithHistory();
  try {
    const t = resolveTarget(f.cfg, { message: "what should I test for the checkout feature", history: [] });
    assert.ok(t.ok && t.target.kind === "feature");
    if (t.ok) {
      assert.match(t.target.description ?? "", /checkout/);
      assert.match(t.target.assumption ?? "", /description/);
    }
    const pasted = "Requirement: the order total must round to two places.\nThe discount applies before tax.\nA refund keeps the original rounding.";
    const p = resolveTarget(f.cfg, { message: `QA this:\n${pasted}`, history: [] });
    assert.ok(p.ok && p.target.kind === "feature");
    if (p.ok) assert.match(p.target.description ?? "", /discount applies before tax/);

    const hist = [
      { role: "user" as const, text: "QA feature/orders" }, { role: "assistant" as const, text: "ok" },
    ];
    git(f.repo, ["branch", "feature/orders", "HEAD~1"]);
    const it = resolveTarget(f.cfg, { message: "Can you QA it", history: hist });
    assert.ok(it.ok && it.target.kind === "branch" && it.target.fromConversation);
    if (it.ok) assert.match(it.target.assumption ?? "", /from earlier in this chat/);

    const hist2 = [{ role: "user" as const, text: "what should I test for the checkout feature" }, { role: "assistant" as const, text: "..." }];
    const it2 = resolveTarget(f.cfg, { message: "ok QA it now", history: hist2 });
    assert.ok(it2.ok && it2.target.kind === "feature" && it2.target.fromConversation);
  } finally { f.cleanup(); }
});

test("target: nothing resolvable -> needsInput with 2-4 chips; no sources -> asks; free text still works without sources", () => {
  const f = repoWithHistory();
  try {
    const none: GuardConfig = { ...f.cfg, repos: [] };
    const r = resolveTarget(none, { message: "Can you QA it", history: [] });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.options.length >= 2 && r.options.length <= 4);
      assert.ok(r.options.every((o) => o.id && o.label && o.value));
      assert.match(r.question, /no code repository/);
    }
    const withRepo = { ...f.cfg };
    const empty = resolveTarget({ ...withRepo, repos: [{ id: "gone", path: join(f.root, "does not exist") }] }, { message: "QA it", history: [] });
    assert.equal(empty.ok, false);
    if (!empty.ok) {
      assert.equal(empty.options.length, 4);
      assert.equal(empty.options[0]?.label, "Latest change in gone");
    }
    const feature = resolveTarget(none, { message: "QA the refund flow", history: [] });
    assert.ok(feature.ok && feature.target.kind === "feature");
  } finally { f.cleanup(); }
});

// ---------- the deterministic plan ----------

function plan(f: Fixture, message: string) {
  const r = resolveTarget(f.cfg, { message, history: [] });
  assert.ok(r.ok);
  const target = (r as { ok: true; target: Target }).target;
  const ctx = buildContext(f.cfg, null, target);
  return { target, ctx, plan: deterministicPlan(f.cfg, ctx, target) };
}

test("offline plan: a UI + API change gets screen and service cases and the fixed evidence rules", () => {
  const f = repoWithHistory();
  try {
    const { plan: p, ctx } = plan(f, "QA the last 2 commits");
    assert.equal(ctx.hasDiff, true);
    assert.ok(p.cases.length > 0 && p.cases.length <= MAX_CASES);
    assert.ok(p.cases.every((c) => /^TC-\d{3}$/.test(c.id) && c.cites.length > 0));
    assert.ok(p.cases.some((c) => /changed screen works end to end/.test(c.title)));
    assert.ok(p.cases.some((c) => c.type === "negative" && /refused clearly/.test(c.title)));
    assert.equal(p.evidence.uiChange, true);
    assert.ok(p.evidence.needed.some((e) => /800, 1100 and 1440/.test(e)));
    assert.ok(p.evidence.needed.some((e) => /walkthrough video/.test(e)));
    assert.ok(p.evidence.needed.some((e) => /request, result and readback/.test(e)));
    assert.ok(p.evidence.needed.some((e) => /test database only/i.test(e)));
    assert.ok(p.areas.length >= 2 && p.regressionChecklist.length >= 3);
    assert.ok(["medium", "high"].includes(p.riskLevel));
    // Cases are ordered P0 first.
    const rank = { P0: 0, P1: 1, P2: 2 } as const;
    for (let i = 1; i < p.cases.length; i++) assert.ok(rank[p.cases[i - 1]!.priority] <= rank[p.cases[i]!.priority]);
  } finally { f.cleanup(); }
});

test("offline plan: docs-only is low risk and asks for no screenshots", () => {
  const f = repoWithHistory();
  try {
    const { plan: p } = plan(f, "QA the latest change");
    assert.equal(p.riskLevel, "low");
    assert.equal(p.evidence.uiChange, false);
    assert.ok(!p.evidence.needed.some((e) => /800, 1100/.test(e)));
    assert.ok(p.evidence.needed.some((e) => /no app path changed/.test(e)));
    assert.ok(p.cases.every((c) => c.cites.some((x) => x.includes("guide.md"))));
  } finally { f.cleanup(); }
});

test("offline plan: each change category produces its own cases (data, config, dependencies, parser, ui)", () => {
  const f = fixture();
  try {
    f.commit({ "README.md": "a\n" }, "base");
    f.commit({
      "db/migrations/001.sql": "create table t(a int);\n", "config/app.json": "{}\n", "package.json": "{}\n",
      "src/parser/read.py": "x = 1\n", "src/components/Panel.tsx": "export const a = 1;\n",
    }, "mixed change");
    const { plan: p } = plan(f, "QA the latest change");
    const titles = p.cases.map((c) => c.title).join("\n");
    assert.match(titles, /existing data survives/);
    assert.match(titles, /reads the changed setting/);
    assert.match(titles, /still installs and starts/);
    assert.match(titles, /known inputs still give the known outputs/);
    assert.match(titles, /changed screen works end to end/);
    assert.equal(p.riskLevel, "high");
  } finally { f.cleanup(); }
});

test("offline plan: a requirement with no changed files plans from the description and says so", () => {
  const f = fixture();
  try {
    const none: GuardConfig = { ...f.cfg, repos: [] };
    const r = resolveTarget(none, { message: "what should I test for the refund flow", history: [] });
    assert.ok(r.ok);
    const target = (r as { ok: true; target: Target }).target;
    const ctx = buildContext(none, null, target);
    const p = deterministicPlan(none, ctx, target);
    assert.ok(p.cases.length >= 3 && p.cases.every((c) => c.cites.includes("requirement")));
    assert.ok(p.notCovered.some((n) => /No diff text/.test(n)));
    assert.ok(p.questions.length <= 3 && p.questions.length >= 1);
  } finally { f.cleanup(); }
});

// ---------- the model step ----------

async function ctxFor(f: Fixture, message = "QA the last 2 commits") {
  const r = resolveTarget(f.cfg, { message, history: [] });
  assert.ok(r.ok);
  const target = (r as { ok: true; target: Target }).target;
  return { target, ctx: buildContext(f.cfg, null, target) };
}

test("model design: valid JSON is accepted, ids renumbered, evidence rules fixed, questions capped, foreign journey ids dropped", async () => {
  const f = repoWithHistory();
  try {
    const { target, ctx } = await ctxFor(f);
    let calls = 0;
    let seen: { system: string[]; user: string } | null = null;
    const complete: CompleteFn = async (req) => { calls++; seen = { system: req.system, user: req.user }; return { text: "Here you go:\n" + validReply(["src/orders/OrdersScreen.tsx"]), usage }; };
    const d = await designPlan(f.cfg, ctx, target, "QA the last 2 commits", { complete });
    assert.equal(calls, 1);
    assert.equal(d.modelUsed, true);
    assert.deepEqual(d.plan.cases.map((c) => c.id), ["TC-001", "TC-002"]);
    assert.equal(d.plan.cases[1]?.journeyId, undefined);
    assert.equal(d.notes.length, 1);
    assert.equal(d.plan.questions.length, 3);
    assert.equal(d.plan.evidence.uiChange, true, "the model said false; fixed rules say true");
    assert.ok(d.plan.evidence.needed.some((e) => /800, 1100 and 1440/.test(e)));
    assert.ok(d.plan.evidence.needed.includes("Extra: keep the order id"));
    const s = seen as unknown as { system: string[]; user: string };
    assert.equal(s.system.length, 1);
    assert.match(s.system[0] ?? "", /QA agent of SPIL AURA QA Bot/);
    assert.match(s.user, /src\/orders\/OrdersScreen\.tsx/);
  } finally { f.cleanup(); }
});

test("model design: invalid JSON -> one retry with the errors -> success; twice invalid -> offline plan, said plainly", async () => {
  const f = repoWithHistory();
  try {
    const { target, ctx } = await ctxFor(f);
    const users: string[] = [];
    const flaky: CompleteFn = async (req) => {
      users.push(req.user);
      return { text: users.length === 1 ? "not json at all" : validReply(["OrdersScreen.tsx"]), usage };
    };
    const d = await designPlan(f.cfg, ctx, target, "q", { complete: flaky });
    assert.equal(users.length, 2);
    assert.match(users[1] ?? "", /previous reply was not valid/);
    assert.equal(d.modelUsed, true);
    assert.equal(d.attempts, 2);

    let n = 0;
    const bad: CompleteFn = async () => { n++; return { text: JSON.stringify({ summary: "x" }), usage }; };
    const d2 = await designPlan(f.cfg, ctx, target, "q", { complete: bad });
    assert.equal(n, 2);
    assert.equal(d2.modelUsed, false);
    assert.match(d2.modelNote, /failed validation 2 times/);
    assert.match(d2.modelNote, /offline plan/);
    assert.ok(d2.plan.cases.length > 0);
  } finally { f.cleanup(); }
});

test("model design: a case that cites nothing real is rejected (retry sees the reason)", async () => {
  const f = repoWithHistory();
  try {
    const { target, ctx } = await ctxFor(f);
    const users: string[] = [];
    const c: CompleteFn = async (req) => { users.push(req.user); return { text: validReply(["src/made/up.ts"]), usage }; };
    const d = await designPlan(f.cfg, ctx, target, "q", { complete: c });
    assert.equal(d.modelUsed, false);
    assert.match(users[1] ?? "", /cites must name a changed file or area/);
  } finally { f.cleanup(); }
});

test("model design: unavailable, blocked or API-failing models fall back after one call; noModel makes no call", async () => {
  const f = repoWithHistory();
  try {
    const { target, ctx } = await ctxFor(f);
    for (const err of [new NoBackendError("none"), new BlockedError([{ kind: "TOKEN", count: 1 }]), new ApiError(500, "boom")]) {
      let n = 0;
      const d = await designPlan(f.cfg, ctx, target, "q", { complete: async () => { n++; throw err; } });
      assert.equal(n, 1);
      assert.equal(d.modelUsed, false);
      assert.match(d.modelNote, /offline plan/);
    }
    let called = 0;
    const off = await designPlan(f.cfg, ctx, target, "q", { complete: async () => { called++; return { text: "", usage }; }, noModel: true });
    assert.equal(called, 0);
    assert.match(off.modelNote, /model was not used/i);
  } finally { f.cleanup(); }
});

// ---------- the agent: steps, artifacts, read-only, secrets ----------

test("agent: steps run in order with real timings; result has the full structure; artifacts only in the data dir", async () => {
  const f = repoWithHistory();
  try {
    const before = snapshot(f.repo);
    const rootBefore = snapshot(f.root, [f.cfg.dataDir]);
    const status0 = git(f.repo, ["status", "--short"]);
    const steps: QaStep[] = [];
    const out = await runQaAgent(
      { cfg: f.cfg, db: null, complete: reply(validReply(["docs/guide.md"])), backend: "Fake plan", onStep: (s) => steps.push(s) },
      { message: "Can you QA the latest change", history: [] },
    );
    assert.equal(out.kind, "result");
    if (out.kind !== "result") return;
    const ids = steps.map((s) => s.id);
    assert.deepEqual([...new Set(ids)], ["understand", "target", "context", "design", "report"]);
    assert.ok(steps.every((s) => s.agent === "qa" && s.kind === s.id));
    assert.ok(steps.filter((s) => s.status === "done").every((s) => typeof s.ms === "number"));
    assert.equal(steps.find((s) => s.id === "design" && s.status === "running")?.label, "Asking Fake plan to design the tests");
    assert.match(steps.find((s) => s.id === "design" && s.status === "done")?.label ?? "", /Fake plan designed \d+ cases in \d+\.\d s/);
    const r = out.result;
    assert.equal(r.version, 1);
    assert.equal(r.modelUsed, true);
    assert.equal(r.backend, "Fake plan");
    assert.match(r.assumption ?? "", /I assumed the latest change in demo/);
    for (const k of ["summary", "target", "risk", "areas", "cases", "regressionChecklist", "notCovered", "questions", "evidence", "artifacts", "checkCommands", "journeys", "context"]) assert.ok(k in r, k);
    const dir = join(f.cfg.dataDir, "qa", "runs");
    assert.equal(r.artifacts.markdownPath, join(dir, `${r.id}.md`));
    assert.ok(existsSync(r.artifacts.jsonPath!));
    const onDisk = JSON.parse(readFileSync(r.artifacts.jsonPath!, "utf8")) as QaResult;
    assert.equal(onDisk.id, r.id);
    assert.match(readFileSync(r.artifacts.markdownPath!, "utf8"), /^# QA result: /);
    assert.match(out.markdown, /Assumption/);
    // Read-only: the repo is byte-for-byte as before and nothing was written outside the data dir.
    assert.deepEqual(snapshot(f.repo), before);
    assert.equal(git(f.repo, ["status", "--short"]), status0);
    assert.deepEqual(snapshot(f.root, [f.cfg.dataDir]), rootBefore, "nothing outside the data folder changed");
    assert.deepEqual(readdirSync(dir).sort(), [`${r.id}.json`, `${r.id}.md`]);
    assert.deepEqual(readdirSync(join(f.cfg.dataDir)).sort(), ["qa"]);
    assert.deepEqual(readdirSync(join(f.cfg.dataDir, "qa")), ["runs"]);
  } finally { f.cleanup(); }
});

test("agent: --no-model says so in the result; no model call is made", async () => {
  const f = repoWithHistory();
  try {
    let n = 0;
    const out = await runQaAgent(
      { cfg: f.cfg, db: null, complete: async () => { n++; return { text: "", usage }; }, writeArtifacts: false },
      { message: "QA the latest change", history: [], noModel: true },
    );
    assert.equal(n, 0);
    assert.ok(out.kind === "result");
    if (out.kind === "result") {
      assert.equal(out.result.modelUsed, false);
      assert.equal(out.result.backend, null);
      assert.match(out.result.modelNote, /model was not used/i);
      assert.match(out.markdown, /model was not used/i);
      assert.equal(out.result.artifacts.markdownPath, null);
    }
    assert.equal(existsSync(join(f.cfg.dataDir, "qa")), false, "writeArtifacts:false writes nothing");
  } finally { f.cleanup(); }
});

test("agent: a secret in the message stops everything: nothing read, nothing sent, nothing written", async () => {
  const f = repoWithHistory();
  try {
    let n = 0;
    const steps: QaStep[] = [];
    const out = await runQaAgent(
      { cfg: f.cfg, db: null, complete: async () => { n++; return { text: "", usage }; }, onStep: (s) => steps.push(s) },
      { message: `QA the latest change, my token is ${fakeSecret()}`, history: [] },
    );
    assert.equal(out.kind, "blocked");
    if (out.kind === "blocked") assert.match(out.text, /looks like it contains a secret.*Nothing was sent/);
    assert.equal(n, 0);
    assert.equal(steps.length, 0);
    assert.equal(existsSync(join(f.cfg.dataDir, "qa")), false);
  } finally { f.cleanup(); }
});

test("agent: secrets in a diff never reach the model, the artifacts or the events", async () => {
  const f = fixture();
  try {
    f.commit({ "src/a.ts": "export const a = 1;\n" }, "base");
    f.commit({ "src/a.ts": `export const a = 1;\nexport const k = "${fakeSecret()}";\n`, "src/b.ts": "export const b = 2;\n" }, "Add b and a key");
    const sent: string[] = [];
    const steps: QaStep[] = [];
    const out = await runQaAgent(
      { cfg: f.cfg, db: null, complete: async (req) => { sent.push(req.system.join("\n") + req.user); return { text: validReply(["src/b.ts"]), usage }; }, onStep: (s) => steps.push(s) },
      { message: "QA the latest change", history: [] },
    );
    assert.equal(out.kind, "result");
    assert.equal(sent.length, 1);
    assert.ok(!sent[0]!.includes(fakeSecret()), "the secret was not in the prompt");
    if (out.kind !== "result") return;
    const everything = [JSON.stringify(out.result), out.markdown, JSON.stringify(steps), readFileSync(out.result.artifacts.jsonPath!, "utf8"), readFileSync(out.result.artifacts.markdownPath!, "utf8")].join("\n");
    assert.ok(!everything.includes(fakeSecret()));
  } finally { f.cleanup(); }
});

test("agent: needs-input asks a plain question with chips, runs nothing and writes nothing", async () => {
  const f = repoWithHistory();
  try {
    let n = 0;
    const steps: QaStep[] = [];
    const none: GuardConfig = { ...f.cfg, repos: [] };
    const out = await runQaAgent({ cfg: none, db: null, complete: async () => { n++; return { text: "", usage }; }, onStep: (s) => steps.push(s) }, { message: "Can you QA it", history: [] });
    assert.equal(out.kind, "needs-input");
    if (out.kind === "needs-input") {
      assert.match(out.text, /^QA needs one answer before I start/);
      assert.ok(out.options.length >= 2 && out.options.length <= 4);
    }
    assert.equal(n, 0);
    assert.deepEqual(steps.map((s) => s.id), ["understand", "target", "target"]);
    assert.equal(existsSync(join(f.cfg.dataDir, "qa")), false);
  } finally { f.cleanup(); }
});

// ---------- one project ----------

test("one project: the result names the project, artifacts go to data/qa/runs, rules come from the vault", async () => {
  const a = repoWithHistory();
  try {
    mkdirSync(join(a.cfg.vaultDir, "rules"), { recursive: true });
    writeFileSync(join(a.cfg.vaultDir, "rules", "rule-handshake.md"), `---
id: rule-handshake
type: rule
status: active
audience: [internal_dev]
department: dev
source: owner-answer
created: 2026-01-01
title: "Handshake rule"
---

# Handshake rule

Orders screen handshake. Run \`npm test\` before release (a check).
`);
    const r = await runQaAgent({ cfg: a.cfg, db: null }, { message: "QA the latest change", history: [], noModel: true });
    assert.ok(r.kind === "result");
    if (r.kind !== "result") return;
    assert.equal(r.result.department.name, PROJECT_NAME);
    assert.deepEqual(r.result.checkCommands.map((c) => c.command), ["npm test"]);
    assert.ok(r.result.artifacts.markdownPath!.startsWith(join(a.cfg.dataDir, "qa", "runs")));
    assert.ok(!r.result.artifacts.markdownPath!.includes("departments"));
    assert.match(r.markdown, /^Project: SPIL AURA/m);
  } finally { a.cleanup(); }
});

// ---------- journeys: offered, never run without confirmation ----------

function guardWithJourneys(f: Fixture): GuardConfig {
  cpSync(join(GUARD_ROOT, "qa"), join(f.root, "qa"), { recursive: true });
  // The generated specs in qa/generated/ are local and git-ignored, so a clean clone has none: the test
  // writes its own small safe spec instead of depending on whatever the developer generated.
  mkdirSync(join(f.root, "qa", "generated"), { recursive: true });
  writeFileSync(
    join(f.root, "qa", "generated", "journey-orders-list.spec.ts"),
    'import { journey } from "../helpers/aura.ts";\n' +
      'journey("journey-orders-list", async ({ page, step, visible }) => {\n' +
      '  await step("Open Orders", async () => {\n' +
      '    await page.getByRole("link", { name: "Orders" }).click();\n' +
      '    await visible(page.getByText("Needs you"), "the tile");\n' +
      "  });\n" +
      "});\n",
  );
  cpSync(join(GUARD_ROOT, "engine", "test", "fixtures", "journeys"), join(f.cfg.vaultDir, "journeys"), { recursive: true });
  mkdirSync(join(f.cfg.vaultDir, "inbox"), { recursive: true });
  // The spec imports the harness through qa/helpers/aura.ts; point that at the real harness so the registry is shared with the runner.
  writeFileSync(join(f.root, "qa", "helpers", "aura.ts"), `export * from "${pathToFileURL(join(GUARD_ROOT, "engine", "src", "qa", "harness.ts")).href}";
`);
  return { ...f.cfg, repos: [{ id: "spil-aura", path: f.repo }] };
}

test("journeys: offered only with a checked spec and a reachable app, and never started without confirmation", async () => {
  const f = fixture();
  const prevCdp = process.env["AURA_CDP_URL"];
  try {
    f.commit({ "apps/aura-ui/src/orders/OrdersScreen.tsx": "a\n" }, "base");
    f.commit({ "apps/aura-ui/src/orders/OrdersScreen.tsx": "a\nb\n" }, "Change orders");
    const cfg = guardWithJourneys(f);
    process.env["AURA_CDP_URL"] = "http://127.0.0.1:9";
    let probes = 0;
    let attaches = 0;
    const runDeps = { attach: async () => { attaches++; throw new Error("no app"); }, probe: async () => { probes++; return "fake"; } };
    const out = await runQaAgent({ cfg, db: null, probe: async () => "fake browser", runDeps, writeArtifacts: false }, { message: "QA the latest change", history: [], noModel: true });
    assert.ok(out.kind === "result");
    if (out.kind !== "result") return;
    const offer = out.result.journeys.offer;
    assert.ok(out.result.cases.some((c) => c.journeyId === "journey-orders-list"));
    assert.equal(offer.targetReachable, true);
    assert.deepEqual(offer.runnable.map((r) => r.journeyId), ["journey-orders-list"]);
    assert.ok(offer.blocked.some((b) => /no generated spec/.test(b.reason)));
    assert.match(offer.note, /run the journeys/);
    assert.equal(out.result.run, null);
    assert.equal(attaches, 0, "nothing attached to the app");
    assert.equal(probes, 0);

    // Not reachable: no offer to run.
    const down = await findRunnable(cfg, out.result, { probe: async () => { throw new Error("refused"); } });
    assert.equal(down.targetReachable, false);
    delete process.env["AURA_CDP_URL"];
    const unset = await findRunnable(cfg, out.result);
    assert.equal(unset.targetReachable, false);
    assert.match(unset.note, /AURA_CDP_URL is not set/);

    // Running needs the literal confirmation.
    await assert.rejects(() => runConfirmed(cfg, offer.runnable, {} as never, runDeps), /explicit confirmation/);
    assert.equal(attaches, 0);
  } finally {
    if (prevCdp === undefined) delete process.env["AURA_CDP_URL"]; else process.env["AURA_CDP_URL"] = prevCdp;
    f.cleanup();
  }
});

test("journeys: a confirmed run attaches once; an offer that is gone never attaches", async () => {
  const f = fixture();
  const prevCdp = process.env["AURA_CDP_URL"];
  try {
    f.commit({ "apps/aura-ui/src/orders/OrdersScreen.tsx": "a\n" }, "base");
    f.commit({ "apps/aura-ui/src/orders/OrdersScreen.tsx": "a\nb\n" }, "Change orders");
    const cfg = guardWithJourneys(f);
    process.env["AURA_CDP_URL"] = "http://127.0.0.1:9";
    const first = await runQaAgent({ cfg, db: null, probe: async () => "fake", writeArtifacts: true }, { message: "QA the latest change", history: [], noModel: true });
    assert.ok(first.kind === "result");
    if (first.kind !== "result") return;
    let attaches = 0;
    const runDeps = { probe: async () => "fake", attach: async () => { attaches++; throw new Error("window closed"); } };
    const steps: QaStep[] = [];
    const run = await runQaAgent({ cfg, db: null, probe: async () => "fake", runDeps, onStep: (s) => steps.push(s) }, { message: "run the journeys", history: [], confirmRun: true, prior: first.result });
    assert.equal(attaches, 1);
    assert.ok(run.kind === "result");
    if (run.kind === "result") {
      assert.ok(run.result.run && run.result.run.runs.length === 1);
      assert.equal(run.result.run?.status, "blocked");
      assert.ok(steps.some((s) => s.id === "run" && s.status === "done"));
      assert.match(run.markdown, /Journey run: blocked/);
    }
    // No offer on a result without one.
    const none = await runQaAgent({ cfg, db: null, runDeps }, { message: "run them", history: [], confirmRun: true, prior: { ...first.result, journeys: { ...first.result.journeys, offer: { ...first.result.journeys.offer, runnable: [] } } } });
    assert.equal(none.kind, "run-unavailable");
    assert.equal(attaches, 1);
  } finally {
    if (prevCdp === undefined) delete process.env["AURA_CDP_URL"]; else process.env["AURA_CDP_URL"] = prevCdp;
    f.cleanup();
  }
});
