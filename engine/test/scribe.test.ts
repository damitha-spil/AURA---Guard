import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_ROOT } from "../src/config.ts";
import type { GuardConfig } from "../src/types.ts";
import { draftDiary, buildDiaryPrompt } from "../src/roles/scribe.ts";
import { gatherDay } from "../src/roles/scribe-input.ts";
import type { CompleteFn } from "../src/brain/client.ts";

const DATE = "2026-03-10";

function git(cwd: string, args: string[], when?: string) {
  const env = { ...process.env, ...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {}) };
  execFileSync("git", args, { cwd, env, stdio: "ignore" });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "guard-scribe-"));
  mkdirSync(join(root, "roles"));
  cpSync(join(GUARD_ROOT, "roles", "scribe.yaml"), join(root, "roles", "scribe.yaml"));
  const repo = join(root, "my repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@example.org"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "AI_HANDOFF.md"), "start\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "Add first file", "-m", "Body explains why"], `${DATE}T10:00:00`);
  writeFileSync(join(repo, "AI_HANDOFF.md"), "start\nHANDOFF-LINE\n");
  git(repo, ["commit", "-q", "-am", "Update handoff"], `${DATE}T11:00:00`);
  const cfg: GuardConfig = {
    dataDir: join(root, "data"), vaultDir: join(root, "vault"),
    repos: [{ id: "demo", path: repo }], busyProcesses: [], root,
  };
  return { root, cfg, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const reply = () => JSON.stringify({
  summary: "Did things.", built: ["a file"], decisions: [{ what: "x", why: "y" }],
  questions: ["q1", "q2", "q3", "q4", "q5"],
});
const fake = (text: string, seen?: { user?: string; system?: string[] }): CompleteFn => async (r) => {
  if (seen) { seen.user = r.user; seen.system = r.system; }
  return { text, usage: { input_tokens: 1, output_tokens: 1 } };
};

test("gatherDay reads commits, files and the handoff diff", () => {
  const s = setup();
  const day = gatherDay(s.cfg, DATE);
  assert.equal(day.repos.length, 1);
  assert.equal(day.repos[0]!.commits.length, 2);
  assert.ok(day.repos[0]!.files.some((f) => f.path === "a.txt"));
  assert.ok(day.repos[0]!.handoffDiff.includes("HANDOFF-LINE"));
  assert.equal(gatherDay(s.cfg, "2026-03-11").repos.length, 0);
  s.cleanup();
});

test("diary note is written proposed, questions capped at 3", async () => {
  const s = setup();
  const seen: { user?: string; system?: string[] } = {};
  const file = await draftDiary(s.cfg, DATE, { complete: fake(reply(), seen) });
  assert.ok(file);
  assert.equal(readdirSync(join(s.cfg.vaultDir, "diary")).length, 1);
  const text = readFileSync(file, "utf8");
  assert.match(text, /status: proposed/);
  assert.match(text, /source: commit/);
  assert.match(text, /Questions for the owner/);
  assert.ok(text.includes("- q3") && !text.includes("- q4"));
  assert.ok(seen.user!.includes("Add first file") && seen.user!.includes("Update handoff"));
  assert.ok(seen.system![0]!.includes("At most 3 questions"));
  s.cleanup();
});

test("no commits that day writes nothing", async () => {
  const s = setup();
  const r = await draftDiary(s.cfg, "2026-03-11", { complete: fake(reply()) });
  assert.equal(r, null);
  assert.throws(() => readdirSync(join(s.cfg.vaultDir, "diary")));
  s.cleanup();
});

test("invalid model JSON gives a clear error and no note", async () => {
  const s = setup();
  await assert.rejects(draftDiary(s.cfg, DATE, { complete: fake("not json") }), /Scribe: the model reply/);
  await assert.rejects(draftDiary(s.cfg, DATE, { complete: fake("{\"summary\": 3}") }), /expected shape/);
  assert.throws(() => readdirSync(join(s.cfg.vaultDir, "diary")));
  s.cleanup();
});

test("buildDiaryPrompt has role rules first", () => {
  const s = setup();
  const p = buildDiaryPrompt(s.cfg, gatherDay(s.cfg, DATE));
  assert.ok(p.system[0]!.includes("Scribe"));
  assert.ok(p.user.includes("Add first file"));
  s.cleanup();
});
