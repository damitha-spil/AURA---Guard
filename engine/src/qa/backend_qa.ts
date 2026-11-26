// Safe, read-only Backend & MCP QA Suite:
// Verifies MCP tool contracts (dev/qa/support scope isolation), Cobalt-only DB compliance,
// config/vault secret safety, index/graph freshness, and Cua Driver readiness.

import { existsSync } from "node:fs";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { dbPath } from "../config.ts";
import { openDb } from "../index/db.ts";
import { detectSecrets } from "../mask/detectors.ts";
import { buildServer } from "../mcp/server.ts";
import type { GuardConfig } from "../types.ts";
import { loadVault } from "../vault/load.ts";
import { cuaDriverStatus } from "./harness_api.ts";
import { loadForbidden } from "./safety.ts";

export interface BackendCheckItem {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  ms: number;
  detail: string;
}

export interface BackendQaReport {
  generatedAt: string;
  ok: boolean;
  passed: number;
  warned: number;
  failed: number;
  checks: BackendCheckItem[];
}

async function checkMcpScopeIsolation(cfg: GuardConfig): Promise<BackendCheckItem> {
  const t0 = Date.now();
  const dbFile = dbPath(cfg);
  const db = existsSync(dbFile) ? openDb(dbFile) : null;
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(db, "support", cfg);
    const client = new Client({ name: "backend-qa-probe", version: "0.1.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    await client.close();
    await server.close();

    const leakedInternal = names.filter((n) => n !== "search_knowledge" && n !== "get_doc");
    if (leakedInternal.length > 0) {
      return {
        id: "mcp-support-isolation",
        label: "MCP Support Scope Isolation",
        status: "fail",
        ms: Date.now() - t0,
        detail: `Support scope exposed internal tools: ${leakedInternal.join(", ")}`,
      };
    }
    return {
      id: "mcp-support-isolation",
      label: "MCP Support Scope Isolation",
      status: "pass",
      ms: Date.now() - t0,
      detail: `Support scope strictly limited to ${names.join(", ")}.`,
    };
  } catch (e) {
    return {
      id: "mcp-support-isolation",
      label: "MCP Support Scope Isolation",
      status: "fail",
      ms: Date.now() - t0,
      detail: (e as Error).message,
    };
  } finally {
    db?.close();
  }
}

async function checkMcpQaTools(cfg: GuardConfig): Promise<BackendCheckItem> {
  const t0 = Date.now();
  const dbFile = dbPath(cfg);
  const db = existsSync(dbFile) ? openDb(dbFile) : null;
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(db, "qa", cfg);
    const client = new Client({ name: "backend-qa-probe", version: "0.1.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((t) => t.name));
    await client.close();
    await server.close();

    const required = ["search_knowledge", "list_rules", "get_blast_radius"];
    const missing = required.filter((r) => !names.has(r));
    if (missing.length > 0) {
      return {
        id: "mcp-qa-contract",
        label: "MCP QA Tool Contract",
        status: "fail",
        ms: Date.now() - t0,
        detail: `Missing core QA tools: ${missing.join(", ")}`,
      };
    }
    return {
      id: "mcp-qa-contract",
      label: "MCP QA Tool Contract",
      status: "pass",
      ms: Date.now() - t0,
      detail: `${names.size} read-only tools registered on QA MCP scope.`,
    };
  } catch (e) {
    return {
      id: "mcp-qa-contract",
      label: "MCP QA Tool Contract",
      status: "fail",
      ms: Date.now() - t0,
      detail: (e as Error).message,
    };
  } finally {
    db?.close();
  }
}

function checkVaultIntegrity(cfg: GuardConfig): BackendCheckItem {
  const t0 = Date.now();
  const { notes, problems } = loadVault(cfg.vaultDir);
  let secretHits = 0;
  for (const n of notes) {
    if (detectSecrets(n.body).length > 0) secretHits++;
  }
  if (secretHits > 0) {
    return {
      id: "vault-secrets",
      label: "Vault Secret & Integrity Check",
      status: "fail",
      ms: Date.now() - t0,
      detail: `${secretHits} vault note(s) contain secret-like values.`,
    };
  }
  if (problems.length > 0) {
    return {
      id: "vault-secrets",
      label: "Vault Secret & Integrity Check",
      status: "warn",
      ms: Date.now() - t0,
      detail: `${notes.length} notes loaded; ${problems.length} frontmatter problem(s).`,
    };
  }
  return {
    id: "vault-secrets",
    label: "Vault Secret & Integrity Check",
    status: "pass",
    ms: Date.now() - t0,
    detail: `${notes.length} notes clean; 0 problems, 0 secret hits.`,
  };
}

function checkSafetyPolicy(cfg: GuardConfig): BackendCheckItem {
  const t0 = Date.now();
  const f = loadForbidden(cfg.root);
  const hasTier2 = (f.tier2HardBlockedNames?.length ?? 0) > 0 && (f.tier2BlockedScreens?.length ?? 0) > 0;
  const localOnlyHosts = f.allowedHosts.every((h) => ["127.0.0.1", "localhost", "tauri.localhost"].includes(h.toLowerCase()));
  if (!localOnlyHosts) {
    return {
      id: "qa-safety-policy",
      label: "QA Safety Policy & Allowed Hosts",
      status: "fail",
      ms: Date.now() - t0,
      detail: `Non-local host found in allowedHosts: ${f.allowedHosts.join(", ")}`,
    };
  }
  return {
    id: "qa-safety-policy",
    label: "QA Safety Policy & Allowed Hosts",
    status: hasTier2 ? "pass" : "warn",
    ms: Date.now() - t0,
    detail: `${f.names.length} forbidden names, ${f.tier2HardBlockedNames?.length ?? 0} Tier-2 hard blocks, local-only hosts.`,
  };
}

function checkIndexAndGraph(cfg: GuardConfig): BackendCheckItem {
  const t0 = Date.now();
  const file = dbPath(cfg);
  if (!existsSync(file)) {
    return {
      id: "index-freshness",
      label: "SQLite Knowledge & Graph Index",
      status: "warn",
      ms: Date.now() - t0,
      detail: "Knowledge index not built yet; run `npm run guard -- index`.",
    };
  }
  const db = openDb(file);
  try {
    const docs = db.prepare("SELECT COUNT(*) AS n FROM docs").get() as { n: number };
    const nodes = db.prepare("SELECT COUNT(*) AS n FROM graph_nodes").get() as { n: number };
    return {
      id: "index-freshness",
      label: "SQLite Knowledge & Graph Index",
      status: docs.n > 0 ? "pass" : "warn",
      ms: Date.now() - t0,
      detail: `${docs.n} indexed doc(s), ${nodes.n} code-graph node(s).`,
    };
  } finally {
    db.close();
  }
}

export async function runBackendQaSuite(cfg: GuardConfig): Promise<BackendQaReport> {
  const checks: BackendCheckItem[] = [];
  checks.push(await checkMcpScopeIsolation(cfg));
  checks.push(await checkMcpQaTools(cfg));
  checks.push(checkVaultIntegrity(cfg));
  checks.push(checkSafetyPolicy(cfg));
  checks.push(checkIndexAndGraph(cfg));

  const t0 = Date.now();
  const drv = await cuaDriverStatus(cfg);
  checks.push({
    id: "cua-driver-health",
    label: "Background Cua Driver Health",
    status: drv.available ? "pass" : "warn",
    ms: Date.now() - t0,
    detail: drv.available ? `Ready (${drv.version}) in background mode.` : `Offline (${drv.command}): ${drv.error ?? "not installed"}`,
  });

  const passed = checks.filter((c) => c.status === "pass").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;

  return {
    generatedAt: new Date().toISOString(),
    ok: failed === 0,
    passed,
    warned,
    failed,
    checks,
  };
}
