// The Inbox and Reports views. Cards and lists come from the pure helpers in inbox.js
// (everything escaped); notes and reports are shown with the safe renderer.

import { renderSafe } from "./render.js";
import { renderGroups, renderReportList, typeLabel } from "./inbox.js";

const UNDO_MS = 8000;
const ARM_MS = 4000;

export function initReview({ api, el, $, openNote, closePanel }) {
  const s = { groups: [], total: 0, sel: null, armed: null, reports: [], report: null, view: "chat" };

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
  }

  function renderInbox() {
    const body = $("inbox-body");
    setCount();
    if (!s.total) {
      body.replaceChildren();
      const box = el("div", "empty");
      box.append(el("h2", "", "Nothing is waiting for review"), el("p", "", "New notes from sessions, pull requests and commits land here as proposed. Approved notes become active; dismissed ones are kept as deprecated."));
      body.appendChild(box);
      return;
    }
    body.innerHTML = renderGroups(s.groups); // every note value is escaped in inbox.js
    const ids = cards().map((c) => c.getAttribute("data-id"));
    select(ids.includes(s.sel) ? s.sel : ids[0] ?? null, false);
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
    const b = $("inbox-body").querySelector(`.card[data-id="${CSS.escape(s.armed.id)}"] [data-act="dismiss"]`);
    if (b) {
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
    const b = $("inbox-body").querySelector(`.card[data-id="${CSS.escape(id)}"] [data-act="dismiss"]`);
    if (!b) return;
    b.textContent = "Click again to dismiss";
    b.classList.add("armed");
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
    else select(id, false);
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
    markReport();
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
    if (b) showReport(b.getAttribute("data-path"));
  });
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
