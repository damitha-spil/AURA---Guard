import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, isLogged, parseLoggedShas, readLoggedShas, renderLogCheck, runLogCheck, writeLogCheck } from "../src/logcheck/logcheck.ts";

function git(cwd: string, args: string[], date?: string): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Tester", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } },
  );
}

function commitFile(dir: string, name: string, msg: string, date: string): string {
  writeFileSync(join(dir, name), msg + "\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", msg], date);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

test("parseLoggedShas reads hex shas after **Commit:** and ignores 'not committed'", () => {
  const text = [
    "- **Commit:** abc1234",
    "- **Commit:** not committed",
    "- **Commit:** DEF5678abc, 1234567890abcdef1234567890abcdef12345678",
    "- **Commit:** short sha (or \"not committed\")",
    "Mentioned in text: 9999999",
  ].join("\n");
  assert.deepEqual(parseLoggedShas(text), ["abc1234", "def5678abc", "1234567890abcdef1234567890abcdef12345678"]);
});

test("isLogged matches by prefix both ways and ignores too-short shas", () => {
  const full = "abcdef1234567890abcdef1234567890abcdef12";
  assert.equal(isLogged(full, ["abcdef1"]), true);
  assert.equal(isLogged("abcdef1", [full]), true);
  assert.equal(isLogged(full, ["abcdef"]), false);
  assert.equal(isLogged(full, ["fedcba1"]), false);
});

test("compare reports per day, missing commits and coverage", () => {
  const commits = [
    { sha: "aaaaaaa1111", day: "2026-03-02", subject: "one" },
    { sha: "bbbbbbb2222", day: "2026-03-02", subject: "two" },
    { sha: "ccccccc3333", day: "2026-03-01", subject: "three" },
  ];
  const r = compare("demo", commits, ["aaaaaaa", "ccccccc3"], true);
  assert.equal(r.commits, 3);
  assert.equal(r.logged, 2);
  assert.ok(Math.abs(r.coverage - 2 / 3) < 1e-9);
  assert.deepEqual(r.days.map((d) => d.day), ["2026-03-02", "2026-03-01"]);
  assert.deepEqual(r.days[0]!.missing, [{ sha: "bbbbbbb222", subject: "two" }]);
  assert.equal(r.days[1]!.missing.length, 0);
  const md = renderLogCheck(r, "2026-03-05");
  assert.match(md, /Coverage: 66\.7%/);
  assert.match(md, /bbbbbbb222 two/);
  assert.match(md, /README\.md: present/);
  assert.equal(compare("demo", [], [], false).coverage, 1);
});

test("end to end on a temp repo: git log against ai-log, README check, no author names in the report", async () => {
  const root = mkdtempSync(join(tmpdir(), "guard-logcheck-"));
  try {
    const repo = join(root, "my repo");
    mkdirSync(repo);
    git(repo, ["init", "-q"]);
    const c1 = commitFile(repo, "a.txt", "first change", "2026-03-01T10:00:00");
    commitFile(repo, "b.txt", "second change", "2026-03-01T11:00:00");
    const c3 = commitFile(repo, "c.txt", "third change", "2026-03-02T09:00:00");
    // A merge commit must not be counted.
    git(repo, ["checkout", "-q", "-b", "side"]);
    commitFile(repo, "d.txt", "side change", "2026-03-03T09:00:00");
    git(repo, ["checkout", "-q", "-"]);
    git(repo, ["merge", "--no-ff", "-m", "merge side", "side"], "2026-03-04T09:00:00");

    const logDir = join(repo, "ai-log", "2026", "03");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "2026-03-01-dev.md"), `# Log\n\n- **Commit:** ${c1.slice(0, 8)}\n- **Commit:** ${c3}\n`);
    assert.equal(readLoggedShas(repo).readmeExists, false);
    writeFileSync(join(repo, "ai-log", "README.md"), "# AI log\n");

    const all = await runLogCheck({ id: "demo", path: repo });
    assert.equal(all.commits, 4);
    assert.equal(all.logged, 2);
    assert.equal(all.readmeExists, true);

    const since = await runLogCheck({ id: "demo", path: repo }, "2026-03-02");
    assert.ok(since.commits < all.commits);

    const w = writeLogCheck(join(root, "data"), all, "2026-03-05");
    const text = readFileSync(w.file, "utf8");
    assert.match(w.file, /demo-2026-03-05\.md$/);
    assert.match(text, /second change/);
    assert.ok(!text.includes("Tester"), "no author names");
    assert.ok(!text.includes("t@example.com"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
