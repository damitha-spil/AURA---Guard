import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GUARD_ROOT } from "../src/config.ts";
import { readDiff, parseDiff } from "../src/review/diff.ts";
import {
  checkCoChange, checkCopyText, checkErpWriteTool, checkLineRules, checkNewCss, checkNowrap,
  checkPlicoEdit, checkSecrets, loadRules, runTier0, rustTestStart,
} from "../src/review/tier0.ts";
import { reviewChange } from "../src/review/reviewer.ts";
import { checkPatches, suggestRefactor } from "../src/review/refactor.ts";
import { writeRefactorReport, writeReviewReport } from "../src/review/report.ts";
import { ingestRepos } from "../src/ingest/index.ts";
import { openDb } from "../src/index/db.ts";
import { fakeFile, fakeModel, fixture } from "./review-helpers.ts";

const rules = loadRules(GUARD_ROOT).lineRules;
const ids = (list: { rule: string }[]) => list.map((f) => f.rule);

// ---------- diff ----------

test("readDiff: statuses, line numbers, skipped files, default base HEAD~1", () => {
  const fx = fixture();
  try {
    fx.commit({ "a.ts": "one\ntwo\nthree\n", "gone.ts": "x\n", "package-lock.json": "{}\n" }, "first");
    fx.commit({
      "a.ts": "one\ntwo\nNEW\nthree\n", "gone.ts": null, "b.ts": "hello\nworld\n",
      "package-lock.json": "{ }\n", "logo.png": "binary\u0000data",
    }, "second");
    const d = readDiff(fx.repo);
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(by).sort(), ["a.ts", "b.ts", "gone.ts"]);
    assert.deepEqual(by["a.ts"]!.added, [3]);
    assert.equal(by["a.ts"]!.status, "modified");
    assert.equal(by["a.ts"]!.addedLines[0]!.text, "NEW");
    assert.equal(by["b.ts"]!.status, "added");
    assert.deepEqual(by["b.ts"]!.added, [1, 2]);
    assert.equal(by["gone.ts"]!.status, "deleted");
    assert.deepEqual(by["gone.ts"]!.removed, [1]);
    const skipped = d.skipped.map((s) => s.path).sort();
    assert.deepEqual(skipped, ["logo.png", "package-lock.json"]);
  } finally { fx.cleanup(); }
});

test("parseDiff: rename and cut patch", () => {
  const text = [
    "diff --git a/old.ts b/new.ts", "similarity index 90%", "rename from old.ts", "rename to new.ts",
    "--- a/old.ts", "+++ b/new.ts", "@@ -1,2 +1,2 @@ fn", " keep", "-x", "+y", "",
  ].join("\n");
  const { files } = parseDiff(text);
  assert.equal(files[0]!.status, "renamed");
  assert.equal(files[0]!.path, "new.ts");
  assert.equal(files[0]!.oldPath, "old.ts");
  assert.deepEqual(files[0]!.added, [2]);
  assert.deepEqual(files[0]!.removed, [2]);
});

// ---------- tier 0: each rule true and false ----------

test("secret: reports the kind, never the value", () => {
  const value = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const bad = checkSecrets(fakeFile("src/x.ts", [`const t = "${value}";`]));
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.severity, "blocker");
  assert.ok(!JSON.stringify(bad).includes(value));
  assert.equal(checkSecrets(fakeFile("src/x.ts", ["const a = 1;"])).length, 0);
});

test("hard-coded IPv4, hostname, port, windows path", () => {
  const ip = ["10", "20", "30", "40"].join(".");
  const f = fakeFile("src/net.ts", [
    `const a = "${ip}";`,
    `const b = "https://erp.fabricator.example.net/api";`.replace("example.net", "internal"),
    `const c = "localhost:5173";`,
    `const d = "C:\\\\Data\\\\orders";`,
  ]);
  const got = ids(checkLineRules(f, rules));
  for (const r of ["hardcoded-ipv4", "hardcoded-hostname", "hardcoded-port", "hardcoded-windows-path"]) assert.ok(got.includes(r), r);
  const clean = fakeFile("src/net.ts", [
    `const a = "127.0.0.1";`, `// see https://erp.internal/docs`, `const v = "1.2.3.4"; // version`,
    `const u = "https://github.com/x/y";`, `const p = settings.path;`,
  ]);
  assert.deepEqual(checkLineRules(clean, rules), []);
  assert.deepEqual(checkLineRules(fakeFile("src/net.test.ts", [`const a = "${ip}";`]), rules), []);
});

