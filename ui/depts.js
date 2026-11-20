// Departments screens: landing (choose a department), overview table, department page, and the
// "Add department" wizard. DOM only; the logic lives in departments.js, wizard.js and deptapi.js.
// Every value from the server goes in with textContent, never innerHTML.

import { PRODUCT_NAME, PRODUCT_TAGLINE } from "/brand.js";
import { COLORS, colorHex, FALLBACK_TEMPLATES, ROLE_INFO, addModule, addSource, addSubModule, ago, classifySave, continueTarget, countSources, filterDepartments, flatSources, indexAge, landingMode, loadLast, moveIndex, needsSources, numberKeyTarget, removeNode, removeSource, renameNode, saveLast, summarizeAll, tileHealth, validateName, validatePath } from "/departments.js";
import { createDeptApi } from "/deptapi.js";
import { STEPS, STEP_TITLES, createBody, initialWizard, stepErrors, wizardReducer } from "/wizard.js";

/** Tiny element builder: props are class, text, on<Event> handlers, or attributes. */
function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "color") n.style.setProperty("--dc", colorHex(v));
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

export function initDepartments(ctx) {
  const api = createDeptApi();
  const S = { list: [], templates: [], defaultDepartment: null, loaded: false, error: null, view: "tiles", q: "", cur: null, curError: null, run: null, status: new Map(), nextAction: null };
  const root = { landing: ctx.$("view-landing"), dept: ctx.$("view-dept"), wizard: ctx.$("wizard") };
  const storage = ctx.storage;
  const templates = () => (S.templates.length ? S.templates : FALLBACK_TEMPLATES);

  /* ---------- shared bits ---------- */
  const dot = (color) => h("span", { class: "dot", color, "aria-hidden": "true" });
  const banner = (text, retry) => h("div", { class: "banner", role: "alert" }, h("span", { class: "banner-text", text }), retry ? h("button", { type: "button", class: "btn", onClick: retry }, "Retry") : null);
  const skeleton = (n = 4) => h("div", { class: "skel-wrap", "aria-busy": "true", "aria-label": "Loading" }, Array.from({ length: n }, () => h("div", { class: "skel" })));

  /** Streams /index for a department into a small card. `host` is where the card goes. */
  async function runIndex(id, host, name) {
    if (S.run) return ctx.toast("An index run is already going. Wait for it to finish.", { error: true });
    const chip = h("span", { class: "chip-state", "data-status": "run" }, "Running");
    const pre = h("pre", { class: "run-out", tabindex: "0", "aria-label": "Index output" });
    const card = h("section", { class: "run-card", "aria-label": `Index ${name}` }, h("header", {}, h("strong", { text: `Index now: ${name}` }), chip), pre);
    host.replaceChildren(card);
    host.hidden = false;
    S.run = id;
    S.lastRun = { id, card };
    let done = null;
    let out = "";
    try {
      const reply = await ctx.streamPost("/api/command", { line: "/index", dept: id }, undefined, (ev) => {
        if (ev.type === "output") {
          out += ev.chunk;
          pre.textContent = out;
          pre.scrollTop = pre.scrollHeight;
        } else if (ev.type === "done") done = ev;
      });
      if (reply.json) {
        pre.textContent = reply.json.output || reply.json.error || "That command did not run.";
        done = { code: reply.json.ok ? 0 : 1 };
      }
    } catch {
      pre.textContent = "Lost contact with the server.";
      done = { code: 1 };
    }
    S.run = null;
    const ok = done && done.code === 0;
    chip.textContent = ok ? "Done" : "Failed";
    chip.setAttribute("data-status", ok ? "ok" : "fail");
    if (!out && !pre.textContent) pre.textContent = "(no output)";
    await loadList(true);
    if (S.cur && S.cur.department.id === id) await loadDept(id, true);
  }

  /* ---------- data ---------- */
  async function loadList(quiet) {
    if (!quiet) {
      S.loaded = false;
      S.error = null;
    }
    const r = await api.list();
    if (r.ok) {
      S.list = r.data.departments || [];
      S.templates = r.data.templates || [];
      S.defaultDepartment = r.data.defaultDepartment || null;
      S.error = null;
      S.legacy = false;
    } else if (r.status === 404) S.legacy = true;
    else S.error = r.data.error || "Could not load the departments.";
    S.loaded = true;
    ctx.onList(S.list);
    if (!root.landing.hidden) renderLanding(quiet);
    return r.ok;
  }
  const find = (id) => S.list.find((d) => d.id === id) || null;

  /* ===================================================================== LANDING */
  function openDept(d, view) {
    saveLast(storage, d.id);
    ctx.enter(d.id, view || "chat");
  }

  function tileCounts(d) {
    const c = d.counts || {};
    return `${plural(c.modules || 0, "module")} · ${plural(c.subModules || 0, "sub-module")} · ${plural(c.sources || 0, "source")}`;
  }

  function tile(d, i) {
    const hl = tileHealth(d);
    const open = h("button", { type: "button", class: "tile", "data-id": d.id, color: d.color, "aria-label": `${d.name}. ${d.description || ""} ${tileCounts(d)}. ${hl.label}.${i < 9 ? ` Press ${i + 1} to open.` : ""}`, onClick: () => openDept(d) },
      i < 9 ? h("span", { class: "tile-key", "aria-hidden": "true", text: String(i + 1) }) : h("span", { class: "tile-key", "aria-hidden": "true" }),
      dot(d.color),
      h("span", { class: "tile-main" }, h("span", { class: "tile-name", text: d.name }), h("span", { class: "tile-desc", text: d.description || "No description yet." })),
      h("span", { class: "tile-counts", text: tileCounts(d) }),
      h("span", { class: "tile-health", "data-tone": hl.tone, text: hl.label }));
    const acts = h("div", { class: "tile-actions" },
      h("button", { type: "button", class: "link-btn", "aria-label": `Ask in ${d.name}`, onClick: () => openDept(d, "chat") }, "Ask"),
      h("button", { type: "button", class: "link-btn", "aria-label": `Inbox of ${d.name}`, onClick: () => openDept(d, "inbox") }, "Inbox"),
      h("button", { type: "button", class: "link-btn", "aria-label": `Settings of ${d.name}`, onClick: () => openDept(d, "dept") }, "Settings"));
    return h("li", { class: "tile-wrap", color: d.color }, open, acts);
  }

  function addTile() {
    return h("li", { class: "tile-wrap tile-wrap-add" },
      h("button", { type: "button", class: "tile tile-add", "aria-label": "Add department", onClick: () => openWizard() },
        h("span", { class: "tile-key", "aria-hidden": "true" }),
        h("span", { class: "tile-plus", "aria-hidden": "true" }, "+"),
        h("span", { class: "tile-main" }, h("span", { class: "tile-name", text: "Add department" }), h("span", { class: "tile-desc", text: "Set up its modules, sources and roles in a few steps." }))));
  }

  function firstRun() {
    return h("section", { class: "first-run", "aria-label": "Set up your first department" },
      h("h2", { class: "fr-title", text: "Let's set up your first department" }),
      h("p", { class: "fr-text", text: "A department is a team with its own repositories, documents and knowledge. Each one stays separate. Pick the kind that fits best; you can change everything later." }),
      h("ul", { class: "fr-templates" }, templates().map((t) => h("li", {}, h("button", { type: "button", class: "fr-card", onClick: () => openWizard(t.id) }, h("strong", { text: t.name }), h("span", { class: "fr-desc", text: t.description }), h("span", { class: "fr-hint", text: t.hint }))))));
  }

  function overview(list) {
    const sum = summarizeAll(S.list);
    const strip = h("dl", { class: "sum-strip", "aria-label": "All departments" },
      [["Departments", sum.departments], ["Modules", sum.modules], ["Sub-modules", sum.subModules], ["Sources", sum.sources], ["In inbox", sum.inbox], ["Need sources", sum.needSources], ["Stale index", sum.stale], ["Problems", sum.problems]].map(([k, v]) => h("div", { class: "sum-item" }, h("dt", { text: k }), h("dd", { text: String(v) }))));
    const cols = ["Department", "Modules", "Sub", "Sources", "Index", "Notes", "Inbox", "Stale", "Daily", "Reviews", "QA", "Problems", ""];
    const rows = list.map((d) => {
      const hh = d.health || {};
      const age = indexAge(hh.indexedAt);
      const c = d.counts || {};
      return h("tr", { color: d.color },
        h("th", { scope: "row" }, h("button", { type: "button", class: "ov-name", onClick: () => openDept(d) }, dot(d.color), h("span", { text: d.name }), needsSources(d) ? h("span", { class: "badge-warn", text: "Needs sources" }) : null)),
        h("td", { class: "num", text: String(c.modules || 0) }), h("td", { class: "num", text: String(c.subModules || 0) }), h("td", { class: "num", text: String(c.sources || 0) }),
        h("td", { class: "ov-index", "data-state": age.state, text: age.state === "never" ? "never" : age.state + " · " + (age.days === 0 ? "today" : age.days + "d") }),
        h("td", { class: "num", text: `${hh.active || 0} / ${hh.proposed || 0}` }), h("td", { class: "num", text: String(hh.inbox || 0) }), h("td", { class: "num", text: String(hh.stale || 0) }),
        h("td", { text: ago(hh.lastDaily) }), h("td", { class: "num", text: String(hh.reviews || 0) }), h("td", { class: "num", text: String(hh.qaPlans || 0) }), h("td", { class: "num", "data-bad": hh.problems ? "1" : null, text: String(hh.problems || 0) }),
        h("td", { class: "ov-acts" },
          h("button", { type: "button", class: "link-btn", "aria-label": `Index ${d.name} now`, onClick: () => runIndex(d.id, runHost(), d.name) }, "Index now"),
          h("button", { type: "button", class: "link-btn", "aria-label": `Open ${d.name}`, onClick: () => openDept(d) }, "Open")));
    });
    return h("div", { class: "overview" }, strip,
      h("div", { class: "table-wrap" }, h("table", { class: "ov-table" }, h("caption", { class: "sr-only", text: "Health of each department. Notes are active / proposed." }), h("thead", {}, h("tr", {}, cols.map((c) => h("th", { scope: "col", text: c })))), h("tbody", {}, rows))));
  }

  const runHost = () => root.landing.querySelector("#l-run");

  function renderBody() {
    const body = root.landing.querySelector("#l-body");
    if (!body) return;
    body.replaceChildren();
    if (S.error) return void body.append(banner(S.error, () => loadList()));
    if (!S.loaded) return void body.append(skeleton(5));
    const mode = landingMode(S.list);
    if (mode === "empty") {
      root.landing.setAttribute("data-mode", "empty");
      return void body.append(firstRun());
    }
    root.landing.setAttribute("data-mode", mode);
    const list = filterDepartments(S.list.map((d) => ({ ...d, moduleNames: d.moduleNames })), S.q);
    S.visible = list;
    if (S.view === "overview") return void body.append(list.length ? overview(list) : h("p", { class: "l-none", text: `No department matches "${S.q}".` }));
    const ul = h("ul", { class: "tiles", "aria-label": "Departments" }, list.map(tile), S.q ? null : addTile());
    if (!list.length) body.append(h("p", { class: "l-none", role: "status", text: `No department matches "${S.q}". Clear the filter to see all ${S.list.length}.` }));
    if (list.length || !S.q) body.append(ul);
    else body.append(h("ul", { class: "tiles" }, addTile()));
  }

  function renderLanding(keepFrame) {
    if (keepFrame && root.landing.querySelector("#l-body")) {
      renderBody();
      renderContinue();
      return;
    }
    const filter = h("input", { id: "l-filter", class: "l-input", type: "search", autocomplete: "off", placeholder: "Filter departments", "aria-label": "Filter departments", value: S.q });
    filter.value = S.q;
    filter.addEventListener("input", () => {
      S.q = filter.value;
      renderBody();
    });
    const viewBtn = (id, label) => h("button", { type: "button", role: "radio", class: "seg-b", "aria-checked": String(S.view === id), onClick: () => { S.view = id; renderLanding(); } }, label);
    const bar = h("div", { class: "l-bar" },
      h("label", { class: "l-filter", for: "l-filter" }, h("span", { class: "l-prompt", "aria-hidden": "true", text: ">" }), filter, h("span", { class: "l-keys", "aria-hidden": "true", text: "1-9 open" })),
      h("div", { class: "seg l-seg", role: "radiogroup", "aria-label": "View" }, viewBtn("tiles", "Tiles"), viewBtn("overview", "Overview")));
    const hero = h("header", { class: "l-hero" }, h("span", { class: "l-mark", "data-slot": "mark" }), h("div", { class: "l-titles" }, h("p", { class: "l-product", text: PRODUCT_NAME }), h("p", { class: "l-sub", text: PRODUCT_TAGLINE })));
    const frame = h("div", { class: "l-scroll", id: "l-scroll" },
      h("div", { class: "l-inner" }, hero, h("h1", { class: "l-choose", text: "Choose your department" }), h("div", { id: "l-continue", class: "l-continue" }), bar, h("div", { id: "l-run", class: "l-run", hidden: true }), h("div", { id: "l-body", class: "l-body" })));
    root.landing.replaceChildren(frame);
    ctx.mountMark(frame.querySelector('[data-slot="mark"]'));
    renderContinue();
    renderBody();
    frame.addEventListener("keydown", onLandingKey);
  }

  function renderContinue() {
    const box = root.landing.querySelector("#l-continue");
    if (!box) return;
    box.replaceChildren();
    const last = continueTarget(S.list, loadLast(storage));
    if (last) box.append(h("button", { type: "button", class: "continue-btn", color: last.color, onClick: () => openDept(last) }, dot(last.color), h("span", { text: `Continue in ${last.name}` }), h("kbd", { text: "Enter" })));
  }

  function tiles() {
    return [...root.landing.querySelectorAll("#l-body .tile")];
  }
  function onLandingKey(e) {
    const t = e.target;
    const filter = root.landing.querySelector("#l-filter");
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (t === filter) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        tiles()[0]?.focus();
      } else if (e.key === "Enter") {
        const first = (S.visible || [])[0];
        const last = continueTarget(S.list, loadLast(storage));
        if (first && S.q) openDept(first);
        else if (last && !S.q) openDept(last);
      } else if (e.key === "Escape" && filter.value) {
        filter.value = "";
        S.q = "";
        renderBody();
      } else if (!S.q && S.view === "tiles") {
        const d = numberKeyTarget(e.key, S.visible || []);
        if (d) {
          e.preventDefault();
          openDept(d);
        }
      }
      return;
    }
    if (t instanceof Element && t.classList.contains("tile")) {
      const all = tiles();
      const i = all.indexOf(t);
      if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const cols = all.filter((x) => x.getBoundingClientRect().top === all[0].getBoundingClientRect().top).length || 1;
        const rows = all.filter((x) => x.closest("li").getBoundingClientRect().left === all[0].closest("li").getBoundingClientRect().left).length;
        const colsReal = rows === all.length ? 1 : cols;
        if (e.key === "ArrowUp" && i - colsReal < 0) return filter.focus();
        all[moveIndex(i, e.key, all.length, colsReal)]?.focus();
        return;
      }
    }
    const typing = t instanceof Element && t.closest("input, textarea, select");
    if (!typing) {
      const d = numberKeyTarget(e.key, S.visible || []);
      if (d && S.view === "tiles") {
        e.preventDefault();
        openDept(d);
      } else if (e.key === "/" ) {
        e.preventDefault();
        filter.focus();
      }
    }
  }

  function showLanding() {
    S.q = "";
    renderLanding();
    if (!S.loaded || S.error) loadList();
    else loadList(true);
    root.landing.querySelector("#l-filter")?.focus({ preventScroll: true });
  }

  /* ===================================================================== DEPARTMENT PAGE */
  async function loadDept(id, quiet) {
    if (!quiet) {
      S.cur = null;
      S.curError = null;
      renderDept(id);
    }
    const r = await api.get(id);
    if (!r.ok) {
      S.curError = r.data.error || "Could not load this department.";
      S.curId = id;
      return renderDept(id);
    }
    S.cur = { department: r.data.department, etag: r.data.etag, health: r.data.health || r.data.department.health || {}, sources: r.data.sources || [] };
    S.status = new Map(S.cur.sources.map((s) => [s.id, s.status]));
    S.curError = null;
    const i = S.list.findIndex((d) => d.id === id);
    if (i >= 0) S.list[i] = { ...S.list[i], ...r.data.department };
    ctx.onList(S.list);
    renderDept(id);
  }

  /** Optimistic save: show `next` now, send it with the etag, put the old one back if it fails. */
  async function commit(next, okText) {
    const before = S.cur;
    const id = before.department.id;
    S.cur = { ...before, department: next };
    renderDept(id);
    const res = await api.update(id, stripView(next), before.etag);
    const out = classifySave(res);
    if (out.kind === "ok") {
      S.cur = { ...S.cur, department: res.data.department, etag: res.data.etag };
      if (okText) ctx.toast(okText);
      await loadDept(id, true);
      await loadList(true);
      return true;
    }
    if (out.kind === "conflict") {
      ctx.toast(out.message, { error: true });
      await loadDept(id, true);
      return false;
    }
    S.cur = before;
    ctx.toast(out.message, { error: true });
    renderDept(id);
    return false;
  }
  /** What goes back to the server: no computed fields and no nulls (the registry rejects them). */
  const stripView = (d) => {
    const { counts, health, ...rest } = d;
    return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null && v !== undefined));
  };

  function inline(opts) {
    const input = h("input", { class: "ie-input", type: "text", value: opts.value || "", placeholder: opts.placeholder || "", "aria-label": opts.label, maxlength: opts.max || 80 });
    input.value = opts.value || "";
    const err = h("span", { class: "ie-err", role: "alert" });
    const form = h("form", { class: "ie-form" }, input, h("button", { type: "submit", class: "btn btn-primary" }, opts.action || "Save"), h("button", { type: "button", class: "btn", onClick: () => opts.cancel() }, "Cancel"), err);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const bad = opts.validate ? opts.validate(input.value) : "";
      if (bad) {
        err.textContent = bad;
        input.setAttribute("aria-invalid", "true");
        return input.focus();
      }
      opts.submit(input.value.trim());
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        opts.cancel();
      }
    });
    setTimeout(() => input.focus(), 0);
    return form;
  }

  /** The source form used on the department page and in the wizard. */
  function sourceForm(opts) {
    let kind = "git";
    const path = h("input", { class: "ie-input src-path", type: "text", "aria-label": "Folder path", placeholder: "D:\\Projects\\my-repo", autocomplete: "off", spellcheck: "false" });
    const label = h("input", { class: "ie-input", type: "text", "aria-label": "Label (optional)", placeholder: "Label (optional)", maxlength: 60 });
    const result = h("div", { class: "check-result", role: "status", "aria-live": "polite" });
    const err = h("span", { class: "ie-err", role: "alert" });
    const target = opts.targets ? h("select", { class: "ie-select", "aria-label": "Attach to" }, opts.targets.map((t, i) => h("option", { value: String(i), text: t.label }))) : null;
    const kinds = h("div", { class: "seg", role: "radiogroup", "aria-label": "Kind of source" });
    const kb = (k, text) => h("button", { type: "button", role: "radio", class: "seg-b", "aria-checked": String(k === kind), onClick: () => { kind = k; for (const b of kinds.children) b.setAttribute("aria-checked", String(b.getAttribute("data-k") === kind)); } , "data-k": k }, text);
    kinds.append(kb("git", "Git repository"), kb("docs", "Documents folder"));
    const check = async () => {
      err.textContent = "";
      const bad = validatePath(path.value);
      if (bad) {
        result.replaceChildren();
        err.textContent = bad;
        return path.focus();
      }
      result.textContent = "Checking...";
      const r = await api.checkSource(opts.deptId || S.defaultDepartment || "new", path.value.trim(), kind);
      result.replaceChildren(r.ok ? statusLine(r.data, kind) : h("span", { class: "st st-bad", text: r.data.error || "Could not check that folder." }));
      return r.ok ? r.data : null;
    };
    const form = h("form", { class: "src-form" }, target, kinds, path, label, h("div", { class: "src-btns" }, h("button", { type: "button", class: "btn", onClick: check }, "Check"), h("button", { type: "submit", class: "btn btn-primary" }, "Add source"), h("button", { type: "button", class: "btn", onClick: () => opts.cancel() }, "Cancel")), err, result);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const bad = validatePath(path.value);
      if (bad) {
        err.textContent = bad;
        return path.focus();
      }
      opts.submit({ kind, path: path.value.trim(), label: label.value.trim() }, target ? opts.targets[Number(target.value)].target : opts.target);
    });
    form.addEventListener("keydown", (e) => e.key === "Escape" && (e.stopPropagation(), opts.cancel()));
    setTimeout(() => path.focus(), 0);
    return form;
  }

  function statusLine(st, kind) {
    if (!st) return h("span", { class: "st", text: "Not checked yet" });
    if (!st.exists) return h("span", { class: "st st-bad", text: st.error || "Path missing" });
    const bits = [h("span", { class: "st st-ok", text: "Found" })];
    if (kind === "docs" || !st.isGit) bits.push(h("span", { class: "st", text: st.isGit === false && kind === "git" ? "Not a git repository" : plural(st.docFiles || 0, "document") }));
    else {
      bits.push(h("span", { class: "st", text: "Git repository" }));
      if (st.branch) bits.push(h("span", { class: "st", text: `Branch ${st.branch}` }));
      if (st.lastCommitAt) bits.push(h("span", { class: "st", text: `Last commit ${ago(st.lastCommitAt)}` }));
      if (st.docFiles !== undefined) bits.push(h("span", { class: "st", text: plural(st.docFiles, "document") }));
    }
    if (st.error) bits.push(h("span", { class: "st st-bad", text: st.error }));
    return h("span", { class: "st-row" }, bits);
  }

  function renderDept(id) {
    const page = root.dept;
    page.replaceChildren();
    const top = h("header", { class: "topbar" }, h("span", { class: "dept-chip", "data-dept-chip": "" }), h("h1", { class: "chat-title", text: "Department" }));
    const scroll = h("div", { class: "scroll d-scroll", id: "d-scroll", tabindex: "-1" });
    page.append(top, scroll);
    ctx.paintChips();
    if (S.curError && !S.cur) return scroll.append(banner(S.curError, () => loadDept(id)));
    if (!S.cur) return scroll.append(skeleton(6));
    const d = S.cur.department;
    const hh = S.cur.health || {};
    const busy = !!S.run;
    const edit = (field, label, multiline) => {
      const input = h(multiline ? "textarea" : "input", { class: "ie-big", "aria-label": label, placeholder: label, rows: multiline ? 2 : null, maxlength: multiline ? 400 : 80, type: multiline ? null : "text" });
      input.value = d[field] || "";
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !multiline) input.blur();
        if (e.key === "Escape") {
          input.value = d[field] || "";
          input.blur();
        }
      });
      input.addEventListener("change", () => {
        if (field === "name") {
          const bad = validateName(input.value);
          if (bad) {
            ctx.toast(bad, { error: true });
            input.value = d.name;
            return;
          }
        }
        if (input.value.trim() !== (d[field] || "")) commit({ ...d, [field]: input.value.trim() }, "Saved.");
      });
      return input;
    };
    const head = h("section", { class: "d-head", color: d.color },
      h("div", { class: "d-title" }, dot(d.color), edit("name", "Department name")),
      edit("description", "Description", true),
      h("label", { class: "d-owner" }, h("span", { text: "Owner" }), edit("owner", "Owner")),
      h("div", { class: "swatches", role: "radiogroup", "aria-label": "Colour" }, COLORS.map((c) => h("button", { type: "button", role: "radio", class: "swatch", color: c, "aria-checked": String(c === d.color), "aria-label": `Colour ${c}`, onClick: () => c !== d.color && commit({ ...d, color: c }, "Colour changed.") }))));
    const age = indexAge(hh.indexedAt);
    const stat = (k, v, tone) => h("div", { class: "h-item", "data-tone": tone || null }, h("dt", { text: k }), h("dd", { text: String(v) }));
    const health = h("section", { class: "d-health", "aria-label": "Health" },
      h("h2", { class: "d-h2", text: "Health" }),
      h("dl", { class: "h-grid" },
        stat("Index", age.label, age.state === "fresh" ? "ok" : "warn"), stat("Commits", hh.commits ?? 0), stat("Files", hh.files ?? 0), stat("Notes", `${hh.active ?? 0} active, ${hh.proposed ?? 0} proposed`),
        stat("Inbox", hh.inbox ?? 0), stat("Stale notes", hh.stale ?? 0, hh.stale ? "warn" : null), stat("Last daily run", ago(hh.lastDaily)), stat("Reviews", hh.reviews ?? 0), stat("QA plans", hh.qaPlans ?? 0), stat("Problems", hh.problems ?? 0, hh.problems ? "bad" : null)));
    const next = S.nextAction === d.id ? h("div", { class: "next-step", role: "status" }, h("strong", { text: "Next step" }), h("span", { text: needsSources(d) ? "Add a source so there is something to index." : "Index this department so you can ask it questions." }), h("button", { type: "button", class: "btn btn-primary", disabled: needsSources(d) || busy, onClick: () => { S.nextAction = null; runIndex(d.id, page.querySelector("#d-run"), d.name); } }, "Index now")) : null;
    const actions = h("div", { class: "d-actions" },
      h("button", { type: "button", class: "btn btn-primary", disabled: busy, onClick: () => runIndex(d.id, page.querySelector("#d-run"), d.name) }, "Index now"),
      h("button", { type: "button", class: "btn", onClick: () => ctx.enter(d.id, "chat") }, "Open chat"),
      h("button", { type: "button", class: "btn", onClick: () => ctx.enter(d.id, "inbox") }, `Inbox${hh.inbox ? ` (${hh.inbox})` : ""}`),
      h("button", { type: "button", class: "btn", onClick: () => ctx.enter(d.id, "reports") }, "Reports"));
    scroll.append(...[head, next, actions, h("div", { id: "d-run", class: "l-run", hidden: true }), health, treeSection(d), rolesSection(d), dangerSection(d)].filter(Boolean));
    if (S.lastRun && S.lastRun.id === d.id) {
      const host = scroll.querySelector("#d-run");
      host.replaceChildren(S.lastRun.card);
      host.hidden = false;
    }
    if (S.focusAfter) {
      scroll.querySelector(S.focusAfter)?.focus();
      S.focusAfter = null;
    }
  }

  /* ----- tree ----- */
  function treeSection(d) {
    const sec = h("section", { class: "d-tree", "aria-label": "Modules and sources" });
    const ui = S.treeUi || (S.treeUi = {});
    const sourceRow = (s) => {
      const st = S.status.get(s.id);
      const row = h("li", { class: "t-src" },
        h("span", { class: "t-ico", "aria-hidden": "true", text: s.kind === "docs" ? "D" : "G" }),
        h("span", { class: "t-src-main" }, h("span", { class: "t-src-label", text: s.label }), h("code", { class: "t-path", text: s.path })),
        st ? statusLine(st, s.kind) : h("span", { class: "st", text: "Checking..." }),
        st && !st.exists ? h("span", { class: "badge-warn", text: "Path missing" }) : null,
        h("button", { type: "button", class: "link-btn danger", "aria-label": `Remove source ${s.label}`, onClick: () => commit(removeSource(d, s.id), "Source removed.") }, "Remove"));
      return row;
    };
    const addSrcBtn = (target, text) => h("button", { type: "button", class: "link-btn", onClick: () => { ui.srcFor = JSON.stringify(target); renderDept(d.id); } }, text);
    const srcFormRow = (target) => (ui.srcFor === JSON.stringify(target) ? h("li", { class: "t-form" }, sourceForm({ deptId: d.id, target, cancel: () => { ui.srcFor = null; renderDept(d.id); }, submit: (src, tg) => { ui.srcFor = null; commit(addSource(d, tg, src), "Source added."); } })) : null);
    const nameRow = (node, kind, extra) => {
      if (ui.rename === node.id) return h("div", { class: "t-name" }, inline({ label: `Rename ${node.name}`, value: node.name, validate: validateName, submit: (v) => { ui.rename = null; commit(renameNode(d, node.id, v), "Renamed."); }, cancel: () => { ui.rename = null; renderDept(d.id); } }));
      return h("div", { class: "t-name" }, h("span", { class: `t-title t-${kind}`, text: node.name }), node.description ? h("span", { class: "t-desc", text: node.description }) : null,
        h("span", { class: "t-btns" }, extra, h("button", { type: "button", class: "link-btn", "aria-label": `Rename ${node.name}`, onClick: () => { ui.rename = node.id; renderDept(d.id); } }, "Rename"),
          h("button", { type: "button", class: "link-btn danger", "aria-label": `Remove ${node.name}`, onClick: () => commit(removeNode(d, node.id), "Removed.") }, "Remove")));
    };
    const empty = (text, btn) => h("li", { class: "t-empty" }, h("span", { text }), btn);
    const subItem = (m, s) => h("li", { class: "t-sub" }, nameRow(s, "sub", addSrcBtn({ moduleId: m.id, subId: s.id }, "Add source")),
      h("ul", { class: "t-list" }, (s.sources || []).map(sourceRow), srcFormRow({ moduleId: m.id, subId: s.id }), !(s.sources || []).length && ui.srcFor !== JSON.stringify({ moduleId: m.id, subId: s.id }) ? empty("no sources yet", addSrcBtn({ moduleId: m.id, subId: s.id }, "Add source")) : null));
    const modItem = (m) => h("li", { class: "t-mod" },
      nameRow(m, "mod", [addSrcBtn({ moduleId: m.id }, "Add source"), h("button", { type: "button", class: "link-btn", onClick: () => { ui.addSub = m.id; renderDept(d.id); } }, "Add sub-module")]),
      h("ul", { class: "t-list" },
        (m.sources || []).map(sourceRow), srcFormRow({ moduleId: m.id }),
        (m.subModules || []).map((s) => subItem(m, s)),
        ui.addSub === m.id ? h("li", { class: "t-form" }, inline({ label: `New sub-module in ${m.name}`, placeholder: "Sub-module name", action: "Add", validate: validateName, submit: (v) => { ui.addSub = null; commit(addSubModule(d, m.id, v), "Sub-module added."); }, cancel: () => { ui.addSub = null; renderDept(d.id); } })) : null,
        !(m.sources || []).length && !(m.subModules || []).length && ui.addSub !== m.id && ui.srcFor !== JSON.stringify({ moduleId: m.id }) ? empty("nothing here yet", addSrcBtn({ moduleId: m.id }, "Add source")) : null));
    sec.append(h("div", { class: "d-h2-row" }, h("h2", { class: "d-h2", text: "Modules and sources" }), h("span", { class: "muted", text: `${plural(d.modules.length, "module")}, ${plural(countSources(d), "source")}` })));
    const root0 = h("ul", { class: "t-root" },
      h("li", { class: "t-dept" }, h("div", { class: "t-name" }, h("span", { class: "t-title", text: "Whole department" }), h("span", { class: "t-btns" }, addSrcBtn({}, "Add source"))),
        h("ul", { class: "t-list" }, (d.sources || []).map(sourceRow), srcFormRow({}), !(d.sources || []).length && ui.srcFor !== JSON.stringify({}) ? empty("no sources yet", addSrcBtn({}, "Add source")) : null)),
      (d.modules || []).map(modItem));
    sec.append(root0);
    sec.append(ui.addMod ? inline({ label: "New module name", placeholder: "Module name, for example Cutting", action: "Add module", validate: validateName, submit: (v) => { ui.addMod = false; commit(addModule(d, v), "Module added."); }, cancel: () => { ui.addMod = false; renderDept(d.id); } }) : h("button", { type: "button", class: "btn", onClick: () => { ui.addMod = true; renderDept(d.id); } }, "Add module"));
    return sec;
  }

  function rolesSection(d) {
    const sec = h("section", { class: "d-roles", "aria-label": "Roles" }, h("h2", { class: "d-h2", text: "Roles" }), roleList(d.roles || {}, (key, on) => commit({ ...d, roles: { ...d.roles, [key]: on } }, "Role updated.")));
    return sec;
  }
  function roleList(roles, onToggle) {
    return h("ul", { class: "roles" }, ROLE_INFO.map((r) => {
      const on = !!roles[r.key];
      const b = h("button", { type: "button", role: "switch", class: "switch-ctl", "aria-checked": String(on), "aria-labelledby": `rl-${r.key}`, "aria-describedby": `rd-${r.key}`, onClick: () => onToggle(r.key, !on) }, h("span", { class: "knob", "aria-hidden": "true" }));
      return h("li", { class: "role" }, b, h("span", { class: "role-text" }, h("span", { id: `rl-${r.key}`, class: "role-name", text: r.name }), h("span", { id: `rd-${r.key}`, class: "role-desc", text: r.text })));
    }));
  }

  function dangerSection(d) {
    const typed = h("input", { class: "ie-input", type: "text", "aria-label": `Type ${d.id} to confirm`, placeholder: d.id, autocomplete: "off" });
    const archive = h("button", { type: "button", class: "btn btn-danger", disabled: true }, "Archive department");
    const purgeBtn = h("button", { type: "button", class: "btn btn-danger", disabled: true }, "Purge all data");
    const typed2 = h("input", { class: "ie-input", type: "text", "aria-label": `Type ${d.id} to confirm purge`, placeholder: d.id, autocomplete: "off" });
    typed.addEventListener("input", () => (archive.disabled = typed.value.trim() !== d.id));
    typed2.addEventListener("input", () => (purgeBtn.disabled = typed2.value.trim() !== d.id));
    const after = async (r, text) => {
      if (!r.ok) return ctx.toast(r.data.error || "That did not work.", { error: true });
      ctx.toast(text);
      await loadList(true);
      ctx.showLanding();
    };
    archive.addEventListener("click", async () => after(await api.remove(d.id, false), `${d.name} archived.`));
    purgeBtn.addEventListener("click", async () => after(await api.remove(d.id, true), `${d.name} and its data were deleted.`));
    return h("section", { class: "d-danger", "aria-label": "Archive or delete" },
      h("h2", { class: "d-h2", text: "Archive" }),
      h("p", { class: "muted", text: `Archiving hides ${d.name} from the landing page. Its knowledge is kept. Type the department id (${d.id}) to confirm.` }),
      h("div", { class: "danger-row" }, typed, archive),
      h("details", { class: "advanced" }, h("summary", { text: "Advanced / danger" }),
        h("p", { class: "muted", text: `Purging deletes the index, notes and chats of ${d.name} for good. This cannot be undone. Type ${d.id} to confirm.` }),
        h("div", { class: "danger-row" }, typed2, purgeBtn)));
  }

  function showDept(id) {
    loadDept(id);
  }

  /* ===================================================================== WIZARD */
  let W = null;
  let wizReturn = null;
  const dlg = () => root.wizard;

  function openWizard(templateId) {
    W = initialWizard(templates());
    if (templateId) W = wizardReducer(W, { type: "template", id: templateId });
    W = { ...W, dirty: false, creating: false, serverError: null, confirmClose: false };
    wizReturn = document.activeElement;
    dlg().hidden = false;
    dlg().setAttribute("data-open", "1");
    renderWizard();
  }
  function closeWizard(force) {
    if (!force && W && W.dirty) {
      W = { ...W, confirmClose: true };
      return renderWizard();
    }
    W = null;
    dlg().hidden = true;
    dlg().removeAttribute("data-open");
    dlg().replaceChildren();
    if (wizReturn && wizReturn.focus && document.contains(wizReturn)) wizReturn.focus();
    else root.landing.querySelector("#l-filter")?.focus();
  }
  const wd = (a, rerender = true) => {
    W = { ...W, ...wizardReducer(W, a), creating: W.creating, serverError: null, confirmClose: false };
    if (rerender) renderWizard();
  };

  function treeTargets(draft) {
    const out = [{ label: "Whole department", target: {} }];
    for (const m of draft.modules) {
      out.push({ label: m.name, target: { moduleId: m.id } });
      for (const s of m.subModules) out.push({ label: `${m.name} / ${s.name}`, target: { moduleId: m.id, subId: s.id } });
    }
    return out;
  }

  function stepBasics(d) {
    const name = h("input", { id: "w-name", class: "field", type: "text", maxlength: 80, "aria-label": "Department name", placeholder: "For example: Product Engineering", autocomplete: "off", "data-autofocus": "" });
    name.value = d.name;
    name.addEventListener("input", () => wd({ type: "set", field: "name", value: name.value }, false));
    const desc = h("textarea", { id: "w-desc", class: "field", rows: 2, maxlength: 400, "aria-label": "Description", placeholder: "What does this team do?" });
    desc.value = d.description;
    desc.addEventListener("input", () => wd({ type: "set", field: "description", value: desc.value }, false));
    const owner = h("input", { id: "w-owner", class: "field", type: "text", maxlength: 80, "aria-label": "Owner", placeholder: "Who looks after it?", autocomplete: "off" });
    owner.value = d.owner;
    owner.addEventListener("input", () => wd({ type: "set", field: "owner", value: owner.value }, false));
    const tpl = h("div", { class: "tpl-grid", role: "radiogroup", "aria-label": "Template" }, templates().map((t) => h("button", { type: "button", role: "radio", class: "tpl", "aria-checked": String(d.template === t.id), onClick: () => wd({ type: "template", id: t.id }) }, h("strong", { text: t.name }), h("span", { class: "tpl-desc", text: t.description }), h("span", { class: "tpl-hint", text: t.hint }))));
    const col = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Colour" }, COLORS.map((c) => h("button", { type: "button", role: "radio", class: "swatch", color: c, "aria-checked": String(c === d.color), "aria-label": `Colour ${c}`, onClick: () => wd({ type: "set", field: "color", value: c }) })));
    return [h("label", { class: "w-label", for: "w-name", text: "Name" }), name, h("label", { class: "w-label", for: "w-desc", text: "Description" }), desc, h("label", { class: "w-label", for: "w-owner", text: "Owner" }), owner, h("p", { class: "w-label", text: "Template" }), tpl, h("p", { class: "w-label", text: "Colour" }), col];
  }

  function stepStructure(d) {
    const kids = [h("p", { class: "w-help", text: "Modules and sub-modules are optional groups inside the department. For example: Cutting, with Cut Planner, Cut Core and Cut Service inside it." })];
    const list = h("ul", { class: "w-tree" });
    for (const m of d.modules) {
      const mi = h("input", { class: "field", type: "text", maxlength: 80, "aria-label": `Module name: ${m.name}` });
      mi.value = m.name;
      mi.addEventListener("change", () => (mi.value.trim() ? wd({ type: "rename", id: m.id, name: mi.value }) : (mi.value = m.name)));
      const subs = h("ul", { class: "w-tree w-sub" }, m.subModules.map((s) => {
        const si = h("input", { class: "field", type: "text", maxlength: 80, "aria-label": `Sub-module name: ${s.name}` });
        si.value = s.name;
        si.addEventListener("change", () => (si.value.trim() ? wd({ type: "rename", id: s.id, name: si.value }) : (si.value = s.name)));
        return h("li", { class: "w-row" }, si, h("button", { type: "button", class: "btn", "aria-label": `Remove ${s.name}`, onClick: () => wd({ type: "remove", id: s.id }) }, "Remove"));
      }));
      const addSub = h("form", { class: "w-row" }, h("input", { class: "field", type: "text", maxlength: 80, "aria-label": `Add a sub-module to ${m.name}`, placeholder: "Add sub-module", "data-for": m.id }), h("button", { type: "submit", class: "btn" }, "Add sub-module"));
      addSub.addEventListener("submit", (e) => {
        e.preventDefault();
        const i = addSub.querySelector("input");
        if (i.value.trim()) {
          S.wfocus = `[data-for="${m.id}"]`;
          wd({ type: "addSubModule", moduleId: m.id, name: i.value });
        }
      });
      list.append(h("li", { class: "w-mod" }, h("div", { class: "w-row" }, mi, h("button", { type: "button", class: "btn", "aria-label": `Remove ${m.name}`, onClick: () => wd({ type: "remove", id: m.id }) }, "Remove")), subs, addSub));
    }
    kids.push(list);
    const add = h("form", { class: "w-row" }, h("input", { id: "w-addmod", class: "field", type: "text", maxlength: 80, "aria-label": "Add a module", placeholder: "Add module, for example Cutting", "data-autofocus": "" }), h("button", { type: "submit", class: "btn btn-primary" }, "Add module"));
    add.addEventListener("submit", (e) => {
      e.preventDefault();
      const i = add.querySelector("input");
      if (i.value.trim()) {
        S.wfocus = "#w-addmod";
        wd({ type: "addModule", name: i.value });
      }
    });
    kids.push(add);
    if (!d.modules.length) {
      kids.push(h("button", { type: "button", class: "link-btn", onClick: () => {
        let t = wizardReducer(W, { type: "addModule", name: "Cutting" });
        const id = t.draft.modules[t.draft.modules.length - 1].id;
        for (const n of ["Cut Planner", "Cut Core", "Cut Service"]) t = wizardReducer(t, { type: "addSubModule", moduleId: id, name: n });
        W = { ...W, ...t };
        renderWizard();
      } }, "Try an example: Cutting with Cut Planner, Cut Core, Cut Service"));
    }
    return kids;
  }

  function stepSources(d) {
    const kids = [h("p", { class: "w-help", text: "A source is a git repository or a folder of documents on this computer. Attach it to the whole department, a module or a sub-module. You can skip this and add sources later." })];
    const all = [];
    const push = (s, where) => all.push({ s, where });
    d.sources.forEach((s) => push(s, "Whole department"));
    for (const m of d.modules) {
      m.sources.forEach((s) => push(s, m.name));
      for (const sub of m.subModules) sub.sources.forEach((s) => push(s, `${m.name} / ${sub.name}`));
    }
    if (all.length) kids.push(h("ul", { class: "w-srcs" }, all.map(({ s, where }) => h("li", { class: "w-src" }, h("span", { class: "t-ico", "aria-hidden": "true", text: s.kind === "docs" ? "D" : "G" }), h("span", { class: "t-src-main" }, h("span", { class: "t-src-label", text: `${s.label}  ·  ${where}` }), h("code", { class: "t-path", text: s.path })), h("button", { type: "button", class: "btn", "aria-label": `Remove source ${s.label}`, onClick: () => wd({ type: "removeSource", id: s.id }) }, "Remove")))));
    else kids.push(h("p", { class: "w-empty", text: "No sources yet." }));
    kids.push(sourceForm({ targets: treeTargets(d), cancel: () => {}, submit: (src, tg) => { wd({ type: "addSource", target: tg, source: src }); } }));
    return kids;
  }

  function stepRoles(d) {
    return [h("p", { class: "w-help", text: `Set from the ${d.template} template. Turn on only what this department needs.` }), roleList(d.roles, (k, on) => wd({ type: "role", key: k, value: on })), W.rolesTouched ? h("button", { type: "button", class: "link-btn", onClick: () => wd({ type: "resetRoles" }) }, "Reset roles to the template") : null];
  }

  function stepReview(d) {
    const srcs = flatSources(d);
    const on = ROLE_INFO.filter((r) => d.roles[r.key]).map((r) => r.name);
    const row = (k, v) => h("div", { class: "rv-row" }, h("dt", { text: k }), h("dd", { text: v }));
    return [h("dl", { class: "rv" }, row("Name", d.name), row("Description", d.description || "None"), row("Owner", d.owner || "None"), row("Template", d.template), row("Modules", d.modules.length ? d.modules.map((m) => m.subModules.length ? `${m.name} (${m.subModules.map((s) => s.name).join(", ")})` : m.name).join("; ") : "None"), row("Sources", srcs.length ? srcs.map((s) => s.label).join(", ") : "None yet. You can add them from the department page."), row("Roles on", on.length ? on.join(", ") : "None"))];
  }

  function renderWizard() {
    const d = W.draft;
    const kind = STEPS[W.step];
    const body = { basics: stepBasics, structure: stepStructure, sources: stepSources, roles: stepRoles, review: stepReview }[kind](d);
    const steps = h("ol", { class: "w-steps", "aria-label": "Steps" }, STEPS.map((s, i) => h("li", { class: "w-step", "aria-current": i === W.step ? "step" : null, "data-done": i < W.step ? "1" : null }, h("button", { type: "button", class: "w-step-btn", onClick: () => wd({ type: "goto", step: i }) }, h("span", { class: "w-num", text: String(i + 1) }), h("span", { class: "w-step-name", text: STEP_TITLES[s] })))));
    const errs = W.errors.length ? h("ul", { class: "w-errors", role: "alert" }, W.errors.map((e) => h("li", { text: e }))) : null;
    const srv = W.serverError ? h("div", { class: "banner", role: "alert" }, h("span", { class: "banner-text", text: W.serverError })) : null;
    const last = W.step === STEPS.length - 1;
    const foot = h("footer", { class: "w-foot" },
      h("button", { type: "button", class: "btn", onClick: () => closeWizard() }, "Cancel"),
      h("span", { class: "w-spacer" }),
      W.step > 0 ? h("button", { type: "button", class: "btn", onClick: () => wd({ type: "back" }) }, "Back") : null,
      kind === "sources" && !flatSources(d).length ? h("button", { type: "button", class: "btn", onClick: () => wd({ type: "next" }) }, "Skip, add later") : null,
      last ? h("button", { type: "button", class: "btn btn-primary", disabled: W.creating, onClick: create }, W.creating ? "Creating..." : "Create department") : h("button", { type: "button", class: "btn btn-primary", onClick: () => wd({ type: "next" }) }, "Next"));
    const confirm = W.confirmClose ? h("div", { class: "w-confirm", role: "alertdialog", "aria-label": "Discard this department?" }, h("p", { text: "Discard what you typed? The new department has not been created." }), h("div", { class: "w-confirm-btns" }, h("button", { type: "button", class: "btn", "data-autofocus": "", onClick: () => { W = { ...W, confirmClose: false }; renderWizard(); } }, "Keep editing"), h("button", { type: "button", class: "btn btn-danger", onClick: () => closeWizard(true) }, "Discard"))) : null;
    const card = h("div", { class: "w-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "w-title" },
      h("header", { class: "w-head" }, h("h2", { id: "w-title", class: "w-title", text: "Add department" }), h("p", { class: "w-subtitle", text: `Step ${W.step + 1} of ${STEPS.length}: ${STEP_TITLES[kind]}` })),
      steps, h("div", { class: "w-body", id: "w-body" }, body), srv, errs, confirm, foot);
    dlg().replaceChildren(h("div", { class: "w-backdrop", onClick: () => closeWizard() }), card);
    const target = (S.wfocus && card.querySelector(S.wfocus)) || card.querySelector("[data-autofocus]") || card.querySelector(".w-body input, .w-body button");
    S.wfocus = null;
    target?.focus({ preventScroll: true });
  }

  async function create() {
    const errs = stepErrors(W, STEPS.length - 1);
    if (errs.length) return wd({ type: "next" });
    W = { ...W, creating: true, serverError: null };
    renderWizard();
    const r = await api.create(createBody(W));
    if (!r.ok) {
      W = { ...W, creating: false, serverError: r.data.error || "The department could not be created." };
      return renderWizard();
    }
    const id = r.data.department.id;
    W = { ...W, dirty: false };
    closeWizard(true);
    S.nextAction = id;
    ctx.toast(`${r.data.department.name} was created.`);
    await loadList(true);
    saveLast(storage, id);
    ctx.enter(id, "dept");
  }

  /** Esc and Tab handling for the open wizard (Tab stays inside it). */
  document.addEventListener("keydown", (e) => {
    if (!W || dlg().hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (W.confirmClose) {
        W = { ...W, confirmClose: false };
        renderWizard();
      } else closeWizard();
    } else if (e.key === "Tab") {
      const f = [...dlg().querySelectorAll("button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex='-1'])")].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const lastEl = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  return { loadList, showLanding, showDept, openWizard, list: () => S.list, find, get legacy() { return !!S.legacy; }, get wizardOpen() { return !!W; }, state: S, runIndex };
}
