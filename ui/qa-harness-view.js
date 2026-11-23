// Agentic QA Harness IDE Workstation (Linear + LangSmith + Postman + Playwright).
// 3 Workspaces (Agent Observability, Test Lab, Evaluation Lab) + Left Rail + Multi-Tab Bar +
// Center Canvas + Right JSON/Span Inspector + Bottom Terminal/Logs/Artifacts + Ctrl+Shift+K Palette.
// Zero inline styles; zero innerHTML on model/server data; 100% CSP-compliant.

import {
  GATE_INFO, WORKSPACES, buildExecutionLogs, buildReplayFrames, buildWaterfallSpans,
  buildWorkflowGraph, filterExecutionLogs, filterSuiteCases, regressionSeries, searchPalette, tokenizeJsonLines,
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
    const [runsRes, suiteRes, govRes, drvRes] = await Promise.all([
      api("/api/qa/runs"),
      api("/api/qa/suite"),
      api("/api/qa/governance"),
      api("/api/qa/driver"),
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
    state.loadedOnce = true;
    render();
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
    const panel = el("section", "qh-panel");
    const head = el("div", "qh-panel-head");
    head.appendChild(el("h2", "qh-panel-title", journeysOnly ? "Journey Specs & Coverage" : "Test Case Explorer"));
    if (journeysOnly) {
      panel.appendChild(head);
      const list = state.suite?.journeys ?? [];
      if (!list.length) { panel.appendChild(el("p", "qh-empty", "No journeys found in vault/journeys/.")); return panel; }
      const tw = el("div", "qh-table-wrap");
      const tbl = el("table", "qh-table");
      const thr = el("tr");
      for (const h of ["Journey", "Area", "Steps", "Spec", "Action"]) thr.appendChild(el("th", "", h));
      tbl.appendChild(el("thead")).appendChild(thr);
      const tb = el("tbody");
      for (const j of list) {
        const tr = el("tr");
        tr.append(el("td", "", j.title), el("td", "", j.area), el("td", "", String(j.stepsCount)), el("td", "", j.hasSpec ? "Generated" : "Missing"));
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
      return panel;
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
    ctrls.append(q, pri);
    head.appendChild(ctrls);
    panel.appendChild(head);

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
    const panel = el("section", "qh-panel");
    const frames = buildReplayFrames(state.detail);
    const head = el("div", "qh-panel-head");
    head.appendChild(el("h2", "qh-panel-title", "Playwright / Cua Action Replay"));
    if (!frames.length) { panel.appendChild(el("p", "qh-empty", "No executed steps or defect screenshots on the selected run.")); return panel; }

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
    head.appendChild(ctrls);
    panel.appendChild(head);

    const frame = frames[Math.min(state.replayIdx, frames.length - 1)];
    const stage = el("div", "qh-replay-stage");
    stage.append(
      el("strong", "", `${frame.journey} — ${frame.step}${frame.width ? ` (${frame.width} px)` : ""}`),
      el("div", "qh-kpi-sub", `Expected: ${frame.expected}`),
      el("div", "qh-kpi-sub", `Actual: ${frame.actual}`),
    );
    if (frame.screenshot) {
      const img = el("img", "qh-replay-img");
      img.alt = `Screenshot at ${frame.step}`;
      img.src = `/api/qa/artifact?path=${encodeURIComponent(frame.screenshot)}`;
      stage.appendChild(img);
    }
    panel.appendChild(stage);
    return panel;
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
    else if (state.view === "evaluations") { center.append(renderCompare(), renderWorkflowAndWaterfall()); }
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