test("inline style and new css under apps/aura-ui", () => {
  const f = fakeFile("apps/aura-ui/src/A.tsx", [`<div style={{ color: "red" }} />`]);
  assert.ok(ids(checkLineRules(f, rules)).includes("inline-style"));
  assert.deepEqual(checkLineRules(fakeFile("apps/aura-ui/src/components/plico/B.tsx", [`<div style={{}} />`]), rules), []);
  assert.deepEqual(checkLineRules(fakeFile("other/A.tsx", [`<div style={{}} />`]), rules), []);
  assert.equal(checkNewCss(fakeFile("apps/aura-ui/src/new.css", ["a{}"], "added")).length, 1);
  assert.equal(checkNewCss(fakeFile("apps/aura-ui/src/new.css", ["a{}"], "modified")).length, 0);
  assert.equal(checkNewCss(fakeFile("docs/new.css", ["a{}"], "added")).length, 0);
});

test("whitespace-nowrap needs a width limit nearby", () => {
  assert.equal(checkNowrap(fakeFile("apps/aura-ui/src/A.tsx", [`<span className="whitespace-nowrap">x</span>`])).length, 1);
  assert.equal(checkNowrap(fakeFile("apps/aura-ui/src/A.tsx", [`<span className="whitespace-nowrap max-w-xs truncate">x</span>`])).length, 0);
  assert.equal(checkNowrap(fakeFile("apps/aura-ui/src/A.tsx", [`<div className="max-w-sm">`, `<span className="whitespace-nowrap">x</span>`])).length, 0);
});

test("screen text outside copy.ts is a suggestion", () => {
  const bad = checkCopyText(fakeFile("apps/aura-ui/src/A.tsx", [`<p>Save the order now</p>`, `<input placeholder="Search for an order" />`]));
  assert.equal(bad.length, 2);
  assert.ok(bad.every((f) => f.severity === "suggestion"));
  assert.equal(checkCopyText(fakeFile("apps/aura-ui/src/copy.ts", [`<p>Save the order now</p>`])).length, 0);
  assert.equal(checkCopyText(fakeFile("apps/aura-ui/src/A.tsx", [`<p>{copy.save}</p>`, `<b>OK</b>`])).length, 0);
});

test("plico files are a blocker, other files are not", () => {
  const f = checkPlicoEdit(fakeFile("apps/aura-ui/src/components/plico/button.tsx", ["x"]));
  assert.equal(f[0]!.severity, "blocker");
  assert.equal(checkPlicoEdit(fakeFile("apps/aura-ui/src/components/aura/x.tsx", ["x"])).length, 0);
});

test("ERP write tool names", () => {
  assert.equal(checkErpWriteTool(fakeFile("src/mcp/tools.ts", [`  name: "erp_create_order",`])).length, 1);
  assert.equal(checkErpWriteTool(fakeFile("src/mcp/tools.ts", [`  name: "erp_search_orders",`])).length, 0);
  assert.equal(checkErpWriteTool(fakeFile("src/mcp/tools.ts", [`  name: "update_theme_colour",`])).length, 0);
  assert.equal(checkErpWriteTool(fakeFile("src/mcp/tools.test.ts", [`  name: "erp_create_order",`])).length, 0);
});

test("console.log, dbg!, println! and unwrap", () => {
  assert.ok(ids(checkLineRules(fakeFile("src/a.ts", [`console.log("x");`]), rules)).includes("console-log-left-in"));
  assert.equal(checkLineRules(fakeFile("src/a.ts", [`// console.log("x");`]), rules).length, 0);
  assert.equal(checkLineRules(fakeFile("src/a.test.ts", [`console.log("x");`]), rules).length, 0);
  const rs = checkLineRules(fakeFile("src/lib.rs", ["dbg!(x);", `println!("hi");`, "let v = r.unwrap();"]), rules);
  assert.deepEqual(ids(rs).sort(), ["dbg-macro-left-in", "println-left-in"]); // unwrap is off by default
  const inTests = fakeFile("src/lib.rs", ["dbg!(x);"]);
  inTests.hunks[0]!.header = "mod tests {";
  assert.equal(checkLineRules(inTests, rules).length, 0);
  assert.equal(checkLineRules(fakeFile("tests/it.rs", ["dbg!(x);"]), rules).length, 0);
});

