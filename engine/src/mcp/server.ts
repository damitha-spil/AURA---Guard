// Read-only MCP server over stdio. Never write to stdout: it is the protocol.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dbPath, envValue, loadConfig } from "../config.ts";
import { PRODUCT_NAME } from "../brand.ts";
import { loadRegistry, resolveDepartment } from "../departments/registry.ts";
import { openDb } from "../index/db.ts";
import type { Db } from "../index/db.ts";
import { getDoc, search } from "../index/search.ts";
import { historyFor } from "../index/history.ts";
import { coChanged } from "../index/cochange.ts";
import { findStale } from "../index/stale.ts";
import { blastRadius } from "../index/graph.ts";
import type { Audience, DocKind, GuardConfig } from "../types.ts";

export type Scope = "dev" | "qa" | "support";

export const SCOPE_AUDIENCE: Record<Scope, Audience> = {
  dev: "internal_dev",
  qa: "qa_internal",
  support: "customer_support",
};

export const NOT_BUILT = "Index not built yet; run `npm run guard -- index`";

export function parseScope(v: string | undefined): Scope {
  return v === "qa" || v === "support" ? v : "dev";
}

type Text = { content: { type: "text"; text: string }[] };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });

/** `db` may be null when the index file does not exist yet. */
export function buildServer(db: Db | null, scope: Scope, departmentName?: string): McpServer {
  const audience = SCOPE_AUDIENCE[scope];
  const server = new McpServer(
    { name: "aura-guard", title: PRODUCT_NAME, version: "0.1.0" },
    departmentName ? { instructions: `Knowledge of the ${departmentName} department only.` } : {},
  );
  const run = (fn: (d: Db) => string): Text => {
    if (!db) return text(NOT_BUILT);
    try {
      return text(fn(db));
    } catch (e) {
      return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  server.registerTool(
    "search_knowledge",
    {
      description: "Search notes, commits and files. Cite the ref of each result.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
        kinds: z.array(z.enum(["note", "commit", "file"])).optional(),
      },
    },
    ({ query, limit, kinds }) =>
      run((d) => {
        const opts: { audience: Audience; limit?: number; kinds?: DocKind[] } = { audience };
        if (limit !== undefined) opts.limit = limit;
        if (kinds) opts.kinds = kinds;
        const hits = search(d, query, opts);
        if (hits.length === 0) return "No results.";
        return hits.map((h) => `[${h.kind}] ${h.ref}\n${h.title}\n${h.snippet}`).join("\n\n");
      }),
  );

  server.registerTool(
    "get_doc",
    { description: "Get the full text of a note, commit or file by ref.", inputSchema: { ref: z.string() } },
    ({ ref }) =>
      run((d) => {
        const doc = getDoc(d, ref, audience);
        return doc ? `${doc.ref}\n${doc.title}\n\n${doc.body}` : `Not found: ${ref}`;
      }),
  );

  if (scope === "support") return server;

  server.registerTool(
    "trace_history",
    {
      description: "Recent commits that touched a path prefix.",
      inputSchema: { repo: z.string(), path: z.string(), limit: z.number().int().min(1).max(100).optional() },
    },
    ({ repo, path, limit }) =>
      run((d) => {
        const rows = historyFor(d, repo, path, limit);
        if (rows.length === 0) return "No history found.";
        return rows.map((r) => `${repo}@${r.sha} ${r.date.slice(0, 10)} ${r.subject}\n  ${r.files.join(", ")}`).join("\n");
      }),
  );

  server.registerTool(
    "co_changed",
    {
      description: "Files that usually change together with this one.",
      inputSchema: { repo: z.string(), path: z.string(), limit: z.number().int().min(1).max(100).optional() },
    },
    ({ repo, path, limit }) =>
      run((d) => {
        const rows = coChanged(d, repo, path, limit);
        if (rows.length === 0) return "No co-changed files found.";
        return rows.map((r) => `${repo}:${r.path} together ${r.together}x (${Math.round(r.ratio * 100)}%)`).join("\n");
      }),
  );

  server.registerTool(
    "get_blast_radius",
    {
      description: "Code that depends on a file (uses it), up to two hops along the code graph.",
      inputSchema: { repo: z.string(), path: z.string() },
    },
    ({ repo, path }) =>
      run((d) => {
        const rows = blastRadius(d, repo, path);
        if (rows.length === 0) return "No graph nodes found for that path.";
        return rows.map((r) => `${r.depth}  ${r.path || r.id}  (${r.label})`).join("\n");
      }),
  );

  server.registerTool(
    "list_rules",
    {
      description: "List rule notes, optionally by status.",
      inputSchema: { status: z.enum(["proposed", "shadow", "active", "stale", "deprecated"]).optional() },
    },
    ({ status }) =>
      run((d) => {
        // Rule notes are found by their frontmatter type, not their id.
        const rows = d
          .prepare("SELECT ref, title, status, audience FROM docs WHERE kind='note' AND note_type='rule' ORDER BY ref")
          .all() as { ref: string; title: string; status: string; audience: string }[];
        const mine = rows.filter(
          (r) => r.audience.split(",").map((s) => s.trim()).includes(audience) && (!status || r.status === status),
        );
        if (mine.length === 0) return "No rules found.";
        return mine.map((r) => `${r.ref} [${r.status}] ${r.title}`).join("\n");
      }),
  );

  server.registerTool(
    "stale_notes",
    { description: "Notes whose anchored code changed since they were last checked.", inputSchema: {} },
    () =>
      run((d) => {
        const rows = findStale(d);
        if (rows.length === 0) return "No stale notes.";
        return rows
          .map((r) => `${r.noteId} (${r.repo}:${r.path})\n` + r.commits.map((c) => `  ${r.repo}@${c.sha} ${c.subject}`).join("\n"))
          .join("\n");
      }),
  );

  return server;
}

/** The department this server serves: QSB_DEPT or AURA_GUARD_DEPT, else the registry default. */
export function mcpConfig(base: GuardConfig, env: Record<string, string | undefined> = process.env): GuardConfig {
  return resolveDepartment(loadRegistry(base), envValue("DEPT", env), PRODUCT_NAME).cfg;
}

async function main(): Promise<void> {
  const scope = parseScope(envValue("SCOPE"));
  const cfg = mcpConfig(loadConfig());
  const file = dbPath(cfg);
  const db = existsSync(file) ? openDb(file) : null;
  await buildServer(db, scope, cfg.departmentName).connect(new StdioServerTransport());
  console.error(`aura-guard MCP ready (scope ${scope}, department ${cfg.departmentId ?? "default"})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
