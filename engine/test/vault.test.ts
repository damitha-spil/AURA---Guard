import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/index/db.ts";
import { indexVault } from "../src/index/notes.ts";
import { loadVault } from "../src/vault/load.ts";
import { newNote } from "../src/vault/new.ts";
import { splitFrontmatter } from "../src/vault/frontmatter.ts";
import { GUARD_ROOT } from "../src/config.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "guard-vault-"));
}

function note(over: Record<string, string> = {}, body = "# Hello\n\nText."): string {
  const f: Record<string, string> = {
    id: "rule-one",
    type: "rule",
    status: "proposed",
    audience: "[internal_dev]",
    department: "dev",
    source: "import",
    created: "2026-11-20",
    ...over,
  };
  const lines = Object.entries(f).filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

function put(dir: string, rel: string, text: string): void {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

test("frontmatter handles CRLF", () => {
  const s = splitFrontmatter("---\r\nid: a\r\n---\r\n\r\nbody\r\n");
  assert.deepEqual(s.data, { id: "a" });
  assert.equal(s.body.trim(), "body");
});

test("a valid note loads with heading title and forward-slash path", () => {
  const dir = tmp();
  put(dir, "rules/rule-one.md", note());
  put(dir, "README.md", "# readme");
  put(dir, ".obsidian/x.md", "junk");
  const r = loadVault(dir);
  assert.equal(r.problems.length, 0);
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0]!.meta.title, "Hello");
  assert.equal(r.notes[0]!.file, "rules/rule-one.md");
  assert.equal(r.notes[0]!.hash.length, 64);
  rmSync(dir, { recursive: true });
});

test("bad notes give problems", () => {
  const dir = tmp();
  put(dir, "a.md", note({ id: "" }));
  put(dir, "b.md", note({ id: "rule-b", status: "wild" }));
  put(dir, "c.md", note({ id: "rule-c", audience: "[]" }));
  put(dir, "d.md", note({ id: "rule-d", created: "20/11/2026" }));
  put(dir, "e.md", note({ id: "Not Kebab" }));
  put(dir, "f.md", "no frontmatter");
  put(dir, "g1.md", note({ id: "rule-dup" }));
  put(dir, "g2.md", note({ id: "rule-dup" }));
  const r = loadVault(dir);
  const by = (f: string) => r.problems.filter((p) => p.file === f);
  assert.ok(by("a.md").length > 0);
  assert.match(by("b.md")[0]!.message, /status/);
  assert.match(by("c.md")[0]!.message, /audience/);
  assert.match(by("d.md")[0]!.message, /created/);
  assert.match(by("e.md")[0]!.message, /kebab/);
  assert.match(by("f.md")[0]!.message, /frontmatter/);
  assert.match(by("g2.md")[0]!.message, /duplicate/);
  assert.equal(r.notes.length, 1);
  rmSync(dir, { recursive: true });
});

test("indexVault adds, skips unchanged, updates, removes, fills anchors", () => {
  const dir = tmp();
  const db = openDb(":memory:");
  const anchored = note({ id: "rule-one" }).replace(
    "---\n\n",
    "code_anchors:\n  - repo: r\n    path: a/b.ts\n    symbol: f\n---\n\n",
  );
  put(dir, "rules/rule-one.md", anchored);
  put(dir, "rules/rule-two.md", note({ id: "rule-two" }));
  let r = indexVault(db, dir);
  assert.deepEqual([r.added, r.updated, r.removed], [2, 0, 0]);
  const a = db.prepare("SELECT * FROM anchors WHERE note_id='rule-one'").all() as { path: string }[];
  assert.equal(a.length, 1);
  assert.equal(a[0]!.path, "a/b.ts");

  r = indexVault(db, dir);
  assert.deepEqual([r.added, r.updated, r.removed], [0, 0, 0]);

  put(dir, "rules/rule-one.md", note({ id: "rule-one", audience: "[internal_dev, qa_internal]" }));
  r = indexVault(db, dir);
  assert.deepEqual([r.added, r.updated, r.removed], [0, 1, 0]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM anchors").get()!.c, 0);
  const row = db.prepare("SELECT audience, status, kind FROM docs WHERE ref='rule-one'").get() as {
    audience: string; status: string; kind: string;
  };
  assert.deepEqual({ ...row }, { audience: "internal_dev,qa_internal", status: "proposed", kind: "note" });

  rmSync(join(dir, "rules/rule-two.md"));
  r = indexVault(db, dir);
  assert.deepEqual([r.added, r.updated, r.removed], [0, 0, 1]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM docs").get()!.c, 1);
  rmSync(dir, { recursive: true });
});

test("newNote writes a proposed note and never overwrites", () => {
  const dir = tmp();
  const p1 = newNote(dir, { type: "rule", title: "Use Small Steps!", body: "Do it." });
  const p2 = newNote(dir, { type: "rule", title: "Use Small Steps!", body: "Again." });
  assert.notEqual(p1, p2);
  assert.ok(existsSync(p1) && existsSync(p2));
  assert.match(p1.replace(/\\/g, "/"), /rules\/rule-use-small-steps\.md$/);
  assert.match(readFileSync(p1, "utf8"), /status: proposed/);
  const r = loadVault(dir);
  assert.equal(r.problems.length, 0);
  assert.deepEqual(r.notes.map((n) => n.meta.id).sort(), ["rule-use-small-steps", "rule-use-small-steps-2"]);
  rmSync(dir, { recursive: true });
});

test("every note in the real vault is valid", () => {
  const r = loadVault(join(GUARD_ROOT, "vault"));
  assert.deepEqual(r.problems, []);
  assert.ok(r.notes.length >= 8);
});
