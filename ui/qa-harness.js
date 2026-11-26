// Pure QA Harness workstation state, workspaces, multi-tab execution model,
// JSON tokenizer, command palette search, execution logs, graph DAG, and replay frames.
// Zero DOM, zero HTML strings, importable in Node for unit testing.

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v, d = "") => (typeof v === "string" ? v : v == null ? d : String(v));

export const WORKSPACES = [
  {
    id: "observability",
    label: "Agent Observability",
    shortcut: "1",
    views: [
      { id: "overview", label: "Overview" },
      { id: "runs", label: "Agent Runs" },
      { id: "workflows", label: "Workflows" },
      { id: "artifacts", label: "Replay & Artifacts" },
    ],
  },
  {
    id: "test-lab",
    label: "Test Lab",
    shortcut: "2",
    views: [
      { id: "suites", label: "Test Suites" },
      { id: "journeys", label: "Journey Specs" },
    ],
  },
  {
    id: "eval-lab",
    label: "Evaluation Lab",
    shortcut: "3",
    views: [
      { id: "evaluations", label: "Evaluations" },
      { id: "compare", label: "Run Comparison" },
      { id: "governance", label: "Governance & Audit" },
    ],
  },
];

export const HARNESS_TABS = WORKSPACES.flatMap((w) => w.views);

export const GATE_INFO = {
  pass: { label: "Release Gate: PASS", tone: "good" },
  warn: { label: "Release Gate: WARN", tone: "warn" },
  block: { label: "Release Gate: BLOCK", tone: "bad" },
};

/** Computes proportional start% and width% bars for waterfall spans. */
export function buildWaterfallSpans(spans) {
  const list = arr(spans);
  if (list.length === 0) return [];
  const maxEnd = list.reduce((m, s) => Math.max(m, num(s.startMs) + Math.max(1, num(s.durationMs))), 1);
  return list.map((s) => {
    const startMs = Math.max(0, num(s.startMs));
    const durationMs = Math.max(1, num(s.durationMs));
    const leftPct = Math.min(96, Math.round((startMs / maxEnd) * 100));
    const widthPct = Math.max(3, Math.min(100 - leftPct, Math.round((durationMs / maxEnd) * 100)));
    return {
      id: str(s.id),
      parentId: s.parentId ? str(s.parentId) : null,
      label: str(s.label),
      kind: str(s.kind, "agent"),
      status: str(s.status, "done"),
      startMs,
      durationMs,
      detail: str(s.detail),
      leftPct,
      widthPct,
    };
  });
}

/** Builds a deterministic DAG of the multi-agent QA pipeline for SVG rendering. */
export function buildWorkflowGraph(detail) {
  const r = detail?.result ?? {};
  const spans = arr(detail?.spans);
  const byId = new Map(spans.map((s) => [s.id, s]));
  const hasRunner = !!r.run;
  const runStatus = r.run?.status ?? "pending";
  const safetyChecked = r.journeys?.offer?.safety?.checked ?? 0;
  const safetyPassed = r.journeys?.offer?.safety?.passed ?? 0;

  const nodes = [
    { id: "understand", spanId: "root", label: "Planner", role: "Understand", status: "done", x: 24, y: 66, ms: 40 },
    { id: "target", spanId: "context", label: "Target", role: "Git / PR", status: r.target?.repos?.length ? "done" : "warn", x: 150, y: 66, ms: 80 },
    { id: "context", spanId: "context", label: "Context", role: "Blast & Notes", status: byId.get("context")?.status ?? "done", x: 276, y: 66, ms: byId.get("context")?.durationMs ?? 0 },
    { id: "design", spanId: "design", label: r.modelUsed ? "LLM Designer" : "Templates", role: `${arr(r.cases).length} cases`, status: byId.get("design")?.status ?? "done", x: 402, y: 66, ms: byId.get("design")?.durationMs ?? 0 },
    { id: "safety", spanId: "safety", label: "Safety Guard", role: safetyChecked ? `${safetyPassed}/${safetyChecked} safe` : "No specs", status: !safetyChecked ? "skipped" : safetyPassed < safetyChecked ? "error" : "done", x: 528, y: 24, ms: byId.get("safety")?.durationMs ?? 0 },
    { id: "runner", spanId: "runner", label: "Executor", role: hasRunner ? runStatus : "Not run", status: !hasRunner ? "skipped" : runStatus === "failed" || runStatus === "rejected" ? "error" : "done", x: 528, y: 112, ms: byId.get("runner")?.durationMs ?? 0 },
    { id: "report", spanId: "report", label: "Evaluator", role: detail?.scorecard?.releaseGate?.toUpperCase() ?? "WARN", status: detail?.scorecard?.releaseGate === "block" ? "error" : "done", x: 660, y: 66, ms: byId.get("report")?.durationMs ?? 0 },
  ];

  const edges = [
    ["understand", "target"],
    ["target", "context"],
    ["context", "design"],
    ["design", "safety"],
    ["safety", "runner"],
    ["safety", "report"],
    ["runner", "report"],
  ];
  return { nodes, edges };
}

