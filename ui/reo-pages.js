// SPIL REO — UI controllers for Defects, Plugins Hub (+ Team Directory), and Agents/Tools/Skills.
// CSP-strict DOM construction (createElement / textContent only; no innerHTML).

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function btn(cls, label, onClick) {
  const b = el("button", cls, label);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function pill(text, tone = "") {
  return el("span", `reo-pill${tone ? ` ${tone}` : ""}`, text);
}

function sevTone(sev) {
  if (sev === "critical" || sev === "high") return "bad";
  if (sev === "medium") return "warn";
  return "info";
}

export function mountReoPages({ api, toast, onRunMission, openView, openSource }) {
  // ---------------- 1. DEFECTS & REPORTS PAGE ----------------
  function mountDefects(root) {
    let defects = [];
    let team = [];
    let selected = null;
    let showNewForm = false;
    let showTeamsBox = false;
    let filters = { q: "", severity: "all", status: "all" };

    async function load() {
      const [dr, pr] = await Promise.all([api("/api/defects"), api("/api/plugins")]);
      if (dr.ok) defects = dr.data.defects || [];
      if (pr.ok) team = pr.data.team || [];
      if (selected) selected = defects.find((d) => d.id === selected.id) || null;
      paint();
    }

    function filteredDefects() {
      const q = filters.q.trim().toLowerCase();
      return defects.filter((d) => {
        if (filters.severity !== "all" && d.severity !== filters.severity) return false;
        if (filters.status !== "all" && d.status !== filters.status) return false;
        if (q && !`${d.id} ${d.title} ${d.appName} ${d.branch} ${d.testedBy} ${d.assignedTo}`.toLowerCase().includes(q)) return false;
        return true;
      });
    }

    async function exportReport(list) {
      const res = await api("/api/defects/report", {
        method: "POST",
        body: JSON.stringify({ ids: list.map((d) => d.id), branch: list[0]?.branch, appName: list[0]?.appName }),
      });
      if (!res.ok) return toast("Could not generate report.");
      toast(`Saved report: ${res.data.path}`);
      const blob = new Blob([res.data.html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
    }

    function paint() {
      root.replaceChildren();
      const wrap = el("div", "reo-wrap");
      const list = filteredDefects();

      const head = el("div", "reo-head");
      const titles = el("div");
      titles.append(
        el("h2", "reo-title", "Defects & Assurance Reports"),
        el("p", "reo-sub", "Deduplicated findings across QA, Code Review, API, and Security agents — export PDFs or dispatch to MS Teams."),
      );
      const acts = el("div", "reo-actions");
      acts.append(
        btn("btn btn-quiet", showNewForm ? "Close Form" : "+ Log Defect", () => { showNewForm = !showNewForm; paint(); }),
        btn("btn btn-quiet", "Send to Teams", () => { showTeamsBox = !showTeamsBox; paint(); }),
        btn("btn btn-primary", "Export PDF Report", () => exportReport(list)),
      );
      head.append(titles, acts);
      wrap.appendChild(head);

      const kpis = el("div", "reo-kpis");
      const kpiItems = [
        [defects.length, "Total Defects"],
        [defects.filter((d) => d.status === "open").length, "Open"],
        [defects.filter((d) => d.severity === "critical" || d.severity === "high").length, "Critical / High"],
        [defects.filter((d) => Boolean(d.sentTeamsAt)).length, "Dispatched to Teams"],
        [defects.filter((d) => d.status === "fixed").length, "Resolved"],
      ];
      for (const [val, label] of kpiItems) {
        const k = el("div", "reo-kpi");
        k.append(el("b", "", val), el("span", "", label));
        kpis.appendChild(k);
      }
      wrap.appendChild(kpis);

      if (showNewForm) {
        const f = el("form", "reo-form");
        const titleIn = el("input", "reo-input"); titleIn.placeholder = "Defect title (required)";
        const appIn = el("input", "reo-input"); appIn.placeholder = "App Name (e.g. SPIL AURA)"; appIn.value = "SPIL AURA";
        const branchIn = el("input", "reo-input"); branchIn.placeholder = "Branch Name"; branchIn.value = "development";
        const testerIn = el("input", "reo-input"); testerIn.placeholder = "Tested By";
        const assignIn = el("input", "reo-input"); assignIn.placeholder = "Assign Engineer";
        const sevSel = el("select", "reo-select");
        for (const s of ["critical", "high", "medium", "low"]) sevSel.appendChild(el("option", "", s));
        sevSel.value = "high";
        const sugIn = el("textarea", "reo-textarea"); sugIn.placeholder = "Code review suggestion / recommended fix...";
        const actions = el("div", "reo-form-full");
        actions.append(btn("btn btn-primary", "Save Defect", async () => {
          if (!titleIn.value.trim()) return toast("Title is required.");
          const r = await api("/api/defects", {
            method: "POST",
            body: JSON.stringify({
              title: titleIn.value.trim(),
              appName: appIn.value.trim() || "SPIL AURA",
              branch: branchIn.value.trim() || "development",
              testedBy: testerIn.value.trim() || "QA Engineer",
              assignedTo: assignIn.value.trim(),
              severity: sevSel.value,
              codeSuggestion: sugIn.value.trim(),
            }),
          });
          if (r.ok) { showNewForm = false; toast(`Saved ${r.data.defect.id}`); await load(); }
        }));
        f.append(titleIn, appIn, branchIn, testerIn, assignIn, sevSel, sugIn, actions);
        wrap.appendChild(f);
      }

      if (showTeamsBox) {
        const tf = el("div", "reo-form");
        const recSel = el("select", "reo-select");
        recSel.appendChild(el("option", "", "Pick Team Member (or enter webhook)"));
        for (const m of team) {
          const opt = el("option", "", `${m.name} (${m.role})`);
          opt.value = m.id;
          recSel.appendChild(opt);
        }
        const hookIn = el("input", "reo-input"); hookIn.placeholder = "HTTPS Teams Webhook URL (optional for preview)";
        recSel.addEventListener("change", () => {
          const m = team.find((x) => x.id === recSel.value);
          if (m && m.teamsWebhookOrId) hookIn.value = m.teamsWebhookOrId;
        });
        const noteIn = el("input", "reo-input"); noteIn.placeholder = "Message note to engineer...";
        const actsRow = el("div", "reo-form-full");
        actsRow.append(
          btn("btn btn-quiet", "Preview Card", async () => {
            const m = team.find((x) => x.id === recSel.value);
            const r = await api("/api/defects/notify-teams", {
              method: "POST",
              body: JSON.stringify({ recipientName: m ? m.name : "Engineering Team", note: noteIn.value, ids: list.map((d) => d.id), confirmed: false }),
            });
            if (r.ok) toast("Built Teams adaptive card preview.");
          }),
          btn("btn btn-primary", "Confirm & Send to Teams", async () => {
            const m = team.find((x) => x.id === recSel.value);
            const r = await api("/api/defects/notify-teams", {
              method: "POST",
              body: JSON.stringify({ recipientName: m ? m.name : "Engineering Team", note: noteIn.value, ids: list.map((d) => d.id), webhookUrl: hookIn.value.trim(), confirmed: true }),
            });
            if (r.ok) {
              toast(r.data.sent ? `Dispatched ${r.data.count} defect(s) to Teams.` : "No HTTPS webhook provided — preview generated only.");
              showTeamsBox = false;
              await load();
            }
          }),
        );
        tf.append(recSel, hookIn, noteIn, actsRow);
        wrap.appendChild(tf);
      }

      const bar = el("div", "reo-filters");
      const qIn = el("input", "reo-input"); qIn.placeholder = "Filter by app, branch, tester, or title..."; qIn.value = filters.q;
      qIn.addEventListener("input", () => { filters.q = qIn.value; paint(); });
      const sevF = el("select", "reo-select");
      for (const s of ["all", "critical", "high", "medium", "low"]) sevF.appendChild(el("option", "", s === "all" ? "All severities" : s)).value = s;
      sevF.value = filters.severity;
      sevF.addEventListener("change", () => { filters.severity = sevF.value; paint(); });
      const stF = el("select", "reo-select");
      for (const s of ["all", "open", "triaged", "notified", "fixed", "false_positive"]) stF.appendChild(el("option", "", s === "all" ? "All statuses" : s)).value = s;
      stF.value = filters.status;
      stF.addEventListener("change", () => { filters.status = stF.value; paint(); });
      bar.append(qIn, sevF, stF);
      wrap.appendChild(bar);

      const tblWrap = el("div", "reo-table-wrap");
      const tbl = el("table", "reo-table");
      const thead = el("thead");
      const hr = el("tr");
      for (const h of ["ID", "Defect", "Severity", "App / Branch", "Tested Date & By", "Assigned", "Status"]) hr.appendChild(el("th", "", h));
      thead.appendChild(hr);
      const tbody = el("tbody");
      if (!list.length) {
        const tr = el("tr");
        const td = el("td", "reo-note", "No defects recorded yet. Run QA/Review/Security agents or click + Log Defect.");
        td.colSpan = 7;
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      for (const d of list) {
        const tr = el("tr");
        tr.append(
          el("td", "", d.id),
          el("td", "", d.title),
        );
        const sevTd = el("td"); sevTd.appendChild(pill(d.severity.toUpperCase(), sevTone(d.severity))); tr.appendChild(sevTd);
        tr.append(
          el("td", "", `${d.appName} / ${d.branch}`),
          el("td", "", `${d.testedDate} · ${d.testedBy}`),
          el("td", "", d.assignedTo || "Unassigned"),
        );
        const stTd = el("td"); stTd.appendChild(pill(d.status, d.status === "fixed" ? "ok" : d.status === "notified" ? "info" : "")); tr.appendChild(stTd);
        tr.addEventListener("click", () => { selected = d; paint(); });
        tbody.appendChild(tr);
      }
      tbl.append(thead, tbody);
      tblWrap.appendChild(tbl);
      wrap.appendChild(tblWrap);

      if (selected) {
        const drw = el("section", "reo-drawer");
        const dHead = el("div", "reo-card-head");
        dHead.append(el("h3", "reo-card-title", `${selected.id}: ${selected.title}`), pill(selected.severity.toUpperCase(), sevTone(selected.severity)));
        drw.appendChild(dHead);
        drw.appendChild(el("p", "reo-note", `App: ${selected.appName} | Branch: ${selected.branch} | Tested: ${selected.testedDate} by ${selected.testedBy} | Source Agent: ${selected.agentSource.toUpperCase()}`));
        if (selected.expected) drw.appendChild(el("p", "reo-note", `Expected: ${selected.expected}`));
        if (selected.actual) drw.appendChild(el("p", "reo-note", `Actual: ${selected.actual}`));
        if (selected.codeSuggestion) drw.append(el("strong", "reo-note", `Code Review Suggestion${selected.fileRef ? ` (${selected.fileRef})` : ""}:`), el("pre", "reo-pre", selected.codeSuggestion));
        if (selected.evidencePaths?.length) drw.appendChild(el("p", "reo-note", `Evidence: ${selected.evidencePaths.join(", ")}`));
        const dActs = el("div", "reo-actions");
        for (const [st, label] of [["triaged", "Mark Triaged"], ["fixed", "Mark Fixed"], ["false_positive", "False Positive"]]) {
          dActs.appendChild(btn("btn btn-quiet", label, async () => {
            await api(`/api/defects/${encodeURIComponent(selected.id)}`, { method: "PATCH", body: JSON.stringify({ status: st }) });
            await load();
          }));
        }
        dActs.appendChild(btn("btn btn-primary", "Export This Defect (PDF/Print)", () => exportReport([selected])));
        drw.appendChild(dActs);
        wrap.appendChild(drw);
      }

      root.appendChild(wrap);
    }

    return { show: load, refresh: load };
  }

  // ---------------- 2. PLUGINS & TEAM DIRECTORY PAGE ----------------
  function mountPlugins(root) {
    let plugins = [];
    let team = [];

    async function load() {
      const r = await api("/api/plugins");
      if (r.ok) {
        plugins = r.data.plugins || [];
        team = r.data.team || [];
      }
      paint();
    }

    function paint() {
      root.replaceChildren();
      const wrap = el("div", "reo-wrap");
      const head = el("div", "reo-head");
      const titles = el("div");
      titles.append(
        el("h2", "reo-title", "Plugins & Integrations Hub"),
        el("p", "reo-sub", "Connect Composio toolkits, Microsoft Teams webhooks, Azure DevOps, GitHub, and MCP servers."),
      );
      head.appendChild(titles);
      wrap.appendChild(head);

      const grid = el("div", "reo-grid");
      for (const p of plugins) {
        const card = el("article", "reo-card");
        const ch = el("div", "reo-card-head");
        const left = el("div");
        left.append(el("h3", "reo-card-title", p.name), el("span", "reo-note", p.category));
        ch.append(left, pill(p.enabled ? p.status.toUpperCase() : "DISABLED", p.enabled ? "ok" : ""));
        const desc = el("p", "reo-card-desc", p.description);
        const ep = el("input", "reo-input");
        ep.placeholder = p.id === "composio" ? "Composio workspace / base URL" : p.id === "ms-teams" ? "Teams Webhook URL (https://...)" : "Server / API Endpoint";
        ep.value = p.endpoint || "";
        const row = el("div", "reo-actions");
        row.append(
          btn("btn btn-quiet", p.enabled ? "Disable" : "Enable", async () => {
            await api(`/api/plugins/${encodeURIComponent(p.id)}`, { method: "PUT", body: JSON.stringify({ enabled: !p.enabled, endpoint: ep.value.trim() }) });
            await load();
          }),
          btn("btn btn-primary", "Save", async () => {
            await api(`/api/plugins/${encodeURIComponent(p.id)}`, { method: "PUT", body: JSON.stringify({ enabled: true, endpoint: ep.value.trim() }) });
            toast(`Saved ${p.name}`);
            await load();
          }),
        );
        card.append(ch, desc, ep, row);
        grid.appendChild(card);
      }
      wrap.appendChild(grid);

      // Team Directory for Teams Dispatch
      const tHead = el("div", "reo-head");
      tHead.append(el("h3", "reo-card-title", "Team Directory (MS Teams Engineer Mapping)"));
      wrap.appendChild(tHead);

      const tf = el("form", "reo-form");
      const nIn = el("input", "reo-input"); nIn.placeholder = "Engineer Name";
      const rIn = el("input", "reo-input"); rIn.placeholder = "Role / Module (e.g. Orders UI)";
      const gIn = el("input", "reo-input"); gIn.placeholder = "Git Alias / Email";
      const wIn = el("input", "reo-input"); wIn.placeholder = "MS Teams Webhook URL or Email";
      const tAct = el("div", "reo-form-full");
      tAct.append(btn("btn btn-primary", "+ Add Team Member", async () => {
        if (!nIn.value.trim()) return toast("Engineer name required.");
        const res = await api("/api/team", {
          method: "POST",
          body: JSON.stringify({ name: nIn.value.trim(), role: rIn.value.trim() || "Engineer", gitAlias: gIn.value.trim(), teamsWebhookOrId: wIn.value.trim() }),
        });
        if (res.ok) { toast(`Added ${res.data.member.name}`); await load(); }
      }));
      tf.append(nIn, rIn, gIn, wIn, tAct);
      wrap.appendChild(tf);

      const tblWrap = el("div", "reo-table-wrap");
      const tbl = el("table", "reo-table");
      const thead = el("thead");
      const hr = el("tr");
      for (const h of ["Name", "Role", "Git Alias", "Teams Target", ""]) hr.appendChild(el("th", "", h));
      thead.appendChild(hr);
      const tbody = el("tbody");
      for (const m of team) {
        const tr = el("tr");
        tr.append(el("td", "", m.name), el("td", "", m.role), el("td", "", m.gitAlias || "—"), el("td", "", m.teamsWebhookOrId || "—"));
        const actTd = el("td");
        actTd.appendChild(btn("btn btn-quiet", "Remove", async () => {
          await api(`/api/team/${encodeURIComponent(m.id)}`, { method: "DELETE" });
          await load();
        }));
        tr.appendChild(actTd);
        tbody.appendChild(tr);
      }
      tbl.append(thead, tbody);
      tblWrap.appendChild(tbl);
      wrap.appendChild(tblWrap);

      root.appendChild(wrap);
    }

    return { show: load, refresh: load };
  }

  // ---------------- 3. AGENTS, TOOL LIBRARY & SKILL LIBRARY PAGE ----------------
  function mountAgents(root) {
    let tab = "agents";
    let query = "";
    let agents = [];
    let tools = [];
    let skills = [];

    async function load() {
      const [ar, sr] = await Promise.all([api("/api/reo/agents"), api("/api/qa/skills")]);
      if (ar.ok) { agents = ar.data.agents || []; tools = ar.data.tools || []; }
      if (sr.ok) skills = sr.data.skills || [];
      paint();
    }

    function paint() {
      root.replaceChildren();
      const wrap = el("div", "reo-wrap");
      const head = el("div", "reo-head");
      const titles = el("div");
      titles.append(
        el("h2", "reo-title", "Sub-Agents, Tool Library & Skill Library"),
        el("p", "reo-sub", "Prebuilt specialist agents, permission-tiered tools, and 33+ reusable engineering skills."),
      );
      const qIn = el("input", "reo-input");
      qIn.placeholder = "Filter agents, tools, or skills...";
      qIn.value = query;
      qIn.addEventListener("input", () => { query = qIn.value; paint(); });
      head.append(titles, qIn);
      wrap.appendChild(head);

      const tabs = el("div", "reo-tabs");
      for (const [id, label] of [["agents", `Sub-Agents (${agents.length})`], ["tools", `Tool Library (${tools.length})`], ["skills", `Skill Library (${skills.length})`]]) {
        tabs.appendChild(btn(`reo-tab${tab === id ? " active" : ""}`, label, () => { tab = id; paint(); }));
      }
      wrap.appendChild(tabs);

      const q = query.trim().toLowerCase();
      const grid = el("div", "reo-grid");
      if (tab === "agents") {
        for (const a of agents.filter((x) => !q || `${x.name} ${x.role} ${x.description}`.toLowerCase().includes(q))) {
          const card = el("article", "reo-card");
          const ch = el("div", "reo-card-head");
          const left = el("div");
          left.append(el("h3", "reo-card-title", a.name), el("span", "reo-note", `@${a.id} · ${a.role}`));
          ch.append(left, pill(a.riskTier, a.riskTier === "read_only" ? "ok" : "warn"));
          const foot = el("div", "reo-actions");
          if (onRunMission) {
            foot.appendChild(btn("btn btn-primary", `Run @${a.id} →`, () => onRunMission(`@${a.id} run automated inspection and report findings`)));
          }
          card.append(ch, el("p", "reo-card-desc", a.description), el("p", "reo-note", `Tools: ${a.allowedTools.join(", ")}`), el("p", "reo-note", `Skills: ${a.defaultSkills.join(", ")}`), foot);
          grid.appendChild(card);
        }
      } else if (tab === "tools") {
        for (const t of tools.filter((x) => !q || `${x.name} ${x.id} ${x.category} ${x.description}`.toLowerCase().includes(q))) {
          const card = el("article", "reo-card");
          const ch = el("div", "reo-card-head");
          ch.append(el("h3", "reo-card-title", t.name), pill(t.riskTier, t.riskTier === "read_only" ? "ok" : t.riskTier === "external_notify" ? "bad" : "warn"));
          card.append(ch, el("p", "reo-card-desc", t.description), el("p", "reo-note", `ID: ${t.id} · Category: ${t.category} · Confirm: ${t.requiresConfirmation ? "Yes" : "Auto"}`));
          grid.appendChild(card);
        }
      } else {
        for (const s of skills.filter((x) => !q || `${x.name || x.id} ${x.category || ""} ${x.description || ""}`.toLowerCase().includes(q))) {
          const card = el("article", "reo-card");
          const ch = el("div", "reo-card-head");
          ch.append(el("h3", "reo-card-title", s.name || s.id), pill(s.category || "skill", "info"));
          card.append(ch, el("p", "reo-card-desc", s.description || ""));
          grid.appendChild(card);
        }
      }
      wrap.appendChild(grid);
      root.appendChild(wrap);
    }

    return { show: load, refresh: load };
  }

  // ---------------- 4. KNOWLEDGE HUB PAGE (Vault Explorer + Inbox + Reports + Guide) ----------------
  function mountKnowledge(root) {
    let notes = [];
    let query = "";
    let statusFilter = "all";

    async function load() {
      const r = await api("/api/reo/notes");
      if (r.ok) notes = r.data.notes || [];
      paint();
    }

    function paint() {
      root.replaceChildren();
      const wrap = el("div", "reo-wrap");
      const head = el("div", "reo-head");
      const titles = el("div");
      titles.append(
        el("h2", "reo-title", "Knowledge & Memory Hub"),
        el("p", "reo-sub", "Browse Obsidian vault notes, review proposed rules in Inbox, read Reports, or view How REO Works."),
      );
      const navBtns = el("div", "reo-actions");
      if (openView) {
        navBtns.append(
          btn("btn btn-quiet", "Review Inbox →", () => openView("inbox")),
          btn("btn btn-quiet", "Saved Reports →", () => openView("reports")),
          btn("btn btn-primary", "How REO Works →", () => openView("how")),
        );
      }
      head.append(titles, navBtns);
      wrap.appendChild(head);

      const bar = el("div", "reo-filters");
      const qIn = el("input", "reo-input");
      qIn.placeholder = "Search vault notes by title, id, or type...";
      qIn.value = query;
      qIn.addEventListener("input", () => { query = qIn.value; paint(); });
      const stSel = el("select", "reo-select");
      for (const s of ["all", "active", "proposed", "stale", "shadow", "deprecated"]) stSel.appendChild(el("option", "", s === "all" ? "All statuses" : s)).value = s;
      stSel.value = statusFilter;
      stSel.addEventListener("change", () => { statusFilter = stSel.value; paint(); });
      bar.append(qIn, stSel);
      wrap.appendChild(bar);

      const q = query.trim().toLowerCase();
      const list = notes.filter((n) => (statusFilter === "all" || n.status === statusFilter) && (!q || `${n.title} ${n.id} ${n.type}`.toLowerCase().includes(q)));

      const tblWrap = el("div", "reo-table-wrap");
      const tbl = el("table", "reo-table");
      const thead = el("thead");
      const hr = el("tr");
      for (const h of ["Title", "Type", "Status", "Audience", "Anchors"]) hr.appendChild(el("th", "", h));
      thead.appendChild(hr);
      const tbody = el("tbody");
      if (!list.length) {
        const tr = el("tr");
        const td = el("td", "reo-note", "No matching vault notes found.");
        td.colSpan = 5;
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      for (const n of list) {
        const tr = el("tr");
        tr.append(el("td", "", n.title), el("td", "", n.type));
        const stTd = el("td");
        stTd.appendChild(pill(n.status, n.status === "active" ? "ok" : n.status === "stale" ? "bad" : "warn"));
        tr.append(stTd, el("td", "", Array.isArray(n.audience) ? n.audience.join(", ") : String(n.audience || "")), el("td", "", String(n.anchors || 0)));
        if (openSource && n.ref) tr.addEventListener("click", () => openSource({ ref: n.ref, kind: "note", title: n.title }));
        tbody.appendChild(tr);
      }
      tbl.append(thead, tbody);
      tblWrap.appendChild(tbl);
      wrap.appendChild(tblWrap);
      root.appendChild(wrap);
    }

    return { show: load, refresh: load };
  }

  // ---------------- 5. SYSTEM SETTINGS EXTENSION (Repos, Guardrails & Index) ----------------
  function mountSystemSettings(settingsRoot) {
    let sys = null;
    const host = el("section", "reo-wrap");
    settingsRoot.appendChild(host);

    async function load() {
      const r = await api("/api/reo/system");
      if (r.ok) sys = r.data;
      paint();
    }

    function paint() {
      host.replaceChildren();
      const head = el("div", "reo-head");
      const t = el("div");
      t.append(el("h2", "reo-title", "Repositories, Guardrails & Maintenance"), el("p", "reo-sub", "Configured local repos, read-only safety policies, Team Directory, and SQLite index controls."));
      const acts = el("div", "reo-actions");
      if (openView) acts.appendChild(btn("btn btn-quiet", "Manage Team Directory & Plugins →", () => openView("plugins")));
      acts.appendChild(btn("btn btn-primary", "Rebuild SQLite Index", async () => {
        toast("Rebuilding index...");
        const r = await api("/api/index", { method: "POST" });
        if (r.ok) { toast("Index rebuilt cleanly."); await load(); }
        else toast("Index rebuild failed.");
      }));
      head.append(t, acts);
      host.appendChild(head);

      if (!sys) return;
      const grid = el("div", "reo-grid");
      const repoCard = el("article", "reo-card");
      repoCard.append(el("h3", "reo-card-title", `Configured Repositories (${sys.repos.length})`));
      for (const r of sys.repos) {
        repoCard.append(el("p", "reo-note", `${r.label} (${r.id}) — ${r.path}`));
      }
      const guardCard = el("article", "reo-card");
      guardCard.append(
        el("h3", "reo-card-title", "Active Safety & DevSecOps Guardrails"),
        el("p", "reo-note", `Read-Only Target Repos: ${sys.guardrails.readOnlyRepos ? "Enforced" : "Off"}`),
        el("p", "reo-note", `Secret Masking Gate: ${sys.guardrails.maskingGate}`),
        el("p", "reo-note", `Local-Only Security Probes: ${sys.guardrails.localOnlyProbes ? "Enforced" : "Off"}`),
        el("p", "reo-note", `ERP Write Blocking: ${sys.guardrails.erpWritesBlocked ? "Enforced" : "Off"}`),
      );
      const statCard = el("article", "reo-card");
      statCard.append(
        el("h3", "reo-card-title", "Platform Telemetry"),
        el("p", "reo-note", `Vault Notes: ${sys.vaultNotes} (${sys.vaultProblems} problem(s))`),
        el("p", "reo-note", `Installed Skills: ${sys.skillsCount}`),
        el("p", "reo-note", `Tracked Defects: ${sys.defectsCount}`),
      );
      grid.append(repoCard, guardCard, statCard);
      host.appendChild(grid);
    }

    load();
    return { refresh: load };
  }

  return { mountDefects, mountPlugins, mountAgents, mountKnowledge, mountSystemSettings };
}
