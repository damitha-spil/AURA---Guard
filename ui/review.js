// The Inbox and Reports views. Cards and lists come from the pure helpers in inbox.js
// (everything escaped); notes and reports are shown with the safe renderer.

import { renderSafe } from "./render.js";
import { renderGroups, renderReportList, typeLabel, kindLabel, sourceLabel as sourceLabelOf, ageLabel, evidenceText, approveHint } from "./inbox.js";

const UNDO_MS = 8000;
const ARM_MS = 4000;

const TYPE_ICON = {
  rule: "M12 3 5 6v5.5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-3Z",
  adr: "M6 4h12v16H6V4Zm3 5h6M9 13h6",
  pattern: "M4 12h4l2-6 4 12 2-6h4",
  incident: "M12 4 3 20h18L12 4Zm0 7v4m0 3v.01",
  domain: "M4 7l8-4 8 4v10l-8 4-8-4V7Zm8 4v10M4 7l8 4 8-4",
  diary: "M6 3h12v18H6V3Zm3 5h6M9 12h6",
  choice: "M6 6h12M6 12h12M6 18h8",
  journey: "M5 19c0-8 14-4 14-14M5 19h.01M19 5h.01",
};
const TONE = { rule: "violet", adr: "blue", pattern: "green", incident: "amber", domain: "blue", diary: "violet", choice: "violet", journey: "green" };

