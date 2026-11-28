// SPIL REO — Prebuilt Sub-Agent Registry & Intent Orchestrator.
// Routes general knowledge queries on Landing vs. operational/automation tasks to Workspace.
// Supports learned routing weights and custom REO-created agents (`custom-<slug>`).

export type AgentId =
  | "qa"
  | "qe"
  | "review"
  | "security"
  | "api"
  | "knowledge"
  | "report"
  | "a11y"
  | "perf"
  | "release"
  | "architect"
  | "triage";

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
      "qa-swarm-orchestration",
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
      "qe-self-learning",
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
    id: "a11y",
    name: "Accessibility & Visual Agent",
    role: "WCAG, ARIA & Visual Regression",
    description: "Audits semantic ARIA trees, WCAG 2.1/2.2 Axe compliance, OmniParser UI grounding, visual screenshot diffs, and CWV budgets.",
    defaultSkills: ["qa-wcag-gate", "qa-visual-regression", "qa-playwright-mcp", "qa-visual-yaml-assertions", "qa-accessibility-responsive"],
    allowedTools: ["qa_a11y_tree_snapshot", "qa_axe_audit", "qa_visual_diff", "qa_vision_ground_screen", "qa_lighthouse_budget"],
    riskTier: "local_action",
    enabled: true,
  },
  {
    id: "perf",
    name: "Performance & Load Agent",
    role: "Localhost Latency & CWV Budgets",
    description: "Benchmarks localhost response times with bounded k6 smoke loads, Lighthouse Core Web Vitals budgets, and API fuzz resilience.",
    defaultSkills: ["qa-perf-budget", "qa-cwv-audit"],
    allowedTools: ["qa_k6_smoke_load", "qa_lighthouse_budget", "api_schemathesis_fuzz"],
    riskTier: "local_action",
    enabled: true,
  },
  {
    id: "release",
    name: "Release Manager Agent",
    role: "Go-Live Gate & CVE Sign-off",
    description: "Evaluates lockfile CVEs, commit churn trajectory, bug sheets, AST hygiene, and architecture boundaries for release readiness.",
    defaultSkills: ["qe-release-gate", "sec-sca-gate"],
    allowedTools: ["sec_dependency_cves", "qe_commit_trajectory", "qa_bug_sheet", "review_ast_grep", "qe_arch_boundaries"],
    riskTier: "read_only",
    enabled: true,
  },
  {
    id: "architect",
    name: "Architecture Agent",
    role: "Module Boundaries & Coupling",
    description: "Enforces module boundaries, catches circular imports, surfaces dead exports/deps, and computes AST blast radius.",
    defaultSkills: ["qe-architecture-guard", "qe-dead-code"],
    allowedTools: ["qe_arch_boundaries", "qe_dead_code_scan", "get_blast_radius", "co_changed", "qe_recommend_constraint"],
    riskTier: "read_only",
    enabled: true,
  },
  {
    id: "triage",
    name: "Root-Cause Triage Agent",
    role: "Defect Clustering & Blame Analysis",
    description: "Correlates recurring defects, recent git commits, co-change coupling, and Vault knowledge to pinpoint likely root causes.",
    defaultSkills: ["qa-triage", "qa-bug-sheet"],
    allowedTools: ["qa_bug_sheet", "trace_history", "search_knowledge", "co_changed", "qe_commit_trajectory"],
    riskTier: "read_only",
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

export const PREBUILT_AGENT_IDS: ReadonlySet<AgentId> = new Set(PREBUILT_AGENTS.map((a) => a.id));

export function isPrebuiltAgentId(id: string): id is AgentId {
  return PREBUILT_AGENT_IDS.has(id as AgentId);
}

/** Map any agent id (including new specialist or custom agents) to DefectRecord.agentSource. */
export function defectSourceFor(agent: string): "qa" | "review" | "security" | "api" | "qe" {
  switch (agent) {
    case "qa":
    case "a11y":
      return "qa";
    case "review":
      return "review";
    case "security":
      return "security";
    case "api":
    case "perf":
      return "api";
    default:
      return "qe";
  }
}

export interface OrchestrationRoute {
  destination: "landing" | "workspace";
  agents: AgentId[];
  customAgents?: string[];
  reason: string;
}

const OPERATIONAL_PATTERNS: Array<{ re: RegExp; agent: AgentId; reason: string }> = [
  { re: /\b(wcag|a11y|accessib|axe|aria|visual)\b/i, agent: "a11y", reason: "Accessibility / visual inspection request" },
  { re: /\b(perf|latency|load|k6|lighthouse|cwv|slow)\b/i, agent: "perf", reason: "Performance / load testing request" },
  { re: /\b(release|ship|go[- ]?live|rc|gate)\b/i, agent: "release", reason: "Release readiness / gate check" },
  { re: /\b(architect|boundar|cycle|circular|dead[- ]?code|refactor)\b/i, agent: "architect", reason: "Architecture / dependency hygiene check" },
  { re: /\b(root[- ]?cause|why\b.*\bfail|triage|flaky|regress)\b/i, agent: "triage", reason: "Root-cause triage request" },
  { re: /\b(qa|uat|test|retest|crawl|click|playwright|uia|journey|smoke[- ]?test|regression|bug[- ]?sheet|omniparser|visual[- ]?diff)\b/i, agent: "qa", reason: "QA / UI / Visual automation request" },
  { re: /\b(security|sec|owasp|pentest|probe|sqli|xss|idor|vulnerab|audit|secret[- ]?scan|semgrep|sarif|gitleaks|cve|osv|trivy|nuclei)\b/i, agent: "security", reason: "Cyber security / DevSecOps audit request" },
  { re: /\b(review|pr\s*#?\d+|diff|code[- ]?review|lint|tier\s*0|ast[- ]?grep)\b/i, agent: "review", reason: "Code review / AST Tier 0 request" },
  { re: /\b(trajectory|churn|blast[- ]?radius|kb[- ]?drift|constraint|release[- ]?gate|qe|knip|mutation|stryker|benchmark|promptfoo)\b/i, agent: "qe", reason: "Quality engineering analysis request" },
  { re: /\b(openapi|swagger|endpoint|contract[- ]?test|api[- ]?test|schemathesis|fuzz|hurl|load[- ]?test)\b/i, agent: "api", reason: "API contract, fuzz, or load verification request" },
  { re: /\b(defect|pdf|report|teams|notify)\b/i, agent: "report", reason: "Defect report or notification request" },
  { re: /\b(n8n|workflow[- ]?automation|webhook)\b/i, agent: "report", reason: "n8n workflow automation request" },
];

const ROUTE_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "check", "run", "please", "what", "when", "where", "how",
]);

/** Decides whether a prompt stays on the Landing Knowledge box or redirects to the Main Workspace. */
export function routeIntentToAgents(
  prompt: string,
  learned?: Record<string, Partial<Record<string, number>>>,
): OrchestrationRoute {
  const text = (prompt || "").trim();
  if (!text) return { destination: "landing", agents: ["knowledge"], reason: "Empty prompt" };

  // Explicit @custom-<slug> mentions
  const customAgents: string[] = [];
  for (const m of text.matchAll(/@(custom-[a-z0-9-]+)\b/gi)) {
    const id = m[1]!.toLowerCase();
    if (!customAgents.includes(id)) customAgents.push(id);
  }

  // Explicit @agent mentions always route to workspace
  const mentioned: AgentId[] = [];
  for (const a of PREBUILT_AGENTS) {
    if (new RegExp(`@${a.id}\\b`, "i").test(text)) mentioned.push(a.id);
  }
  if (mentioned.length > 0 || customAgents.length > 0) {
    const label = [...mentioned.map((x) => `@${x}`), ...customAgents.map((x) => `@${x}`)].join(", ");
    return {
      destination: "workspace",
      agents: mentioned,
      ...(customAgents.length ? { customAgents } : {}),
      reason: `Explicit ${label} mention`,
    };
  }

  // Slash commands always route to workspace
  if (text.startsWith("/")) {
    return { destination: "workspace", agents: ["qa", "review"], reason: "Slash command" };
  }

  // Pure conceptual questions stay on landing
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

  // Learned routing weights (summed across prompt tokens; threshold >= 1)
  if (learned && Object.keys(learned).length > 0) {
    const tokens = [...new Set(text.toLowerCase().split(/[^a-z0-9_-]+/).filter((w) => w.length >= 3 && !ROUTE_STOPWORDS.has(w)))];
    const scores = new Map<AgentId, number>();
    for (const tok of tokens) {
      const row = learned[tok];
      if (!row) continue;
      for (const [ag, wt] of Object.entries(row)) {
        if (!isPrebuiltAgentId(ag) || typeof wt !== "number" || wt <= 0) continue;
        scores.set(ag, (scores.get(ag) ?? 0) + wt);
      }
    }
    let learnedAdded = false;
    for (const [ag, sum] of scores.entries()) {
      if (sum >= 1 && !matched.includes(ag)) {
        matched.push(ag);
        learnedAdded = true;
      }
    }
    if (learnedAdded) reasons.push("Learned routing");
  }

  if (matched.length > 0) {
    return { destination: "workspace", agents: matched, reason: reasons.join(" + ") };
  }
  return { destination: "landing", agents: ["knowledge"], reason: "General knowledge query" };
}
