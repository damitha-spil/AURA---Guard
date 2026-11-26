// Read-only MCP server over stdio. Never write to stdout: it is the protocol.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dbPath, envValue, loadConfig } from "../config.ts";
import { PRODUCT_NAME } from "../brand.ts";
import { openDb } from "../index/db.ts";
import type { Db } from "../index/db.ts";
import { getDoc, search } from "../index/search.ts";
import { historyFor } from "../index/history.ts";
import { coChanged } from "../index/cochange.ts";
import { findStale } from "../index/stale.ts";
import { blastRadius } from "../index/graph.ts";
import { adviseDeveloper } from "../chat/advisor.ts";
import { buildPrReadinessReport } from "../prs/manager.ts";
import { buildPrEvidencePacket } from "../qa/evidence.ts";
import { cuaDriverStatus } from "../qa/harness_api.ts";
import { planTests } from "../qa/planner.ts";
import { loadForbidden } from "../qa/safety.ts";
import { buildBugSheet } from "../qa/defects.ts";
import { crawlDesktopApp } from "../qa/desktop_crawler.ts";
import { findFeatureEntry } from "../qa/feature_map.ts";
import { runSecurityProbes } from "../qa/security_probes.ts";
import { recommendDurableConstraint } from "../qe/constraints.ts";
import { analyzeRefinementAndKbDrift } from "../qe/refine.ts";
import { analyzeCommitTrajectory } from "../qe/trajectory.ts";
import { getSkill, listSkills } from "../roles/skills.ts";
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
export function buildServer(db: Db | null, scope: Scope, cfg?: GuardConfig): McpServer {
  const audience = SCOPE_AUDIENCE[scope];
  const server = new McpServer({ name: "aura-guard", title: PRODUCT_NAME, version: "0.1.0" });
  const run = (fn: (d: Db) => string): Text => {
    if (!db) return text(NOT_BUILT);
    try {
      return text(fn(db));
    } catch (e) {
      return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const resolveCfg = (): GuardConfig => cfg ?? loadConfig();

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

  server.registerTool(
    "qa_plan_for_diff",
    {
      description: "Return risk-ranked QA journeys and gaps for the current repository diff (read-only).",
      inputSchema: { repo: z.string().optional(), base: z.string().optional(), head: z.string().optional() },
    },
    async ({ repo, base, head }) => {
      try {
        const c = resolveCfg();
        const repoId = repo ?? c.repos[0]?.id ?? "spil-aura";
        const plan = await planTests(c, db, { repo: repoId, ...(base ? { base } : {}), ...(head ? { head } : {}) }, {});
        return text(JSON.stringify(plan, null, 2));
      } catch (e) {
        return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "qa_get_evidence_packet",
    {
      description: "Build and return a redacted PR evidence packet summary for a persisted QA run ID.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      try {
        const built = await buildPrEvidencePacket(resolveCfg(), runId);
        if (!built) return text(`No QA run found for ID: ${runId}`);
        return text(built.markdown);
      } catch (e) {
        return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "qa_check_driver_health",
    { description: "Check background Cua Driver availability and tiered safety policy limits.", inputSchema: {} },
    async () => {
      const c = resolveCfg();
      const drv = await cuaDriverStatus(c);
      const policy = loadForbidden(c.root);
      return text(JSON.stringify({ driver: drv, tier1SafeCount: policy.tier1SafeNames?.length ?? 0, tier2HardBlockCount: policy.tier2HardBlockedNames?.length ?? 0 }, null, 2));
    },
  );

  server.registerTool(
    "pr_readiness_report",
    {
      description: "Return PR readiness checklist, Tier 0 defect/policy findings, blast radius, and developer suggestions.",
      inputSchema: { repo: z.string().optional(), base: z.string().optional(), head: z.string().optional() },
    },
    ({ repo, base, head }) => {
      const report = buildPrReadinessReport(resolveCfg(), db, { ...(repo ? { repo } : {}), ...(base ? { base } : {}), ...(head ? { head } : {}) });
      return text(report.prSummaryMarkdown);
    },
  );

  server.registerTool(
    "advise_architecture",
    {
      description: "Wise Advisor brief combining active rules, proposed hints, past incidents, ADRs, blast radius, and co-changed files.",
      inputSchema: { query: z.string(), repo: z.string().optional(), path: z.string().optional() },
    },
    ({ query, repo, path }) => {
      const brief = adviseDeveloper(resolveCfg(), db, query, { ...(repo ? { repo } : {}), ...(path ? { path } : {}) });
      return text(JSON.stringify(brief, null, 2));
    },
  );

  server.registerTool(
    "list_skills",
    {
      description: "List available Security (sec-*), QA (qa-*), QE (qe-*), and Core skills for Guard.",
      inputSchema: { category: z.enum(["security", "qa", "qe", "core"]).optional() },
    },
    ({ category }) => {
      const skills = listSkills(resolveCfg().root, category);
      return text(JSON.stringify(skills, null, 2));
    },
  );

  server.registerTool(
    "get_skill",
    {
      description: "Load the full checklist and instructions for a named Security, QA, QE, or Core skill.",
      inputSchema: { name: z.string() },
    },
    ({ name }) => {
      const skill = getSkill(resolveCfg().root, name);
      if (!skill) return text(`Skill not found: ${name}`);
      return text(`# ${skill.name} [${skill.category}]\n${skill.description}\n\n${skill.body}`);
    },
  );

  server.registerTool(
    "qe_commit_trajectory",
    {
      description: "Analyze daily/branch commit trajectory, fixup churn, pivots, scope atomicity, and cross-author overlaps.",
      inputSchema: { repo: z.string().optional(), base: z.string().optional(), head: z.string().optional() },
    },
    ({ repo, base, head }) => {
      const rep = analyzeCommitTrajectory(resolveCfg(), db, { ...(repo ? { repo } : {}), ...(base ? { base } : {}), ...(head ? { head } : {}) });
      return text(JSON.stringify(rep, null, 2));
    },
  );

  server.registerTool(
    "qe_code_refine_drift",
    {
      description: "Run structural code refinement (complexity, duplication, magic numbers) and KB drift detection.",
      inputSchema: { repo: z.string().optional(), base: z.string().optional(), head: z.string().optional() },
    },
    ({ repo, base, head }) => {
      const rep = analyzeRefinementAndKbDrift(resolveCfg(), db, { ...(repo ? { repo } : {}), ...(base ? { base } : {}), ...(head ? { head } : {}) });
      return text(JSON.stringify(rep, null, 2));
    },
  );

  server.registerTool(
    "qa_bug_sheet",
    {
      description: "Generate a deduplicated Bug Sheet (fingerprints, Markdown, CSV, ticket drafts) for a QA run ID.",
      inputSchema: { runId: z.string() },
    },
    ({ runId }) => {
      const sheet = buildBugSheet(resolveCfg(), runId);
      if (!sheet) return text(`No QA run found for ID: ${runId}`);
      return text(sheet.markdown);
    },
  );

  server.registerTool(
    "qa_security_probes",
    {
      description: "Run safe local-only adversarial security probes (SQLi canary, XSS, traversal, headers, secrets) on a local test URL.",
      inputSchema: { baseUrl: z.string(), paths: z.array(z.string()).optional() },
    },
    async ({ baseUrl, paths }) => {
      try {
        const rep = await runSecurityProbes(resolveCfg(), { baseUrl, ...(paths ? { paths } : {}) });
        return text(JSON.stringify(rep, null, 2));
      } catch (e) {
        return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "qa_crawl_desktop_app",
    {
      description: "Crawl an allowed Windows desktop app via UIA (default dryRun=true) and optionally click safe Tier 0/1 controls.",
      inputSchema: { matchTitle: z.string().optional(), dryRun: z.boolean().optional(), maxActions: z.number().int().min(1).max(10).optional() },
    },
    async ({ matchTitle, dryRun, maxActions }) => {
      try {
        const rep = await crawlDesktopApp(resolveCfg(), {
          ...(matchTitle ? { matchTitle } : {}),
          dryRun: dryRun ?? true,
          ...(maxActions !== undefined ? { maxActions } : {}),
        });
        return text(JSON.stringify(rep, null, 2));
      } catch (e) {
        return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "qa_feature_map",
    {
      description: "Look up verified user-visible features, entry points, prerequisites, navigation steps, and code anchors.",
      inputSchema: { query: z.string().optional() },
    },
    ({ query }) => {
      const entries = findFeatureEntry(resolveCfg(), query ?? "");
      return text(JSON.stringify(entries, null, 2));
    },
  );

  server.registerTool(
    "qe_recommend_constraint",
    {
      description: "Recommend the smallest effective durable constraint (architecture, mechanical check, vault rule, or skill) for a repeated correction.",
      inputSchema: {
        pattern: z.string(),
        occurrences: z.number().int().min(1).optional(),
        mechanicallyDetectable: z.boolean().optional(),
        canDesignOutInTypesOrApi: z.boolean().optional(),
        isMultiStepProcedure: z.boolean().optional(),
      },
    },
    ({ pattern, occurrences, mechanicallyDetectable, canDesignOutInTypesOrApi, isMultiStepProcedure }) => {
      const rec = recommendDurableConstraint({
        pattern,
        occurrences: occurrences ?? 1,
        mechanicallyDetectable: mechanicallyDetectable ?? false,
        canDesignOutInTypesOrApi: canDesignOutInTypesOrApi ?? false,
        isMultiStepProcedure: isMultiStepProcedure ?? false,
      });
      return text(JSON.stringify(rec, null, 2));
    },
  );

  return server;
}

async function main(): Promise<void> {
  const scope = parseScope(envValue("SCOPE"));
  const cfg = loadConfig();
  const file = dbPath(cfg);
  const db = existsSync(file) ? openDb(file) : null;
  await buildServer(db, scope, cfg).connect(new StdioServerTransport());
  console.error(`aura-guard MCP ready (scope ${scope})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
