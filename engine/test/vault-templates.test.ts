import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVault } from "../src/vault/load.ts";
import { GUARD_ROOT } from "../src/config.ts";

test("loader skips _templates and .obsidian, so template placeholders are never parsed as notes", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-tpl-"));
  mkdirSync(join(dir, "_templates"));
  writeFileSync(join(dir, "_templates", "rule.md"), "---\nid: {{title}}\ncreated: {{date:YYYY-MM-DD}}\n---\n");
  mkdirSync(join(dir, ".obsidian"));
  writeFileSync(join(dir, ".obsidian", "x.md"), "junk");
  const r = loadVault(dir);
  assert.equal(r.notes.length, 0);
  assert.equal(r.problems.length, 0);
  rmSync(dir, { recursive: true });
});

test("the shipped templates are valid note frontmatter once the placeholders are filled in", async () => {
  const { validateMeta } = await import("../src/vault/schema.ts");
  const { splitFrontmatter } = await import("../src/vault/frontmatter.ts");
  const dir = join(GUARD_ROOT, "vault", "_templates");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 7);
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8")
      .replace("{{date:YYYY-MM-DD}}", "2026-11-20")
      .replace('"{{title}}"', '"Sample title"')
      .replace("-replace-with-kebab-id", "-sample");
    const sp = splitFrontmatter(text);
    const v = validateMeta(sp.data, f);
    assert.deepEqual(v.problems, [], f);
    assert.equal(v.meta?.status, "proposed", f);
  }
});
