// SPIL REO — Central Permission-Tiered Tool Library.
// Lists built-in tools + external plugin/MCP tools with explicit risk tiers.

export type ToolCategory = "repo" | "vault" | "ui-driver" | "security" | "api" | "report" | "plugin";
export type ToolRiskTier = "read_only" | "local_action" | "external_notify";

export interface ToolEntry {
  id: string;
  name: string;
  category: ToolCategory;
  riskTier: ToolRiskTier;
  requiresConfirmation: boolean;
  source: "builtin" | "mcp" | "composio";
  description: string;
}

export const BUILTIN_TOOLS: readonly ToolEntry[] = [
  { id: "search_knowledge", name: "Search Knowledge", category: "vault", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "FTS5 search across Obsidian vault notes, docs, and commits." },
  { id: "get_doc", name: "Read Vault Note", category: "vault", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Read a full vault note or indexed document by reference." },
  { id: "list_rules", name: "List Active Rules", category: "vault", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "List approved active engineering rules from the vault." },
  { id: "stale_notes", name: "Detect Stale Notes", category: "vault", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Find vault notes whose code anchors changed in recent commits." },
  { id: "trace_history", name: "Trace Git History", category: "repo", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Read commit history for a file or symbol (read-only git)." },
  { id: "co_changed", name: "Co-Change Graph", category: "repo", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Find files that historically change together across repos." },
  { id: "get_blast_radius", name: "AST Blast Radius", category: "repo", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Compute downstream dependents from the Graphify AST code graph." },
  { id: "qe_commit_trajectory", name: "QE Commit Trajectory", category: "repo", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Detect fixup churn, mid-branch pivots, and cross-author overlaps." },
  { id: "qe_code_refine_drift", name: "Code Refine & KB Drift", category: "repo", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Flag deep nesting, duplicate logic, and undocumented modules." },
  { id: "qe_recommend_constraint", name: "Durable Constraint Advisor", category: "vault", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Recommend smallest effective constraint (architecture -> check -> rule -> skill)." },
  { id: "qa_crawl_desktop_app", name: "Windows UIA Desktop Crawler", category: "ui-driver", riskTier: "local_action", requiresConfirmation: true, source: "builtin", description: "Inspect and crawl allowed desktop app windows via Windows UIA." },
  { id: "qa_feature_map", name: "Feature Map Lookup", category: "ui-driver", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Resolve UI features to source files, routes, and verification specs." },
  { id: "qa_openapi_checks", name: "OpenAPI Contract Runner", category: "api", riskTier: "local_action", requiresConfirmation: false, source: "builtin", description: "Run safe read-only/boundary checks against local OpenAPI endpoints." },
  { id: "qa_security_probes", name: "Local Security Probes", category: "security", riskTier: "local_action", requiresConfirmation: false, source: "builtin", description: "Run local-only SQLi, XSS, header, path-traversal, and secret-leak probes." },
  { id: "qa_bug_sheet", name: "Defect Fingerprinter & Bug Sheet", category: "report", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Deduplicate defects by SHA-256 fingerprint and export JSON/CSV/MD." },
  { id: "export_defect_pdf", name: "SPIL REO PDF Report Exporter", category: "report", riskTier: "local_action", requiresConfirmation: false, source: "builtin", description: "Generate branded SPIL REO PDF/HTML defect reports with embedded snaps." },
  { id: "notify_teams", name: "Microsoft Teams Dispatch", category: "plugin", riskTier: "external_notify", requiresConfirmation: true, source: "builtin", description: "Send a defect report summary card to a mapped engineer or Teams channel." },
];