/** Builds ordered browser-action replay frames from a QA run's defects and executed journeys. */
export function buildReplayFrames(detail) {
  const r = detail?.result;
  if (!r) return [];
  const frames = [];
  const runs = arr(r.run?.runs);
  const defects = arr(r.run?.defects);

  for (const x of runs) {
    frames.push({
      index: frames.length,
      kind: x.status === "failed" ? "defect" : "journey",
      journey: str(x.journeyId),
      step: x.status === "passed" ? "Journey completed" : `Journey ${str(x.status)}`,
      width: null,
      status: str(x.status),
      expected: "All journey steps pass without defects",
      actual: x.blocker ? str(x.blocker) : `${num(x.defects)} defect(s)`,
      screenshot: null,
    });
  }
  for (const d of defects) {
    frames.push({
      index: frames.length,
      kind: "defect",
      journey: str(d.journeyId ?? d.journey),
      step: str(d.step),
      width: typeof d.width === "number" ? d.width : null,
      status: "failed",
      expected: str(d.expected),
      actual: str(d.actual),
      screenshot: d.screenshot ? str(d.screenshot) : null,
    });
  }
  return frames;
}

/** Filters test cases by priority, type, and search query. */
export function filterSuiteCases(cases, { priority = "all", type = "all", query = "" } = {}) {
  const q = String(query).trim().toLowerCase();
  return arr(cases).filter((c) => {
    if (priority !== "all" && c.priority !== priority) return false;
    if (type !== "all" && c.type !== type) return false;
    if (q) {
      const hay = `${str(c.id)} ${str(c.title)} ${str(c.area)} ${str(c.journeyId)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Extracts chronological regression series (oldest -> newest) for SVG trend chart. */
export function regressionSeries(runs) {
  return arr(runs)
    .slice()
    .reverse()
    .map((r, i) => ({
      index: i,
      id: str(r.id),
      label: str(r.generatedAt).slice(5, 10) || str(r.id).slice(0, 10),
      passRate: r.scorecard?.passRate ?? null,
      defects: num(r.scorecard?.defectsCount),
      cases: num(r.scorecard?.totalCases),
      gate: str(r.scorecard?.releaseGate, "warn"),
    }));
}

/** Builds structured execution log lines for the bottom terminal/log drawer. */
export function buildExecutionLogs(detail, governance, driver) {
  const logs = [];
  if (detail?.result) {
    const r = detail.result;
    logs.push({ level: "info", source: "PLANNER", text: `Run ${str(r.id)} initialized for "${str(r.target?.label, "target")}"` });
    for (const sp of buildWaterfallSpans(detail.spans)) {
      const level = sp.status === "error" ? "error" : sp.status === "skipped" ? "warn" : "info";
      logs.push({ level, source: sp.kind.toUpperCase(), text: `${sp.label} (${sp.durationMs} ms) — ${sp.detail || sp.status}` });
    }
    for (const d of arr(r.run?.defects)) {
      logs.push({ level: "error", source: "DEFECT", text: `[${str(d.journeyId ?? d.journey)}] ${str(d.step)}: expected "${str(d.expected)}", got "${str(d.actual)}"` });
    }
  }
  if (driver) {
    logs.push({
      level: driver.available ? "info" : "warn",
      source: "CUA",
      text: driver.available
        ? `Cua Driver ready (${str(driver.version)}) · delivery_mode=${str(driver.deliveryMode)}`
        : `Cua Driver offline (${str(driver.command)}) · blocked tools: ${arr(driver.blockedTools).join(", ")}`,
    });
  }
  if (governance?.egress) {
    logs.push({
      level: governance.egress.blockedSecrets > 0 ? "warn" : "info",
      source: "MASK",
      text: `${num(governance.egress.totalCalls)} audited model calls · ${num(governance.egress.blockedSecrets)} blocked · ${num(governance.egress.maskedSecrets)} masked`,
    });
  }
  return logs;
}

/** Filters bottom terminal logs by level and text query. */
export function filterExecutionLogs(logs, { level = "all", query = "" } = {}) {
  const q = String(query).trim().toLowerCase();
  return arr(logs).filter((l) => {
    if (level !== "all" && l.level !== level) return false;
    if (q && !`${l.source} ${l.text}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Searches views, open runs, and test cases for the Ctrl+Shift+K command palette. */
export function searchPalette(query, { runs = [], cases = [] } = {}) {
  const q = String(query).trim().toLowerCase();
  const items = [];
  for (const ws of WORKSPACES) {
    for (const v of ws.views) {
      items.push({ kind: "view", id: `${ws.id}:${v.id}`, workspace: ws.id, view: v.id, label: v.label, hint: ws.label });
    }
  }
  for (const r of arr(runs).slice(0, 20)) {
    items.push({ kind: "run", id: str(r.id), label: `Open run ${str(r.id)}`, hint: `${str(r.targetLabel)} · ${str(r.scorecard?.releaseGate).toUpperCase()}` });
  }
  for (const c of arr(cases).slice(0, 30)) {
    items.push({ kind: "case", id: str(c.id), title: str(c.title), label: `${str(c.priority)} ${str(c.title)}`, hint: str(c.type) });
  }
  if (!q) return items.slice(0, 14);
  return items.filter((it) => `${it.label} ${it.hint}`.toLowerCase().includes(q)).slice(0, 14);
}

/** Tokenizes JSON into syntax-safe { kind, text } tokens for the Inspector (zero innerHTML). */
export function tokenizeJsonLines(value, maxLines = 180) {
  const raw = JSON.stringify(value, null, 2) ?? "null";
  const lines = raw.split("\n").slice(0, maxLines);
  return lines.map((line) => {
    const m = /^(\s*)("(?:[^"\\]|\\.)*"):\s*(.*)$/.exec(line);
    if (!m) return [{ kind: "plain", text: line }];
    const [, indent, key, rest] = m;
    const valKind = rest.startsWith("\"") ? "str" : /^(?:true|false)/.test(rest) ? "bool" : /^null/.test(rest) ? "null" : /^-?\d/.test(rest) ? "num" : "punct";
    return [
      { kind: "plain", text: indent },
      { kind: "key", text: key },
      { kind: "punct", text: ": " },
      { kind: valKind, text: rest },
    ];
  });
}

/** Groups screenshots and defects across standard Aura responsive widths (800, 1100, 1440 px). */
export function buildResponsiveMatrix(detail) {
  const widths = [800, 1100, 1440];
  const r = detail?.result;
  const shots = arr(detail?.screenshots);
  const defects = arr(r?.run?.defects);
  return widths.map((w) => {
    const wShots = shots.filter((s) => s.width === w);
    const wDefects = defects.filter((d) => d.width === w);
    return {
      width: w,
      shots: wShots,
      defects: wDefects,
      status: wDefects.length > 0 ? "fail" : wShots.length > 0 ? "pass" : "pending",
    };
  });
}

/** Summarizes the 5 deterministic oracles and 4 rubric dimensions for Evaluation Lab. */
export function buildOracleSummary(detail) {
  const defects = arr(detail?.result?.run?.defects);
  const sc = detail?.scorecard ?? {};
  const oracles = [
    { id: "layout", label: "Responsive Layout (800/1100/1440)", status: defects.some((d) => /overflow|squeezed|clip/i.test(str(d.actual))) ? "fail" : "pass" },
    { id: "console", label: "Console & Runtime Errors", status: defects.some((d) => /console|pageerror|ipc|error/i.test(str(d.actual))) ? "fail" : "pass" },
    { id: "form", label: "Form Button Semantics", status: defects.some((d) => /button|submit|form/i.test(str(d.actual))) ? "fail" : "pass" },
    { id: "protocol", label: "Protocol & Secret Leak Guard", status: defects.some((d) => /json|secret|tag/i.test(str(d.actual))) ? "fail" : "pass" },
    { id: "visual", label: "Visual Regression Baseline", status: arr(detail?.screenshots).length > 0 ? "pass" : "warn" },
  ];
  const rubrics = [
    { id: "visual_layout", label: "Visual Layout & Alignment", score: oracles[0].status === "pass" ? 5 : 2 },
    { id: "copy_clarity", label: "Copy & Plain-Words Clarity", score: oracles[3].status === "pass" ? 5 : 1 },
    { id: "data_accuracy", label: "Task & Runtime Accuracy", score: oracles[1].status === "pass" && oracles[2].status === "pass" ? 5 : 2 },
    { id: "safety_compliance", label: "Safety Boundary Compliance", score: sc.safetyChecked > 0 && sc.safetyPassed < sc.safetyChecked ? 2 : 5 },
  ];
  return { oracles, rubrics };
}

/** Maps safety tier 0/1/2 to badge label and tone. */
export function formatSafetyBadge(tier) {
  if (tier === 0) return { label: "READ", tone: "good" };
  if (tier === 1) return { label: "LOCAL", tone: "warn" };
  return { label: "BLOCKED", tone: "bad" };
}
