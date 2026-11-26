// Agentic QA Harness IDE Workstation (Linear + LangSmith + Postman + Playwright).
// 3 Workspaces (Agent Observability, Test Lab, Evaluation Lab) + Left Rail + Multi-Tab Bar +
// Center Canvas + Right JSON/Span Inspector + Bottom Terminal/Logs/Artifacts + Ctrl+Shift+K Palette.
// Zero inline styles; zero innerHTML on model/server data; 100% CSP-compliant.

import {
  GATE_INFO, WORKSPACES, buildExecutionLogs, buildOracleSummary, buildReplayFrames, buildResponsiveMatrix,
  buildWaterfallSpans, buildWorkflowGraph, filterExecutionLogs, filterSuiteCases, formatSafetyBadge,
  regressionSeries, searchPalette, tokenizeJsonLines,
} from "./qa-harness.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

export function createQaHarnessController({ api, root, statusEl, refreshBtn, onAskInChat }) {
  const state = {
    workspace: "observability",
    view: "overview",
    runsData: null,
    openTabs: [],
    selectedId: null,
    selectedSpanId: "root",
    detail: null,
    compareBase: "",
    compareHead: "",
    comparison: null,
    suite: null,
    governance: null,
    driver: null,
    suiteFilter: { priority: "all", type: "all", query: "" },
    inspectorOpen: true,
    inspectorTab: "span",
    bottomOpen: true,
    bottomTab: "logs",
    logLevel: "all",
    logQuery: "",
    paletteOpen: false,
    paletteQuery: "",
    replayIdx: 0,
    playing: false,
    playTimer: null,
    loadedOnce: false,
    liveSession: null,
    liveHintInput: "",
    diffMode: "current",
    triageMsg: "",
    evidenceMarkdown: "",
    backendReport: null,
    prReadiness: null,
    advisorQuery: "",
    advisorBrief: null,
    recordId: "smoke-check",
    recordTitle: "Smoke Check Journey",
    recordArea: "home",
    recordStepsText: "click:Settings\nresize:800\nresize:1100\nresize:1440",
    recordStatus: "",
    bugSheetMarkdown: "",
    probeBaseUrl: "http://127.0.0.1:4310",
    openApiSpecText: "",
    probeReport: null,
    openApiReport: null,
    qeTrajectory: null,
    qeRefine: null,
    crawlResult: null,
    crawlMatch: "AURA",
  };

  function stopReplay() {
    state.playing = false;
    if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; }
  }

  function openRunTab(id) {
    if (!id) return;
    if (!state.openTabs.includes(id)) state.openTabs = [...state.openTabs, id].slice(-8);
    state.selectedId = id;
  }

  async function selectRun(id) {
    openRunTab(id);
    await loadDetail(id);
    render();
  }

  async function loadDetail(id) {
    const res = await api(`/api/qa/run?id=${encodeURIComponent(id)}`);
    if (res.ok) {
      state.detail = res.data;
      state.selectedSpanId = res.data.spans?.[0]?.id ?? "root";
      state.replayIdx = 0;
      stopReplay();
    }
  }

  async function loadComparison() {
    if (!state.compareBase || !state.compareHead) return;
    const res = await api(`/api/qa/compare?base=${encodeURIComponent(state.compareBase)}&head=${encodeURIComponent(state.compareHead)}`);
    state.comparison = res.ok ? res.data : null;
  }

  async function loadAll(preferredId) {
    statusEl.textContent = "Syncing...";
    const [runsRes, suiteRes, govRes, drvRes, liveRes, prRes] = await Promise.all([
      api("/api/qa/runs"),
      api("/api/qa/suite"),
      api("/api/qa/governance"),
      api("/api/qa/driver"),
      api("/api/qa/live/status"),
      api("/api/qa/pr-readiness"),
    ]);
    if (runsRes.ok) {
      state.runsData = runsRes.data;
      const runs = runsRes.data.runs || [];
      const targetId = preferredId || state.selectedId || runs[0]?.id || null;
      if (targetId && runs.some((r) => r.id === targetId)) {
        openRunTab(targetId);
        await loadDetail(targetId);
      } else {
        state.selectedId = null;
        state.detail = null;
      }
      if (!state.compareHead && runs[0]) state.compareHead = runs[0].id;
      if (!state.compareBase && runs[1]) state.compareBase = runs[1].id;
      if (state.compareBase && state.compareHead && state.compareBase !== state.compareHead) await loadComparison();
      statusEl.textContent = `${runs.length} run${runs.length === 1 ? "" : "s"} · ${drvRes.ok && drvRes.data.available ? "Cua ready" : "Cua offline"}`;
    } else {
      statusEl.textContent = "Offline";
    }
    if (suiteRes.ok) state.suite = suiteRes.data;
    if (govRes.ok) state.governance = govRes.data;
    if (drvRes.ok) state.driver = drvRes.data;
    if (liveRes.ok) state.liveSession = liveRes.data;
    if (prRes.ok) state.prReadiness = prRes.data;
    state.loadedOnce = true;
    render();
  }

  async function sendLiveControl(action, hint) {
    const res = await api("/api/qa/live/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...(hint ? { hint } : {}) }),
    });
    if (res.ok) {
      state.liveSession = { ...state.liveSession, ...res.data };
      if (action === "hint") state.liveHintInput = "";
      render();
    }
  }

  async function runTriage(action, frame) {
    if (!state.selectedId || !frame) return;
    const res = await api("/api/qa/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        runId: state.selectedId,
        journey: frame.journey || state.selectedId,
        step: frame.step || "step",
        expected: frame.expected,
        actual: frame.actual,
        width: frame.width,
        screenshotPath: frame.screenshot,
        ...(action === "flaky_hint" ? { hint: state.liveHintInput || `Retry or verify selector for ${frame.step}` } : {}),
      }),
    });
    state.triageMsg = res.ok ? res.data.message : (res.data?.error || "Triage action failed.");
    render();
  }

  async function exportEvidence() {
    if (!state.selectedId) return;
    const res = await api(`/api/qa/evidence?id=${encodeURIComponent(state.selectedId)}`);
    state.evidenceMarkdown = res.ok ? res.data.markdown : "Could not build PR evidence packet.";
    render();
  }

  async function exportBugSheet() {
    if (!state.selectedId) return;
    const res = await api(`/api/qa/bug-sheet?id=${encodeURIComponent(state.selectedId)}`);
    state.bugSheetMarkdown = res.ok ? res.data.markdown : "Could not build Bug Sheet.";
    render();
  }

  async function runSecurityProbesUi() {
    const res = await api("/api/qa/security-probes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: state.probeBaseUrl }),
    });
    if (res.ok) { state.probeReport = res.data; render(); }
  }

  async function runOpenApiUi() {
    const res = await api("/api/qa/openapi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: state.probeBaseUrl, specText: state.openApiSpecText }),
    });
    if (res.ok) { state.openApiReport = res.data; render(); }
  }

  async function loadQeInsights() {
    const [trajRes, refRes] = await Promise.all([api("/api/qe/trajectory"), api("/api/qe/refine")]);
    if (trajRes.ok) state.qeTrajectory = trajRes.data;
    if (refRes.ok) state.qeRefine = refRes.data;
    render();
  }

  async function runDesktopCrawlUi(dryRun) {
    const res = await api("/api/qa/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchTitle: state.crawlMatch, dryRun, maxActions: 5 }),
    });
    if (res.ok) { state.crawlResult = res.data; render(); }
  }

  async function runBackendChecks() {
    const res = await api("/api/qa/backend-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (res.ok) { state.backendReport = res.data; render(); }
  }

  async function draftRecordedJourney() {
    const lines = state.recordStepsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const events = lines.map((line) => {
      const [actRaw, ...rest] = line.split(":");
      const act = (actRaw || "click").trim().toLowerCase();
      const val = rest.join(":").trim();
      if (act === "resize") return { action: "resize", width: Number(val) || 1100 };
      if (act === "type") return { action: "type", target: val.split("=")[0] || "input", text: val.split("=")[1] || "sample" };
      if (act === "press") return { action: "press", key: val || "Escape" };
      return { action: "click", target: val || "Home" };
    });
    const res = await api("/api/qa/record/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: state.recordId, title: state.recordTitle, area: state.recordArea, events, writeProposal: true }),
    });
    state.recordStatus = res.ok ? `Proposed journey saved: ${res.data.proposedPath || res.data.id}` : (res.data?.error || "Draft failed.");
    render();
  }

  async function askAdvisor() {
    const q = state.advisorQuery.trim();
    if (!q) return;
    const res = await api(`/api/advisor?q=${encodeURIComponent(q)}`);
    if (res.ok) { state.advisorBrief = res.data; render(); }
  }

  /* ---------- Top Toolbar + Multi-Tab Execution Strip ---------- */
  function renderToolbar() {
    const bar = el("div", "qh-toolbar");
    const wsGroup = el("div", "qh-ws-group");
    wsGroup.setAttribute("role", "tablist");
    for (const ws of WORKSPACES) {
      const b = el("button", "qh-ws-btn");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(state.workspace === ws.id));
      b.append(el("span", "", ws.label), el("kbd", "qh-kbd", ws.shortcut));
      b.addEventListener("click", () => {
        stopReplay();
        state.workspace = ws.id;
        state.view = ws.views[0].id;
        render();
      });
      wsGroup.appendChild(b);
    }

    const acts = el("div", "qh-tool-actions");
    const palBtn = el("button", "qh-icon-toggle");
    palBtn.type = "button";
    palBtn.append(el("span", "", "Command"), el("kbd", "qh-kbd", "Ctrl Shift K"));
    palBtn.addEventListener("click", () => { state.paletteOpen = true; state.paletteQuery = ""; render(); });

    const inspBtn = el("button", "qh-icon-toggle");
    inspBtn.type = "button";
    inspBtn.setAttribute("aria-pressed", String(state.inspectorOpen));
    inspBtn.append(el("span", "", "Inspector"), el("kbd", "qh-kbd", "I"));
    inspBtn.addEventListener("click", () => { state.inspectorOpen = !state.inspectorOpen; render(); });

    const botBtn = el("button", "qh-icon-toggle");
    botBtn.type = "button";
    botBtn.setAttribute("aria-pressed", String(state.bottomOpen));
    botBtn.append(el("span", "", "Console"), el("kbd", "qh-kbd", "J"));
    botBtn.addEventListener("click", () => { state.bottomOpen = !state.bottomOpen; render(); });

    acts.append(palBtn, inspBtn, botBtn);
    bar.append(wsGroup, acts);
    return bar;
  }

  function renderExecTabs() {
    const bar = el("div", "qh-tabbar");
    const runsById = new Map((state.runsData?.runs ?? []).map((r) => [r.id, r]));
    if (state.openTabs.length === 0) {
      bar.appendChild(el("span", "qh-kpi-sub", "No open execution tabs — select a run or start /qa in Chat"));
      return bar;
    }
    for (const id of state.openTabs) {
      const r = runsById.get(id);
      const tone = GATE_INFO[r?.scorecard?.releaseGate ?? "warn"]?.tone ?? "warn";
      const tab = el("div", "qh-exec-tab");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(state.selectedId === id));
      const dot = el("span", "qh-dot");
      dot.setAttribute("data-tone", tone);
      const lbl = el("button", "qh-tab-close", id);
      lbl.type = "button";
      lbl.addEventListener("click", () => void selectRun(id));
      const x = el("button", "qh-tab-close", "×");
      x.type = "button";
      x.setAttribute("aria-label", `Close ${id}`);
      x.addEventListener("click", (ev) => {
        ev.stopPropagation();
        state.openTabs = state.openTabs.filter((t) => t !== id);
        if (state.selectedId === id) {
          const next = state.openTabs[state.openTabs.length - 1] ?? null;
          state.selectedId = next;
          if (next) void loadDetail(next).then(render);
          else { state.detail = null; render(); }
        } else render();
      });
      tab.append(dot, lbl, x);
      bar.appendChild(tab);
    }
    return bar;
  }

  /* ---------- Left IDE Navigation + Agent Activity Rail ---------- */
  function renderRail() {
    const rail = el("aside", "qh-rail");
    const ws = WORKSPACES.find((w) => w.id === state.workspace) ?? WORKSPACES[0];

    const navSec = el("div", "qh-rail-sec");
    navSec.appendChild(el("div", "qh-rail-head", ws.label));
    for (const v of ws.views) {
      const b = el("button", "qh-nav-item", v.label);
      b.type = "button";
      if (state.view === v.id) b.setAttribute("aria-current", "page");
      b.addEventListener("click", () => { stopReplay(); state.view = v.id; render(); });
      navSec.appendChild(b);
    }
    rail.appendChild(navSec);

    if (state.detail) {
      const agSec = el("div", "qh-rail-sec");
      agSec.appendChild(el("div", "qh-rail-head", "Pipeline Agents"));
      const { nodes } = buildWorkflowGraph(state.detail);
      for (const n of nodes) {
        const row = el("button", "qh-nav-item");
        row.type = "button";
        const left = el("span", "", n.label);
        const dot = el("span", "qh-dot");
        dot.setAttribute("data-tone", n.status === "error" ? "bad" : n.status === "skipped" ? "warn" : "good");
        row.append(left, dot);
        row.addEventListener("click", () => { state.selectedSpanId = n.spanId; state.inspectorOpen = true; render(); });
        agSec.appendChild(row);
      }
      rail.appendChild(agSec);
    }

    const runs = (state.runsData?.runs ?? []).slice(0, 6);
    if (runs.length) {
      const rSec = el("div", "qh-rail-sec");
      rSec.appendChild(el("div", "qh-rail-head", "Recent Runs"));
      for (const r of runs) {
        const row = el("button", "qh-nav-item");
        row.type = "button";
        if (r.id === state.selectedId) row.setAttribute("aria-current", "page");
        const dot = el("span", "qh-dot");
        dot.setAttribute("data-tone", GATE_INFO[r.scorecard.releaseGate]?.tone ?? "warn");
        row.append(el("span", "", r.id.slice(-6)), dot);
        row.title = r.targetLabel;
        row.addEventListener("click", () => void selectRun(r.id));
        rSec.appendChild(row);
      }
      rail.appendChild(rSec);
    }
    return rail;
  }

  /* ---------- Center Views ---------- */
  function renderKpis() {
    const k = state.runsData?.kpis;
    const grid = el("section", "qh-kpis");
    const items = [
      { label: "Pass rate", val: k?.passRate != null ? `${k.passRate}%` : "–", sub: `${k?.executedRuns ?? 0} executed` },
      { label: "QA runs", val: String(k?.totalRuns ?? 0), sub: `${k?.modelRuns ?? 0} LLM-planned` },
      { label: "Defects", val: String(k?.totalDefects ?? 0), sub: "Recorded failures" },
      { label: "Avg latency", val: k ? `${k.avgSeconds} s` : "–", sub: "Pipeline total" },
      { label: "Cua Driver", val: state.driver?.available ? "Ready" : "Offline", sub: state.driver?.available ? "background UIA" : "CDP fallback" },
    ];
    for (const it of items) {
      const c = el("div", "qh-kpi");
      c.append(el("span", "qh-kpi-label", it.label), el("strong", "qh-kpi-val", it.val), el("span", "qh-kpi-sub", it.sub));
      grid.appendChild(c);
    }
    return grid;
  }

  function renderRunsTable() {
    const runs = state.runsData?.runs ?? [];
    const panel = el("section", "qh-panel");
    panel.appendChild(el("h2", "qh-panel-title", "Agent Execution Runs"));
    if (!runs.length) {
      panel.appendChild(el("p", "qh-empty", "No QA runs yet. Trigger /qa this change in Chat."));
      return panel;
    }
    const tw = el("div", "qh-table-wrap");
    const tbl = el("table", "qh-table");
    const thead = el("thead");
    const hr = el("tr");
    for (const h of ["Run ID", "Target", "Risk", "Cases", "Time", "Gate"]) hr.appendChild(el("th", "", h));
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const tbody = el("tbody");
    for (const r of runs) {
      const tr = el("tr", "qh-row-btn");
      tr.setAttribute("data-selected", String(r.id === state.selectedId));
      tr.append(
        el("td", "", r.id),
        el("td", "", r.targetLabel),
        el("td", "", r.riskLevel),
        el("td", "", `${r.scorecard.totalCases} (${r.scorecard.p0Count} P0)`),
        el("td", "", `${r.totalSeconds} s`),
      );
      const gtd = el("td");
      const pill = el("span", "qh-pill", r.scorecard.releaseGate.toUpperCase());
      pill.setAttribute("data-tone", GATE_INFO[r.scorecard.releaseGate]?.tone ?? "warn");
      gtd.appendChild(pill);
      tr.appendChild(gtd);
      tr.addEventListener("click", () => void selectRun(r.id));
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    tw.appendChild(tbl);
    panel.appendChild(tw);
    return panel;
  }

  function renderWorkflowAndWaterfall() {
    const wrap = el("div", "qh-wf-list");
    if (!state.detail) {
      wrap.appendChild(el("p", "qh-empty", "Select a run to inspect its workflow DAG and execution waterfall."));
      return wrap;
    }
    const graphPanel = el("section", "qh-panel");
    graphPanel.appendChild(el("h2", "qh-panel-title", "Multi-Agent Orchestration Graph (click node to inspect)"));
    const svgBox = el("div", "qh-svg-box");
    const svg = svgEl("svg", { class: "qh-svg-graph", viewBox: "0 0 780 168", role: "img", "aria-label": "QA workflow graph" });
    const { nodes, edges } = buildWorkflowGraph(state.detail);
    const nmap = new Map(nodes.map((n) => [n.id, n]));
    for (const [aId, bId] of edges) {
      const a = nmap.get(aId);
      const b = nmap.get(bId);
      if (a && b) svg.appendChild(svgEl("line", { x1: a.x + 92, y1: a.y + 21, x2: b.x, y2: b.y + 21, stroke: "currentColor", "stroke-opacity": "0.35", "stroke-width": "1.5" }));
    }
    for (const n of nodes) {
      const g = svgEl("g", { class: "qh-graph-node" });
      const active = state.selectedSpanId === n.spanId;
      const stroke = active ? "var(--brand, #6366f1)" : n.status === "error" ? "#ef4444" : n.status === "skipped" ? "#9ca3af" : "#10b981";
      g.appendChild(svgEl("rect", { x: n.x, y: n.y, width: 92, height: 42, rx: 7, fill: "var(--surface)", stroke, "stroke-width": active ? "2.2" : "1.5" }));
      const t1 = svgEl("text", { x: n.x + 8, y: n.y + 17, fill: "currentColor", "font-size": "11", "font-weight": "600" });
      t1.textContent = n.label;
      const t2 = svgEl("text", { x: n.x + 8, y: n.y + 32, fill: "var(--muted)", "font-size": "9.5" });
      t2.textContent = n.role;
      g.append(t1, t2);
      g.addEventListener("click", () => { state.selectedSpanId = n.spanId; state.inspectorOpen = true; render(); });
      svg.appendChild(g);
    }
    svgBox.appendChild(svg);
    graphPanel.appendChild(svgBox);
    wrap.appendChild(graphPanel);

    const wfPanel = el("section", "qh-panel");
    wfPanel.appendChild(el("h2", "qh-panel-title", "Execution Waterfall"));
    const wf = el("div", "qh-wf-list");
    for (const sp of buildWaterfallSpans(state.detail.spans)) {
      const row = el("div", "qh-wf-row");
      row.setAttribute("data-selected", String(state.selectedSpanId === sp.id));
      row.appendChild(el("span", "", `${sp.parentId ? "↳ " : ""}${sp.label}`));
      const bar = svgEl("svg", { class: "qh-wf-bar-svg", viewBox: "0 0 100 12", preserveAspectRatio: "none" });
      bar.appendChild(svgEl("rect", { x: 0, y: 2, width: 100, height: 8, rx: 3, fill: "var(--border)", opacity: "0.3" }));
      bar.appendChild(svgEl("rect", { x: sp.leftPct, y: 2, width: sp.widthPct, height: 8, rx: 3, fill: sp.status === "error" ? "#ef4444" : sp.status === "skipped" ? "#9ca3af" : "var(--brand, #6366f1)" }));
      row.append(bar, el("span", "qh-kpi-sub", `${sp.durationMs} ms`));
      row.addEventListener("click", () => { state.selectedSpanId = sp.id; state.inspectorOpen = true; render(); });
      wf.appendChild(row);
    }
    wfPanel.appendChild(wf);
    wrap.appendChild(wfPanel);
    return wrap;
  }

  function renderSuites(journeysOnly) {
    const wrap = el("div", "qh-wf-list");
    const panel = el("section", "qh-panel");
    const head = el("div", "qh-panel-head");
    head.appendChild(el("h2", "qh-panel-title", journeysOnly ? "Journey Specs & Coverage" : "Test Case Explorer"));
    if (journeysOnly) {
      panel.appendChild(head);
      const list = state.suite?.journeys ?? [];
      if (!list.length) { panel.appendChild(el("p", "qh-empty", "No journeys found in vault/journeys/.")); }
      else {
        const tw = el("div", "qh-table-wrap");
        const tbl = el("table", "qh-table");
        const thr = el("tr");
        for (const h of ["Journey", "Area", "Steps", "Spec", "Action"]) thr.appendChild(el("th", "", h));
        tbl.appendChild(el("thead")).appendChild(thr);
        const tb = el("tbody");
        for (const j of list) {
          const tr = el("tr");
          tr.append(el("td", "", j.title), el("td", "", j.area), el("td", "", String(j.stepsCount)), el("td", "", j.hasSpec ? "Generated" : "DSL Ready"));
          const td = el("td");
          const b = el("button", "btn btn-quiet", "Run in Chat");
          b.type = "button";
          b.addEventListener("click", () => onAskInChat(`/qa ${j.title}`));
          td.appendChild(b);
          tr.appendChild(td);
          tb.appendChild(tr);
        }
        tbl.appendChild(tb);
        tw.appendChild(tbl);
        panel.appendChild(tw);
      }

      const recPanel = el("section", "qh-panel");
      recPanel.appendChild(el("h2", "qh-panel-title", "Record & Draft Declarative Journey"));
      const form = el("div", "qh-record-form");
      const idIn = el("input", "qh-input");
      idIn.value = state.recordId;
      idIn.placeholder = "journey-id";
      idIn.addEventListener("input", () => { state.recordId = idIn.value; });
      const titleIn = el("input", "qh-input");
      titleIn.value = state.recordTitle;
      titleIn.placeholder = "Journey title";
      titleIn.addEventListener("input", () => { state.recordTitle = titleIn.value; });
      const areaIn = el("input", "qh-input");
      areaIn.value = state.recordArea;
      areaIn.placeholder = "Area (e.g. orders, settings)";
      areaIn.addEventListener("input", () => { state.recordArea = areaIn.value; });
      const stepsIn = el("textarea", "qh-input");
      stepsIn.rows = 3;
      stepsIn.value = state.recordStepsText;
      stepsIn.addEventListener("input", () => { state.recordStepsText = stepsIn.value; });
      const draftBtn = el("button", "btn btn-quiet", "Draft Proposed Journey");
      draftBtn.type = "button";
      draftBtn.addEventListener("click", () => void draftRecordedJourney());
      form.append(idIn, titleIn, areaIn, stepsIn, draftBtn);
      if (state.recordStatus) form.appendChild(el("div", "qh-kpi-sub", state.recordStatus));
      recPanel.appendChild(form);
      wrap.append(panel, recPanel);
      return wrap;
    }

    const ctrls = el("div", "qh-controls");
    const q = el("input", "qh-input");
    q.type = "search";
    q.placeholder = "Filter cases...";
    q.value = state.suiteFilter.query;
    q.addEventListener("input", () => { state.suiteFilter.query = q.value; render(); });
    const pri = el("select", "qh-select");
    for (const p of ["all", "P0", "P1", "P2"]) {
      const o = el("option", "", p === "all" ? "All priorities" : p);
      o.value = p;
      if (state.suiteFilter.priority === p) o.selected = true;
      pri.appendChild(o);
    }
    pri.addEventListener("change", () => { state.suiteFilter.priority = pri.value; render(); });
    const beBtn = el("button", "btn btn-quiet", "Run Backend & MCP QA");
    beBtn.type = "button";
    beBtn.addEventListener("click", () => void runBackendChecks());
    const secBtn = el("button", "btn btn-quiet", "Security Probes");
    secBtn.type = "button";
    secBtn.addEventListener("click", () => void runSecurityProbesUi());
    const apiBtn = el("button", "btn btn-quiet", "OpenAPI Checks");
    apiBtn.type = "button";
    apiBtn.addEventListener("click", () => void runOpenApiUi());
    const crawlBtn = el("button", "btn btn-quiet", "Crawl Desktop UI");
    crawlBtn.type = "button";
    crawlBtn.addEventListener("click", () => void runDesktopCrawlUi(true));
    ctrls.append(q, pri, beBtn, secBtn, apiBtn, crawlBtn);
    head.appendChild(ctrls);
    panel.appendChild(head);

    if (state.crawlResult) {
      const cr = state.crawlResult;
      panel.appendChild(el("div", "qh-diff-card", `Desktop Crawl (${cr.backend}): "${cr.window?.title}" · ${cr.nodesCount} UIA nodes · ${cr.controls?.length ?? 0} interactive · ${cr.blockedControls?.length ?? 0} Tier-2 blocked`));
    }

    if (state.probeReport) {
      const pr = state.probeReport;
      const box = el("div", "qh-diff-grid");
      for (const pb of (pr.probes || []).slice(0, 6)) {
        const card = el("div", "qh-diff-card");
        const pill = el("span", "qh-pill", pb.status.toUpperCase());
        pill.setAttribute("data-tone", pb.status === "pass" ? "good" : "bad");
        card.append(el("strong", "", `${pb.category.toUpperCase()} `), pill, el("div", "qh-kpi-sub", pb.detail));
        box.appendChild(card);
      }
      panel.appendChild(box);
    }

    if (state.openApiReport) {
      const oa = state.openApiReport;
      panel.appendChild(el("div", "qh-diff-card", `OpenAPI (${oa.baseUrl}): ${oa.passed} pass, ${oa.failed} fail, ${oa.skipped} skipped (${oa.endpointsFound} endpoints).`));
    }

    if (state.backendReport) {
      const rep = state.backendReport;
      const box = el("div", "qh-diff-grid");
      for (const ch of rep.checks || []) {
        const card = el("div", "qh-diff-card");
        const pill = el("span", "qh-pill", ch.status.toUpperCase());
        pill.setAttribute("data-tone", ch.status === "pass" ? "good" : ch.status === "warn" ? "warn" : "bad");
        card.append(el("strong", "", ch.label + " "), pill, el("div", "qh-kpi-sub", ch.detail));
        box.appendChild(card);
      }
      panel.appendChild(box);
    }

    const filtered = filterSuiteCases([...(state.suite?.recentCases ?? []), ...(state.suite?.templates ?? [])], state.suiteFilter);
    if (!filtered.length) { panel.appendChild(el("p", "qh-empty", "No matching test cases.")); return panel; }
    const tw = el("div", "qh-table-wrap");
    const tbl = el("table", "qh-table");
    const thr = el("tr");
    for (const h of ["ID", "Pri", "Type", "Title", "Action"]) thr.appendChild(el("th", "", h));
    tbl.appendChild(el("thead")).appendChild(thr);
    const tb = el("tbody");
    for (const c of filtered.slice(0, 60)) {
      const tr = el("tr");
      tr.append(el("td", "", c.id), el("td", "", c.priority), el("td", "", c.type), el("td", "", c.title));
      const td = el("td");
      const b = el("button", "btn btn-quiet", "QA");
      b.type = "button";
      b.addEventListener("click", () => onAskInChat(`/qa ${c.title}`));
      td.appendChild(b);
      tr.appendChild(td);
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    tw.appendChild(tbl);
    panel.appendChild(tw);
    return panel;
  }

  function renderCompare() {
    const panel = el("section", "qh-panel");
    const head = el("div", "qh-panel-head");
    head.appendChild(el("h2", "qh-panel-title", "Side-by-Side Run Comparison"));
    const runs = state.runsData?.runs ?? [];
    if (runs.length >= 2) {
      const ctrls = el("div", "qh-controls");
      const mk = (val, fn) => {
        const s = el("select", "qh-select");
        for (const r of runs) {
          const o = el("option", "", `${r.id} (${r.targetLabel})`);
          o.value = r.id;
          if (r.id === val) o.selected = true;
          s.appendChild(o);
        }
        s.addEventListener("change", () => fn(s.value));
        return s;
      };
      ctrls.append(
        mk(state.compareBase, async (v) => { state.compareBase = v; await loadComparison(); render(); }),
        el("span", "qh-kpi-sub", "vs"),
        mk(state.compareHead, async (v) => { state.compareHead = v; await loadComparison(); render(); }),
      );
      head.appendChild(ctrls);
    }
    panel.appendChild(head);
    if (!state.comparison) { panel.appendChild(el("p", "qh-empty", "Select two different runs to compare.")); return panel; }
    const c = state.comparison;
    const grid = el("div", "qh-diff-grid");
    for (const [t, lines] of [
      ["Deltas", [`Cases: ${c.deltas.cases >= 0 ? "+" : ""}${c.deltas.cases}`, `P0: ${c.deltas.p0 >= 0 ? "+" : ""}${c.deltas.p0}`, `Defects: ${c.deltas.defects >= 0 ? "+" : ""}${c.deltas.defects}`, `Time: ${c.deltas.seconds} s`]],
      [`Added (${c.addedCases.length})`, c.addedCases.slice(0, 5).length ? c.addedCases.slice(0, 5) : ["None"]],
      [`Removed (${c.removedCases.length})`, c.removedCases.slice(0, 5).length ? c.removedCases.slice(0, 5) : ["None"]],
    ]) {
      const card = el("div", "qh-diff-card");
      card.appendChild(el("strong", "", t));
      for (const l of lines) card.appendChild(el("div", "qh-kpi-sub", l));
      grid.appendChild(card);
    }
    panel.appendChild(grid);
    return panel;
  }

  function renderReplay() {
    const wrap = el("div", "qh-wf-list");
    const panel = el("section", "qh-panel");
    const frames = buildReplayFrames(state.detail);
    const head = el("div", "qh-panel-head");
    head.appendChild(el("h2", "qh-panel-title", "Background Theatre, Responsive Matrix & Triage"));

    const topCtrls = el("div", "qh-controls");
    const diffBtn = el("button", "btn btn-quiet", state.diffMode === "baseline" ? "Mode: Baseline Diff" : "Mode: Current Frame");
    diffBtn.type = "button";
    diffBtn.addEventListener("click", () => { state.diffMode = state.diffMode === "current" ? "baseline" : "current"; render(); });
    const expBtn = el("button", "btn btn-quiet", "Export PR Evidence Packet");
    expBtn.type = "button";
    expBtn.addEventListener("click", () => void exportEvidence());
    const bugBtn = el("button", "btn btn-quiet", "Export Bug Sheet");
    bugBtn.type = "button";
    bugBtn.addEventListener("click", () => void exportBugSheet());
    topCtrls.append(diffBtn, expBtn, bugBtn);
    head.appendChild(topCtrls);
    panel.appendChild(head);

    if (state.detail) {
      const matrix = el("div", "qh-matrix-grid");
      for (const m of buildResponsiveMatrix(state.detail)) {
        const mc = el("div", "qh-matrix-card");
        const pill = el("span", "qh-pill", `${m.width} px · ${m.status.toUpperCase()}`);
        pill.setAttribute("data-tone", m.status === "pass" ? "good" : m.status === "fail" ? "bad" : "warn");
        mc.append(pill, el("div", "qh-kpi-sub", `${m.shots.length} shot(s) · ${m.defects.length} defect(s)`));
        matrix.appendChild(mc);
      }
      panel.appendChild(matrix);
    }

    if (!frames.length) {
      panel.appendChild(el("p", "qh-empty", "No executed steps or defect screenshots on the selected run."));
    } else {
      const ctrls = el("div", "qh-controls");
      const prev = el("button", "btn btn-quiet", "Prev");
      prev.type = "button";
      prev.disabled = state.replayIdx <= 0;
      prev.addEventListener("click", () => { stopReplay(); state.replayIdx = Math.max(0, state.replayIdx - 1); render(); });
      const play = el("button", "btn btn-quiet", state.playing ? "Pause" : "Play");
      play.type = "button";
      play.addEventListener("click", () => {
        if (state.playing) { stopReplay(); render(); }
        else {
          state.playing = true;
          state.playTimer = setInterval(() => {
            if (state.replayIdx >= frames.length - 1) stopReplay();
            else state.replayIdx += 1;
            render();
          }, 1600);
          render();
        }
      });
      const next = el("button", "btn btn-quiet", "Next");
      next.type = "button";
      next.disabled = state.replayIdx >= frames.length - 1;
      next.addEventListener("click", () => { stopReplay(); state.replayIdx = Math.min(frames.length - 1, state.replayIdx + 1); render(); });
      ctrls.append(prev, play, next, el("span", "qh-kpi-sub", `${state.replayIdx + 1} / ${frames.length}`));
      panel.appendChild(ctrls);

      const frame = frames[Math.min(state.replayIdx, frames.length - 1)];
      const stage = el("div", "qh-replay-stage");
      stage.append(
        el("strong", "", `${frame.journey} — ${frame.step}${frame.width ? ` (${frame.width} px)` : ""} [${state.diffMode}]`),
        el("div", "qh-kpi-sub", `Expected: ${frame.expected}`),
        el("div", "qh-kpi-sub", `Actual: ${frame.actual}`),
      );
      if (frame.screenshot) {
        const img = el("img", "qh-replay-img");
        img.alt = `Screenshot at ${frame.step}`;
        img.src = `/api/qa/artifact?path=${encodeURIComponent(frame.screenshot)}`;
        stage.appendChild(img);
      }
      const triageBar = el("div", "qh-triage-bar");
      const bBug = el("button", "btn btn-quiet", "Real Bug");
      bBug.type = "button";
      bBug.addEventListener("click", () => void runTriage("real_bug", frame));
      const bBase = el("button", "btn btn-quiet", "Update Baseline");
      bBase.type = "button";
      bBase.addEventListener("click", () => void runTriage("update_baseline", frame));
      const bHint = el("button", "btn btn-quiet", "Flaky Hint");
      bHint.type = "button";
      bHint.addEventListener("click", () => void runTriage("flaky_hint", frame));
      triageBar.append(bBug, bBase, bHint);
      if (state.triageMsg) triageBar.appendChild(el("span", "qh-kpi-sub", state.triageMsg));
      stage.appendChild(triageBar);
      panel.appendChild(stage);
    }

    wrap.appendChild(panel);
    if (state.evidenceMarkdown) {
      const evPanel = el("section", "qh-panel");
      const evHead = el("div", "qh-panel-head");
      evHead.appendChild(el("h2", "qh-panel-title", "PR Evidence Packet (Redacted)"));
      const copyBtn = el("button", "btn btn-quiet", "Copy Markdown");
      copyBtn.type = "button";
      copyBtn.addEventListener("click", () => void navigator.clipboard?.writeText(state.evidenceMarkdown));
      evHead.appendChild(copyBtn);
      const pre = el("pre", "qh-json", state.evidenceMarkdown);
      evPanel.append(evHead, pre);
      wrap.appendChild(evPanel);
    }
    if (state.bugSheetMarkdown) {
      const bgPanel = el("section", "qh-panel");
      bgPanel.append(el("h2", "qh-panel-title", "Fingerprinted Bug Sheet & Developer Tickets"), el("pre", "qh-json", state.bugSheetMarkdown));
      wrap.appendChild(bgPanel);
    }
    return wrap;
  }

  function renderEvaluationsAndAdvisor() {
    const wrap = el("div", "qh-wf-list");
    if (state.detail) {
      const { oracles, rubrics } = buildOracleSummary(state.detail);
      const op = el("section", "qh-panel");
      op.appendChild(el("h2", "qh-panel-title", "Deterministic Oracles (5) & Rubric Scorecard (4)"));
      const og = el("div", "qh-oracle-grid");
      for (const o of oracles) {
        const c = el("div", "qh-diff-card");
        const p = el("span", "qh-pill", o.status.toUpperCase());
        p.setAttribute("data-tone", o.status === "pass" ? "good" : o.status === "warn" ? "warn" : "bad");
        c.append(el("strong", "", o.label + " "), p);
        og.appendChild(c);
      }
      for (const rb of rubrics) {
        const c = el("div", "qh-diff-card");
        c.append(el("strong", "", `${rb.label}: ${rb.score}/5`), el("div", "qh-kpi-sub", "Rubric evaluation"));
        og.appendChild(c);
      }
      op.appendChild(og);
      wrap.appendChild(op);
    }

    const prPanel = el("section", "qh-panel");
    prPanel.appendChild(el("h2", "qh-panel-title", "PR Readiness & Wise Knowledge Advisor"));
    if (state.prReadiness) {
      const pr = state.prReadiness;
      const pill = el("span", "qh-pill", `PR GATE: ${pr.releaseGate.toUpperCase()}`);
      pill.setAttribute("data-tone", GATE_INFO[pr.releaseGate]?.tone ?? "warn");
      prPanel.append(pill, el("div", "qh-kpi-sub", `${pr.repo} · ${pr.changedFiles?.length ?? 0} changed file(s) · ${pr.defectFindings?.length ?? 0} defect finding(s)`));
      for (const s of (pr.developerSuggestions ?? []).slice(0, 5)) {
        prPanel.appendChild(el("div", "qh-diff-card", `[${s.priority.toUpperCase()}] ${s.title} — ${s.action}`));
      }
    }
    const advCtrls = el("div", "qh-controls");
    const advIn = el("input", "qh-input");
    advIn.placeholder = "Ask Wise Advisor (e.g. order entry, erp create, sidebar)...";
    advIn.value = state.advisorQuery;
    advIn.addEventListener("input", () => { state.advisorQuery = advIn.value; });
    const advBtn = el("button", "btn btn-quiet", "Advise");
    advBtn.type = "button";
    advBtn.addEventListener("click", () => void askAdvisor());
    advCtrls.append(advIn, advBtn);
    prPanel.appendChild(advCtrls);
    if (state.advisorBrief) {
      const b = state.advisorBrief;
      for (const rec of b.recommendations || []) {
        prPanel.appendChild(el("div", "qh-diff-card", rec));
      }
    }
    wrap.appendChild(prPanel);

    const qePanel = el("section", "qh-panel");
    const qeHead = el("div", "qh-panel-head");
    qeHead.appendChild(el("h2", "qh-panel-title", "QE Commit Trajectory & Code Refinement / KB Drift"));
    const qeBtn = el("button", "btn btn-quiet", "Analyze Trajectory & Drift");
    qeBtn.type = "button";
    qeBtn.addEventListener("click", () => void loadQeInsights());
    qeHead.appendChild(qeBtn);
    qePanel.appendChild(qeHead);
    if (state.qeTrajectory) {
      const t = state.qeTrajectory;
      qePanel.appendChild(el("div", "qh-diff-card", `Trajectory (${t.repo}): risk=${t.riskLevel.toUpperCase()} · ${t.commitsAnalyzed} commits · ${t.churnHotspots.length} churn hotspot(s)`));
    }
    if (state.qeRefine) {
      const rf = state.qeRefine;
      qePanel.appendChild(el("div", "qh-diff-card", `Refinement & Drift (${rf.repo}): ${rf.refinements.length} smell(s) · ${rf.staleAnchors.length} stale note(s) · ${rf.undocumentedPatterns.length} undocumented pattern(s)`));
    }
    wrap.appendChild(qePanel);

    wrap.appendChild(renderCompare());
    return wrap;
  }

  function renderLiveStrip() {
    const strip = el("section", "qh-live-strip");
    const left = el("div", "qh-controls");
    const liveState = state.liveSession?.state ?? "idle";
    const sPill = el("span", "qh-pill", `LIVE: ${liveState.toUpperCase()}`);
    sPill.setAttribute("data-tone", liveState === "running" || liveState === "stepping" ? "good" : liveState === "paused" ? "warn" : "good");
    left.appendChild(sPill);
    for (const tier of [0, 1, 2]) {
      const b = formatSafetyBadge(tier);
      const tp = el("span", "qh-pill", `T${tier} ${b.label}`);
      tp.setAttribute("data-tone", b.tone);
      left.appendChild(tp);
    }

    const ctrls = el("div", "qh-controls");
    for (const [act, lbl] of [["pause", "Pause"], ["resume", "Resume"], ["step", "Step Over"], ["abort", "Abort"]]) {
      const btn = el("button", "btn btn-quiet", lbl);
      btn.type = "button";
      btn.addEventListener("click", () => void sendLiveControl(act));
      ctrls.appendChild(btn);
    }
    const hintIn = el("input", "qh-input");
    hintIn.placeholder = "Inject hint...";
    hintIn.value = state.liveHintInput;
    hintIn.addEventListener("input", () => { state.liveHintInput = hintIn.value; });
    const hintBtn = el("button", "btn btn-quiet", "Inject Hint");
    hintBtn.type = "button";
    hintBtn.addEventListener("click", () => void sendLiveControl("hint", state.liveHintInput));
    ctrls.append(hintIn, hintBtn);
    strip.append(left, ctrls);
    return strip;
  }

  function renderGovernance() {
    const wrap = el("div", "qh-wf-list");
    const reg = el("section", "qh-panel");
    reg.appendChild(el("h2", "qh-panel-title", "Regression & Defect Trend"));
    const series = regressionSeries(state.runsData?.runs ?? []);
    if (!series.length) reg.appendChild(el("p", "qh-empty", "No runs yet."));
    else {
      const box = el("div", "qh-svg-box");
      const svg = svgEl("svg", { class: "qh-svg-trend", viewBox: "0 0 560 140", role: "img", "aria-label": "Regression trend" });
      const stepX = series.length > 1 ? 520 / (series.length - 1) : 0;
      if (series.length > 1) {
        svg.appendChild(svgEl("polyline", { fill: "none", stroke: "#ef4444", "stroke-width": "2", points: series.map((p, i) => `${20 + i * stepX},${110 - Math.min(90, p.defects * 18)}`).join(" ") }));
      }
      series.forEach((p, i) => {
        const cx = 20 + i * stepX;
        const cy = 110 - Math.min(90, p.defects * 18);
        svg.appendChild(svgEl("circle", { cx, cy, r: 4, fill: p.gate === "block" ? "#ef4444" : "#10b981" }));
        const lbl = svgEl("text", { x: cx - 10, y: 132, fill: "var(--muted)", "font-size": "9" });
        lbl.textContent = p.label;
        svg.appendChild(lbl);
      });
      box.appendChild(svg);
      reg.appendChild(box);
    }
    wrap.appendChild(reg);

    const gov = el("section", "qh-panel");
    gov.appendChild(el("h2", "qh-panel-title", "Safety Policy, Cua Driver & Egress Audit"));
    const grid = el("div", "qh-diff-grid");
    if (state.governance) {
      const g = state.governance;
      const pol = el("div", "qh-diff-card");
      pol.append(el("strong", "", "Forbidden Actions"), el("div", "qh-kpi-sub", `${g.forbidden.names} names · ${g.forbidden.keys} keys`), el("div", "qh-kpi-sub", `Hosts: ${g.forbidden.allowedHosts.join(", ") || "none"}`));
      const eg = el("div", "qh-diff-card");
      eg.append(el("strong", "", "Egress Masking"), el("div", "qh-kpi-sub", `${g.egress.totalCalls} calls · ${g.egress.blockedSecrets} blocked`), el("div", "qh-kpi-sub", `${g.egress.maskedSecrets} masked placeholders`));
      grid.append(pol, eg);
    }
    if (state.driver) {
      const d = state.driver;
      const drv = el("div", "qh-diff-card");
      drv.append(el("strong", "", "Background Driver (Cua)"), el("div", "qh-kpi-sub", d.available ? `Ready (${d.version})` : `Offline (${d.command})`), el("div", "qh-kpi-sub", `Blocked: ${d.blockedTools.join(", ")}`));
      grid.appendChild(drv);
    }
    gov.appendChild(grid);
    wrap.appendChild(gov);
    return wrap;
  }

  function renderCenter() {
    const center = el("div", "qh-center");
    center.appendChild(renderLiveStrip());
    center.appendChild(renderKpis());
    if (state.detail) {
      const sc = state.detail.scorecard;
      const gate = el("div", "qh-gate");
      gate.setAttribute("data-tone", GATE_INFO[sc.releaseGate]?.tone ?? "warn");
      const gt = el("div");
      gt.append(el("strong", "", GATE_INFO[sc.releaseGate]?.label ?? "Release Gate"), el("div", "qh-kpi-sub", sc.gateReason));
      gate.append(gt, el("span", "qh-gate-badge", `${sc.totalCases} cases · ${sc.defectsCount} defects`));
      center.appendChild(gate);
    }
    if (state.view === "overview") { center.append(renderRunsTable(), renderWorkflowAndWaterfall()); }
    else if (state.view === "runs") { center.appendChild(renderRunsTable()); }
    else if (state.view === "workflows") { center.appendChild(renderWorkflowAndWaterfall()); }
    else if (state.view === "artifacts") { center.appendChild(renderReplay()); }
    else if (state.view === "suites") { center.appendChild(renderSuites(false)); }
    else if (state.view === "journeys") { center.appendChild(renderSuites(true)); }
    else if (state.view === "evaluations") { center.append(renderEvaluationsAndAdvisor(), renderWorkflowAndWaterfall()); }
    else if (state.view === "compare") { center.appendChild(renderCompare()); }
    else { center.appendChild(renderGovernance()); }
    return center;
  }

  /* ---------- Right Postman/LangSmith Inspector ---------- */
  function renderInspector() {
    const insp = el("aside", "qh-inspector");
    const tabs = el("div", "qh-insp-tabs");
    for (const [id, lbl] of [["span", "Span"], ["json", "JSON"], ["safety", "Safety"]]) {
      const b = el("button", "qh-insp-tab", lbl);
      b.type = "button";
      b.setAttribute("aria-selected", String(state.inspectorTab === id));
      b.addEventListener("click", () => { state.inspectorTab = id; render(); });
      tabs.appendChild(b);
    }
    insp.appendChild(tabs);

    const body = el("div", "qh-insp-body");
    if (!state.detail) {
      body.appendChild(el("p", "qh-empty", "Select a QA run or click a workflow node."));
      insp.appendChild(body);
      return insp;
    }

    if (state.inspectorTab === "span") {
      const span = state.detail.spans.find((s) => s.id === state.selectedSpanId) ?? state.detail.spans[0];
      if (span) {
        body.append(
          el("strong", "", span.label),
          el("div", "qh-kpi-sub", `Kind: ${span.kind} · Status: ${span.status} · ${span.durationMs} ms`),
          el("div", "qh-diff-card", span.detail || "No extra span details."),
        );
      }
      body.appendChild(el("strong", "", `Target: ${state.detail.result.target?.label ?? "–"}`));
      for (const f of (state.detail.result.context?.changedFiles ?? []).slice(0, 8)) {
        body.appendChild(el("div", "qh-kpi-sub", `${f.repo}: ${f.path}`));
      }
    } else if (state.inspectorTab === "json") {
      const copy = el("button", "btn btn-quiet", "Copy JSON");
      copy.type = "button";
      copy.addEventListener("click", () => void navigator.clipboard?.writeText(JSON.stringify(state.detail.result, null, 2)));
      const pre = el("pre", "qh-json");
      for (const toks of tokenizeJsonLines(state.detail.result)) {
        const line = el("div");
        for (const t of toks) line.appendChild(el("span", t.kind === "plain" ? "" : `qh-tok-${t.kind}`, t.text));
        pre.appendChild(line);
      }
      body.append(copy, pre);
    } else {
      const sc = state.detail.scorecard;
      body.append(
        el("strong", "", `Safety Gate: ${sc.safetyPassed}/${sc.safetyChecked} passed`),
        el("div", "qh-kpi-sub", `Release verdict: ${sc.releaseGate.toUpperCase()}`),
        el("div", "qh-kpi-sub", sc.gateReason),
      );
      if (state.driver) {
        body.append(
          el("strong", "", "Cua Guard Policy"),
          el("div", "qh-kpi-sub", `Delivery mode: ${state.driver.deliveryMode} (locked)`),
          el("div", "qh-kpi-sub", `Blocked tools: ${state.driver.blockedTools.join(", ")}`),
        );
      }
    }
    insp.appendChild(body);
    return insp;
  }

  /* ---------- Bottom Dockable Console / Logs / Artifacts ---------- */
  function renderBottom() {
    const bot = el("section", "qh-bottom");
    const head = el("div", "qh-bottom-head");
    const tabs = el("div", "qh-controls");
    for (const [id, lbl] of [["logs", "Execution Logs"], ["artifacts", "Artifacts"], ["driver", "Driver"]]) {
      const b = el("button", "qh-insp-tab", lbl);
      b.type = "button";
      b.setAttribute("aria-selected", String(state.bottomTab === id));
      b.addEventListener("click", () => { state.bottomTab = id; render(); });
      tabs.appendChild(b);
    }
    const filters = el("div", "qh-controls");
    if (state.bottomTab === "logs") {
      const sel = el("select", "qh-select");
      for (const lv of ["all", "info", "warn", "error"]) {
        const o = el("option", "", lv);
        o.value = lv;
        if (state.logLevel === lv) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => { state.logLevel = sel.value; render(); });
      filters.appendChild(sel);
    }
    head.append(tabs, filters);
    bot.appendChild(head);

    const body = el("div", "qh-bottom-body");
    if (state.bottomTab === "logs") {
      const lines = filterExecutionLogs(buildExecutionLogs(state.detail, state.governance, state.driver), { level: state.logLevel, query: state.logQuery });
      if (!lines.length) body.appendChild(el("div", "qh-kpi-sub", "No log lines match current filter."));
      for (const l of lines) {
        const row = el("div", "qh-log-line");
        const lv = el("span", "qh-log-lvl", l.level.toUpperCase());
        lv.setAttribute("data-lvl", l.level);
        row.append(lv, el("span", "qh-log-src", `[${l.source}]`), el("span", "", l.text));
        body.appendChild(row);
      }
    } else if (state.bottomTab === "artifacts") {
      const shots = state.detail?.screenshots ?? [];
      const md = state.detail?.result?.artifacts?.markdownPath;
      if (md) body.appendChild(el("div", "qh-log-line", `Report: ${md}`));
      for (const s of shots) body.appendChild(el("div", "qh-log-line", `Screenshot [${s.journey} @ ${s.step}]: ${s.path}`));
      if (!md && !shots.length) body.appendChild(el("div", "qh-kpi-sub", "No artifacts on selected run."));
    } else {
      const d = state.driver;
      body.appendChild(el("div", "qh-log-line", d ? `command=${d.command} available=${d.available} mode=${d.deliveryMode}` : "Driver probe pending..."));
      if (d?.error) body.appendChild(el("div", "qh-log-line", `hint: ${d.error} (install: irm https://cua.ai/driver/install.ps1 | iex)`));
    }
    bot.appendChild(body);
    return bot;
  }

  /* ---------- Command Palette Modal (Ctrl+Shift+K) ---------- */
  function renderPalette() {
    const backdrop = el("div", "qh-palette-backdrop");
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) { state.paletteOpen = false; render(); } });
    const box = el("div", "qh-palette");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "QA Harness command palette");
    const input = el("input", "qh-palette-input");
    input.type = "search";
    input.placeholder = "Jump to workspace, view, run, or test case...";
    input.value = state.paletteQuery;
    const list = el("div", "qh-palette-list");

    const drawItems = () => {
      list.textContent = "";
      const hits = searchPalette(state.paletteQuery, { runs: state.runsData?.runs ?? [], cases: state.suite?.recentCases ?? [] });
      for (const h of hits) {
        const b = el("button", "qh-palette-item");
        b.type = "button";
        b.append(el("span", "", h.label), el("span", "qh-kpi-sub", h.hint));
        b.addEventListener("click", () => {
          state.paletteOpen = false;
          if (h.kind === "view") { state.workspace = h.workspace; state.view = h.view; render(); }
          else if (h.kind === "run") { void selectRun(h.id); }
          else if (h.kind === "case") { onAskInChat(`/qa ${h.title}`); }
        });
        list.appendChild(b);
      }
    };
    input.addEventListener("input", () => { state.paletteQuery = input.value; drawItems(); });
    drawItems();
    box.append(input, list);
    backdrop.appendChild(box);
    setTimeout(() => input.focus(), 0);
    return backdrop;
  }

  function render() {
    root.textContent = "";
    root.appendChild(renderToolbar());
    root.appendChild(renderExecTabs());
    const wb = el("div", "qh-workbench");
    const row = el("div", "qh-main-row");
    row.append(renderRail(), renderCenter());
    if (state.inspectorOpen) row.appendChild(renderInspector());
    wb.appendChild(row);
    if (state.bottomOpen) wb.appendChild(renderBottom());
    root.appendChild(wb);
    if (state.paletteOpen) root.appendChild(renderPalette());
  }

  window.addEventListener("keydown", (e) => {
    const qaEl = document.getElementById("view-qa");
    if (!qaEl || qaEl.hidden) return;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      state.paletteOpen = !state.paletteOpen;
      state.paletteQuery = "";
      render();
      return;
    }
    if (e.key === "Escape" && state.paletteOpen) { state.paletteOpen = false; render(); return; }
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName ?? "")) return;
    if (e.key === "i" || e.key === "I") { state.inspectorOpen = !state.inspectorOpen; render(); }
    else if (e.key === "j" || e.key === "J") { state.bottomOpen = !state.bottomOpen; render(); }
    else if (e.key === "1" || e.key === "2" || e.key === "3") {
      const ws = WORKSPACES[Number(e.key) - 1];
      if (ws) { state.workspace = ws.id; state.view = ws.views[0].id; render(); }
    }
  });

  refreshBtn.addEventListener("click", () => void loadAll());

  return {
    show(preferredId) {
      if (!state.loadedOnce || preferredId) void loadAll(preferredId);
      else render();
    },
    stopReplay,
  };
}
