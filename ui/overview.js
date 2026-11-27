// The Overview home screen. Everything shown comes from GET /api/overview, GET /api/project or
// the project summary the app already holds. A panel with no data says so; nothing is invented.
// DOM only through createElement/createElementNS (no innerHTML), so commit or note text is never markup.
// Sizes that depend on data are set through the CSSOM, which the page's CSP allows.

import { buildProcess, guardProcessSteps } from "/process.js";

const NS = "http://www.w3.org/2000/svg";

export function greeting(hour) {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Points for a sparkline in a w x h box. Returns "" when there are fewer than two values. */
export function sparkPoints(values, w, h, pad = 3) {
  if (!Array.isArray(values) || values.length < 2) return "";
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = (w - pad * 2) / (values.length - 1);
  return values.map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1)}`).join(" ");
}

export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function sv(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}
function icon(d) {
  const s = sv("svg", { viewBox: "0 0 24 24", class: "i", "aria-hidden": "true" });
  s.appendChild(sv("path", { d, fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  return s;
}
const IC = {
  commit: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM3 12h5M16 12h5",
  note: "M7 3h8l4 4v14H7V3Zm7 0v5h5M10 13h6M10 17h6",
  inbox: "M4 13l2.5-7.5h11L20 13v5.5H4V13Zm0 0h5l1 2h4l1-2h5",
  qa: "M12 3.5 5 6v5.5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-2.5ZM9 12l2.2 2.2L15.5 10",
  chat: "M4 5.5h16v10.5H9.5L4 20V5.5Z",
  report: "M6 3.5h8.5L19 8v12.5H6v-17Zm8 0V8.5h5M9 13h7M9 16.5h7",
  repo: "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Zm0 13a3 3 0 0 1 3-3h10",
  search: "m20 20-4.2-4.2M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Z",
  key: "M8 11.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM10.5 13 19 4.5M16 7.5l2.5 2.5",
};

function spark(values, tone) {
  const w = 120;
  const h = 36;
  const pts = sparkPoints(values, w, h);
  const s = sv("svg", { viewBox: `0 0 ${w} ${h}`, class: `spark ${tone}`, role: "img", "aria-label": pts ? "Trend over time" : "Not enough data for a trend", preserveAspectRatio: "none" });
  if (!pts) {
    s.appendChild(sv("line", { x1: 3, x2: w - 3, y1: h - 4, y2: h - 4, class: "spark-flat" }));
    return s;
  }
  s.appendChild(sv("polygon", { points: `3,${h} ${pts} ${w - 3},${h}`, class: "spark-area" }));
  s.appendChild(sv("polyline", { points: pts, class: "spark-line", fill: "none" }));
  return s;
}

function kpi({ tone, ic, label, value, sub, visual }) {
  const c = el("article", "ov-kpi");
  const top = el("div", "ov-kpi-top");
  const badge = el("span", `ov-kpi-ic ${tone}`);
  badge.appendChild(icon(ic));
  top.append(badge, el("span", "ov-kpi-label", label));
  c.append(top, el("div", "ov-kpi-value", value), el("div", "ov-kpi-sub", sub));
  if (visual) c.appendChild(visual);
  return c;
}

function panel(title, sub, actionLabel, onAction) {
  const p = el("section", "ov-panel");
  const head = el("header", "ov-panel-head");
  const t = el("div", "ov-panel-titles");
  t.appendChild(el("h2", "ov-panel-title", title));
  if (sub) t.appendChild(el("p", "ov-panel-sub", sub));
  head.appendChild(t);
  if (actionLabel) {
    const b = el("button", "ov-link", actionLabel);
    b.type = "button";
    b.addEventListener("click", onAction);
    head.appendChild(b);
  }
  p.appendChild(head);
  return p;
}
const empty = (text) => el("p", "ov-empty", text);

function passTone(rate) {
  if (rate === null || rate === undefined) return "muted";
  return rate >= 90 ? "ok" : rate >= 60 ? "warn" : "bad";
}

export function mountOverview({ root, api, getProject, actions }) {
  let data = null;
  let failed = false;

  function stat({ label, value, sub, visual, tone }) {
    const c = el("article", "ov-stat");
    c.append(el("p", "ov-stat-label", label), el("p", `ov-stat-value ${tone || ""}`, value), el("p", "ov-stat-sub", sub));
    if (visual) c.appendChild(visual);
    return c;
  }

  function stats(project) {
    const sec = el("section", "ov-stats-sec");
    const head = el("div", "ov-stats-head");
    head.append(el("p", "ov-eyebrow", "Memory"), el("h2", "ov-stats-title", "What Guard knows about your project"));
    const wrap = el("div", "ov-stats");
    const per = data?.commitsPerDay ?? [];
    const total30 = per.reduce((s, d) => s + d.n, 0);
    const v = project?.vault;
    const qa = data?.qa;
    wrap.append(
      stat({ label: "Knowledge notes", value: v ? v.notes.toLocaleString("en") : "-", sub: v ? `${v.active} active, ${v.proposed} proposed, ${v.stale} stale` : "The vault has not been read yet" }),
      stat({ label: "Commits, last 30 days", value: data ? total30.toLocaleString("en") : "-", sub: project?.index ? `${project.index.commits.toLocaleString("en")} commits indexed in total` : "The index has not been built yet", visual: spark(per.map((d) => d.n), "blue") }),
      stat({ label: "QA pass rate", value: qa && qa.passRate !== null ? `${qa.passRate}%` : "-", tone: passTone(qa?.passRate), sub: qa ? (qa.totalRuns ? `${qa.totalRuns} runs, ${qa.totalDefects} defects found` : "No QA runs yet") : "", visual: spark(qa?.passSeries ?? [], passTone(qa?.passRate)) }),
    );
    sec.append(head, wrap);
    return sec;
  }

  function process(project) {
    const sec = el("section", "ov-stats-sec ov-process");
    const head = el("div", "ov-stats-head");
    head.append(el("p", "ov-eyebrow", "Process"), el("h2", "ov-stats-title", "How Guard works, and where it stands"));
    sec.append(head, buildProcess(guardProcessSteps(project, data)));
    return sec;
  }

  function pipeline(project) {
    const p = panel("Memory pipeline", "What Guard knows, and where work is waiting", null);
    const flow = el("ol", "ov-flow");
    const pending = data?.inbox?.total ?? 0;
    const nodes = [
      { ic: IC.repo, title: "Repositories", sub: project ? `${project.repos.length} read-only` : "-", ok: !!project?.repos?.length },
      { ic: IC.search, title: "Index", sub: project?.index ? `${project.index.files.toLocaleString("en")} files, ${project.index.commits.toLocaleString("en")} commits` : "Not built", ok: !!project?.index?.indexedAt },
      { ic: IC.note, title: "Vault", sub: project?.vault ? `${project.vault.notes} notes` : "-", ok: !!project?.vault?.notes },
      { ic: IC.inbox, title: "Review inbox", sub: data ? `${pending} waiting` : "-", ok: data ? pending === 0 : false, active: pending > 0, go: "inbox" },
      { ic: IC.qa, title: "QA runs", sub: data ? `${data.qa.totalRuns} so far` : "-", ok: !!data?.qa?.totalRuns, go: "qa" },
    ];
    nodes.forEach((n, i) => {
      const li = el("li", "ov-node" + (n.active ? " active" : ""));
      const card = el(n.go ? "button" : "div", "ov-node-card");
      if (n.go) {
        card.type = "button";
        card.addEventListener("click", () => actions.openView(n.go));
      }
      const ic = el("span", "ov-node-ic");
      ic.appendChild(icon(n.ic));
      const tx = el("span", "ov-node-text");
      tx.append(el("span", "ov-node-title", n.title), el("span", "ov-node-sub", n.sub));
      const badge = el("span", "ov-node-badge " + (n.ok ? "ok" : n.active ? "warn" : "idle"), n.ok ? "OK" : n.active ? "Needs you" : "Empty");
      card.append(ic, tx, badge);
      li.appendChild(card);
      if (i < nodes.length - 1) li.appendChild(el("span", "ov-arrow"));
      flow.appendChild(li);
    });
    p.appendChild(flow);
    return p;
  }

  function activity() {
    const p = panel("Recent activity", "Newest commits and notes in the index", "Ask about changes", () => actions.ask("What changed in the last few days?"));
    const items = [];
    for (const c of data?.recentCommits ?? []) items.push({ kind: "commit", title: c.title, meta: c.repo || "", when: c.date, ref: c.ref });
    for (const n of data?.recentNotes ?? []) items.push({ kind: "note", title: n.title, meta: [n.type, n.status].filter(Boolean).join(", "), when: n.date, ref: n.ref });
    items.sort((a, b) => String(b.when || "").localeCompare(String(a.when || "")));
    if (!items.length) {
      p.appendChild(empty("Nothing is indexed yet. Run the index to see commits and notes here."));
      return p;
    }
    const ul = el("ul", "ov-list");
    for (const it of items.slice(0, 8)) {
      const li = el("li", "");
      const b = el("button", "ov-row");
      b.type = "button";
      b.addEventListener("click", () => actions.openSource({ ref: it.ref, kind: it.kind, title: it.title }));
      const ic = el("span", `ov-row-ic ${it.kind}`);
      ic.appendChild(icon(IC[it.kind]));
      const tx = el("span", "ov-row-text");
      tx.append(el("span", "ov-row-title", it.title), el("span", "ov-row-meta", it.meta));
      b.append(ic, tx, el("time", "ov-row-when", it.when ? ago(it.when) || String(it.when).slice(0, 10) : ""));
      li.appendChild(b);
      ul.appendChild(li);
    }
    p.appendChild(ul);
    return p;
  }

  function runs() {
    const p = panel("Recent QA runs", "From the QA harness", "Open harness", () => actions.openView("qa"));
    const list = data?.qa?.recent ?? [];
    if (!list.length) {
      p.appendChild(empty("No QA runs yet. Ask Guard to QA the latest change from the chat."));
      return p;
    }
    const wrap = el("div", "ov-table-wrap");
    const t = el("table", "ov-table");
    const head = el("thead");
    const hr = el("tr");
    for (const h of ["Run", "When", "Risk", "Result", "Defects", "Time"]) hr.appendChild(el("th", "", h));
    head.appendChild(hr);
    t.appendChild(head);
    const tb = el("tbody");
    for (const r of list) {
      const tr = el("tr", "ov-run");
      tr.tabIndex = 0;
      const open = () => actions.openRun(r.id);
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter") open();
      });
      const res = el("td");
      res.appendChild(el("span", `ov-pill ${passTone(r.passRate)}`, r.passRate === null ? "Plan only" : `${r.passRate}% passed`));
      tr.append(el("td", "ov-run-req", r.request || r.id), el("td", "", ago(r.generatedAt)), el("td", "", r.riskLevel), res, el("td", "", r.defects), el("td", "", `${Number(r.seconds).toFixed(1)} s`));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    p.appendChild(wrap);
    return p;
  }

  function knowledge(project) {
    const p = panel("Knowledge base", project?.vault ? `${project.vault.notes} notes in the vault` : "", "Reports", () => actions.openView("reports"));
    const types = data?.noteTypes ?? [];
    if (!types.length) {
      p.appendChild(empty("No notes are indexed yet."));
      return p;
    }
    const max = Math.max(...types.map((t) => t.n));
    const ul = el("ul", "ov-bars");
    for (const t of types.slice(0, 6)) {
      const li = el("li", "ov-bar");
      const track = el("span", "ov-bar-track");
      const fill = el("span", "ov-bar-fill");
      fill.style.width = `${Math.max(4, Math.round((t.n / max) * 100))}%`;
      track.appendChild(fill);
      li.append(el("span", "ov-bar-label", t.type), track, el("span", "ov-bar-n", t.n));
      ul.appendChild(li);
    }
    p.appendChild(ul);
    if (project?.vault?.problems) p.appendChild(el("p", "ov-note warn", `${project.vault.problems} notes have problems. Run /check to list them.`));
    return p;
  }

  function repos(project) {
    const p = panel("Repositories", "Read-only; Guard never writes here", null);
    if (!project?.repos?.length) {
      p.appendChild(empty("No repositories are configured."));
      return p;
    }
    const ul = el("ul", "ov-list");
    for (const r of project.repos) {
      const li = el("li", "ov-repo");
      li.append(el("span", "ov-repo-name", r.label), el("span", "ov-repo-branch", r.branch || "no branch"), el("span", "ov-repo-n", `${r.commits.toLocaleString("en")} commits`));
      ul.appendChild(li);
    }
    p.appendChild(ul);
    return p;
  }

  function quick() {
    const p = panel("Quick actions", null, null);
    const grid = el("div", "ov-quick");
    const items = [
      ["New chat", IC.chat, () => actions.openChat(), "violet"],
      ["QA this change", IC.qa, () => actions.fillQa(), "green"],
      ["Review inbox", IC.inbox, () => actions.openView("inbox"), "amber"],
      ["Reports", IC.report, () => actions.openView("reports"), "blue"],
      ["Search", IC.search, () => actions.focusSearch(), "violet"],
      ["Model & keys", IC.key, () => actions.openView("settings"), "blue"],
    ];
    for (const [label, d, fn, tone] of items) {
      const b = el("button", "ov-quick-btn");
      b.type = "button";
      const ic = el("span", `ov-kpi-ic ${tone}`);
      ic.appendChild(icon(d));
      b.append(ic, el("span", "", label));
      b.addEventListener("click", fn);
      grid.appendChild(b);
    }
    p.appendChild(grid);
    return p;
  }

  function howToUse() {
    const p = panel("How to use SPIL REO", "REVIEW · EVALUATE · OPTIMIZE — Powered by SPIL Labs", "Open Chat", () => actions.openChat());
    const ul = el("ul", "ov-list");
    const guide = [
      ["1. Chat (Main Workspace)", "Ask questions about SPIL AURA, run /qa, /review, /check, or inspect commit history backed by your local vault."],
      ["2. QA Harness", "Run live UI/Desktop crawls (Windows UIA & Playwright), OpenAPI contract checks, and safe local DevSecOps probes."],
      ["3. Inbox & Reports", "Review proposed vault rules, commit trajectory alerts, bug sheets, and PR readiness packets."],
      ["4. Privacy & Safety", "SPIL REO is strictly read-only on your repos and ERP, and masks 100% of secrets before any model call."],
    ];
    for (const [title, desc] of guide) {
      const li = el("li", "ov-repo");
      li.append(el("span", "ov-repo-name", title), el("span", "ov-repo-branch", desc));
      ul.appendChild(li);
    }
    p.appendChild(ul);
    return p;
  }

  function paint() {
    const project = getProject();
    root.replaceChildren();
    const body = el("div", "ov-wrap");
    if (failed) body.appendChild(el("p", "ov-note warn", "The overview could not be loaded. The numbers below come from the project summary only."));
    body.appendChild(howToUse());
    body.appendChild(stats(project));
    body.appendChild(process(project));
    body.appendChild(pipeline(project));
    const cols = el("div", "ov-cols");
    const main = el("div", "ov-col");
    main.append(runs(), activity());
    const side = el("div", "ov-col");
    side.append(quick(), knowledge(project), repos(project));
    cols.append(main, side);
    body.appendChild(cols);
    root.appendChild(body);
  }

  async function refresh() {
    const r = await api("/api/overview");
    failed = !r.ok;
    data = r.ok ? r.data : null;
    paint();
  }
  return { show: refresh, refresh, paint };
}
