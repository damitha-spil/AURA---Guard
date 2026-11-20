import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/index/db.ts";
import { blastRadius, importGraphify, MAX_GRAPH_DEPTH, neighbours } from "../src/index/graph.ts";

// Same node-link shape graphify writes: nodes[] with id/label/file_type/source_file, links[] with source/target/relation.
const graph = {
  directed: true,
  multigraph: false,
  nodes: [
    { id: "ui_app", label: "App.tsx", file_type: "code", source_file: "apps/ui/App.tsx" },
    { id: "ui_app_render", label: "render", file_type: "code", source_file: "apps/ui/App.tsx" },
    { id: "core_desk", label: "desk.rs", file_type: "code", source_file: "crates/core/desk.rs" },
    { id: "core_route", label: "route_job", file_type: "code", source_file: "crates/core/desk.rs" },
    { id: "core_store", label: "store.rs", file_type: "code", source_file: "crates/core/store.rs" },
    { id: "lonely", label: "lonely.ts", file_type: "code", source_file: "tools/lonely.ts" },
  ],
  links: [
    { source: "ui_app", target: "ui_app_render", relation: "contains", confidence: "EXTRACTED" },
    { source: "ui_app_render", target: "core_route", relation: "calls", confidence: "INFERRED" },
    { source: "core_route", target: "core_desk", relation: "contains", confidence: "EXTRACTED" },
    { source: "core_route", target: "core_store", relation: "calls", confidence: "EXTRACTED" },
  ],
};

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "guard-graph-"));
  const file = join(dir, "graph.json");
  writeFileSync(file, JSON.stringify(graph));
  return file;
}

test("import loads nodes and edges and replaces a repo's rows", () => {
  const db = openDb(":memory:");
  const file = fixture();
  assert.deepEqual(importGraphify(db, "aura", file), { nodes: 6, edges: 4 });
  assert.deepEqual(importGraphify(db, "aura", file), { nodes: 6, edges: 4 });
  const n = db.prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE repo='aura'").get() as { n: number };
  assert.equal(n.n, 4);
  rmSync(file, { force: true });
});

test("import refuses a file that is not node-link JSON and keeps old rows", () => {
  const db = openDb(":memory:");
  const file = fixture();
  importGraphify(db, "aura", file);
  writeFileSync(file, JSON.stringify({ hello: 1 }));
  assert.throws(() => importGraphify(db, "aura", file), /Not a graphify graph.json/);
  const n = db.prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE repo='aura'").get() as { n: number };
  assert.equal(n.n, 6);
  rmSync(file, { force: true });
});

test("blast radius lists what depends on a file, two hops, skipping the file itself", () => {
  const db = openDb(":memory:");
  const file = fixture();
  importGraphify(db, "aura", file);
  // Who depends on store.rs: route_job calls it (1 hop), render calls route_job (2 hops).
  const hits = blastRadius(db, "aura", "crates/core/store.rs");
  assert.equal(MAX_GRAPH_DEPTH, 2);
  assert.deepEqual(hits.map((h) => [h.id, h.depth]), [["core_route", 1], ["ui_app_render", 2]]);
  assert.ok(hits.every((h) => h.path !== "crates/core/store.rs"));
  // Nothing uses App.tsx, so changing it affects no other file. Direction matters.
  assert.deepEqual(blastRadius(db, "aura", "apps/ui/App.tsx"), []);
  rmSync(file, { force: true });
});

test("blast radius of a file with no graph nodes is empty; paths accept backslashes", () => {
  const db = openDb(":memory:");
  const file = fixture();
  importGraphify(db, "aura", file);
  assert.deepEqual(blastRadius(db, "aura", "missing/file.ts"), []);
  // render calls into desk.rs (1 hop); App.tsx contains render (2 hops). Same-file edges are skipped.
  assert.deepEqual(blastRadius(db, "aura", "crates\\core\\desk.rs").map((h) => h.id), ["ui_app_render", "ui_app"]);
  rmSync(file, { force: true });
});

test("neighbours walks both directions and clamps depth", () => {
  const db = openDb(":memory:");
  const file = fixture();
  importGraphify(db, "aura", file);
  const one = neighbours(db, "aura", "core_route", 1).map((h) => h.id).sort();
  assert.deepEqual(one, ["core_desk", "core_store", "ui_app_render"]);
  const deep = neighbours(db, "aura", "ui_app", 9 as 2).map((h) => h.id);
  assert.ok(deep.includes("core_route"));
  assert.ok(!deep.includes("core_store"), "depth is capped at MAX_GRAPH_DEPTH");
  rmSync(file, { force: true });
});
