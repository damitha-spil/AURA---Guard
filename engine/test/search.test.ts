import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, upsertDoc } from "../src/index/db.ts";
import type { DocRow } from "../src/index/db.ts";
import { getDoc, search, toFtsQuery } from "../src/index/search.ts";

function seed() {
  const db = openDb(":memory:");
  const add = (d: Partial<DocRow> & { ref: string; kind: DocRow["kind"]; title: string; body: string }) =>
    upsertDoc(db, { hash: d.ref, audience: "internal_dev", ...d });
  add({ kind: "note", ref: "rule-reader", title: "Reader fallback", body: "When the reader is slow use Aura vision.", status: "active", audience: "internal_dev,qa_internal" });
  add({ kind: "note", ref: "support-reader", title: "Reader troubleshooting", body: "If the reader is slow, wait and retry.", status: "active", audience: "customer_support,internal_dev" });
  add({ kind: "note", ref: "old-reader", title: "Reader old", body: "reader reader reader", status: "stale", audience: "internal_dev" });
  add({ kind: "commit", ref: "aura@abc123", title: "Fix reader timeout", body: "reader timeout fixed", repo: "aura" });
  add({ kind: "file", ref: "aura:src/reader.rs", title: "src/reader.rs", body: "fn reader() {}", repo: "aura" });
  return db;
}

test("notes rank above commits and files when close", () => {
  const hits = search(seed(), "reader");
  assert.equal(hits[0]?.kind, "note");
  assert.ok(hits.some((h) => h.kind === "commit"));
});

test("title matches rank higher", () => {
  const db = openDb(":memory:");
  upsertDoc(db, { kind: "commit", ref: "a@1", title: "unrelated", body: "zebra", hash: "1", audience: "internal_dev" });
  upsertDoc(db, { kind: "commit", ref: "a@2", title: "zebra", body: "unrelated", hash: "2", audience: "internal_dev" });
  assert.equal(search(db, "zebra")[0]?.ref, "a@2");
});

test("special characters never throw", () => {
  const db = seed();
  for (const q of ['"', "a-b", "title:reader", "read*", "NEAR(a b)", "(reader", "reader)", "AND OR NOT", "''", "\"reader\" OR x", "", "   ", "***", "^reader", "C:\\path", "é ñ"]) {
    assert.doesNotThrow(() => search(db, q), q);
  }
  assert.ok(search(db, "title:reader").length > 0);
  assert.equal(toFtsQuery("x-y"), '"x" OR "y"*');
  assert.equal(toFtsQuery("why does the reader fail"), '"reader" OR "fail"*');
  assert.equal(toFtsQuery("the a"), '"the" OR "a"*');
  assert.equal(toFtsQuery("***"), "");
});

test("last token is a prefix", () => {
  assert.ok(search(seed(), "troubleshoot").length > 0);
  assert.ok(search(seed(), "read").length > 0);
});

test("customer_support sees only customer_support notes", () => {
  const hits = search(seed(), "reader", { audience: "customer_support" });
  assert.deepEqual(hits.map((h) => h.ref), ["support-reader"]);
});

test("qa audience sees no commits or files", () => {
  const hits = search(seed(), "reader", { audience: "qa_internal" });
  assert.deepEqual(hits.map((h) => h.ref), ["rule-reader"]);
});

test("internal_dev sees commits and files", () => {
  const kinds = new Set(search(seed(), "reader", { audience: "internal_dev" }).map((h) => h.kind));
  assert.ok(kinds.has("commit") && kinds.has("file"));
});

test("stale excluded by default, included on request", () => {
  const db = seed();
  assert.ok(!search(db, "reader").some((h) => h.ref === "old-reader"));
  assert.ok(search(db, "reader", { includeStale: true }).some((h) => h.ref === "old-reader"));
});

test("kinds filter and limit", () => {
  const db = seed();
  assert.ok(search(db, "reader", { kinds: ["commit"] }).every((h) => h.kind === "commit"));
  assert.equal(search(db, "reader", { limit: 1 }).length, 1);
});

test("getDoc respects audience", () => {
  const db = seed();
  assert.equal(getDoc(db, "support-reader", "customer_support")?.title, "Reader troubleshooting");
  assert.equal(getDoc(db, "rule-reader", "customer_support"), null);
  assert.equal(getDoc(db, "aura@abc123", "customer_support"), null);
  assert.equal(getDoc(db, "aura@abc123", "internal_dev")?.kind, "commit");
  assert.equal(getDoc(db, "missing"), null);
});
