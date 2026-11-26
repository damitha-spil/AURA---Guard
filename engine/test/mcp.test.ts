import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, upsertDoc } from "../src/index/db.ts";
import { buildServer, NOT_BUILT } from "../src/mcp/server.ts";
import type { Scope } from "../src/mcp/server.ts";
import type { Db } from "../src/index/db.ts";

async function connect(db: Db | null, scope: Scope) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = buildServer(db, scope);
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function seed() {
  const db = openDb(":memory:");
  upsertDoc(db, { kind: "note", ref: "sup", title: "Reader help", body: "wait for the reader", hash: "1", status: "active", audience: "customer_support" });
  upsertDoc(db, { kind: "note", ref: "rule-x", title: "Reader rule", body: "internal reader detail", hash: "2", status: "active", noteType: "rule", audience: "internal_dev" });
  upsertDoc(db, { kind: "commit", ref: "r@abc", title: "reader commit", body: "reader", hash: "3", audience: "internal_dev", repo: "r" });
  return db;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

test("tool lists per scope", async () => {
  const names = async (s: Scope) => (await (await connect(seed(), s)).listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(await names("support"), ["get_doc", "search_knowledge"]);
  const dev = await names("dev");
  assert.equal(dev.length, 21);
  assert.ok(dev.includes("get_blast_radius"));
  assert.ok(dev.includes("pr_readiness_report"));
  assert.ok(dev.includes("advise_architecture"));
  assert.ok(dev.includes("list_skills"));
  assert.ok(dev.includes("get_skill"));
  assert.ok(dev.includes("qe_commit_trajectory"));
  assert.ok(dev.includes("qe_code_refine_drift"));
  assert.ok(dev.includes("qa_bug_sheet"));
  assert.ok(dev.includes("qa_security_probes"));
  assert.ok(dev.includes("qa_crawl_desktop_app"));
  assert.ok(dev.includes("qa_feature_map"));
  assert.ok(dev.includes("qe_recommend_constraint"));
  assert.deepEqual(await names("qa"), dev);
});

test("support scope returns only customer_support notes", async () => {
  const c = await connect(seed(), "support");
  const r = textOf(await c.callTool({ name: "search_knowledge", arguments: { query: "reader" } }));
  assert.match(r, /sup/);
  assert.doesNotMatch(r, /rule-x|r@abc/);
  assert.match(textOf(await c.callTool({ name: "get_doc", arguments: { ref: "rule-x" } })), /Not found/);
});

test("dev scope searches commits and lists rules", async () => {
  const c = await connect(seed(), "dev");
  assert.match(textOf(await c.callTool({ name: "search_knowledge", arguments: { query: "reader" } })), /r@abc/);
  assert.match(textOf(await c.callTool({ name: "list_rules", arguments: {} })), /rule-x/);
});

test("missing index answers politely", async () => {
  const c = await connect(null, "dev");
  assert.equal(textOf(await c.callTool({ name: "search_knowledge", arguments: { query: "x" } })), NOT_BUILT);
});
