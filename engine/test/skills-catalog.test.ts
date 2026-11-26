import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { detectSecrets } from "../src/mask/detectors.ts";
import { buildServer } from "../src/mcp/server.ts";
import { getSkill, listSkills } from "../src/roles/skills.ts";
import type { GuardConfig } from "../src/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");

test("Skill Registry loads all Security, QA, QE, and Core skills cleanly with zero secrets", () => {
  const all = listSkills(ROOT);
  assert.ok(all.length >= 32, `expected at least 32 skills, got ${all.length}`);

  const sec = listSkills(ROOT, "security");
  const qa = listSkills(ROOT, "qa");
  const qe = listSkills(ROOT, "qe");
  const core = listSkills(ROOT, "core");

  assert.equal(sec.length, 10);
  assert.ok(qa.length >= 12);
  assert.equal(qe.length, 6);
  assert.ok(core.length >= 4);

  for (const s of all) {
    assert.ok(s.name.length > 0);
    assert.ok(s.description.length > 10, `short description for ${s.name}`);
    const full = getSkill(ROOT, s.name);
    assert.ok(full && full.body.length > 50, `empty body for ${s.name}`);
    assert.equal(detectSecrets(full.body).length, 0, `secret detected in skill ${s.name}`);
  }

  // Reject path traversal
  assert.equal(getSkill(ROOT, "../package.json"), null);
  assert.equal(getSkill(ROOT, "nonexistent-skill-id"), null);

  assert.ok(getSkill(ROOT, "sec-audit-master")?.body.includes("Zero-Trust"));
  assert.ok(getSkill(ROOT, "qa-swagger-api")?.body.includes("OpenAPI"));
  assert.ok(getSkill(ROOT, "qe-commit-trajectory")?.body.includes("Pivot"));
});

test("MCP list_skills and get_skill expose modular skills on dev/qa scopes", async () => {
  const cfg: GuardConfig = { root: ROOT, dataDir: join(ROOT, "data"), vaultDir: join(ROOT, "vault"), repos: [], busyProcesses: [] };
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  const server = buildServer(null, "qa", cfg);
  const client = new Client({ name: "skills-test", version: "0.1.0" }, { capabilities: {} });
  await Promise.all([server.connect(sT), client.connect(cT)]);

  const listed = await client.callTool({ name: "list_skills", arguments: { category: "security" } });
  const listText = ((listed.content as { text: string }[])[0]!).text;
  const parsed = JSON.parse(listText) as { name: string }[];
  assert.equal(parsed.length, 10);
  assert.ok(parsed.some((s) => s.name === "sec-auth-access"));

  const fetched = await client.callTool({ name: "get_skill", arguments: { name: "qe-release-gate" } });
  const fetchText = ((fetched.content as { text: string }[])[0]!).text;
  assert.match(fetchText, /# qe-release-gate \[qe\]/);

  await client.close();
  await server.close();
});
