import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanUserText, findSessionDir, readSessionFile, sessionFolderName } from "../src/sessions/read.ts";
import { findCorrections, scoreOwnerText } from "../src/sessions/corrections.ts";
import type { Turn } from "../src/sessions/read.ts";
import { writeCandidates } from "../src/sessions/to-notes.ts";
import { mineSessions } from "../src/sessions/mine.ts";
import { splitFrontmatter } from "../src/vault/frontmatter.ts";
import { validateMeta } from "../src/vault/schema.ts";
import type { GuardConfig } from "../src/types.ts";

const S = "11111111-aaaa-bbbb-cccc-000000000001";

function line(type: "user" | "assistant", content: unknown, n: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    sessionId: S,
    timestamp: `2026-11-01T10:00:${String(n).padStart(2, "0")}.000Z`,
    message: { role: type, content },
    ...extra,
  });
}

// Built at runtime so no secret-shaped literal sits in this file.
const FAKE_SECRET = "AK" + "IA" + "Q7ZXN4MPLW2RTV6B";

function makeSessions(): { root: string; repo: string; cfg: GuardConfig } {
  const root = mkdtempSync(join(tmpdir(), "guard-sess-"));
  const dir = join(root, "projects", "d--Some-Repo");
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "queue-operation", sessionId: S }),
    "not json at all",
    line("user", "Please add a retry to the reader call", 1),
    line("assistant", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Added unbounded retries with a silent catch." }], 2),
    line("user", [{ type: "tool_result", content: "tool output here" }], 3),
    line("user", "No, don't use unbounded retries. Use a time limit instead.", 4),
    line("assistant", [{ type: "text", text: "Done, now with a time limit." }], 5),
    line("user", "nice", 6),
    line("assistant", [{ type: "text", text: "Anything else?" }], 7),
    line("user", "From now on always show a visible state for fallbacks", 8),
    line("assistant", [{ type: "text", text: "Noted." }], 9),
    line("user", `No, never paste the key ${FAKE_SECRET} into the config`, 10),
    line("assistant", [{ type: "text", text: "ok" }], 11, { isSidechain: true }),
  ];
  writeFileSync(join(dir, `${S}.jsonl`), lines.join("\n"));
  const vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  const cfg: GuardConfig = {
    department: "dev",
    dataDir: join(root, "data"),
    vaultDir: vault,
    repos: [],
    busyProcesses: [],
    root,
  };
  return { root: join(root, "projects"), repo: "D:\\Some Repo", cfg };
}

test("folder name mapping and discovery", () => {
  assert.equal(sessionFolderName("D:\\SPIL AURA"), "d--SPIL-AURA");
  const { root, repo } = makeSessions();
  assert.ok(findSessionDir(repo, root)?.endsWith("d--Some-Repo"));
  assert.equal(findSessionDir("D:\\Missing", root), undefined);
});

test("cleanUserText strips non-owner blocks", () => {
  const raw =
    "<system-reminder>secret rules</system-reminder>Fix this\n<ide_selection>code</ide_selection> [Pasted text #1 +20 lines] <command-name>/x</command-name>";
  assert.equal(cleanUserText(raw), "Fix this");
  assert.equal(cleanUserText("Base directory for this skill: x\nstuff"), "");
});

test("readSessionFile keeps text turns only", () => {
  const { root } = makeSessions();
  const turns = readSessionFile(join(root, "d--Some-Repo", `${S}.jsonl`));
  assert.ok(turns.every((t) => !t.text.includes("tool output")));
  assert.ok(turns.every((t) => !t.text.includes("hmm")));
  assert.ok(!turns.some((t) => t.text === "ok")); // sidechain skipped
  assert.equal(turns[0]?.role, "user");
});

test("approvals are not flagged; corrections are", () => {
  for (const ok of ["ok", "nice", "yes", "commit", "Commit it.", "looks good", "thanks!"]) {
    assert.equal(scoreOwnerText(ok), undefined, ok);
  }
  assert.ok((scoreOwnerText("No, that's wrong. Use X instead of Y")?.score ?? 0) >= 0.7);
  assert.equal(scoreOwnerText("Please add a retry to the reader call"), undefined);
  assert.equal(scoreOwnerText("why did you remove it")?.kind, "correction");
});

test("standing rule and preference kinds", () => {
  assert.equal(scoreOwnerText("From now on always use short names")?.kind, "standing-rule");
  assert.equal(scoreOwnerText("I would prefer a plain list")?.kind, "preference");
});

test("findCorrections needs a previous assistant turn", () => {
  const turns: Turn[] = [
    { session: "s", ts: "1", role: "user", text: "No, don't do that" },
    { session: "s", ts: "2", role: "assistant", text: "Did X.\n\nAll done with X." },
    { session: "s", ts: "3", role: "user", text: "No, don't do that" },
  ];
  const c = findCorrections(turns);
  assert.equal(c.length, 1);
  assert.equal(c[0]?.ts, "3");
  assert.ok(c[0]?.context.includes("All done"));
});

test("mining: secret candidate dropped, others masked, dedupe on rerun, notes valid", () => {
  const { root, repo, cfg } = makeSessions();
  const dry = mineSessions(cfg, { repoPath: repo, minScore: 0.5, dryRun: true, sessionsRoot: root });
  assert.equal(dry.sessions, 1);
  assert.equal(dry.blocked, 1);
  assert.equal(dry.written.length, 0);
  assert.ok(dry.candidates.length >= 2);
  assert.ok(dry.candidates.every((c) => !c.owner.includes(FAKE_SECRET)));
  assert.ok(dry.candidates.some((c) => c.kind === "standing-rule"));

  const r1 = mineSessions(cfg, { repoPath: repo, minScore: 0.5, sessionsRoot: root });
  assert.equal(r1.written.length, dry.candidates.length);
  const r2 = mineSessions(cfg, { repoPath: repo, minScore: 0.5, sessionsRoot: root });
  assert.equal(r2.written.length, 0);
  assert.equal(r2.skippedDuplicate, dry.candidates.length);

  const inbox = join(cfg.vaultDir, "inbox");
  const files = readdirSync(inbox);
  assert.equal(files.length, r1.written.length);
  for (const f of files) {
    const text = readFileSync(join(inbox, f), "utf8");
    assert.ok(!text.includes(FAKE_SECRET));
    assert.ok(text.includes("## Possible rule"));
    assert.match(text, /<!-- session: \S+ \S+ hash:[0-9a-f]+ -->/);
    const sp = splitFrontmatter(text);
    const v = validateMeta(sp.data, f);
    assert.deepEqual(v.problems, []);
    assert.equal(v.meta?.type, "choice");
    assert.equal(v.meta?.status, "proposed");
    assert.equal(v.meta?.source, "session");
  }
});

test("writeCandidates drops a secret candidate directly", () => {
  const { cfg } = makeSessions();
  const r = writeCandidates(
    cfg.vaultDir,
    [{ session: "s", ts: "t", context: "ctx", owner: `use ${FAKE_SECRET}`, kind: "correction", score: 0.9 }],
    { minScore: 0.5 },
  );
  assert.equal(r.written.length, 0);
  assert.equal(r.blocked, 1);
});
