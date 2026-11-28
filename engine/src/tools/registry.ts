// SPIL REO — Central Permission-Tiered Tool Library.
// Lists built-in tools + external plugin/MCP tools with explicit risk tiers.

export type ToolCategory = "repo" | "vault" | "ui-driver" | "security" | "api" | "report" | "plugin" | "web" | "files" | "system";
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
  // Native tools (engine/src/tools/native/). Guard runs them only when the user asks; models never get tools.
  { id: "web_search", name: "Web Search", category: "web", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "/web: search the web (Brave with a key, else DuckDuckGo, then Bing). The query passes the masking gate." },
  { id: "web_fetch", name: "Fetch Web Page", category: "web", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "/fetch: read a public http(s) page as text. Local and private addresses are refused." },
  { id: "browser_render", name: "Render Web Page", category: "web", riskTier: "local_action", requiresConfirmation: false, source: "builtin", description: "/browse: run installed Chrome or Edge headless with a throwaway profile and return the page text." },
  { id: "list_dir", name: "List Folder", category: "files", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "/ls: list a folder inside a configured repo or the vault." },
  { id: "read_file", name: "Read File", category: "files", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "/read: read a text file inside a configured repo or the vault. Secret files are refused." },
  { id: "search_files", name: "Find in Files", category: "files", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "/find: plain text search across the configured repos and the vault." },
  { id: "system_info", name: "System Info", category: "system", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "/system: operating system, processor, memory and disk space." },
  { id: "list_processes", name: "List Processes", category: "system", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "/processes: Windows process names, ids and memory. No command lines." },
  { id: "get_time", name: "Current Time", category: "system", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "/time: local time, time zone and UTC." },
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
  { id: "n8n_list_workflows", name: "n8n List Workflows", category: "plugin", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Discover configured n8n workflows, active states, tags, and webhook paths." },
  { id: "n8n_list_executions", name: "n8n List Executions", category: "plugin", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Inspect recent n8n workflow execution statuses and timestamps." },
  { id: "n8n_trigger_webhook", name: "n8n Trigger Webhook", category: "plugin", riskTier: "external_notify", requiresConfirmation: true, source: "builtin", description: "Trigger an n8n workflow webhook with a masked JSON QA payload." },
  { id: "qa_a11y_tree_snapshot", name: "Playwright A11y Tree Snapshot", category: "ui-driver", riskTier: "local_action", requiresConfirmation: false, source: "builtin", description: "Capture semantic ARIA accessibility tree refs from local UI pages without brittle selectors." },
  { id: "qa_vision_ground_screen", name: "OmniParser Vision Grounder", category: "ui-driver", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Extract structured normalized bounding boxes and control labels from screenshots or canvas HTML." },
  { id: "qa_visual_diff", name: "Visual Regression Diff", category: "ui-driver", riskTier: "local_action", requiresConfirmation: false, source: "builtin", description: "Compare baseline vs current screenshots for visual regressions and save diff reports." },
  { id: "qa_axe_audit", name: "Axe WCAG 2.1/2.2 Audit", category: "ui-driver", riskTier: "local_action", requiresConfirmation: false, source: "builtin", description: "Run automated WCAG accessibility checks and record deduplicated defects." },
  { id: "qa_lighthouse_budget", name: "Lighthouse CWV Budget Gate", category: "ui-driver", riskTier: "local_action", requiresConfirmation: false, source: "builtin", description: "Measure localhost TTFB, payload size, unsized CLS images, and Core Web Vitals budgets." },
  { id: "review_ast_grep", name: "ast-grep Tier 0 Scanner", category: "repo", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Run structural AST & Vault-rule safety pattern scans at zero token cost." },
  { id: "qe_dead_code_scan", name: "Knip Dead Code Scan", category: "repo", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Detect unused exports, orphan modules, and unused npm dependencies across repos." },
  { id: "qe_arch_boundaries", name: "Architecture Boundary Guard", category: "repo", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Enforce module boundary rules and detect circular dependencies (dependency-cruiser pattern)." },
  { id: "qe_mutation_score", name: "Stryker Mutation Audit", category: "repo", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Measure unit test assertion adequacy across high-churn mutant branch sites." },
  { id: "sec_semgrep_scan", name: "Semgrep SAST & SARIF Ingest", category: "security", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Run OWASP static SAST / ingest SARIF findings into the SHA-256 Defect store." },
  { id: "sec_gitleaks_history", name: "Gitleaks Commit History Audit", category: "security", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Scan read-only git history for leaked credentials with automatic redaction." },
  { id: "sec_dependency_cves", name: "OSV / Trivy Dependency CVEs", category: "security", riskTier: "read_only", requiresConfirmation: false, source: "builtin", description: "Scan lockfiles for CVEs and enforce BLOCK_RELEASE gate on Critical/High findings." },
  { id: "sec_nuclei_local", name: "Nuclei Localhost Scan", category: "security", riskTier: "local_action", requiresConfirmation: false, source: "builtin", description: "Run localhost-only security template checks (.env, .git, headers, CORS, actuator)." },
  { id: "api_schemathesis_fuzz", name: "Schemathesis OpenAPI Fuzzer", category: "api", riskTier: "local_action", requiresConfirmation: false, source: "builtin", description: "Run property-based localhost boundary fuzzing against OpenAPI schemas to catch 5xx crashes." },
  { id: "api_hurl_runner", name: "Hurl Chainable API Contracts", category: "api", riskTier: "local_action", requiresConfirmation: false, source: "builtin", description: "Execute plain-text chainable .hurl HTTP capture and assertion suites against localhost." },
  { id: "qa_k6_smoke_load", name: "k6 Localhost Smoke Load", category: "api", riskTier: "local_action", requiresConfirmation: false, source: "builtin", description: "Run bounded 10s max localhost concurrency smoke-load checks and assert p95 latency budgets." },
  { id: "composio_list_connections", name: "Composio List Connections", category: "plugin", riskTier: "read_only", requiresConfirmation: false, source: "composio", description: "List connected OAuth toolkits (Jira, Linear, Slack, GitHub, Notion) configured in Composio." },
  { id: "composio_execute_action", name: "Composio Execute Action", category: "plugin", riskTier: "external_notify", requiresConfirmation: true, source: "composio", description: "Execute a Composio toolkit action with secret-masked parameters." },
  { id: "mcp_hub_call_tool", name: "External MCP Tool Bridge", category: "plugin", riskTier: "local_action", requiresConfirmation: true, source: "mcp", description: "Invoke a tool on any configured external stdio, HTTP, or SSE MCP server." },
];
