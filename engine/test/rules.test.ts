import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/index/db.ts";
import { ingestRepos } from "../src/ingest/index.ts";
import { exportActiveChecks, loadActiveChecks, parseCheckBlock, parseExported } from "../src/rules/checks.ts";
import { isNoisePath, mineCoChange, trivialPair } from "../src/rules/mine.ts";
import { approveRule, dismissRule, ruleNotes, setFrontmatterFields } from "../src/rules/manage.ts";
import { checkHash, proposeRules } from "../src/rules/propose.ts";
import type { GuardConfig } from "../src/types.ts";

function git(cwd: string, args: string[], date?: string): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Tester", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } },
  );
}

function commit(dir: string, files: Record<string, string>, msg: string, date: string): void {
  for (const [p, t] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, t);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", msg], date);
}

/** A repo where api/handler.ts and docs/api.md change together in 5 of 6 commits; the lockfile changes in all. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "guard-rules-"));
  const repo = join(root, "my repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  for (let i = 1; i <= 5; i++) {
    commit(repo, {
      "api/handler.ts": `h${i}\n`, "docs/api.md": `d${i}\n`, "package-lock.json": `l${i}\n`, "ui/other.ts": i === 3 ? "o\n" : `o${i}\n`,
    }, `change ${i}`, `2026-02-0${i}T10:00:00`);
  }
  commit(repo, { "api/handler.ts": "solo\n" }, "handler only", "2026-02-09T10:00:00");
  // A bulk commit touching many files must not count as a link.
  const bulk: Record<string, string> = {};
  for (let i = 0; i < 30; i++) bulk[`bulk/f${i}.txt`] = "x\n";
  commit(repo, bulk, "bulk", "2026-02-10T10:00:00");
  const cfg: GuardConfig = {
    dataDir: join(root, "data"), vaultDir: join(root, "vault"),
    repos: [{ id: "demo", path: repo }], busyProcesses: [], root,
  };
  const db = openDb(":memory:");
  ingestRepos(db, cfg);
  return { root, cfg, db, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("mining finds the stable pair and skips lockfiles, bulk commits and same-folder pairs", () => {
  const s = setup();
  try {
    const m = mineCoChange(s.db, "demo");
    const pairs = m.findings.map((f) => f.files.join(" + "));
    assert.ok(pairs.some((p) => p.includes("api/handler.ts") && p.includes("docs/api.md")), pairs.join("\n"));
    assert.ok(pairs.every((p) => !p.includes("package-lock.json") && !p.includes("bulk/")));
    assert.ok(m.commitsSkipped >= 1);
    const f = m.findings.find((x) => x.files.includes("docs/api.md"))!;
    assert.ok(f.commits >= 4);
    assert.ok(f.ratio >= 0.6 && f.ratio <= 1);
  } finally {
    s.cleanup();
  }
});

test("noise and trivial-pair helpers", () => {
  assert.equal(isNoisePath("Cargo.lock"), true);
  assert.equal(isNoisePath("app/package-lock.json"), true);
  assert.equal(isNoisePath("ai-log/2026/11/x.md"), true);
  assert.equal(isNoisePath("src/main.rs"), false);
  assert.equal(trivialPair("src/a.ts", "src/b.ts"), true);
  assert.equal(trivialPair("src/orders/erp.rs", "src/orders/erp/tests.rs"), true);
  assert.equal(trivialPair("api/a.ts", "docs/a.md"), false);
});

test("propose writes proposed pattern notes with a valid check, and a rerun dedupes", () => {
  const s = setup();
  try {
    const dry = proposeRules(s.db, s.cfg.vaultDir, "demo", { dryRun: true });
    assert.ok(dry.proposals.length >= 1);
    assert.equal(readdirSafe(join(s.cfg.vaultDir, "inbox")).length, 0, "dry run writes nothing");

    const r = proposeRules(s.db, s.cfg.vaultDir, "demo", { max: 1 });
    assert.equal(r.proposals.length, 1);
    const files = readdirSafe(join(s.cfg.vaultDir, "inbox"));
    assert.equal(files.length, 1);
    const notes = ruleNotes(s.cfg.vaultDir);
    assert.equal(notes.length, 1);
    const n = notes[0]!;
    assert.equal(n.meta.status, "proposed");
    assert.deepEqual(n.meta.audience, ["internal_dev"]);
    assert.equal(n.meta.source, "commit");
    const c = parseCheckBlock(n.body);
    assert.equal(c.state, "ok");
    if (c.state === "ok") assert.equal(r.proposals[0]!.id, `pattern-cochange-${checkHash(c.check)}`);

    const again = proposeRules(s.db, s.cfg.vaultDir, "demo", { max: 1 });
    assert.equal(again.proposals.length, 0);
    assert.ok(again.duplicates >= 1);
  } finally {
    s.cleanup();
  }
});

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

test("approve changes only status and reviewed, and keeps CRLF line endings", () => {
  const s = setup();
  try {
    proposeRules(s.db, s.cfg.vaultDir, "demo", { max: 1 });
    const n = ruleNotes(s.cfg.vaultDir)[0]!;
    const path = join(s.cfg.vaultDir, n.file);
    const lf = readFileSync(path, "utf8");
    const crlf = lf.replace(/\n/g, "\r\n");
    writeFileSync(path, crlf);

    const r = approveRule(s.cfg.vaultDir, n.meta.id, new Date(2026, 2, 5));
    assert.equal(r.ok, true);
    assert.deepEqual(r.changes.map((c) => c.field).sort(), ["reviewed", "status"]);
    const after = readFileSync(path, "utf8");
    // Undo the two intended edits and the file must equal the original byte for byte.
    const restored = after.replace("status: active", "status: proposed").replace(/reviewed: 2026-03-05\r\n/, "");
    assert.equal(restored, crlf);
    assert.ok(after.includes("\r\n") && !/[^\r]\n/.test(after));
    const now = ruleNotes(s.cfg.vaultDir)[0]!;
    assert.equal(now.meta.status, "active");
    assert.equal(now.meta.reviewed, "2026-03-05");
    assert.equal(now.body, n.body);
  } finally {
    s.cleanup();
  }
});

test("approve refuses an invalid note, a bad check block, a wrong type and a deprecated note", () => {
  const s = setup();
  try {
    const dir = join(s.cfg.vaultDir, "inbox");
    mkdirSync(dir, { recursive: true });
    const head = (id: string, extra = "") =>
      `---\nid: ${id}\ntype: pattern\nstatus: proposed\naudience: [internal_dev]\ndepartment: dev\nsource: commit\ncreated: 2026-01-01\n${extra}---\n\n# T\n\n`;
    writeFileSync(join(dir, "bad-check.md"), head("bad-check") + '```json\n{"kind":"co-change","if_changed":[]}\n```\n');
    writeFileSync(join(dir, "no-audience.md"), "---\nid: no-audience\ntype: pattern\nstatus: proposed\naudience: []\ncreated: 2026-01-01\nsource: commit\n---\n\n# T\n");
    writeFileSync(join(dir, "dead.md"), head("dead").replace("status: proposed", "status: deprecated") + "text\n");
    writeFileSync(join(dir, "diary-x.md"), head("diary-x").replace("type: pattern", "type: diary") + "text\n");

    assert.match(approveRule(s.cfg.vaultDir, "bad-check").reason!, /check block/);
    assert.match(approveRule(s.cfg.vaultDir, "no-audience").reason!, /no valid note/);
    assert.match(approveRule(s.cfg.vaultDir, "dead").reason!, /only proposed or shadow/);
    assert.match(approveRule(s.cfg.vaultDir, "diary-x").reason!, /not a pattern or rule/);
    assert.match(approveRule(s.cfg.vaultDir, "missing").reason!, /no valid note/);
    assert.match(readFileSync(join(dir, "bad-check.md"), "utf8"), /status: proposed/);
  } finally {
    s.cleanup();
  }
});

test("dismiss sets deprecated and the check is not proposed again", () => {
  const s = setup();
  try {
    proposeRules(s.db, s.cfg.vaultDir, "demo", { max: 1 });
    const id = ruleNotes(s.cfg.vaultDir)[0]!.meta.id;
    const r = dismissRule(s.cfg.vaultDir, id);
    assert.equal(r.ok, true);
    assert.deepEqual(r.changes.map((c) => c.field), ["status"]);
    assert.equal(ruleNotes(s.cfg.vaultDir, "deprecated").length, 1);
    assert.equal(proposeRules(s.db, s.cfg.vaultDir, "demo", { max: 1 }).proposals.length, 0);
  } finally {
    s.cleanup();
  }
});

test("export writes only ACTIVE checks with a valid shape, and the loader reads them", () => {
  const s = setup();
  try {
    proposeRules(s.db, s.cfg.vaultDir, "demo", { max: 5 });
    assert.equal(loadActiveChecks(s.cfg).length, 0, "nothing is active before approval");
    const id = ruleNotes(s.cfg.vaultDir)[0]!.meta.id;
    approveRule(s.cfg.vaultDir, id);
    const e = exportActiveChecks(s.cfg);
    assert.equal(e.checks.length, 1);
    assert.equal(e.checks[0]!.id, id);
    const back = parseExported(readFileSync(e.file, "utf8"));
    assert.equal(back[0]!.check.kind, "co-change");
    assert.ok(back[0]!.check.if_changed.length >= 1);
    assert.throws(() => parseExported('{"checks":[{"id":"x","title":"t","check":{"kind":"co-change"}}]}'));
  } finally {
    s.cleanup();
  }
});

test("setFrontmatterFields keeps every other line, quoted values included", () => {
  const text = '---\nid: a\nstatus: proposed\ntitle: "Keep: me"\ncreated: 2026-01-01\n---\n\nbody\n';
  const r = setFrontmatterFields(text, { status: "active", reviewed: "2026-02-02" });
  assert.ok(!("error" in r));
  if (!("error" in r)) {
    assert.equal(r.text, '---\nid: a\nstatus: active\ntitle: "Keep: me"\ncreated: 2026-01-01\nreviewed: 2026-02-02\n---\n\nbody\n');
  }
  assert.ok("error" in setFrontmatterFields("no frontmatter", { status: "active" }));
});