export function initReview({ api, el, $, openNote, closePanel, getProject, goto }) {
  const s = { groups: [], total: 0, sel: null, armed: null, reports: [], report: null, view: "chat", folder: "all", filter: "", rfolder: "all", notes: new Map() };
  const NS = "http://www.w3.org/2000/svg";
  const ico = (d) => {
    const v = document.createElementNS(NS, "svg");
    v.setAttribute("viewBox", "0 0 24 24");
    v.setAttribute("class", "i");
    v.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.6");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    v.appendChild(p);
    return v;
  };
  const setPane = (id, pane) => $(id).setAttribute("data-pane", pane);

  /* ---------- toasts ---------- */
  function toast(text, { undo, error } = {}) {
    const t = el("div", "toast" + (error ? " toast-error" : ""));
    t.appendChild(el("span", "toast-text", text));
    let timer = null;
    const remove = () => {
      clearTimeout(timer);
      t.remove();
    };
    if (undo) {
      const b = el("button", "btn btn-quiet toast-undo", "Undo");
      b.type = "button";
      b.addEventListener("click", async () => {
        remove();
        await undo();
      });
      t.appendChild(b);
    }
    const x = el("button", "toast-x", "Close");
    x.type = "button";
    x.addEventListener("click", remove);
    t.appendChild(x);
    $("toasts").appendChild(t);
    timer = setTimeout(remove, undo ? UNDO_MS : 5000);
  }

  /* ---------- inbox ---------- */
  const cards = () => [...$("inbox-body").querySelectorAll(".card")];
  const find = (id) => s.groups.flatMap((g) => g.items).find((i) => i.id === id);

  function setCount() {
    const b = $("inbox-count");
    b.hidden = !s.total;
    b.textContent = String(s.total);
    $("inbox-total").textContent = s.total ? `${s.total} waiting` : "";
  }

  function select(id, scroll) {
    s.sel = id;
    for (const c of cards()) c.classList.toggle("selected", c.getAttribute("data-id") === id);
    if (scroll) cards().find((c) => c.getAttribute("data-id") === id)?.scrollIntoView({ block: "nearest" });
    if (id) showDetail(id);
    else $("inbox-detail").replaceChildren();
  }

  function visibleGroups() {
    const q = s.filter.trim().toLowerCase();
    return s.groups
      .filter((g) => s.folder === "all" || g.type === s.folder)
      .map((g) => ({ ...g, items: g.items.filter((i) => !q || `${i.title} ${i.preview || ""} ${i.id}`.toLowerCase().includes(q)) }))
      .map((g) => ({ ...g, count: g.items.length }))
      .filter((g) => g.items.length);
  }

  function folderButton(label, count, active, onClick, tone, d) {
    const b = el("button", "folder" + (active ? " active" : ""));
    b.type = "button";
    const ic = el("span", `folder-ic ${tone || "violet"}`);
    ic.appendChild(ico(d || TYPE_ICON.rule));
    b.append(ic, el("span", "folder-name", label), el("span", "folder-n", count === null ? "" : count));
    if (onClick) b.addEventListener("click", onClick);
    else b.disabled = true;
    return b;
  }

  function renderFolders() {
    const box = $("inbox-folders");
    box.replaceChildren();
    box.appendChild(el("p", "folder-group", "Proposed"));
    box.appendChild(folderButton("All proposed", s.total, s.folder === "all", () => { s.folder = "all"; renderInbox(); }, "violet", "M4 13l2.5-7.5h11L20 13v5.5H4V13Zm0 0h5l1 2h4l1-2h5"));
    for (const g of s.groups) box.appendChild(folderButton(typeLabel(g.type), g.count, s.folder === g.type, () => { s.folder = g.type; renderInbox(); }, TONE[g.type] || "violet", TYPE_ICON[g.type]));
    const v = getProject && getProject() && getProject().vault;
    box.appendChild(el("p", "folder-group", "In the vault"));
    box.appendChild(folderButton("Approved", v ? v.active : null, false, null, "green", "m5 12.5 4 4 10-10"));
    box.appendChild(folderButton("Stale", v ? v.stale : null, false, null, "amber", "M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"));
    const rep = folderButton("Reports", s.reports.length || null, false, () => goto && goto("reports"), "blue", "M6 3.5h8.5L19 8v12.5H6v-17Zm8 0V8.5h5");
    box.appendChild(rep);
  }

  function renderInbox() {
    const body = $("inbox-body");
    setCount();
    renderFolders();
    if (!s.total) {
      body.replaceChildren();
      $("inbox-detail").replaceChildren();
      const box = el("div", "empty");
      box.append(el("h2", "", "Nothing is waiting for review"), el("p", "", "New notes from sessions, pull requests and commits land here as proposed. Approved notes become active; dismissed ones are kept as deprecated."));
      body.appendChild(box);
      return;
    }
    const groups = visibleGroups();
    if (!groups.length) {
      body.replaceChildren(el("p", "empty-list", "No note matches this filter."));
      $("inbox-detail").replaceChildren();
      return;
    }
    body.innerHTML = renderGroups(groups); // every note value is escaped in inbox.js
    const ids = cards().map((c) => c.getAttribute("data-id"));
    select(ids.includes(s.sel) ? s.sel : ids[0] ?? null, false);
  }

  async function showDetail(id) {
    const box = $("inbox-detail");
    const item = find(id);
    box.replaceChildren();
    if (!item) return;
    const back = el("button", "btn btn-quiet tri-back", "Back");
    back.type = "button";
    back.addEventListener("click", () => setPane("inbox-tri", "list"));
    const head = el("header", "det-head");
    const titles = el("div", "det-titles");
    titles.append(el("h2", "det-title", item.title), el("p", "det-sub", [typeLabel(item.type), sourceLabelOf(item.source), ageLabel(item.created)].filter(Boolean).join(" - ")));
    const tools = el("div", "det-tools");
    const copy = el("button", "icon-btn det-icon");
    copy.type = "button";
    copy.title = "Copy the note id";
    copy.setAttribute("aria-label", "Copy the note id");
    copy.appendChild(ico("M9 9h10v11H9V9Zm-4 6V4h10"));
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.id);
        toast("Copied the note id");
      } catch {
        toast("Copy failed", { error: true });
      }
    });
    const openB = el("button", "icon-btn det-icon");
    openB.type = "button";
    openB.title = "Open the note in the side panel";
    openB.setAttribute("aria-label", "Open the note in the side panel");
    openB.setAttribute("data-act", "open");
    openB.appendChild(ico("M14 4h6v6M20 4l-8 8M18 14v6H4V6h6"));
    tools.append(copy, openB);
    head.append(back, titles, tools);

    const card = el("div", "det-card");
    const pills = el("div", "card-meta");
    if (item.anchors) pills.appendChild(el("span", "meta-pill", `${item.anchors} code ${item.anchors === 1 ? "anchor" : "anchors"}`));
    const ev = evidenceText(item);
    if (ev) pills.appendChild(el("span", "meta-pill" + (item.checkInvalid ? " meta-warn" : ""), ev));
    const bodyEl = el("div", "bubble det-body", "Loading...");
    card.append(el("code", "det-id", item.id));
    if (pills.children.length) card.appendChild(pills);
    card.appendChild(bodyEl);
    card.appendChild(el("p", "card-hint", approveHint(item)));

    const acts = el("div", "det-actions");
    const approve = el("button", "btn btn-primary", "Approve");
    approve.type = "button";
    approve.setAttribute("data-act", "approve");
    if (item.checkInvalid) approve.disabled = true;
    const dis = el("button", "btn btn-danger", "Dismiss");
    dis.type = "button";
    dis.setAttribute("data-act", "dismiss");
    acts.append(approve, dis);
    card.appendChild(acts);
    box.append(head, card);

    let note = s.notes.get(id);
    if (!note) {
      const r = await api(`/api/inbox/note?id=${encodeURIComponent(id)}`);
      if (r.ok) {
        note = r.data;
        s.notes.set(id, note);
      }
    }
    if (s.sel !== id) return; // the person moved on while it loaded
    if (note) bodyEl.innerHTML = renderSafe(note.body); // escaped first, then a few tags
    else bodyEl.textContent = item.preview || "(no text)";
  }

  async function loadInbox() {
    const r = await api("/api/inbox");
    if (!r.ok) {
      toast(r.data.error || "Could not load the inbox.", { error: true });
      return;
    }
    s.groups = r.data.groups;
    s.total = r.data.total;
    renderInbox();
  }

  function neighbour(id) {
    const ids = cards().map((c) => c.getAttribute("data-id"));
    const i = ids.indexOf(id);
    return ids[i + 1] ?? ids[i - 1] ?? null;
  }

  async function change(id, to) {
    const item = find(id);
    const next = neighbour(id);
    const r = await api(`/api/notes/${encodeURIComponent(id)}/status`, { body: { to } });
    if (!r.ok) {
      toast(r.data.error || "That change was refused.", { error: true });
      await loadInbox();
      return;
    }
    s.sel = next;
    await loadInbox();
    const title = item ? item.title : id;
    const verb = to === "active" ? "Approved" : "Dismissed";
    toast(`${verb}: ${title}`, {
      undo: r.data.undoable
        ? async () => {
            const u = await api(`/api/notes/${encodeURIComponent(id)}/undo`, { body: {} });
            if (!u.ok) toast(u.data.error || "Could not undo.", { error: true });
            else {
              s.sel = id;
              toast(`Put back: ${title}`);
            }
            await loadInbox();
          }
        : null,
    });
  }

  function disarm() {
    if (!s.armed) return;
    clearTimeout(s.armed.timer);
    for (const b of [$("inbox-body").querySelector(`.card[data-id="${CSS.escape(s.armed.id)}"] [data-act="dismiss"]`), $("inbox-detail").querySelector('[data-act="dismiss"]')]) {
      if (!b) continue;
      b.textContent = "Dismiss";
      b.classList.remove("armed");
    }
    s.armed = null;
  }

  function dismiss(id) {
    if (s.armed && s.armed.id === id) {
      disarm();
      return change(id, "deprecated");
    }
    disarm();
    const marks = [$("inbox-body").querySelector(`.card[data-id="${CSS.escape(id)}"] [data-act="dismiss"]`), $("inbox-detail").querySelector('[data-act="dismiss"]')].filter(Boolean);
    if (!marks.length) return;
    for (const b of marks) {
      b.textContent = "Click again to dismiss";
      b.classList.add("armed");
    }
    s.armed = { id, timer: setTimeout(disarm, ARM_MS) };
  }

  async function open(id) {
    const r = await api(`/api/inbox/note?id=${encodeURIComponent(id)}`);
    if (!r.ok) return toast(r.data.error || "Could not open that note.", { error: true });
    openNote(r.data);
  }

  function doAction(id, act) {
    if (!id) return;
    select(id, false);
    if (act === "approve") {
      disarm();
      return change(id, "active");
    }
    if (act === "dismiss") return dismiss(id);
    if (act === "open") return open(id);
  }

  $("inbox-body").addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    const btn = t && t.closest("[data-act]");
    const card = t && t.closest(".card");
    if (!card) return;
    const id = card.getAttribute("data-id");
    if (btn) doAction(id, btn.getAttribute("data-act"));
    else {
      select(id, false);
      setPane("inbox-tri", "detail");
    }
  });
  $("inbox-detail").addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("[data-act]") : null;
    if (btn && s.sel) doAction(s.sel, btn.getAttribute("data-act"));
  });
  $("inbox-filter").addEventListener("input", () => {
    s.filter = $("inbox-filter").value;
    renderInbox();
  });
  $("inbox-refresh").addEventListener("click", loadInbox);

  document.addEventListener("keydown", (e) => {
    if (s.view !== "inbox" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof Element && t.closest("input, textarea, select")) return;
    const key = e.key.toLowerCase();
    const ids = cards().map((c) => c.getAttribute("data-id"));
    if (key === "j" || key === "k") {
      e.preventDefault();
      const i = Math.max(0, ids.indexOf(s.sel));
      const n = ids[Math.min(ids.length - 1, Math.max(0, i + (key === "j" ? 1 : -1)))];
      if (n) select(n, true);
    } else if (key === "a" && s.sel) {
      e.preventDefault();
      doAction(s.sel, "approve");
    } else if (key === "d" && s.sel) {
      e.preventDefault();
      doAction(s.sel, "dismiss");
    } else if (key === "enter" && s.sel && !(t instanceof Element && t.closest("button"))) {
      e.preventDefault();
      doAction(s.sel, "open");
    } else if (key === "escape") closePanel();
  });

  /* ---------- reports ---------- */
  async function loadReports() {
    const r = await api("/api/reports");
    if (!r.ok) return toast(r.data.error || "Could not load the reports.", { error: true });
    s.reports = r.data.reports;
    $("reports-total").textContent = s.reports.length ? `${s.reports.length} files` : "";
    const list = $("report-list");
    if (!s.reports.length) {
      list.replaceChildren(el("p", "empty-list", "No reports yet. Run /review, /qa plan, /daily or /logcheck."));
      return;
    }
    list.innerHTML = renderReportList(s.reports); // names are escaped in inbox.js
    renderReportFolders();
    markReport();
  }

  function renderReportFolders() {
    const box = $("report-folders");
    box.replaceChildren();
    box.appendChild(el("p", "folder-group", "Reports"));
    const kinds = [];
    for (const r of s.reports) if (!kinds.includes(r.kind)) kinds.push(r.kind);
    const apply = (k) => {
      s.rfolder = k;
      for (const g of $("report-list").querySelectorAll(".rgroup")) {
        const label = g.querySelector(".group-title")?.firstChild?.textContent || "";
        g.hidden = k !== "all" && label !== kindLabel(k);
      }
      renderReportFolders();
    };
    box.appendChild(folderButton("All reports", s.reports.length, s.rfolder === "all", () => apply("all"), "violet", "M6 3.5h8.5L19 8v12.5H6v-17Zm8 0V8.5h5"));
    for (const k of kinds) box.appendChild(folderButton(kindLabel(k), s.reports.filter((x) => x.kind === k).length, s.rfolder === k, () => apply(k), "blue", "M6 3.5h8.5L19 8v12.5H6v-17Z"));
    const ib = folderButton("Review inbox", s.total || null, false, () => goto && goto("inbox"), "amber", "M4 13l2.5-7.5h11L20 13v5.5H4V13Zm0 0h5l1 2h4l1-2h5");
    box.appendChild(el("p", "folder-group", "Other"));
    box.appendChild(ib);
  }

  function markReport() {
    for (const b of $("report-list").querySelectorAll(".report-item")) b.classList.toggle("active", b.getAttribute("data-path") === s.report);
  }

  async function showReport(path) {
    s.report = path;
    markReport();
    $("reader-title").textContent = path.split("/").pop();
    $("reader-path").textContent = path;
    const body = $("reader-body");
    body.replaceChildren(el("p", "", "Loading..."));
    const r = await api(`/api/report?path=${encodeURIComponent(path)}`);
    if (!r.ok) {
      body.replaceChildren(el("p", "", r.data.error || "Could not open that report."));
      $("reader-copy").hidden = true;
      return;
    }
    const wrap = el("div", "bubble");
    wrap.innerHTML = renderSafe(r.data.text); // escaped first, then a few tags
    body.replaceChildren();
    if (r.data.truncated) body.appendChild(el("div", "panel-note", "This report is long; only the first part is shown."));
    body.appendChild(wrap);
    body.scrollTop = 0;
    const copy = $("reader-copy");
    copy.hidden = false;
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(r.data.text);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Copy failed";
      }
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    };
  }

  $("report-list").addEventListener("click", (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest(".report-item") : null;
    if (b) {
      showReport(b.getAttribute("data-path"));
      setPane("reports-tri", "detail");
    }
  });
  $("reader-back").addEventListener("click", () => setPane("reports-tri", "list"));
  $("reports-refresh").addEventListener("click", loadReports);

  return {
    show(view) {
      s.view = view;
      disarm();
      if (view === "inbox") loadInbox();
      if (view === "reports") loadReports();
    },
    refreshCount: async () => {
      const r = await api("/api/inbox");
      if (r.ok) {
        s.total = r.data.total;
        setCount();
      }
    },
    typeLabel,
  };
}
