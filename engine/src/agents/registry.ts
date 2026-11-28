// SPIL REO — Prebuilt Sub-Agent Registry & Intent Orchestrator.
// Routes general knowledge queries on Landing vs. operational/automation tasks to Workspace.

export type AgentId = "qa" | "qe" | "review" | "security" | "api" | "knowledge" | "report";

export interface SubAgentSpec {
  id: AgentId;
  name: string;
  role: string;
  description: string;
  defaultSkills: string[];
  allowedTools: string[];
  riskTier: "read_only" | "local_action" | "external_notify";
  enabled: boolean;
}

export const PREBUILT_AGENTS: readonly SubAgentSpec[] = [
  {
    id: "qa",
    name: "QA Agent",
    role: "UI & Desktop Automation",
    description: "Runs live UI/Desktop crawls (Windows UIA & Playwright CDP), visual/A11y/CWV gates, declarative journeys, and captures visual evidence.",
    defaultSkills: [
      "qa-diff",
      "qa-explore",
      "qa-ui-telemetry",
      "qa-accessibility-responsive",
      "qa-evidence",
      "qa-n8n-automation",
      "qa-n8n-bidirectional-mcp",
      "qa-playwright-mcp",
      "qa-self-healing-journeys",
      "qa-visual-yaml-assertions",
      "qa-visual-regression",
      "qa-wcag-gate",
      "qa-cwv-audit",
    ],
    allowedTools: [
      "qa_crawl_desktop_app",
      "qa_feature_map",
      "qa_bug_sheet",
      "search_knowledge",
      "get_blast_radius",
      "n8n_list_workflows",
      "n8n_list_executions",
      "n8n_trigger_webhook",
      "qa_a11y_tree_snapshot",
      "qa_vision_ground_screen",
      "qa_visual_diff",
      "qa_axe_audit",
      "qa_lighthouse_budget",
    ],
    riskTier: "local_action",
    enabled: true,
  },
  {
    id: "qe",
    name: "QE Agent",
    role: "Quality Engineering Brain",
    description: "Analyzes commit trajectory, churn hotspots, blast radius, dead code, boundaries, mutation adequacy, KB drift, and model evals.",
    defaultSkills: [
      "qe-commit-trajectory",
      "qe-code-refine",
      "qe-kb-drift",
      "qe-release-gate",
      "lauren-poteto-rules",
      "qe-n8n-triage",
      "qe-ast-rules",
      "qe-dead-code",
      "qe-architecture-guard",
      "qe-mutation-audit",
      "qe-model-benchmark",
    ],
    allowedTools: [
      "qe_commit_trajectory",
      "qe_code_refine_drift",
      "qe_recommend_constraint",
      "get_blast_radius",
      "co_changed",
      "n8n_list_workflows",
      "n8n_list_executions",
      "review_ast_grep",
      "qe_dead_code_scan",
      "qe_arch_boundaries",
      "qe_mutation_score",
    ],
    riskTier: "read_only",
    enabled: true,
  },
  {
    id: "review",
    name: "Code Review Agent",
    role: "Static & Semantic Review",
    description: "Runs Tier 0 deterministic AST/boundary/dead-code checks, active vault rules, and diff review with copyable fix suggestions.",
    defaultSkills: ["guard-review", "pr-advisor", "qe-code-refine", "qe-ast-rules", "qe-architecture-guard", "qe-dead-code"],
    allowedTools: ["search_knowledge", "list_rules", "get_blast_radius", "trace_history", "review_ast_grep", "qe_dead_code_scan", "qe_arch_boundaries"],
    riskTier: "read_only",
    enabled: true,
  },
  {
    id: "security",
    name: "Cyber Security Agent",
    role: "DevSecOps & Adversarial Probes",
    description: "Performs Semgrep SAST/SARIF, Gitleaks history, OSV/Trivy CVE gates, OWASP Top 10 audits, and localhost Nuclei/security probes.",
    defaultSkills: [
      "sec-audit-master",
      "sec-api-input",
      "sec-auth-access",
      "sec-db-secrets",
      "qa-adversarial-probes",
      "sec-sarif-triage",
      "sec-git-secret-audit",
      "sec-sca-gate",
      "sec-nuclei-localhost",
    ],
    allowedTools: [
      "qa_security_probes",
      "sec_semgrep_scan",
      "sec_gitleaks_history",
      "sec_dependency_cves",
      "sec_nuclei_local",
      "search_knowledge",
      "list_rules",
    ],
    riskTier: "local_action",
    enabled: true,
  },
  {
    id: "api",
    name: "API Contract Agent",
    role: "OpenAPI / Swagger & Load Verification",
    description: "Executes OpenAPI contract validation, Schemathesis property fuzzing, Hurl chains, and bounded localhost k6 smoke-load checks.",
    defaultSkills: ["qa-swagger-api", "qe-contract-drift", "sec-api-input", "qa-api-fuzzing", "qa-hurl-contracts", "qa-perf-budget"],
    allowedTools: ["qa_openapi_checks", "qa_security_probes", "api_schemathesis_fuzz", "api_hurl_runner", "qa_k6_smoke_load", "search_knowledge"],
    riskTier: "local_action",
    enabled: true,
  },
  {
    id: "knowledge",
    name: "Knowledge & Scribe Agent",
    role: "Vault Q&A & Engineering Memory",
    description: "Answers questions from the Obsidian vault and indexed code with citations, drafts diaries, and detects stale notes.",
    defaultSkills: ["ask-guard", "ai-log"],
    allowedTools: ["search_knowledge", "get_doc", "trace_history", "list_rules", "stale_notes"],
    riskTier: "read_only",
    enabled: true,
  },
  {
    id: "report",
    name: "Defect & Report Agent",
    role: "Triage, PDF Reports & Teams Dispatch",
    description: "Deduplicates defects by SHA-256 fingerprint, builds branded SPIL REO PDF reports, and dispatches to engineers on Teams.",
    defaultSkills: ["qa-bug-sheet", "qa-triage", "qa-evidence", "qa-n8n-automation"],
    allowedTools: ["qa_bug_sheet", "export_defect_pdf", "notify_teams", "n8n_list_workflows", "n8n_list_executions", "n8n_trigger_webhook"],
    riskTier: "external_notify",
    enabled: true,
  },
];