/** Rules from a temp root whose local file switches unwrap-in-rust on. */
function rulesWithUnwrap() {
  const fx = fixture();
  writeFileSync(join(fx.root, "roles", "review-rules.local.json"), JSON.stringify({ enable: ["unwrap-in-rust"] }));
  return { fx, rules: loadRules(fx.root) };
}

test("unwrap-in-rust is off by default and, when enabled, only fires on I/O, parse, lock, env, channel and thread results", () => {
  assert.ok(!loadRules(GUARD_ROOT).lineRules.some((r) => r.id === "unwrap-in-rust"));
  const { fx, rules: on } = rulesWithUnwrap();
  try {
    const hit = (line: string) => checkLineRules(fakeFile("src/lib.rs", [line]), on.lineRules).length;
    for (const l of ["let t = std::fs::read_to_string(p).unwrap();", "let g = m.lock().unwrap();", "let n = s.parse::<u32>().unwrap();",
      `let v = std::env::var("X").unwrap();`, "let m = rx.recv().unwrap();", "h.join().unwrap();"]) assert.equal(hit(l), 1, l);
    for (const l of ["let v = list.first().unwrap();", "let v = r.unwrap_or(1);", "let v = Regex::new(\"a\").unwrap();"]) assert.equal(hit(l), 0, l);
    const inTests = fakeFile("src/lib.rs", ["let g = m.lock().unwrap();"]);
    inTests.hunks[0]!.header = "mod tests {";
    assert.equal(checkLineRules(inTests, on.lineRules).length, 0);
  } finally { fx.cleanup(); }
});

test("company rules can replace and disable rules", () => {
  const fx = fixture();
  try {
    const base = loadRules(fx.root);
    assert.ok(base.lineRules.some((r) => r.id === "println-left-in"));
    writeFileSync(join(fx.root, "roles", "review-rules.local.json"), JSON.stringify({
      line_rules: [{ id: "println-left-in", disabled: true }, { id: "todo-left", severity: "suggestion", message: "TODO", pattern: "TODO" }],
    }));
    const merged = loadRules(fx.root);
    assert.ok(!merged.lineRules.some((r) => r.id === "println-left-in"));
    assert.ok(merged.lineRules.some((r) => r.id === "todo-left"));
  } finally { fx.cleanup(); }
});

// ---------- co-change ----------

test("co-change: a usual partner missing from the diff is a risk with history evidence", async () => {
  const fx = fixture();
  try {
    fx.commit({ "a.ts": "1\n", "b.ts": "1\n" }, "start");
    for (let i = 2; i <= 4; i++) fx.commit({ "a.ts": `${i}\n`, "b.ts": `${i}\n` }, `together ${i}`);
    fx.commit({ "a.ts": "5\n" }, "only a");
    const db = openDb(":memory:");
    ingestRepos(db, fx.cfg);
    const withB = readDiff(fx.repo, { base: "HEAD~2", head: "HEAD~1" });
    assert.deepEqual(checkCoChange(withB, db, "demo", loadRules(fx.root), () => true), []);
    const onlyA = readDiff(fx.repo, { base: "HEAD~1", head: "HEAD" });
    const got = checkCoChange(onlyA, db, "demo", loadRules(fx.root), () => true);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.rule, "cochange-partner-missing");
    assert.equal(got[0]!.severity, "risk");
    assert.match(got[0]!.message, /b\.ts/);
    assert.match(got[0]!.evidence, /4 times/);
    assert.deepEqual(checkCoChange(onlyA, db, "demo", loadRules(fx.root), () => false), []);
    db.close();
  } finally { fx.cleanup(); }
});

// ---------- reviewer ----------

