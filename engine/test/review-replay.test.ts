import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { ingestRepos } from "../src/ingest/index.ts";
import { openDb } from "../src/index/db.ts";
import { findIntroducers, runReplay } from "../src/review/replay.ts";
import { reviewCommands } from "../src/cli/commands-review.ts";
import { fixture, git } from "./review-helpers.ts";

const BASE = Array.from({ length: 10 }, (_, i) => `const v${i} = ${i};`);

function history(fx: ReturnType<typeof fixture>): { portBug: string; loopBug: string } {
  fx.commit({ "calc.ts": BASE.join("\n") + "\n", "loop.ts": "export function run(n) {\n  return n;\n}\n" }, "start");
  const withPort = [...BASE.slice(0, 5), `const api = "localhost:8080"; const tok = "${"ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}";`, ...BASE.slice(5)];
  const portBug = fx.commit({ "calc.ts": withPort.join("\n") + "\n" }, "Add the api setting");
  const loopBug = fx.commit({ "loop.ts": "export function run(n) {\n  for (let i = 0; i <= n; i++) {}\n  return n;\n}\n" }, "Add a loop");
  fx.commit({ "notes.md": "hello\n" }, "Docs");
  const fixedPort = [...BASE.slice(0, 5), `const api = settings.api;`, ...BASE.slice(5)];
  fx.commit({ "calc.ts": fixedPort.join("\n") + "\n" }, "Fix leaked token in calc");
  fx.commit({ "loop.ts": "export function run(n) {\n  for (let i = 0; i < n; i++) {}\n  return n;\n}\n" }, "Fix off-by-one in loop");
  return { portBug, loopBug };
}

test("findIntroducers blames the commit that wrote the fixed line", () => {
  const fx = fixture();
  try {
    const { portBug } = history(fx);
    const fixSha = git(fx.repo, ["rev-parse", "HEAD~1"]).trim();
    const got = findIntroducers(fx.repo, fixSha);
    assert.deepEqual([...got.keys()], [portBug]);
    assert.deepEqual(got.get(portBug), [{ file: "calc.ts", line: 6 }]);
  } finally { fx.cleanup(); }
});

test("replay scores only defect-class checks: one bug found, one missed; policy findings are counted apart", async () => {
  const fx = fixture();
  try {
    history(fx);
    const db = openDb(":memory:");
    ingestRepos(db, fx.cfg);
    const r = await runReplay(fx.cfg, db, { repo: "demo", limit: 5, model: false }, {}, new Date(2026, 2, 5));
    assert.equal(r.fixesUsed, 2);
    assert.equal(r.introducers, 2);
    assert.equal(r.tier0.cases, 2);
    assert.equal(r.tier0.detected, 1);
    assert.equal(r.tier0.fileDetected, 1);
    assert.equal(r.tier0.findings, 1); // the secret; the hard-coded port is policy and is not scored
    assert.equal(r.tier0.matching, 1);
    assert.equal(r.tier0Top.matching, 1);
    assert.equal(r.policy.get("hardcoded-port"), 1);
    assert.ok(!r.perRule.has("hardcoded-port"));
    assert.equal(r.model, null);
    assert.ok(existsSync(r.reportPath));
    assert.match(r.reportPath, /replay-2026-03-05\.md$/);
    const text = readFileSync(r.reportPath, "utf8");
    assert.match(text, /Fixed checks, defect class \| 2 \| 1 \(50%\)/);
    assert.match(text, /## Rule compliance \(policy class, not scored\)/);
    assert.match(text, /\| hardcoded-port \| 1 \|/);
    assert.match(text, /\| secret-in-code \| 1 \| 1 \|/);
    db.close();
  } finally { fx.cleanup(); }
});

test("review command prints the report path and counts, and reads --base from flags", async () => {
  const fx = fixture();
  try {
    fx.commit({ "a.ts": "one\n" }, "start");
    fx.commit({ "a.ts": "one\nconsole.log(1);\n" }, "second");
    const lines: string[] = [];
    const code = await reviewCommands["review"]!({
      rest: ["demo"], flags: { base: "HEAD~1", "no-model": true }, out: (s) => lines.push(s), cfg: fx.cfg,
    });
    assert.equal(code, 0);
    const text = lines.join("\n");
    assert.match(text, /Review report: .*\.md/);
    assert.match(text, /Fixed checks: 0 blocker, 1 risk, 0 suggestion/);
    assert.match(text, /Full report with the appendix: .*\.md/);
    assert.match(text, /1 rule-compliance findings/);
    assert.match(text, /No comments/);
    assert.match(text, /Model review: not used/);
    assert.match(text, /nothing was posted/i);
    const bad = await reviewCommands["review"]!({ rest: ["nope"], flags: { "no-model": true }, out: () => {}, cfg: fx.cfg });
    assert.equal(bad, 1);
  } finally { fx.cleanup(); }
});