export interface OrchestrationRoute {
  destination: "landing" | "workspace";
  agents: AgentId[];
  reason: string;
}

const OPERATIONAL_PATTERNS: Array<{ re: RegExp; agent: AgentId; reason: string }> = [
  { re: /\b(qa|uat|test|retest|crawl|click|playwright|uia|journey|smoke[- ]?test|regression|bug[- ]?sheet|axe|wcag|lighthouse|cwv|visual[- ]?diff|omniparser|a11y)\b/i, agent: "qa", reason: "QA / UI / A11y / Visual automation request" },
  { re: /\b(security|sec|owasp|pentest|probe|sqli|xss|idor|vulnerab|audit|secret[- ]?scan|semgrep|sarif|gitleaks|cve|osv|trivy|nuclei)\b/i, agent: "security", reason: "Cyber security / DevSecOps audit request" },
  { re: /\b(review|pr\s*#?\d+|diff|code[- ]?review|refactor|lint|tier\s*0|ast[- ]?grep)\b/i, agent: "review", reason: "Code review / AST Tier 0 request" },
  { re: /\b(trajectory|churn|blast[- ]?radius|kb[- ]?drift|constraint|release[- ]?gate|qe|knip|dead[- ]?code|boundar|mutation|stryker|benchmark|promptfoo)\b/i, agent: "qe", reason: "Quality engineering analysis request" },
  { re: /\b(openapi|swagger|endpoint|contract[- ]?test|api[- ]?test|schemathesis|fuzz|hurl|k6|load[- ]?test)\b/i, agent: "api", reason: "API contract, fuzz, or load verification request" },
  { re: /\b(defect|pdf|report|teams|notify|triage)\b/i, agent: "report", reason: "Defect report or notification request" },
  { re: /\b(n8n|workflow[- ]?automation|webhook)\b/i, agent: "report", reason: "n8n workflow automation request" },
];

/** Decides whether a prompt stays on the Landing Knowledge box or redirects to the Main Workspace. */
export function routeIntentToAgents(prompt: string): OrchestrationRoute {
  const text = (prompt || "").trim();
  if (!text) return { destination: "landing", agents: ["knowledge"], reason: "Empty prompt" };

  // Explicit @agent mentions always route to workspace
  const mentioned: AgentId[] = [];
  for (const a of PREBUILT_AGENTS) {
    if (new RegExp(`@${a.id}\\b`, "i").test(text)) mentioned.push(a.id);
  }
  if (mentioned.length > 0) {
    return { destination: "workspace", agents: mentioned, reason: `Explicit @${mentioned.join(", @")} mention` };
  }

  // Slash commands always route to workspace
  if (text.startsWith("/")) {
    return { destination: "workspace", agents: ["qa", "review"], reason: "Slash command" };
  }

  // Pure conceptual questions ("what is QA?", "where are the tests?") stay on landing
  if (/^(what is|what are|why does|where are|explain|how does|tell me about)\b/i.test(text) && !/\b(run|execute|crawl|audit|review|check|test this|qa this|qa the)\b/i.test(text)) {
    return { destination: "landing", agents: ["knowledge"], reason: "General knowledge question" };
  }

  const matched: AgentId[] = [];
  const reasons: string[] = [];
  for (const p of OPERATIONAL_PATTERNS) {
    if (p.re.test(text) && !matched.includes(p.agent)) {
      matched.push(p.agent);
      reasons.push(p.reason);
    }
  }
  if (matched.length > 0) {
    return { destination: "workspace", agents: matched, reason: reasons.join(" + ") };
  }
  return { destination: "landing", agents: ["knowledge"], reason: "General knowledge query" };
}