function twoCommitRepo(fx: ReturnType<typeof fixture>): void {
  const lines = Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`);
  fx.commit({ "src/a.ts": lines.join("\n") + "\n" }, "start");
  const changed = [...lines];
  changed[0] = "const v0 = 100;";
  changed[5] = `console.log("debug");`;
  changed.push("const last = compute(null);");
  fx.commit({ "src/a.ts": changed.join("\n") + "\n" }, "change");
}

test("reviewChange: no model gives fixed checks only", async () => {
  const fx = fixture();
  try {
    twoCommitRepo(fx);
    const r = await reviewChange(fx.cfg, null, { repo: "demo" }, {});
    assert.equal(r.model.used, false);
    assert.deepEqual(ids(r.tier0), ["console-log-left-in"]);
    assert.equal(r.tier0[0]!.line, 6);
    assert.equal(r.stats.files, 1);
  } finally { fx.cleanup(); }
});

test("reviewChange: model findings are validated, deduplicated, filtered to the diff and capped at 5", async () => {
  const fx = fixture();
  try {
    twoCommitRepo(fx);
    const f = (line: number, issue: string, extra: object = {}) => ({ file: "src/a.ts", line, severity: "risk", issue, why: "w", ...extra });
    const reply = JSON.stringify({ findings: [
      f(6, "repeats the console.log check"),           // same line as tier0 -> duplicate
      f(99, "outside the change"),
      { file: "src/other.ts", line: 3, severity: "risk", issue: "wrong file", why: "" },
      { file: "src/a.ts", line: "x", severity: "risk", issue: "bad line" },
      f(13, "null passed to compute", { severity: "blocker", suggestion: "--- a/src/a.ts\n+++ b/src/a.ts\n" }),
      f(12, "one"), f(11, "two"), f(10, "three"), f(9, "four"), f(3, "five"), f(2, "six"), f(1, "seven"),
    ] });
    const seen: { user?: string; system?: string[] } = {};
    const r = await reviewChange(fx.cfg, null, { repo: "demo" }, { complete: fakeModel(reply, seen), backendUsed: () => "fake" });
    assert.equal(r.backend, "fake");
    assert.equal(r.model.used, true);
    assert.equal(r.model.error, undefined);
    assert.ok(r.findings.length <= 5);
    assert.equal(r.findings.length, 5);
    assert.equal(r.findings[0]!.severity, "blocker");
    assert.equal(r.findings[0]!.line, 13);
    assert.ok(r.findings[0]!.suggestion);
    assert.ok(r.findings.every((x) => x.line !== 6));
    assert.ok(r.findings.every((x) => x.file === "src/a.ts"));
    assert.equal(r.stats.modelDroppedInvalid, 1);
    assert.ok(r.stats.modelDroppedDuplicate >= 1);
    assert.ok(r.stats.modelDroppedOutsideDiff >= 2);
    assert.equal(r.stats.modelDroppedOverLimit, 3);
    // the prompt carries the numbered change and the fixed-check summary, and a stable system block
    assert.match(seen.user ?? "", /L13\+ const last/);
    assert.match(seen.user ?? "", /console-log-left-in/);
    assert.match(seen.system?.[0] ?? "", /at most 5/i);
  } finally { fx.cleanup(); }
});

test("reviewChange: a bad model answer keeps the fixed checks and says so", async () => {
  const fx = fixture();
  try {
    twoCommitRepo(fx);
    const r = await reviewChange(fx.cfg, null, { repo: "demo" }, { complete: fakeModel("not json at all") });
    assert.equal(r.model.used, true);
    assert.match(r.model.error ?? "", /JSON/);
    assert.equal(r.tier0.length, 1);
    assert.equal(r.findings.length, 0);
  } finally { fx.cleanup(); }
});

test("runTier0 combines checks and sorts blockers first", () => {
  const diff = {
    base: "a", head: "b", baseSha: "a", headSha: "b", skipped: [],
    files: [fakeFile("src/a.ts", [`console.log(1);`]), fakeFile("apps/aura-ui/src/components/plico/x.tsx", ["x"])],
  };
  const out = runTier0(diff, { rules: loadRules(GUARD_ROOT) });
  assert.equal(out[0]!.severity, "blocker");
});

// ---------- refactor ----------

const SOURCE = ["function add(a, b) {", "  return a + b;", "}", "", "function sub(a, b) {", "  return a - b;", "}", ""].join("\n");
const GOOD = [
  "--- a/src/m.ts", "+++ b/src/m.ts", "@@ -1,3 +1,3 @@", " function add(a, b) {", "-  return a + b;", "+  return Number(a) + Number(b);", " }", "",
].join("\n");
const BAD = [
  "--- a/src/m.ts", "+++ b/src/m.ts", "@@ -1,3 +1,3 @@", " function add(a, b) {", "-  return a * b;", "+  return a + b + 0;", " }", "",
].join("\n");

test("checkPatches marks a patch that does not apply, without touching the repo", () => {
  const fx = fixture();
  try {
    fx.commit({ "src/m.ts": SOURCE }, "m");
    const res = checkPatches(fx.repo, "HEAD", "src/m.ts", [GOOD, BAD, ""]);
    assert.equal(res[0]!.applies, true);
    assert.equal(res[1]!.applies, false);
    assert.ok(res[1]!.error);
    assert.equal(res[2]!.applies, false);
    assert.equal(readFileSync(join(fx.repo, "src", "m.ts"), "utf8"), SOURCE);
    assert.equal(readFileSync(join(fx.repo, "src", "m.ts"), "utf8").includes("Number("), false);
  } finally { fx.cleanup(); }
});

test("suggestRefactor: at most 3, patches checked, reports written", async () => {
  const fx = fixture();
  try {
    fx.commit({ "src/m.ts": SOURCE }, "m");
    const item = (title: string, patch: string) => ({ title, why: "w", risk: "low", affected: ["src/x.ts"], patch });
    const reply = JSON.stringify({ refactors: [item("good", GOOD), item("bad", BAD), item("three", ""), item("four", GOOD)] });
    const r = await suggestRefactor(fx.cfg, null, { repo: "demo", path: "src/m.ts" }, { complete: fakeModel(reply) });
    assert.equal(r.refactors.length, 3);
    assert.deepEqual(r.refactors.map((x) => x.applies), [true, false, false]);
    const w = writeRefactorReport(fx.cfg, r, new Date(2026, 2, 5));
    const text = readFileSync(w.reportPath, "utf8");
    assert.match(text, /DOES NOT APPLY/);
    assert.match(text, /checked: it applies/);
    assert.equal(w.patchPaths.length, 2);
    await assert.rejects(() => suggestRefactor(fx.cfg, null, { repo: "demo", path: "nope.ts" }, {}), /not in the repo/);
  } finally { fx.cleanup(); }
});

// ---------- report ----------

test("writeReviewReport writes markdown and patch files under data/reviews/<repo>/", async () => {
  const fx = fixture();
  try {
    twoCommitRepo(fx);
    const reply = JSON.stringify({ findings: [
      { file: "src/a.ts", line: 13, severity: "risk", issue: "null goes in", why: "crash", suggestion: "--- a/src/a.ts\n+++ b/src/a.ts\n" },
    ] });
    const r = await reviewChange(fx.cfg, null, { repo: "demo" }, { complete: fakeModel(reply), backendUsed: () => "fake" });
    const w = writeReviewReport(fx.cfg, r, new Date(2026, 2, 5));
    assert.ok(w.reportPath.includes(join("data", "reviews", "demo")));
    assert.match(w.reportPath, /2026-03-05-[0-9a-f]{8}\.md$/);
    const text = readFileSync(w.reportPath, "utf8");
    assert.match(text, /Shadow mode/);
    assert.match(text, /console-log-left-in/);
    assert.match(text, /null goes in/);
    assert.equal(w.patchPaths.length, 1);
    assert.ok(existsSync(w.patchPaths[0]!));
    assert.ok(readdirSync(join(fx.cfg.dataDir, "reviews", "demo")).length >= 2);
  } finally { fx.cleanup(); }
});

test("Rust unwrap after #[cfg(test)] is skipped when the file is known; branch names in notes are not secrets", () => {
  const src = "fn a() {}\n#[cfg(test)]\nmod t { fn x() { r.unwrap(); } }\n";
  assert.equal(rustTestStart(src), 2);
  const u = "let a = m.lock().unwrap();";
  const f = fakeFile("src/lib.rs", [u, u], "modified", 1);
  const withLate = fakeFile("src/lib.rs", [u, u, u], "modified", 1);
  const diff = { base: "a", head: "b", baseSha: "a", headSha: "b", skipped: [], files: [withLate] };
  const { fx, rules: on } = rulesWithUnwrap();
  try {
    const got = runTier0(diff, { rules: on, readFile: () => src });
    assert.deepEqual(got.map((x) => x.line), [1]);
    assert.equal(runTier0({ ...diff, files: [f] }, { rules: on }).length, 2);
  } finally { fx.cleanup(); }
  const note = fakeFile("AI_HANDOFF.md", ["Branch `feature/aura/Fine-Tune-Qx7Zk2Wm9Lp4Rv8Tn3Bc` from main"]);
  assert.deepEqual(checkSecrets(note), []);
});

// ---------- tuning: classes, examples, css, secrets, cap ----------

import { looksLikeIdentifier } from "../src/review/tier0.ts";
import { MAX_SHOWN, triage } from "../src/review/rank.ts";
import type { Finding } from "../src/review/tier0.ts";

const mk = (rule: string, severity: Finding["severity"], cls: Finding["class"], confidence: number, line = 1): Finding =>
  ({ rule, severity, file: "src/a.ts", line, message: rule, evidence: "", class: cls, confidence });

test("every rule has a class: defect checks are bugs, Aura's written rules are policy", () => {
  const set = loadRules(GUARD_ROOT);
  for (const r of set.lineRules) assert.ok(r.class === "defect" || r.class === "policy", r.id);
  const byId = Object.fromEntries(set.lineRules.map((r) => [r.id, r.class]));
  for (const id of ["hardcoded-ipv4", "hardcoded-hostname", "hardcoded-port", "hardcoded-windows-path", "inline-style"]) assert.equal(byId[id], "policy", id);
  assert.equal(set.specialRules["secret-in-code"]?.class, "defect");
  assert.equal(set.specialRules["erp-write-tool-for-ai"]?.class, "defect");
  assert.equal(set.specialRules["cochange-partner-missing"]?.class, "defect");
  assert.equal(set.specialRules["plico-file-edited"]?.class, "policy");
  const got = runTier0(
    { base: "a", head: "b", baseSha: "a", headSha: "b", skipped: [], files: [fakeFile("src/x.ts", [`const c = "localhost:5173";`, "const t = \"ghp_\" + \"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8\";"])] },
    { rules: set },
  );
  assert.equal(got.find((f) => f.rule === "hardcoded-port")?.class, "policy");
});

test("example addresses in help text, copy files and docs are not hard-coded company facts", () => {
  const ex = (path: string, line: string) => checkLineRules(fakeFile(path, [line]), rules).length;
  assert.equal(ex("src/a.ts", `hint: "Use an address such as http://erp.fabricator.internal/api"`), 0);
  assert.equal(ex("src/a.ts", `placeholder: "e.g. 10.20.30.40"`), 0);
  assert.equal(ex("apps/aura-ui/src/copy.ts", `server: "http://erp.fabricator.internal/api"`), 0);
  assert.equal(ex("apps/aura-ui/src/copy.ts", `ip: "10.20.30.40"`), 0);
  assert.equal(ex("src/a.ts", `const u = "http://127.0.0.1:9000/mcp";`), 1); // still a port rule hit
  assert.equal(ex("src/a.ts", `const u = "http://localhost/x";`), 0);
  assert.equal(ex("src/a.ts", `const ip = "203.0.113.7";`), 0); // documentation range (RFC 5737)
  assert.equal(ex("src/a.ts", `const ip = "10.20.30.40";`), 1);
  assert.equal(ex("src/a.ts", `const u = "http://erp.fabricator.internal/api";`), 1);
  // inside a Rust test module
  const inTests = fakeFile("src/lib.rs", [`let u = "http://erp.fabricator.internal/api";`]);
  inTests.hunks[0]!.header = "mod tests {";
  assert.equal(checkLineRules(inTests, rules).length, 0);
  assert.equal(ex("src/orders/tests.rs", `let u = "http://erp.fabricator.internal/api";`), 0);
});

test("new-css-file: only an added css file under apps/aura-ui that is not in the known list", () => {
  const css = loadRules(GUARD_ROOT).newCss;
  const added = (p: string) => checkNewCss(fakeFile(p, ["a{}"], "added"), css).length;
  assert.equal(added("apps/aura-ui/aura-ui-chat.css"), 0);
  assert.equal(added("apps/aura-ui/aura-ui-views-orders.css"), 0);
  assert.equal(added("apps/aura-ui/uiblocks.css"), 0);
  assert.equal(added("apps/aura-ui/src/styles/palettes.css"), 0);
  assert.equal(added("apps/aura-ui/src/components/aura/brand-new.css"), 1);
  assert.equal(added("apps/aura-ui/fresh-extras.css"), 1);
  assert.equal(added("apps/other/new.css"), 0);
  assert.equal(checkNewCss(fakeFile("apps/aura-ui/fresh-extras.css", ["a{}"], "modified"), css).length, 0);
});

test("possible-secret-in-code skips identifiers, Rust paths and hex digests but keeps random keys", () => {
  const ident = [
    "parse_order_group_from_message_text_1", "OrderGroupEvidenceBuilder", "orderGroupEvidenceBuilderV2",
    "da39a3ee5e6b4b0d3255bfef95601890afd80709", "b".repeat(20) + "0123456789abcdef0123456789abcdef".slice(0, 12),
  ];
  for (const t of ident) assert.equal(looksLikeIdentifier(t), true, t);
  assert.equal(looksLikeIdentifier("x", "agent_core::orders::group"), true);
  for (const t of ["q8Zk3Xv9Lm2Pw7Tn4Bc6Rj1Yh5Dg0Fs", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"]) assert.equal(looksLikeIdentifier(t), false, t);
  const lines = [
    `use agent_core::orders::group::parse_order_group_from_message_text;`,
    `let e = OrderGroupEvidenceBuilder::new();`,
    `const sha = "da39a3ee5e6b4b0d3255bfef95601890afd80709abcdef0123456789ab";`,
  ];
  assert.deepEqual(checkSecrets(fakeFile("src/lib.rs", lines)), []);
  const key = "q8Zk3Xv9Lm2Pw7Tn4Bc6Rj1Yh5Dg0Fs2Np8Qa";
  const hit = checkSecrets(fakeFile("src/lib.ts", [`const k = "${key}";`]));
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.rule, "possible-secret-in-code");
  assert.ok(!JSON.stringify(hit).includes(key));
  const skipped = checkSecrets(fakeFile("tools/eval/truth.json", [`"id": "${key}"`]), loadRules(GUARD_ROOT).possibleSecretPathSkip);
  assert.deepEqual(skipped, []);
});

test("triage: at most 5 shown, blockers first, then defects by confidence; policy goes to rule compliance", () => {
  const list: Finding[] = [
    mk("policy-a", "risk", "policy", 0.9, 1), mk("policy-b", "risk", "policy", 0.9, 2),
    mk("d1", "suggestion", "defect", 0.2, 3), mk("d2", "risk", "defect", 0.7, 4), mk("d3", "risk", "defect", 0.5, 5),
    mk("d4", "risk", "defect", 0.6, 6), mk("d5", "risk", "defect", 0.4, 7), mk("d6", "risk", "defect", 0.3, 8),
    mk("plico", "blocker", "policy", 0.95, 9),
  ];
  const t = triage(list);
  assert.equal(MAX_SHOWN, 5);
  assert.equal(t.shown.length, 5);
  assert.deepEqual(t.shown.map((f) => f.rule), ["plico", "d2", "d4", "d3", "d5"]);
  assert.deepEqual(t.moreDefects.map((f) => f.rule), ["d6", "d1"]);
  assert.deepEqual(t.policy.map((f) => f.rule).sort(), ["policy-a", "policy-b"]);
  assert.equal(triage([]).shown.length, 0);
});

test("report shows 5 comments, '+N lower priority', rule compliance counts and an appendix", async () => {
  const fx = fixture();
  try {
    const many = Array.from({ length: 8 }, (_, i) => `const t${i} = "${"gh" + "p_"}${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R"}${i}";`);
    fx.commit({ "a.ts": "one\n" }, "start");
    fx.commit({ "a.ts": ["one", ...many, `console.log(1);`, `const p = "localhost:8080";`].join("\n") + "\n" }, "second");
    const r = await reviewChange(fx.cfg, null, { repo: "demo" }, {});
    assert.equal(r.triage.shown.length, 5);
    assert.ok(r.triage.moreDefects.length >= 3);
    assert.equal(r.triage.policy.length, 2);
    const w = writeReviewReport(fx.cfg, r, new Date(2026, 2, 5));
    const text = readFileSync(w.reportPath, "utf8");
    assert.match(text, /## Comments \(top 5/);
    assert.match(text, /\+3 lower priority/);
    assert.match(text, /## Rule compliance/);
    assert.match(text, /\| hardcoded-port \| 1 \|/);
    assert.match(text, /## Appendix/);
    const main = text.slice(text.indexOf("## Comments"), text.indexOf("## Rule compliance"));
    assert.equal((main.match(/^- \*\*/gm) ?? []).length, 5);
    assert.ok(!main.includes("hardcoded-port"));
  } finally { fx.cleanup(); }
});
