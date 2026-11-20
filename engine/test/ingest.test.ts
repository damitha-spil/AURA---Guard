import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/index/db.ts";
import { readCommits, headSha } from "../src/ingest/git.ts";
import { ingestRepos } from "../src/ingest/index.ts";
import { coChanged } from "../src/index/cochange.ts";
import { historyFor } from "../src/index/history.ts";
import { findStale } from "../src/index/stale.ts";
import type { GuardConfig } from "../src/types.ts";

function git(cwd: string, args: string[], date?: string): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Tester", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    },
  );
}

function commit(dir: string, files: Record<string, string>, msg: string, date: string): string {
  for (const [p, t] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, t);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", msg], date);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "guard-ingest-"));
  git(dir, ["init", "-q"]);
  const c1 = commit(dir, { "src/a.ts": "a1\n", "src/b.ts": "b1\n", "README.md": "# hi\n" },
    "first: init \"quoted\" & <odd> %s\n\nbody line 1\n\nbody line 2", "2026-01-01T10:00:00Z");
  const c2 = commit(dir, { "src/a.ts": "a2\n", "src/my file.ts": "x\n" }, "second", "2026-01-02T10:00:00Z");
  const c3 = commit(dir, { "src/a.ts": "a3\n", "src/b.ts": "b3\n" }, "third", "2026-01-03T10:00:00Z");
  const cfg: GuardConfig = {
    department: "dev", dataDir: dir, vaultDir: dir, busyProcesses: [], root: dir,
    repos: [{ id: "r", path: dir }, { id: "gone", path: join(dir, "nope") }],
  };
  return { dir, cfg, c1, c2, c3 };
}

test("readCommits parses subjects, bodies and paths with spaces", () => {
  const { dir, c1, c2 } = setup();
  try {
    const cs = readCommits(dir, "r");
    assert.equal(cs.length, 3);
    const first = cs.find((c) => c.sha === c1)!;
    assert.equal(first.subject, "first: init \"quoted\" & <odd> %s");
    assert.match(first.body, /body line 1\n\nbody line 2/);
    assert.equal(first.files.length, 3);
    const second = cs.find((c) => c.sha === c2)!;
    assert.ok(second.files.some((f) => f.path === "src/my file.ts" && f.added === 1));
    assert.equal(readCommits(dir, "r", c1).length, 2);
    assert.equal(readCommits(dir, "r", "0".repeat(40)).length, 3);
    assert.equal(readCommits(dir, "r", undefined, 1).length, 1);
    assert.equal(headSha(dir), cs[0]!.sha);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ingest is incremental; file docs added and removed; unknown repo skipped", () => {
  const { dir, cfg } = setup();
  try {
    const db = openDb(":memory:");
    let res = ingestRepos(db, cfg);
    assert.deepEqual(res[0], { repo: "r", commits: 3, files: 1 });
    assert.equal(res[1]!.skipped, "path not found");
    res = ingestRepos(db, cfg);
    assert.equal(res[0]!.commits, 0);

    commit(dir, { "docs/guide.md": "g\n", "desk.json": "{}\n" }, "fourth", "2026-01-04T10:00:00Z");
    res = ingestRepos(db, cfg);
    assert.equal(res[0]!.commits, 1);
    assert.equal(res[0]!.files, 3);
    const refs = () => (db.prepare("SELECT ref FROM docs WHERE kind='file' ORDER BY ref").all() as { ref: string }[]).map((r) => r.ref);
    assert.deepEqual(refs(), ["r:README.md", "r:desk.json", "r:docs/guide.md"]);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM docs WHERE kind='commit'").get() as { n: number }).n, 4);

    git(dir, ["rm", "-q", "docs/guide.md"]);
    git(dir, ["commit", "-m", "fifth"], "2026-01-05T10:00:00Z");
    ingestRepos(db, cfg);
    assert.deepEqual(refs(), ["r:README.md", "r:desk.json"]);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coChanged, historyFor, findStale", () => {
  const { dir, cfg, c1, c3 } = setup();
  try {
    const db = openDb(":memory:");
    ingestRepos(db, cfg);

    const co = coChanged(db, "r", "src/a.ts");
    assert.deepEqual(co.map((c) => [c.path, c.together]), [["src/b.ts", 2], ["README.md", 1], ["src/my file.ts", 1]]);
    assert.equal(co[0]!.ratio, 2 / 3);
    assert.deepEqual(coChanged(db, "r", "nope.ts"), []);

    const h = historyFor(db, "r", "src/");
    assert.deepEqual(h.map((x) => x.subject), ["third", "second", "first: init \"quoted\" & <odd> %s"]);
    assert.deepEqual(h[0]!.files, ["src/a.ts", "src/b.ts"]);
    assert.equal(historyFor(db, "r", "src/", 1).length, 1);
    assert.equal(historyFor(db, "r", "README").length, 1);

    const ins = db.prepare("INSERT INTO anchors(note_id, repo, path, symbol, verified_sha) VALUES (?,?,?,?,?)");
    ins.run("n-exact", "r", "src/a.ts", null, c1);
    ins.run("n-prefix", "r", "src/", null, c3);
    ins.run("n-fresh", "r", "src/b.ts", null, c3);
    ins.run("n-unknown", "r", "src/a.ts", null, "f".repeat(40));
    ins.run("n-unverified", "r", "src/a.ts", null, null);
    const stale = findStale(db);
    const byId = Object.fromEntries(stale.map((s) => [s.noteId, s]));
    assert.deepEqual(byId["n-exact"]!.commits.map((c) => c.subject), ["third", "second"]);
    assert.equal(byId["n-prefix"], undefined);
    assert.equal(byId["n-fresh"], undefined);
    assert.equal(byId["n-unverified"], undefined);
    assert.match(byId["n-unknown"]!.reason!, /not in the index/);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
