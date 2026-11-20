// Code graph from graphify (https://github.com/graphify-labs/graphify). Its
// graph.json (NetworkX node-link form) is imported into the same SQLite index.
// These tables are created here, not in db.ts, so the shared schema stays put.

import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";

// A walk deeper than this reaches most of a 20k-node graph, and the answer
// stops being useful for a review or a question.
export const MAX_GRAPH_DEPTH = 2;
// One walk returns at most this many nodes, so an MCP answer stays readable.
export const MAX_GRAPH_ROWS = 200;

/** One node of graphify's graph.json. Only the fields Guard uses are typed. */
export interface GraphifyNode {
  id: string;
  label?: string;
  file_type?: string;
  source_file?: string;
}

/** One edge of graphify's graph.json, stored under "links". */
export interface GraphifyLink {
  source: string;
  target: string;
  relation?: string;
}

export interface GraphifyFile {
  nodes: GraphifyNode[];
  links: GraphifyLink[];
}

export interface GraphHit {
  id: string;
  label: string;
  kind: string;
  path: string;
  depth: number;
}

export interface ImportCounts {
  nodes: number;
  edges: number;
}

export function ensureGraphTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      repo TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL,
      kind TEXT NOT NULL, path TEXT NOT NULL,
      PRIMARY KEY (repo, id)
    );
    CREATE INDEX IF NOT EXISTS graph_nodes_path ON graph_nodes(repo, path);
    CREATE TABLE IF NOT EXISTS graph_edges (
      repo TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS graph_edges_src ON graph_edges(repo, src);
    CREATE INDEX IF NOT EXISTS graph_edges_dst ON graph_edges(repo, dst);
    -- HEAD sha of the repo when its graph was last built, so index can skip an unchanged repo.
    CREATE TABLE IF NOT EXISTS graph_state (repo TEXT PRIMARY KEY, sha TEXT NOT NULL);
  `);
}

/** Replace one repo's graph with the contents of a graphify graph.json. */
export function importGraphify(db: Db, repo: string, graphJsonPath: string): ImportCounts {
  ensureGraphTables(db);
  const g = JSON.parse(readFileSync(graphJsonPath, "utf8")) as Partial<GraphifyFile>;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.links)) {
    throw new Error("Not a graphify graph.json: expected \"nodes\" and \"links\" arrays");
  }
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM graph_edges WHERE repo=?").run(repo);
    db.prepare("DELETE FROM graph_nodes WHERE repo=?").run(repo);
    const insNode = db.prepare(
      "INSERT OR IGNORE INTO graph_nodes(repo, id, label, kind, path) VALUES (?,?,?,?,?)",
    );
    let nodes = 0;
    for (const n of g.nodes) {
      const r = insNode.run(
        repo,
        String(n.id),
        n.label ?? String(n.id),
        n.file_type ?? "",
        normPath(n.source_file ?? ""),
      );
      nodes += Number(r.changes);
    }
    const insEdge = db.prepare("INSERT INTO graph_edges(repo, src, dst, kind) VALUES (?,?,?,?)");
    for (const l of g.links) insEdge.run(repo, String(l.source), String(l.target), l.relation ?? "");
    db.exec("COMMIT");
    return { nodes, edges: g.links.length };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function normPath(p: string): string {
  return p.split("\\").join("/").replace(/^\.\//, "");
}

type Direction = "out" | "in" | "both";

/**
 * Breadth-first walk from the start nodes. "out" follows edges from a node to
 * what it uses; "in" follows edges pointing at it (its users); "both" does both.
 */
function walk(db: Db, repo: string, starts: string[], depth: number, dir: Direction): GraphHit[] {
  const seen = new Map<string, number>();
  for (const s of starts) seen.set(s, 0);
  const outStmt = db.prepare("SELECT dst AS id FROM graph_edges WHERE repo=? AND src=?");
  const inStmt = db.prepare("SELECT src AS id FROM graph_edges WHERE repo=? AND dst=?");
  let frontier = [...starts];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const rows: { id: string }[] = [];
      if (dir !== "in") rows.push(...(outStmt.all(repo, cur) as { id: string }[]));
      if (dir !== "out") rows.push(...(inStmt.all(repo, cur) as { id: string }[]));
      for (const r of rows) {
        if (!seen.has(r.id)) {
          seen.set(r.id, d);
          next.push(r.id);
        }
      }
    }
    frontier = next;
  }
  const nodeStmt = db.prepare("SELECT label, kind, path FROM graph_nodes WHERE repo=? AND id=?");
  const hits: GraphHit[] = [];
  for (const [id, d] of seen) {
    if (d === 0) continue;
    const n = nodeStmt.get(repo, id) as { label: string; kind: string; path: string } | undefined;
    hits.push({ id, label: n?.label ?? id, kind: n?.kind ?? "", path: n?.path ?? "", depth: d });
  }
  hits.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  return hits.slice(0, MAX_GRAPH_ROWS);
}

/** Nodes within `depth` hops in either direction. Matches a node id or a file path. */
export function neighbours(db: Db, repo: string, nodeOrPath: string, depth: 1 | 2 = 1): GraphHit[] {
  ensureGraphTables(db);
  const key = normPath(nodeOrPath);
  const starts = (
    db.prepare("SELECT id FROM graph_nodes WHERE repo=? AND (id=? OR path=?)").all(repo, nodeOrPath, key) as {
      id: string;
    }[]
  ).map((r) => r.id);
  return walk(db, repo, starts, Math.min(Math.max(1, depth), MAX_GRAPH_DEPTH), "both");
}

/**
 * What depends on a file: code that uses it, up to MAX_GRAPH_DEPTH hops along
 * incoming edges (graphify edges point from the user to what it uses).
 * Nodes that live in the same file are left out.
 */
export function blastRadius(db: Db, repo: string, path: string): GraphHit[] {
  ensureGraphTables(db);
  const key = normPath(path);
  const starts = (
    db.prepare("SELECT id FROM graph_nodes WHERE repo=? AND path=?").all(repo, key) as { id: string }[]
  ).map((r) => r.id);
  return walk(db, repo, starts, MAX_GRAPH_DEPTH, "in").filter((h) => h.path !== key);
}
