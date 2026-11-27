import { renderSafe } from "/render.js";
import { initReview } from "/review.js";
import { mountOverview } from "/overview.js";
import { startParticles } from "/hero.js";
import { buildMark, remountMarks, setMarkState, STYLES, STYLE_NAMES, STYLE_BLURBS, WORK_DEFAULTS, styleDescriptor } from "/marks.js";
import { applyStep, workSteps, summarize, totalMs, formatDuration, stepIcon, splitEvents } from "/steps.js";
import { planReveal, revealedLength, shouldReveal } from "/reveal.js";
import { shortTitle, groupChats, relativeTime, showChatSearch, filterChats, currentWork, flipWork, errorInfo, statusSummary, suggestionCards } from "/titles.js";
import { PRODUCT_NAME, PRODUCT_SHORT, PROJECT_NAME, MONOGRAM } from "/brand.js";
import { mountSettings } from "/settings.js";
import { QA_LABEL, routeSlash, qaSlashItems, chipAction, usedChip, isQaMessage, qaInitial, reduceQaEvent, qaFromJson, qaSummary, qaTotalMs, qaErrorInfo, progressNote, announceBucket, findReportPath } from "/qa.js";
import { renderQaCard, renderNeedsInput, markAskUsed } from "/qa-view.js";
import { createQaHarnessController } from "/qa-harness-view.js";
import { mountReoPages } from "/reo-pages.js";

const KIND_LABEL = { note: "Note", commit: "Commit", file: "File", context: "Context" };
const KIND_ICON = {
  note: "M7 3h8l4 4v14H7V3Zm7 0v5h5M10 13h6M10 17h6",
  commit: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM3 12h5M16 12h5",
  file: "m9 8-4 4 4 4M15 8l4 4-4 4",
  context: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
};
const ICON = {
  copy: "M9 9h10v11H9V9Zm-4 6V4h10",
  redo: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  up: "M7 11v9H4v-9h3Zm0 0 4-8c1.7 0 2.5 1.2 2.2 2.8L12.8 9H19a2 2 0 0 1 2 2.3l-1.2 6A2.5 2.5 0 0 1 17.4 19H7",
  down: "M7 13V4H4v9h3Zm0 0 4 8c1.7 0 2.5-1.2 2.2-2.8L12.8 15H19a2 2 0 0 0 2-2.3l-1.2-6A2.5 2.5 0 0 0 17.4 5H7",
  chev: "m6 9 6 6 6-6",
  check: "m5 12.5 4.5 4.5L19 7.5",
  x: "m6 6 12 12M18 6 6 18",
  trash: "M5 7h14M10 11v6M14 11v6M8 7l1-3h6l1 3M7 7l1 13h8l1-13",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20a7.5 7.5 0 0 1 15 0",
  spark: "M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8L12 3.5Z",
  alert: "M12 8v5M12 16.5v.01M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z",
  edit: "M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4",
  modules: "M12 3.5 3.5 8 12 12.5 20.5 8 12 3.5ZM3.5 12 12 16.5 20.5 12M3.5 16 12 20.5 20.5 16",
  recent: "M12 7v5l3 2M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z",
  review: "M4 13l2.5-7.5h11L20 13v5.5H4V13Zm0 0h5l1 2h4l1-2h5",
  draft: "M7 3.5h7.5L19 8v12.5H7v-17Zm7 0V8.5h5M10 13h6M10 16.5h3",
  note: "M7 3.5h7.5L19 8v12.5H7v-17Zm7 0V8.5h5M10 13h6M10 16.5h6",
  search: "m20 20-4.2-4.2M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Z",
  list: "M5 6h2M5 12h2M5 18h2M10 6h9M10 12h9M10 18h6",
  code: "m8 8-4 4 4 4M16 8l4 4-4 4",
  qa: "M12 3.5 5 6.2v5.6c0 4.3 3 7.4 7 8.7 4-1.3 7-4.4 7-8.7V6.2l-7-2.7Zm-3 8.6 2.2 2.2 4-4.3",
  index: "M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18.5 3v4h-4M5.5 21v-4h4",
  inbox: "M4 13l2.5-7.5h11L20 13v5.5H4V13Zm0 0h5l1 2h4l1-2h5",
  key: "M8 11.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM10.5 13 19 4.5M16 7.5l2.5 2.5",
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const NS = "http://www.w3.org/2000/svg";
const svg = (d, sw = 2) => {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", String(sw));
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  s.appendChild(p);
  return s;
};

/* ---------- preferences (theme.js loaded them before first paint) ---------- */
const Prefs = globalThis.GuardPrefs;
const storage = Prefs ? Prefs.safeStorage() : null;
const state = {
  view: "overview", project: null, status: null, summary: null, suggestions: null, indexing: null,
  prefs: Prefs ? Prefs.load(storage) : { style: "noir", mode: "light", motion: "auto", showWork: "auto" },
  chats: [], chat: null, commands: [], busy: false, abort: null, menuIndex: 0, menuItems: [],
  backend: "No model", runningChat: null, notesOnly: false, sideSet: false, reveal: null,
  chatQuery: "", armedDelete: null,
};
const style = () => state.prefs.style;
const desc = () => styleDescriptor(style());
const reducedMotion = () => state.prefs.motion === "reduced" || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
function workMode() {
  const w = state.prefs.showWork;
  if (w === "on") return { live: true, expanded: true };
  if (w === "off") return { live: false, expanded: false };
  return WORK_DEFAULTS[style()] || WORK_DEFAULTS.noir;
}
function savePrefs() {
  if (Prefs) Prefs.save(storage, state.prefs);
}
function sideStored() {
  try {
    const v = storage && storage.getItem("guard.side");
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}
function setSide(collapsed, remember) {
  $("app").classList.toggle("side-collapsed", collapsed);
  const b = $("sidebar-toggle");
  b.setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)";
  b.setAttribute("aria-label", label);
  b.title = label;
  $("drawer-btn").setAttribute("aria-expanded", String(!collapsed));
  // The menu drawer is transient: it always starts closed, so nothing is stored.
  if (remember) state.sideSet = true;
}
const sideCollapsed = () => $("app").classList.contains("side-collapsed");
function followStyleSidebar() {
  const stored = sideStored();
  void stored;
  setSide(typeof innerWidth === "number" && innerWidth < 1100, false);
}

/* ---------- api ---------- */
/** A 401 means this window's cookie is out of date (Guard was restarted). Reload "/" once so it pairs again. */
function recoverPairing() {
  try {
    if (sessionStorage.getItem("guard.repair") === "1") return;
    sessionStorage.setItem("guard.repair", "1");
  } catch {
    return;
  }
  location.replace("/");
}
async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.body !== undefined) {
    init.method = opts.method || "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, init);
  if (r.status === 401) recoverPairing();
  const data = await r.json().catch(() => ({}));
  if (!r.ok && !data.error) data.error = `Request failed (${r.status})`;
  return { status: r.status, ok: r.ok, data };
}

/** POST that streams newline-delimited JSON events. Falls back to one JSON reply (errors, old servers). */
async function streamPost(path, body, signal, onEvent) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify(body), signal });
  const type = r.headers.get("content-type") || "";
  if (!type.includes("ndjson") || !r.body) return { json: await r.json().catch(() => ({})), status: r.status };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { events, rest } = splitEvents(buf);
    buf = rest;
    for (const ev of events) onEvent(ev);
  }
  if (buf.trim()) for (const ev of splitEvents(buf + "\n").events) onEvent(ev);
  return { json: null, status: r.status };
}

/* ---------- small helpers ---------- */
function say(text) {
  const n = $("live-status");
  if (n) n.textContent = text;
}
const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dayOrClock = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const t = new Date();
  return d.toDateString() === t.toDateString() ? clock(iso) : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const mark = (st) => buildMark(document, style(), st);
function nearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
}
function toBottom(force) {
  const box = $("messages");
  if (force || nearBottom(box)) box.scrollTop = box.scrollHeight;
}

/* ---------- sidebar ---------- */
function renderChatList() {
  const box = $("chat-list");
  box.replaceChildren();
  const wrap = $("chat-search-wrap");
  const searchable = showChatSearch(state.chats.length);
  wrap.hidden = !searchable;
  if (!searchable) state.chatQuery = "";
  if (!state.chats.length) {
    box.appendChild(el("p", "empty-list", "No chats yet. Ask a question to start one."));
    return;
  }
  const shown = filterChats(state.chats, state.chatQuery);
  if (!shown.length) {
    box.appendChild(el("p", "empty-list", "No chat matches that."));
    return;
  }
  for (const g of groupChats(shown)) {
    box.appendChild(el("h3", "chat-group", g.label));
    for (const c of g.chats) {
      const active = state.chat && state.chat.id === c.id;
      const row = el("div", "chat-item" + (active ? " active" : ""));
      const open = el("button", "chat-open");
      open.type = "button";
      open.title = c.title;
      if (active) open.setAttribute("aria-current", "true");
      open.appendChild(el("span", "chat-name", shortTitle(c.title)));
      if (state.runningChat === c.id) {
        const dots = el("span", "run-dots");
        dots.setAttribute("role", "img");
        dots.setAttribute("aria-label", "Working");
        dots.append(el("i"), el("i"), el("i"));
        open.appendChild(dots);
      } else open.appendChild(el("span", "chat-time", relativeTime(c.updated)));
      open.addEventListener("click", () => openChat(c.id));
      const del = el("button", "chat-del" + (state.armedDelete === c.id ? " armed" : ""));
      del.type = "button";
      const armed = state.armedDelete === c.id;
      del.setAttribute("aria-label", armed ? `Confirm: delete chat ${c.title}` : `Delete chat: ${c.title}`);
      if (armed) del.appendChild(el("span", "", "Delete?"));
      else del.appendChild(svg(ICON.trash, 1.5));
      del.addEventListener("click", () => deleteChat(c.id, c.title));
      row.append(open, del);
      box.appendChild(row);
    }
  }
}

/** Reads the status and the project facts, then repaints the sidebar pill, the badge and the open popover. */
async function refreshStatus() {
  const [st, pr] = await Promise.all([api("/api/status"), api("/api/project")]);
  state.status = st.ok ? st.data : null;
  state.project = pr.ok ? pr.data : null;
  paintStatus();
  api("/api/overview").then((r) => {
    state.overview = r.ok ? r.data : null;
    if (!state.busy && state.view === "chat" && !(state.chat && state.chat.messages && state.chat.messages.length)) renderMessages();
  });
  if (st.ok) setBusy(st.data.running);
  if (state.project && state.project.inbox) setInboxBadge(Number(state.project.inbox.pending) || 0);
  else review.refreshCount();
}

function setInboxBadge(n) {
  const b = $("inbox-count");
  b.hidden = !n;
  b.textContent = String(n);
  b.setAttribute("aria-label", `${n} waiting for review`);
  const bell = $("bell-n");
  bell.hidden = !n;
  bell.textContent = n > 99 ? "99+" : String(n);
  $("gbar-bell").setAttribute("aria-label", n ? `Review inbox, ${n} waiting` : "Review inbox");
}

function paintStatus() {
  const s = statusSummary({ status: state.status, project: state.project });
  state.summary = s;
  if (state.status && state.status.backend) {
    state.backend = s.model;
    $("backend-name").textContent = s.model;
  }
  if (state.status && state.status.version) $("app-version").textContent = `Version ${state.status.version}`;
  $("status-line").textContent = s.line;
  $("status-dot").className = "status-dot " + s.tone;
  $("gbar-dot").className = "status-dot " + (state.status ? s.tone : "bad");
  $("gbar-conn-text").textContent = state.status ? "Engine connected" : "Engine not reachable";
  paintHero();
  if (state.view === "how") overviewView.paint();
  $("status-toggle").title = `Project status. ${s.title}`;
  for (const f of document.querySelectorAll(".empty-facts")) fillFacts(f);
  if (!$("status-detail").hidden) renderStatusPanel();
}

/** The hero's badge and source chips: only what the project summary really holds. */
function paintHero() {
  const s = state.summary;
  const badge = $("land-badge-text");
  if (badge) {
    const c = s && s.counts;
    badge.textContent = c && (c.notes || c.commits) ? `${(c.notes || 0).toLocaleString("en")} notes and ${(c.commits || 0).toLocaleString("en")} commits in memory` : "Read-only engineering assistant";
  }
  const list = $("land-sources");
  if (!list) return;
  list.replaceChildren();
  const p = state.project;
  const items = [];
  if (p && p.repos && p.repos.length) items.push([`${p.repos.length} ${p.repos.length === 1 ? "repository" : "repositories"}`, "overview"]);
  if (p && p.vault && p.vault.notes) items.push([`${p.vault.notes} vault notes`, "reports"]);
  if (p && p.index && p.index.files) items.push([`${p.index.files.toLocaleString("en")} indexed files`, "overview"]);
  items.push(["QA harness", "qa"]);
  if (p && p.inbox && p.inbox.pending) items.push([`${p.inbox.pending} awaiting review`, "inbox"]);
  for (const [label, view] of items) {
    const li = el("li", "");
    const b = el("button", "land-source", label);
    b.type = "button";
    b.addEventListener("click", () => (view === "overview" ? $("input").focus() : setView(view)));
    li.appendChild(b);
    list.appendChild(li);
  }
}

function setBusy(name) {
  $("busy").hidden = !name;
  if (name) $("busy").textContent = `Running /${name}...`;
}

async function refreshChats() {
  const { data } = await api("/api/chats");
  state.chats = data.chats || [];
  renderChatList();
}

/* ---------- work trace ---------- */
function stepIconNode(s) {
  const n = el("span", "step-icon");
  const kind = stepIcon(s);
  if (kind === "spinner") {
    const sp = el("span", "spin");
    sp.append(el("i"), el("i"), el("i"));
    n.appendChild(sp);
  } else n.appendChild(svg(kind === "error" ? ICON.x : ICON.check, 2.4));
  return n;
}

/**
 * A work trace: a head button and a list of real steps. `ctl.set(...)` re-renders it.
 * While live the head shows "Thinking"; when finished it shows "Worked for 4 s - 5 steps".
 */
function createTrace(initial) {
  const box = el("div", "trace");
  const ctl = { box, steps: initial.steps || [], live: !!initial.live, open: initial.open, ms: initial.ms || 0, sources: initial.sources || [], t0: Date.now(), timer: null, agent: initial.agent || null, bucket: 0 };
  const render = () => {
    box.setAttribute("data-open", String(ctl.open));
    box.setAttribute("data-live", String(ctl.live));
    if (ctl.agent) box.setAttribute("data-agent", ctl.agent);
    box.replaceChildren();
    const head = el("button", "trace-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(ctl.open));
    const ic = el("span", "trace-ic");
    ic.appendChild(svg(ICON.spark, 1.5));
    const label = el("span", "trace-label" + (ctl.live ? " shimmer" : ""));
    const lived = formatDuration(Date.now() - ctl.t0).replace("under 1 s", "");
    label.textContent = ctl.agent === "qa" ? (ctl.live ? `${QA_LABEL} is working ${lived}`.trim() : qaSummary(ctl.steps, ctl.ms)) : ctl.live ? `Thinking ${lived}`.trim() : summarize(ctl.steps, ctl.ms);
    const chev = svg(ICON.chev, 1.75);
    chev.setAttribute("class", "chev");
    head.append(ic, label, chev);
    head.addEventListener("click", () => {
      ctl.open = !ctl.open;
      render();
    });
    box.appendChild(head);
    const list = el("ol", "trace-list");
    list.setAttribute("aria-label", "Steps");
    for (const s of workSteps(ctl.steps)) {
      const li = el("li", "step");
      li.setAttribute("data-status", s.status);
      const text = el("span", "step-label", s.label);
      if (s.detail) text.appendChild(el("span", ctl.agent === "qa" && s.id === "target" && /^I assumed/i.test(s.detail) ? "step-assume" : "step-detail", s.detail));
      if (ctl.agent === "qa" && s.status === "running") {
        const note = progressNote(s.id, Date.now() - (s.startedAt || Date.now()));
        if (note) text.appendChild(el("span", "step-hint", note));
      }
      li.append(stepIconNode(s), text);
      if (s.status !== "running" && typeof s.ms === "number" && s.ms > 0) li.appendChild(el("span", "step-ms", formatDuration(s.ms)));
      list.appendChild(li);
    }
    box.appendChild(list);
    if (ctl.live) box.appendChild(el("span", "trace-bar"));
  };
  ctl.set = (patch) => {
    Object.assign(ctl, patch);
    render();
  };
  ctl.add = (step) => {
    ctl.steps = applyStep(ctl.steps, step);
    say(step.label);
    render();
    toBottom(false);
  };
  ctl.start = () => {
    ctl.timer = setInterval(() => {
      if (!ctl.live) return;
      render();
      const run = ctl.agent === "qa" ? ctl.steps.find((x) => x.status === "running") : null;
      if (!run) return;
      const age = Date.now() - (run.startedAt || Date.now());
      const b = announceBucket(age);
      if (b > 0 && b !== ctl.bucket) {
        ctl.bucket = b;
        say(progressNote(run.id, age) || run.label);
      }
    }, 1000);
  };
  ctl.stop = () => clearInterval(ctl.timer);
  render();
  return ctl;
}

/* ---------- messages ---------- */
function sourceChip(s) {
  const b = el("button", "src");
  b.type = "button";
  b.title = s.ref;
  b.appendChild(svg(KIND_ICON[s.kind] || KIND_ICON.note, 1.8));
  b.append(el("span", "src-title", s.title));
  b.setAttribute("aria-label", `${KIND_LABEL[s.kind] || s.kind}: ${s.title}${s.status === "proposed" ? " (unapproved)" : ""}`);
  b.title = `${s.title}\n${s.ref}${s.status === "proposed" ? "\nUnapproved: the owner has not approved this note yet" : ""}`;
  b.setAttribute("data-kind", s.kind || "note");
  if (s.status === "proposed") {
    b.setAttribute("data-unapproved", "true");
    b.appendChild(el("span", "tag-unapproved", "Unapproved"));
  }
  b.addEventListener("click", () => openSource(s));
  return b;
}

const SRC_SHOWN = 6;
/** Sources as one tidy block: chips grouped by type, the first few visible, the rest behind "N more". */
function sourceBlock(sources) {
  const box = el("div", "src-block");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "Sources");
  const head = el("div", "src-head");
  head.append(el("span", "src-title-label", "Sources"), el("span", "src-count", String(sources.length)));
  box.appendChild(head);
  const order = ["note", "commit", "file", "context"];
  const kinds = [...new Set(sources.map((s) => s.kind || "note"))].sort((x, y) => order.indexOf(x) - order.indexOf(y));
  const row = el("div", "src-row");
  let shown = 0;
  const hidden = [];
  for (const k of kinds) {
    const g = el("div", "src-group");
    g.append(el("span", "src-kind", KIND_LABEL[k] || k));
    for (const s of sources.filter((x) => (x.kind || "note") === k)) {
      const chip = sourceChip(s);
      if (shown >= SRC_SHOWN) {
        chip.hidden = true;
        hidden.push(chip);
      }
      shown++;
      g.appendChild(chip);
    }
    row.appendChild(g);
  }
  box.appendChild(row);
  if (hidden.length) {
    const more = el("button", "src-more", `${hidden.length} more`);
    more.type = "button";
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      const open = more.getAttribute("aria-expanded") !== "true";
      for (const c of hidden) c.hidden = !open;
      more.setAttribute("aria-expanded", String(open));
      more.textContent = open ? "Show fewer" : `${hidden.length} more`;
    });
    box.appendChild(more);
  }
  return box;
}

function actionButton(icon, label, onClick, pressable) {
  const b = el("button", "act");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.setAttribute("data-tip", label.split(":")[0]);
  b.appendChild(svg(icon, 1.5));
  if (pressable) b.setAttribute("aria-pressed", "false");
  b.addEventListener("click", () => onClick(b));
  return b;
}

async function sendFeedback(index, rating, note) {
  if (!state.chat) return;
  const body = { chatId: state.chat.id, messageIndex: index, rating };
  if (note) body.note = note;
  await api("/api/feedback", { body });
}

function actionsFor(m, index) {
  const row = el("div", "msg-actions");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Answer actions");
  const wrap = el("div", "msg-extra");
  const copy = actionButton(ICON.copy, "Copy answer", async (b) => {
    try {
      await navigator.clipboard.writeText(m.text);
      toast("Copied");
    } catch {
      toast("Copy failed");
    }
    b.blur();
  });
  const again = actionButton(ICON.redo, "Regenerate: ask the same question again", () => {
    const msgs = state.chat ? state.chat.messages : [];
    for (let i = Math.min(index, msgs.length) - 1; i >= 0; i--) {
      if (msgs[i].role === "user") return void send(msgs[i].text);
    }
  });
  const up = actionButton(ICON.up, "Good answer", async (b) => {
    up.setAttribute("aria-pressed", "true");
    down.setAttribute("aria-pressed", "false");
    row.classList.add("pinned");
    wrap.querySelector(".fb-prompt")?.remove();
    await sendFeedback(index, "up");
    b.blur();
  }, true);
  const down = actionButton(ICON.down, "Not right", async () => {
    down.setAttribute("aria-pressed", "true");
    up.setAttribute("aria-pressed", "false");
    row.classList.add("pinned");
    await sendFeedback(index, "down");
    if (wrap.querySelector(".fb-prompt")) return;
    const f = el("form", "fb-prompt");
    f.append(el("span", "", "Was this right?"));
    const input = el("input");
    input.type = "text";
    input.maxLength = 200;
    input.placeholder = "What was wrong? (optional)";
    input.setAttribute("aria-label", "What was wrong with the answer");
    const send = el("button", "btn btn-primary", "Send");
    send.type = "submit";
    const skip = el("button", "btn", "Skip");
    skip.type = "button";
    skip.addEventListener("click", () => f.remove());
    f.append(input, send, skip);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const note = input.value.trim();
      if (note) await sendFeedback(index, "down", note);
      f.replaceChildren(el("span", "", "Thanks, noted."));
      setTimeout(() => f.remove(), 2500);
    });
    wrap.appendChild(f);
    input.focus();
  }, true);
  row.append(copy, again, up, down);
  wrap.prepend(row);
  return { wrap, row };
}

function metaText(m) {
  const parts = [clock(m.ts)];
  if (m.role === "assistant") {
    parts.push(state.backend);
    if (m.trace) parts.push(formatDuration(isQaMessage(m) ? qaTotalMs(m.trace, m.qa) : totalMs(m.trace, 0)));
  }
  return parts.filter(Boolean).join(" · ");
}

function messageShell(role, m) {
  const wrap = el("div", `msg ${role}${m && m.error ? " error" : ""}`);
  const av = el("div", "msg-avatar");
  if (role === "user") av.appendChild(el("span", "user-initial", "Y"));
  else {
    av.appendChild(mark("idle"));
  }
  const top = el("div", "msg-top");
  top.append(el("span", "msg-role", role === "user" ? "You" : PRODUCT_SHORT), el("span", "msg-meta", m ? metaText(m) : ""));
  const main = el("div", "msg-main");
  wrap.append(av, top, main);
  const s = { wrap, main, av, top };
  if (m && isQaMessage(m)) markQa(s);
  return s;
}

/** The QA sub-agent speaks with its own identity: a small QA badge on the avatar and its own name. */
function markQa(s) {
  if (s.wrap.classList.contains("qa-agent")) return;
  s.wrap.classList.add("qa-agent");
  const badge = el("span", "qa-badge", "QA");
  badge.setAttribute("aria-hidden", "true");
  s.av.appendChild(badge);
  s.top.querySelector(".msg-role").textContent = QA_LABEL;
}

function toolCard(name, output, ok, running) {
  const card = el("div", "tool-card");
  const head = el("div", "tool-head");
  head.appendChild(svg("m5 8 4 4-4 4M12 16h7", 2));
  head.appendChild(el("span", "tool-name", name));
  let spin = null;
  if (running) {
    spin = el("span", "spin");
    spin.append(el("i"), el("i"), el("i"));
    head.appendChild(spin);
  }
  const chipEl = el("span", "tool-chip", running ? "Running" : ok ? "Done" : "Failed");
  chipEl.setAttribute("data-status", running ? "run" : ok ? "ok" : "fail");
  head.appendChild(chipEl);
  const toggle = el("button", "act");
  toggle.type = "button";
  toggle.setAttribute("aria-label", "Show or hide output");
  toggle.appendChild(svg(ICON.chev, 2));
  head.appendChild(toggle);
  const body = el("div", "tool-body");
  const pre = el("pre", "tool-out");
  pre.tabIndex = 0;
  pre.textContent = output; // textContent: shown as text
  body.appendChild(pre);
  const foot = el("div", "tool-foot");
  const copy = el("button", "btn btn-quiet", "Copy");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent || "");
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy failed";
    }
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  });
  foot.appendChild(copy);
  card.append(head, body, foot);
  const setOpen = (open) => {
    body.hidden = !open;
    foot.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => setOpen(body.hidden));
  setOpen(running || output.split("\n").length <= 14);
  return { card, pre, chip: chipEl, head, setOpen, spin };
}

/** Code blocks get a small header with a Copy button. Runs after renderSafe has built the (escaped) markup. */
function decorateCode(node) {
  for (const pre of node.querySelectorAll("pre")) {
    if (pre.parentElement && pre.parentElement.classList.contains("codeblock")) continue;
    const wrap = el("div", "codeblock");
    const head = el("div", "code-head");
    const lang = el("span", "code-lang");
    lang.append(svg(ICON.code, 1.5), el("span", "", "Code"));
    const btn = el("button", "code-copy");
    btn.type = "button";
    btn.append(svg(ICON.copy, 1.5), el("span", "", "Copy"));
    btn.addEventListener("click", async () => {
      const label = btn.querySelector("span");
      try {
        await navigator.clipboard.writeText(pre.textContent || "");
        label.textContent = "Copied";
      } catch {
        label.textContent = "Copy failed";
      }
      setTimeout(() => (label.textContent = "Copy"), 1500);
    });
    head.append(lang, btn);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
}

/** A failed answer as an alert card: icon, plain title, the message, and what to do next. */
function alertCard(message, userText, live, qa) {
  const info = qa ? qaErrorInfo(message, qa.kind) : errorInfo(message);
  const card = el("div", "alert-card");
  card.setAttribute("role", live ? "alert" : "group");
  card.setAttribute("aria-label", info.title);
  const ic = el("span", "alert-ic");
  ic.appendChild(svg(ICON.alert, 1.5));
  const body = el("div", "alert-body");
  body.append(el("h3", "alert-title", info.title), el("p", "alert-text", message));
  if (userText) {
    const acts = el("div", "alert-actions");
    const edit = el("button", "alert-btn");
    edit.type = "button";
    edit.append(svg(ICON.edit, 1.5), el("span", "", "Edit message"));
    edit.addEventListener("click", () => {
      $("input").value = userText;
      growInput();
      syncSend();
      $("input").focus();
    });
    acts.appendChild(edit);
    if (info.retry) {
      const again = el("button", "alert-btn alert-btn-quiet");
      again.type = "button";
      again.append(svg(ICON.redo, 1.5), el("span", "", "Try again"));
      again.addEventListener("click", () => send(userText));
      acts.appendChild(again);
    }
    body.appendChild(acts);
  }
  card.append(ic, body);
  return card;
}

/** A stored message as a node. `prev` is the message before it (to spot command results). */
function messageNode(m, index, prev) {
  const { wrap, main } = messageShell(m.role, m);
  const known = new Set((m.sources || []).map((s) => s.ref));
  if (m.role === "user") {
    main.appendChild(el("div", "answer", m.text));
    return wrap;
  }
  const isCmd = prev && prev.role === "user" && prev.text.startsWith("/") && /^```\n/.test(m.text);
  if (isCmd) {
    const out = m.text.replace(/^```\n/, "").replace(/\n```$/, "");
    main.appendChild(toolCard(prev.text, out, !m.error, false).card);
    return wrap;
  }
  const qaMsg = isQaMessage(m);
  if (m.trace && m.trace.length) {
    const w = workMode();
    const agent = m.trace.some((t) => t.agent === "qa") ? "qa" : null;
    main.appendChild(createTrace({ steps: m.trace, live: false, open: w.expanded, ms: agent ? qaTotalMs(m.trace, m.qa) : totalMs(m.trace, 0), sources: m.sources || [], agent }).box);
  }
  if (m.error) {
    main.appendChild(alertCard(m.text, prev && prev.role === "user" ? prev.text : "", false, qaMsg ? {} : null));
    return wrap;
  }
  if (m.needsInput) {
    const msgs = state.chat ? state.chat.messages : [];
    const next = msgs[index + 1];
    main.appendChild(renderNeedsInput(m.needsInput, qaCtx, usedChip(m.needsInput, next ? (next.role === "user" ? next.text : "") : null)));
    return wrap;
  }
  if (m.qa) {
    const total = state.chat ? state.chat.messages.length : 0;
    main.appendChild(renderQaCard(m.qa, qaCtx, { isLatest: index === total - 1 }));
    main.appendChild(actionsFor(m, index).wrap);
    return wrap;
  }
  const ans = el("div", "answer bubble");
  ans.innerHTML = renderSafe(m.text, known); // renderSafe escapes all text before adding tags
  decorateCode(ans);
  main.appendChild(ans);
  if (m.sources && m.sources.length) {
    main.appendChild(sourceBlock(m.sources));
  }
  main.appendChild(actionsFor(m, index).wrap);
  return wrap;
}

/** Quiet facts under the sentence: what the answers can draw on, and how fresh it is. */
function fillFacts(node) {
  node.replaceChildren();
  const s = state.summary;
  if (!s) return;
  // KPI cards: only numbers the server really reported. No trend lines, because Guard keeps no history of them.
  if (s.counts) {
    for (const [n, w, tone] of [[s.counts.notes, "notes", "violet"], [s.counts.commits, "commits", "blue"], [s.counts.files, "files", "green"]]) {
      if (!n) continue;
      const card = el("span", "fact kpi");
      const ic = el("span", "kpi-ic " + tone);
      ic.setAttribute("aria-hidden", "true");
      ic.appendChild(svg(KIND_ICON[w === "notes" ? "note" : w === "commits" ? "commit" : "file"], 1.6));
      const tx = el("span", "kpi-text");
      tx.append(el("span", "kpi-label", w), el("span", "kpi-num", n.toLocaleString("en")));
      card.append(ic, tx);
      card.setAttribute("aria-label", `${n.toLocaleString("en")} ${w}`);
      node.appendChild(card);
    }
  }
  if (s.index) {
    const card = el("span", "fact kpi " + s.index.state);
    const ic = el("span", "kpi-ic " + (s.index.state === "ok" ? "green" : "amber"));
    ic.setAttribute("aria-hidden", "true");
    ic.appendChild(svg(ICON.check, 1.8));
    const tx = el("span", "kpi-text");
    tx.append(el("span", "kpi-label", "Search index"), el("span", "kpi-sub", s.index.label.replace(/. It is getting old.$/, "")));
    card.append(ic, tx);
    node.appendChild(card);
  }
}

/** A little section card: a small title, a body and an optional "View all" link. */
function featCard(cls, title, linkLabel, onLink) {
  const c = el("section", `feat ${cls}`);
  const head = el("header", "feat-head");
  head.appendChild(el("h3", "feat-title", title));
  if (linkLabel) {
    const l = el("button", "feat-link", linkLabel);
    l.type = "button";
    l.addEventListener("click", onLink);
    head.appendChild(l);
  }
  c.appendChild(head);
  return c;
}
function featRow(title, meta, onClick) {
  const b = el("button", "feat-row");
  b.type = "button";
  b.append(el("span", "feat-row-title", title), el("span", "feat-row-meta", meta || ""));
  b.addEventListener("click", onClick);
  return b;
}

/** The empty chat: a clean headline, quick actions, three cards of real project facts, and the suggestion list. */
function emptyState() {
  const box = el("div", "empty");
  const badge = el("div", "reo-pill", "SPIL REO · REVIEW · EVALUATE · OPTIMIZE");
  box.append(badge);
  const h = el("h2", "empty-title");
  h.append("Ask your ", el("strong", "", "codebase"), ", get ", el("strong", "", "sources"));
  box.append(h);
  box.append(el("p", "empty-sub", "Answers come only from the vault notes and the indexed code, with sources. Type / for commands."));

  const quick = el("div", "quick-pills");
  const qp = (label, tone, d, fn, extra) => {
    const b = el("button", "qpill");
    b.type = "button";
    if (extra) b.setAttribute("data-quick", extra);
    const ic = el("span", `qpill-ic ${tone}`);
    ic.appendChild(svg(d, 1.7));
    b.append(ic, el("span", "", label));
    b.addEventListener("click", fn);
    return b;
  };
  quick.append(
    qp("QA this change", "green", ICON.qa, () => qaCtx.fillComposer("QA the latest change"), "qa"),
    qp("Review inbox", "amber", ICON.inbox, () => setView("inbox"), "inbox"),
    qp("Reports", "blue", ICON.draft, () => setView("reports"), "reports"),
    qp("Show work", "violet", ICON.list, () => $("pill-work").click(), "work"),
  );
  box.appendChild(quick);
  return box;
}

function renderMessages() {
  const box = $("messages");
  box.replaceChildren();
  const th = el("div", "thread");
  th.id = "thread";
  box.appendChild(th);
  const msgs = state.chat ? state.chat.messages : [];
  $("chat-title").textContent = state.chat ? shortTitle(state.chat.title, 60) : "New chat";
  $("app").setAttribute("data-empty", String(!msgs.length));
  if (!msgs.length) th.appendChild(emptyState());
  msgs.forEach((m, i) => th.appendChild(messageNode(m, i, msgs[i - 1])));
  box.scrollTop = msgs.length ? box.scrollHeight : 0; // the first screen starts at its top, a chat at its latest message
}
const thread = () => $("thread");

/* ---------- chats ---------- */
async function openChat(id) {
  if (state.busy) return;
  const { ok, data } = await api(`/api/chats/${id}`);
  if (!ok) return;
  state.chat = data;
  renderMessages();
  renderChatList();
  closePanel();
  $("input").focus();
}

function newChat() {
  if (state.busy) return;
  state.chat = null;
  renderMessages();
  renderChatList();
  closePanel();
  setView("chat");
  $("input").focus();
}

async function ensureChat() {
  if (state.chat) return state.chat;
  const { data } = await api("/api/chats", { method: "POST", body: {} });
  state.chat = data;
  await refreshChats();
  return data;
}

let armTimer = null;
async function deleteChat(id) {
  // First click asks "Delete?" in the row; a second click within a few seconds deletes.
  clearTimeout(armTimer);
  if (state.armedDelete !== id) {
    state.armedDelete = id;
    renderChatList();
    armTimer = setTimeout(() => {
      state.armedDelete = null;
      renderChatList();
    }, 3500);
    return;
  }
  state.armedDelete = null;
  await api(`/api/chats/${id}`, { method: "DELETE" });
  if (state.chat && state.chat.id === id) state.chat = null;
  await refreshChats();
  renderMessages();
}

/* ---------- sending ---------- */
function setSending(on) {
  state.busy = on;
  $("send").hidden = on;
  $("stop").hidden = !on;
  $("brand-tile").setAttribute("data-state", on ? "thinking" : "idle");
}

function revealInto(node, text, known, done) {
  const d = desc();
  if (d.reveal === "none" || !shouldReveal({ reducedMotion: reducedMotion(), text })) {
    node.innerHTML = renderSafe(text, known);
    decorateCode(node);
    return done();
  }
  const plan = planReveal(text, d.reveal === "typewriter" ? { wordMs: 9, maxMs: 900 } : {});
  const t0 = performance.now();
  let last = -1;
  let raf = 0;
  const stop = () => {
    cancelAnimationFrame(raf);
    state.reveal = null;
    node.innerHTML = renderSafe(text, known);
    decorateCode(node);
    done();
  };
  const tick = () => {
    const len = revealedLength(plan, performance.now() - t0);
    if (len >= plan.length) return stop();
    if (len !== last) {
      last = len;
      node.innerHTML = renderSafe(text.slice(0, len), known);
      toBottom(false);
    }
    raf = requestAnimationFrame(tick);
  };
  state.reveal = stop; // a click or scroll calls this to show everything at once
  raf = requestAnimationFrame(tick);
}

function userNode(text) {
  const { wrap, main } = messageShell("user", { role: "user", text, ts: new Date().toISOString() });
  main.appendChild(el("div", "answer", text));
  wrap.classList.add("entering");
  return wrap;
}

$("harness-close")?.addEventListener("click", () => { $("harness-pane").hidden = true; });

async function runLiveMission(prompt, signal) {
  const pane = $("harness-pane");
  const stream = $("harness-stream");
  const sub = $("harness-sub");
  if (!pane || !stream) return;
  pane.hidden = false;
  if (sub) sub.textContent = "Planning sub-agent mission...";
  stream.replaceChildren();

  const planBox = el("div", "mission-card");
  const planTitle = el("strong", "", "Mission Plan");
  const planList = el("div", "mission-card");
  planBox.append(planTitle, planList);
  stream.appendChild(planBox);

  const res = await fetch("/api/reo/mission", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
    signal,
  });
  if (!res.ok || !res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "mission" && sub) {
          sub.textContent = ev.status === "started" ? `Active agents: ${ev.agents.join(", ")}` : `Completed (${ev.agents.join(", ")})`;
        } else if (ev.type === "plan" && Array.isArray(ev.steps)) {
          planList.replaceChildren();
          for (const st of ev.steps) {
            const row = el("div", "mission-step");
            row.append(el("span", "", `[${st.agent.toUpperCase()}] ${st.title}`), el("span", "reo-pill", st.status));
            planList.appendChild(row);
          }
        } else if (ev.type === "tool") {
          const card = el("div", "tool-log");
          const h = el("div", "tool-log-head");
          h.append(el("span", "", `${ev.agent.toUpperCase()} · ${ev.tool}`), el("span", "reo-pill", ev.status));
          card.append(h, el("div", "", ev.detail || ""));
          if (ev.output) card.appendChild(el("pre", "", JSON.stringify(ev.output, null, 2).slice(0, 600)));
          stream.appendChild(card);
        } else if (ev.type === "defect" && ev.defect) {
          const dc = el("div", "mission-card");
          dc.append(el("strong", "", `Auto-Filed Defect ${ev.defect.id}: ${ev.defect.title}`));
          const openBtn = el("button", "btn btn-quiet", "Open in Defects →");
          openBtn.type = "button";
          openBtn.addEventListener("click", () => setView("defects"));
          dc.appendChild(openBtn);
          stream.appendChild(dc);
        }
      } catch { /* ignore partial JSON line */ }
    }
  }
}

async function send(forced, opts = {}) {
  const input = $("input");
  const text = (typeof forced === "string" ? forced : input.value).trim();
  if (!text || state.busy) return;
  if (state.view === "overview") {
    api("/api/reo/route", { method: "POST", body: JSON.stringify({ prompt: text }) }).then((r) => {
      if (r.ok && r.data && r.data.destination === "workspace" && Array.isArray(r.data.agents)) {
        toast(`Routing to ${r.data.agents.join(", ")} agent(s) in Workspace`);
      }
    }).catch(() => {});
  }
  setView("chat");
  hideMenu();
  // An older question or run button must not stay live once the conversation moves on.
  for (const box of document.querySelectorAll(".qa-ask")) markAskUsed(box);
  for (const b of document.querySelectorAll(".qa-run")) b.disabled = true;
  input.value = "";
  growInput();
  setSending(true);
  const chat = await ensureChat();
  state.runningChat = chat.id;
  renderChatList();
  const t = thread();
  t.querySelector(".empty")?.remove();
  $("app").setAttribute("data-empty", "false");
  t.appendChild(userNode(text));
  toBottom(true);
  const controller = new AbortController();
  state.abort = controller;
  try {
    const isMission = /^@(qa|qe|review|security|api|report)\b/i.test(text) || /\b(run mission|audit|probe|crawl)\b/i.test(text);
    if (isMission) {
      await runLiveMission(text, controller.signal);
    }
    const route = opts.runJourneys ? { kind: "ask", text } : routeSlash(text);
    if (route.kind === "command") await runCommand(text, chat, controller.signal);
    else if (route.kind === "qa") await runAsk(route.text, chat, controller.signal, { mode: "qa" });
    else await runAsk(text, chat, controller.signal, opts.runJourneys ? { runJourneys: true } : {});
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    document.querySelector(".msg.live")?.remove();
    const s = messageShell("assistant", { role: "assistant", ts: new Date().toISOString(), error: true });
    s.main.appendChild(alertCard(aborted ? "Stopped waiting. If the answer arrives, it is saved in this chat; reopen the chat to see it." : "Could not reach AURA QA. Is its window still running?", text, true));
    setMarkState(s.av.firstChild, "error");
    thread().appendChild(s.wrap);
  } finally {
    state.abort = null;
    state.runningChat = null;
    setSending(false);
    toBottom(true);
    refreshChats();
    refreshStatus();
    input.focus();
  }
}

async function runAsk(text, chat, signal, opts = {}) {
  const w = workMode();
  const s = messageShell("assistant", { role: "assistant", ts: new Date().toISOString() });
  s.wrap.classList.add("live", "entering");
  setMarkState(s.av.firstChild, "thinking");
  const tr = createTrace({ steps: [], live: true, open: w.live });
  tr.start();
  s.main.appendChild(tr.box);
  thread().appendChild(s.wrap);
  toBottom(true);
  say("AURA QA is working");
  let result = null;
  let qs = qaInitial();
  const enterQa = () => {
    markQa(s);
    tr.set({ agent: "qa", open: state.prefs.showWork !== "off" });
    say("QA agent started");
  };
  if (opts.mode === "qa" || opts.runJourneys) {
    // The person asked for QA: show the agent's identity at once, before its first event arrives.
    markQa(s);
    tr.set({ agent: "qa", open: state.prefs.showWork !== "off" });
  }
  const sendBody = { question: text, ...(opts.mode ? { mode: opts.mode } : {}), ...(opts.runJourneys ? { runJourneys: true } : {}), ...(state.notesOnly ? { notesOnly: true } : {}) };
  const reply = await streamPost(`/api/chats/${chat.id}/ask`, sendBody, signal, (ev) => {
    const was = qs.active;
    qs = reduceQaEvent(qs, ev);
    if (qs.active && !was) enterQa();
    if (ev.type === "step") tr.add(ev.step);
    else if (ev.type === "answer" || ev.type === "error") result = ev;
  });
  tr.stop();
  if (!result && reply.json) {
    const j = reply.json;
    const jq = qaFromJson(j);
    if (jq.active) {
      qs = jq;
      enterQa();
      tr.set({ steps: jq.steps });
    }
    result = j.text !== undefined ? { type: j.ok ? "answer" : "error", text: j.text, message: j.text, sources: j.sources, chat: j.chat } : { type: "error", message: j.error || "No answer.", chat: null };
  }
  if (!result) result = { type: "error", message: "The answer did not arrive.", chat: null };
  if (result.chat) state.chat = result.chat;
  const failed = result.type === "error";
  const body = failed ? result.message : result.text;
  const sources = failed ? [] : result.sources || [];
  const isQa = qs.active;
  const ms = isQa ? qaTotalMs(tr.steps, qs.result) || Date.now() - tr.t0 : totalMs(tr.steps, Date.now() - tr.t0);
  s.wrap.classList.remove("live");
  if (failed) s.wrap.classList.add("error");
  setMarkState(s.av.firstChild, failed ? "error" : "done");
  s.top.querySelector(".msg-meta").textContent = [clock(new Date().toISOString()), state.backend, formatDuration(ms)].filter(Boolean).join(" · ");
  tr.set({ live: false, ms, sources, open: w.expanded });
  if (!workSteps(tr.steps).length) tr.box.remove();
  if (isQa && !failed && (qs.needsInput || qs.result)) {
    // The structured outcome replaces the Markdown text (which stays stored as the fallback).
    if (qs.needsInput) {
      s.main.appendChild(renderNeedsInput(qs.needsInput, qaCtx, null));
      say("QA needs one answer: " + qs.needsInput.question);
    } else {
      s.main.appendChild(renderQaCard(qs.result, qaCtx, { isLatest: true }));
      s.main.appendChild(actionsFor({ text: body }, state.chat ? state.chat.messages.length - 1 : 0).wrap);
      say("QA result ready. " + (qs.result.risk ? qs.result.risk.level + " risk." : ""));
    }
    $("chat-title").textContent = state.chat ? shortTitle(state.chat.title, 60) : "New chat";
    toBottom(false);
    return;
  }
  const ans = el("div", "answer bubble");
  s.main.appendChild(ans);
  const known = new Set(sources.map((x) => x.ref));
  const finish = () => {
    if (sources.length) {
      const row = el("div", "src-row");
      row.setAttribute("aria-label", "Sources");
      for (const x of sources) row.appendChild(sourceChip(x));
      s.main.appendChild(row);
    }
    if (!failed) {
      const idx = state.chat ? state.chat.messages.length - 1 : 0;
      s.main.appendChild(actionsFor({ text: body }, idx).wrap);
    }
    say(failed ? (isQa ? "QA agent could not finish: " : "AURA QA could not answer: ") + body : "Answer ready");
    toBottom(false);
  };
  if (failed) {
    ans.replaceWith(alertCard(body, text, true, isQa ? { kind: result.kind } : null));
    finish();
  } else revealInto(ans, body, known, finish);
  $("chat-title").textContent = state.chat ? shortTitle(state.chat.title, 60) : "New chat";
}

async function runCommand(text, chat, signal) {
  const name = text.split(/\s+/)[0];
  const s = messageShell("assistant", { role: "assistant", ts: new Date().toISOString() });
  s.wrap.classList.add("live", "entering");
  setMarkState(s.av.firstChild, "thinking");
  const tool = toolCard(text, "", true, true);
  s.main.appendChild(tool.card);
  thread().appendChild(s.wrap);
  toBottom(true);
  say(`Running ${name}`);
  let output = "";
  let doneEv = null;
  const reply = await streamPost("/api/command", { line: text, chatId: chat.id }, signal, (ev) => {
    if (ev.type === "output") {
      output += ev.chunk;
      tool.pre.textContent = output;
      tool.pre.scrollTop = tool.pre.scrollHeight;
      toBottom(false);
    } else if (ev.type === "done") doneEv = ev;
  });
  tool.spin?.remove();
  s.wrap.classList.remove("live");
  let ok;
  if (reply.json) {
    const j = reply.json;
    tool.pre.textContent = j.output !== undefined ? j.output : j.error || "That command did not run.";
    ok = j.output !== undefined && j.ok;
    tool.chip.textContent = ok ? "Done" : "Failed";
    if (j.chat) state.chat = j.chat;
  } else {
    ok = !!doneEv && doneEv.code === 0;
    tool.chip.textContent = ok ? "Done" : doneEv && doneEv.timedOut ? "Timed out" : "Failed";
    if (!output) tool.pre.textContent = "(no output)";
    if (doneEv && doneEv.chat) state.chat = doneEv.chat;
  }
  tool.chip.setAttribute("data-status", ok ? "ok" : "fail");
  setMarkState(s.av.firstChild, ok ? "done" : "error");
  say(`${name} finished`);
}

/* ---------- composer ---------- */
function growInput() {
  syncSend();
  const i = $("input");
  if (typeof CSS !== "undefined" && CSS.supports && CSS.supports("field-sizing", "content")) return;
  i.style.height = "auto";
  i.style.height = Math.min(200, i.scrollHeight) + "px";
}
function syncPills() {
  $("pill-notes").setAttribute("aria-pressed", String(state.notesOnly));
  const on = workMode().live;
  $("pill-work").setAttribute("aria-pressed", String(on));
  $("top-work").setAttribute("aria-checked", String(on));
}
function syncSend() {
  if ($("robot-busy")) $("robot-busy").hidden = !state.busy;
  $("work-note").hidden = !state.busy;
  $("send").disabled = !$("input").value.trim();
}
function toggleWork() {
  state.prefs.showWork = flipWork(state.prefs.showWork, (WORK_DEFAULTS[style()] || WORK_DEFAULTS.noir).live);
  savePrefs();
  syncPills();
  renderPopover();
}

function menuMatches(value) {
  if (!value.startsWith("/")) return [];
  const qa = qaSlashItems(value, PROJECT_NAME);
  if (/\s/.test(value)) return qa;
  const q = value.slice(1).toLowerCase();
  return [...state.commands.filter((c) => c.name.startsWith(q)), ...qa];
}
const menuText = (c) => (c.insert !== undefined ? c.insert : `/${c.name} `);

function showMenu() {
  const items = menuMatches($("input").value);
  state.menuItems = items;
  state.menuIndex = Math.min(state.menuIndex, Math.max(0, items.length - 1));
  const menu = $("slash-menu");
  menu.replaceChildren();
  menu.hidden = !items.length;
  items.forEach((c, i) => {
    const row = el("div", "slash-item" + (c.available ? "" : " slash-off"));
    row.setAttribute("role", "option");
    row.id = `slash-${c.name}`;
    row.setAttribute("aria-selected", String(i === state.menuIndex));
    row.append(el("span", "slash-usage", c.usage), el("span", "slash-help", c.available ? c.help : "not available yet"));
    row.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      pick(i);
    });
    menu.appendChild(row);
  });
  if (items.length) {
    const foot = el("div", "slash-foot");
    foot.append(el("span", "", "Up and down to move"), el("span", "", "Enter to pick"), el("span", "", "Esc to close"));
    menu.appendChild(foot);
    $("input").setAttribute("aria-activedescendant", `slash-${items[state.menuIndex].name}`);
  } else $("input").removeAttribute("aria-activedescendant");
  $("input").setAttribute("aria-expanded", String(!menu.hidden));
}

function hideMenu() {
  $("slash-menu").hidden = true;
  state.menuItems = [];
}

function pick(i) {
  const c = state.menuItems[i];
  if (!c) return;
  const input = $("input");
  input.value = menuText(c);
  state.menuIndex = 0;
  showMenu();
  input.focus();
}

/* ---------- source panel ---------- */
function closePanel() {
  $("panel").hidden = true;
  $("app").classList.remove("has-panel");
}

async function openSource(s) {
  $("panel").hidden = false;
  $("app").classList.add("has-panel");
  $("panel-kind").textContent = KIND_LABEL[s.kind] || s.kind || "Source";
  $("panel-title").textContent = s.title || s.ref;
  $("panel-ref").textContent = s.ref;
  const body = $("panel-body");
  body.replaceChildren(el("p", "", "Loading..."));
  let doc = s.text !== undefined ? { kind: "context", ref: s.ref, title: s.title, body: s.text } : null;
  if (!doc) {
    const r = await api(`/api/doc?ref=${encodeURIComponent(s.ref)}`);
    if (!r.ok) {
      body.replaceChildren(el("p", "", "That source is not in the index any more."));
      return;
    }
    doc = r.data;
  }
  $("panel-kind").textContent = KIND_LABEL[doc.kind] || doc.kind;
  $("panel-title").textContent = doc.title || doc.ref;
  body.replaceChildren();
  if (doc.status === "proposed") body.appendChild(el("div", "panel-note", "Proposed note: the owner has not approved it yet."));
  if (doc.kind === "note") {
    const b = el("div", "bubble");
    b.innerHTML = renderSafe(doc.body); // escaped first
    body.appendChild(b);
  } else {
    body.appendChild(el("pre", "doc-text", doc.body)); // textContent: shown as text
  }
}

/** A vault note from the inbox, shown in the same panel. The text is escaped before it is rendered. */
function openNoteDoc(n) {
  $("panel").hidden = false;
  $("app").classList.add("has-panel");
  $("panel-kind").textContent = `Note - ${n.type}`;
  $("panel-title").textContent = n.title;
  $("panel-ref").textContent = n.id;
  const body = $("panel-body");
  body.replaceChildren();
  body.appendChild(el("div", "panel-note", `Status: ${n.status}. The owner has not approved it yet.`));
  const b = el("div", "bubble");
  b.innerHTML = renderSafe(n.body);
  body.appendChild(b);
  body.scrollTop = 0;
}

/* ---------- views ---------- */
const review = initReview({ api, el, $, openNote: openNoteDoc, closePanel, getProject: () => state.project, goto: (v) => setView(v) });
function toast(text, opts = {}) {
  const t = el("div", "toast" + (opts.error ? " toast-error" : ""));
  t.appendChild(el("span", "toast-text", text));
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), opts.error ? 6000 : 1600);
}

/** The title and the project chips. There is one project, so nothing here changes per view. */
function paintChrome() {
  document.title = PRODUCT_NAME;
  for (const n of document.querySelectorAll("[data-project-name]")) n.textContent = PROJECT_NAME;
}

const overviewView = mountOverview({
  root: $("overview-body"),
  api,
  getProject: () => state.project,
  actions: {
    openChat: () => newChat(),
    openView: (v) => (v === "settings" ? openSettings() : setView(v)),
    openSource: (src) => openSource(src),
    openRun: (id) => { setView("qa"); ensureQaHarness().show(id); },
    ask: (text) => { setView("chat"); send(text); },
    fillQa: () => { setView("chat"); qaCtx.fillComposer("QA the latest change"); },
    focusSearch: () => $("global-search").focus(),
  },
});
let settingsView = null;
let qaHarnessView = null;
const reoPages = mountReoPages({
  api,
  toast,
  onRunMission: (prompt) => { setView("chat"); send(prompt); },
  openView: (v) => (v === "settings" ? openSettings() : setView(v)),
  openSource: (src) => openSource(src),
});
let defectsView = null;
let pluginsView = null;
let agentsView = null;
let knowledgeView = null;
let systemSettingsView = null;
function ensureQaHarness() {
  if (!qaHarnessView) {
    qaHarnessView = createQaHarnessController({
      api,
      root: $("qa-harness-body"),
      statusEl: $("qa-harness-status"),
      refreshBtn: $("qa-harness-refresh"),
      onAskInChat: (prompt) => {
        setView("chat");
        const box = $("input");
        box.value = prompt;
        box.focus();
      },
    });
  }
  return qaHarnessView;
}
function setView(name) {
  if (state.view === "settings" && name !== "settings") settingsView?.hide();
  if (state.view === "qa" && name !== "qa") qaHarnessView?.stopReplay();
  if (name === "settings" && state.view !== "settings") state.viewBeforeSettings = state.view;
  state.view = name;
  $("app").setAttribute("data-view", name);
  for (const n of document.querySelectorAll("[data-nav]")) {
    if (n.getAttribute("data-nav") === name) n.setAttribute("aria-current", "page");
    else n.removeAttribute("aria-current");
  }
  // One composer, two homes: in the hero on Overview, at the bottom of the Chat page.
  const slot = $("hero-composer-slot");
  const wrap = $("composer-wrap");
  if (wrap && name === "overview") slot.appendChild(wrap);
  else if (wrap && wrap.parentNode === slot) $("chat-col").appendChild(wrap);
  wrap?.classList.toggle("is-hero", name === "overview");
  $("settings-btn")?.classList.toggle("active", name === "settings");
  for (const v of ["overview", "how", "chat", "defects", "agents", "plugins", "knowledge", "inbox", "reports", "qa", "settings"]) {
    $(`view-${v}`).hidden = v !== name;
    const tab = $(`tab-${v}`);
    if (!tab) continue;
    tab.classList.toggle("active", v === name);
    tab.setAttribute("aria-selected", String(v === name));
  }
  for (const n of document.querySelectorAll(".chat-only")) n.hidden = name !== "chat";
  closePanel();
  if (name === "inbox" || name === "reports") review.show(name);
  if (name === "qa") ensureQaHarness().show();
  if (name === "how") overviewView.show();
  if (name === "defects") (defectsView ||= reoPages.mountDefects($("view-defects"))).show();
  if (name === "plugins") (pluginsView ||= reoPages.mountPlugins($("view-plugins"))).show();
  if (name === "agents") (agentsView ||= reoPages.mountAgents($("view-agents"))).show();
  if (name === "knowledge") (knowledgeView ||= reoPages.mountKnowledge($("view-knowledge"))).show();
  if (name === "chat") {
    if (!state.busy && !(state.chat && state.chat.messages && state.chat.messages.length)) renderMessages();
    $("input").focus();
  }
  if (name === "settings") {
    if (!settingsView) {
      settingsView = mountSettings({ root: $("view-settings"), onBack: closeSettings });
      mountThemeCard($("view-settings"));
      systemSettingsView = reoPages.mountSystemSettings($("view-settings"));
    }
    settingsView.show();
    systemSettingsView?.refresh();
  }
}

/** A Theme card at the end of the settings page: Light, Dark or System. Same preference as the sidebar toggle. */
function mountThemeCard(root) {
  const wrap = root.querySelector(".st-wrap");
  if (!wrap || !Prefs) return;
  const card = el("section", "st-card st-theme");
  card.id = "st-theme";
  const head = el("header", "st-card-head");
  const t = el("div", "st-card-titles");
  t.append(el("h2", "st-card-title", "Theme"), el("p", "st-card-sub", "Light is the default. System follows this computer."));
  head.appendChild(t);
  const seg = el("div", "seg");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "Theme");
  const paint = () => {
    for (const b of seg.children) {
      const on = b.getAttribute("data-mode") === state.prefs.mode;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  for (const m of ["light", "dark", "system"]) {
    const b = el("button", "", MODE_LABEL[m]);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("data-mode", m);
    b.addEventListener("click", () => {
      setPrefs({ mode: m });
      paint();
    });
    seg.appendChild(b);
  }
  radioKeys(seg);
  paint();
  card.append(head, seg);
  wrap.appendChild(card);
  themeCardSync = paint;
}
let themeCardSync = null;

/** Machine-wide model and key settings. */
function openSettings() {
  closeStatus();
  if (state.view !== "settings") setView("settings");
}
function closeSettings() {
  setView(state.viewBeforeSettings && state.viewBeforeSettings !== "settings" ? state.viewBeforeSettings : "chat");
}
for (const b of document.querySelectorAll(".switch")) b.addEventListener("click", () => setView(b.getAttribute("data-view")));

document.addEventListener("click", (ev) => {
  const t = ev.target;
  if (t instanceof Element && t.classList.contains("cite")) {
    const ref = t.getAttribute("data-ref");
    const src = (state.chat?.messages || []).flatMap((m) => m.sources || []).find((s) => s.ref === ref);
    openSource(src || { ref, kind: "note", title: ref });
  }
  if (state.reveal && t instanceof Element && t.closest("#messages")) state.reveal();
});
$("messages").addEventListener("wheel", () => state.reveal && state.reveal(), { passive: true });

/* ---------- appearance ---------- */
const MODE_LABEL = { system: "System", light: "Light", dark: "Dark" };
const MOTION_LABEL = { auto: "Auto", reduced: "Reduced" };
const WORK_LABEL = { auto: "Style default", on: "Always", off: "Never" };
const SAMPLE = { noir: "> dense, mono, sharp", dots: "Warm, calm, readable", pulse: "Quiet and airy", aurora: "Soft glow, rounded" };

function segment(label, values, labels, current, onPick) {
  const wrapper = el("div", "pop-section");
  wrapper.appendChild(el("h3", "pop-title", label));
  const seg = el("div", "seg");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", label);
  for (const v of values) {
    const b = el("button", "", labels[v]);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("data-k", `${label}-${v}`);
    b.setAttribute("aria-checked", String(v === current));
    b.tabIndex = v === current ? 0 : -1;
    b.addEventListener("click", () => onPick(v));
    seg.appendChild(b);
  }
  wrapper.appendChild(seg);
  return { wrapper, seg };
}

function radioKeys(group) {
  group.addEventListener("keydown", (e) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    const items = [...group.querySelectorAll('[role="radio"]')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const n = items[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
    n.click();
    const again = $("appearance").querySelector(`[data-k="${n.getAttribute("data-k")}"]`);
    if (again) again.focus();
  });
}

function renderPopover() {
  const pop = $("appearance");
  if (pop.hidden) return;
  const focusKey = pop.contains(document.activeElement) ? document.activeElement.getAttribute("data-k") : null;
  pop.replaceChildren();
  const parts = [
    segment("Mode", ["system", "light", "dark"], MODE_LABEL, state.prefs.mode, (v) => setPrefs({ mode: v })),
    segment("Motion", ["auto", "reduced"], MOTION_LABEL, state.prefs.motion, (v) => setPrefs({ motion: v })),
    segment("Show work", ["auto", "on", "off"], WORK_LABEL, state.prefs.showWork, (v) => setPrefs({ showWork: v })),
  ];
  for (const p of parts) {
    radioKeys(p.seg);
    pop.appendChild(p.wrapper);
  }
  const act = el("div", "pop-actions");
  const reset = el("button", "btn", "Reset to default (Light)");
  reset.type = "button";
  reset.addEventListener("click", () => setPrefs(Prefs.DEFAULTS, true));
  const close = el("button", "btn btn-primary", "Done");
  close.type = "button";
  close.addEventListener("click", closePopover);
  act.append(reset, close);
  pop.appendChild(act);
  if (focusKey) pop.querySelector(`[data-k="${focusKey}"]`)?.focus();
}

function openPopover() {
  $("appearance").hidden = false;
  $("appearance-btn").setAttribute("aria-expanded", "true");
  renderPopover();
  $("appearance").querySelector('[aria-checked="true"]')?.focus();
}
function closePopover() {
  $("appearance").hidden = true;
  $("appearance-btn").setAttribute("aria-expanded", "false");
  $("appearance-btn").focus();
}

function syncThemeToggle() {
  const dark = state.prefs.mode === "dark" || (state.prefs.mode === "system" && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
  const b = $("theme-toggle");
  if (!b) return;
  b.setAttribute("aria-pressed", String(dark));
  b.setAttribute("aria-checked", String(dark));
  b.setAttribute("title", dark ? "Switch to light theme" : "Switch to dark theme");
  b.querySelector(".theme-label").textContent = dark ? "Dark" : "Light";
}

function applyAll() {
  Prefs.apply(state.prefs, document.documentElement);
  if (themeCardSync) themeCardSync();
  syncThemeToggle();
  remountMarks(document, document, style());
  if (!state.busy) renderMessages();
  if (!state.sideSet && sideStored() === null) followStyleSidebar();
  syncPills();
  renderChatList();
}

/** Choosing a style applies at once (no reload); a short cross-fade hides the switch where supported. */
function setPrefs(patch, replace) {
  state.prefs = Prefs.normalize(replace ? patch : { ...state.prefs, ...patch });
  if (replace) {
    try {
      storage && storage.removeItem("guard.side");
    } catch {
      /* ignore */
    }
    state.sideSet = false;
  }
  savePrefs();
  const go = () => {
    applyAll();
    renderPopover();
  };
  if (document.startViewTransition && !reducedMotion() && (replace || patch.style !== undefined)) document.startViewTransition(go);
  else go();
}

$("theme-toggle")?.addEventListener("click", () => {
  const dark = $("theme-toggle").getAttribute("aria-pressed") === "true";
  setPrefs({ mode: dark ? "light" : "dark" });
});
$("appearance-btn").addEventListener("click", () => ($("appearance").hidden ? openPopover() : closePopover()));
$("appearance").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closePopover();
  } else if (e.key === "Tab") {
    const f = [...$("appearance").querySelectorAll("button")].filter((b) => b.tabIndex >= 0);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
document.addEventListener("pointerdown", (e) => {
  const pop = $("appearance");
  if (!pop.hidden && e.target instanceof Node && !pop.contains(e.target) && !$("appearance-btn").contains(e.target)) {
    pop.hidden = true;
    $("appearance-btn").setAttribute("aria-expanded", "false");
  }
});

/* ---------- QA agent: what the card and the question may ask of this screen ---------- */
const qaCtx = {
  get storage() {
    return storage;
  },
  toast: (t, o) => toast(t, o),
  say,
  fillComposer(text, { onlyIfEmpty } = {}) {
    const i = $("input");
    if (onlyIfEmpty && i.value.trim()) return;
    i.value = text;
    growInput();
    i.focus();
    i.setSelectionRange(text.length, text.length);
  },
  pickChip(option) {
    const a = chipAction(option);
    if (a.action === "send") send(a.text);
    else if (a.action === "fill") qaCtx.fillComposer(a.text);
  },
  runJourneys: () => send("Run the read-only journeys", { runJourneys: true }),
  openInbox: () => setView("inbox"),
  openHarness: (runId) => { setView("qa"); ensureQaHarness().show(runId); },
  async openReport(markdownPath) {
    const r = await api("/api/reports");
    if (!r.ok) return false;
    const rel = findReportPath(markdownPath, r.data.reports);
    if (!rel) return false;
    setView("reports");
    for (let i = 0; i < 25; i++) {
      const b = [...document.querySelectorAll("#report-list .report-item")].find((x) => x.getAttribute("data-path") === rel);
      if (b) {
        b.click();
        return true;
      }
      await new Promise((ok) => setTimeout(ok, 100));
    }
    return false;
  },
};

/* ---------- project status popover ---------- */
function closeStatus() {
  $("status-detail").hidden = true;
  $("status-toggle").setAttribute("aria-expanded", "false");
}

function sdSection(title) {
  const s = el("section", "sd-block");
  s.appendChild(el("h4", "sd-title", title));
  return s;
}

function sdAction(icon, label, onClick, cls = "btn") {
  const b = el("button", cls);
  b.type = "button";
  b.append(svg(icon, 1.6), el("span", "", label));
  b.addEventListener("click", onClick);
  return b;
}

/** Builds the popover from the last status and project facts. Everything is set with textContent. */
function renderStatusPanel() {
  const box = $("status-detail");
  const s = state.summary || statusSummary({ status: state.status, project: state.project });
  const keep = box.contains(document.activeElement) ? document.activeElement.getAttribute("data-k") : null;
  box.replaceChildren();

  const head = el("header", "sd-head");
  head.appendChild(el("span", "tile sd-tile", MONOGRAM));
  head.lastChild.setAttribute("aria-hidden", "true");
  const titles = el("div", "sd-titles");
  titles.append(el("h3", "sd-name", PROJECT_NAME), el("p", "sd-sub " + (s.index ? s.index.state : "unknown"), s.index ? s.index.label : "Index status unknown"));
  const x = el("button", "icon-btn sd-close");
  x.type = "button";
  x.setAttribute("aria-label", "Close project status");
  x.setAttribute("data-k", "close");
  x.appendChild(svg(ICON.x, 1.75));
  x.addEventListener("click", () => {
    closeStatus();
    $("status-toggle").focus();
  });
  head.append(titles, x);
  box.appendChild(head);

  const repos = sdSection("Repositories");
  if (!s.repos.length) repos.appendChild(el("p", "sd-empty", "No repository has been read yet."));
  else {
    const list = el("ul", "sd-repos");
    for (const r of s.repos) {
      const li = el("li", "sd-repo");
      const top = el("div", "sd-repo-top");
      top.appendChild(el("span", "sd-repo-name", r.label));
      if (r.branch) top.appendChild(el("span", "sd-branch", r.branch));
      const meta = el("p", "sd-repo-meta");
      meta.appendChild(el("span", "", r.commitText));
      meta.appendChild(el("span", "sd-repo-idx " + r.state, r.indexText));
      li.append(top, meta);
      list.appendChild(li);
    }
    repos.appendChild(list);
  }
  box.appendChild(repos);

  const notes = sdSection("Index and notes");
  notes.appendChild(el("p", "sd-line", s.countsText));
  if (s.vault) {
    const grid = el("dl", "sd-stats");
    for (const [label, n] of [["Notes", s.vault.notes], ["Active", s.vault.active], ["Proposed", s.vault.proposed], ["Stale", s.vault.stale]]) {
      const cell = el("div", "sd-stat");
      cell.append(el("dd", "", String(n)), el("dt", "", label));
      grid.appendChild(cell);
    }
    notes.appendChild(grid);
    const vl = el("p", "sd-vault " + s.vaultTone);
    vl.append(el("span", "sd-dot"), el("span", "", s.vaultText));
    notes.appendChild(vl);
  }
  box.appendChild(notes);

  if (s.pending !== null) {
    const inbox = el("section", "sd-block sd-inbox");
    inbox.appendChild(el("p", "sd-line", s.pendingText));
    const open = sdAction(ICON.inbox, "Open inbox", () => {
      closeStatus();
      setView("inbox");
    });
    open.setAttribute("data-k", "inbox");
    inbox.appendChild(open);
    box.appendChild(inbox);
  }

  const run = el("section", "sd-block sd-run");
  const ix = state.indexing;
  const live = ix && !ix.failed;
  const running = live || (state.status && state.status.running);
  const go = sdAction(ICON.index, live ? "Indexing..." : "Index now", indexNow, "btn btn-primary");
  go.setAttribute("data-k", "index");
  if (running) go.setAttribute("aria-disabled", "true");
  const note = el("p", "sd-note" + (ix && ix.failed ? " bad" : ""));
  note.id = "index-note";
  note.setAttribute("role", "status");
  note.textContent = ix ? ix.line : state.status && state.status.running ? `Running /${state.status.running}...` : "Reads the commits, files and notes again.";
  run.append(go, note);
  box.appendChild(run);

  const foot = el("footer", "sd-foot");
  const model = el("p", "sd-model " + (s.modelOk ? "ok" : "bad"));
  model.append(el("span", "sd-dot"), el("span", "", s.modelOk ? `Model: ${s.model}` : "No model is ready"));
  const link = sdAction(ICON.key, "Model & keys", openSettings, "sd-link");
  link.setAttribute("data-k", "keys");
  foot.append(model, link);
  box.appendChild(foot);
  if (keep) box.querySelector(`[data-k="${keep}"]`)?.focus();
}

/** Runs the index command through the same streaming API the chat uses, shows the last line, then refreshes. */
async function indexNow() {
  if ((state.indexing && !state.indexing.failed) || state.busy || (state.status && state.status.running)) return;
  state.indexing = { line: "Starting...", failed: false };
  say("Indexing started");
  renderStatusPanel();
  let done = null;
  let ok = false;
  try {
    const reply = await streamPost("/api/command", { line: "/index" }, new AbortController().signal, (ev) => {
      if (ev.type === "output") {
        const last = String(ev.chunk).split("\n").map((x) => x.trim()).filter(Boolean).pop();
        if (last) {
          state.indexing.line = last;
          const n = $("index-note");
          if (n) n.textContent = last;
        }
      } else if (ev.type === "done") done = ev;
    });
    ok = reply.json ? !!reply.json.ok && reply.json.output !== undefined : !!done && done.code === 0;
    if (!ok && reply.json && reply.json.error) state.indexing.line = reply.json.error;
  } catch {
    state.indexing.line = "Could not reach AURA QA.";
  }
  if (ok) {
    state.indexing = null;
    await refreshStatus();
    toast("Index rebuilt");
    say("Index rebuilt");
  } else {
    state.indexing = { line: state.indexing.line === "Starting..." ? "Indexing did not finish." : state.indexing.line, failed: true };
    await refreshStatus();
    toast("Indexing did not finish", { error: true });
    setTimeout(() => {
      state.indexing = null;
      if (!$("status-detail").hidden) renderStatusPanel();
    }, 6000);
  }
  if (!$("status-detail").hidden) renderStatusPanel();
}

/* ---------- wiring ---------- */
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});
$("input").addEventListener("input", () => {
  state.menuIndex = 0;
  growInput();
  showMenu();
});
$("input").addEventListener("keydown", (e) => {
  const open = !$("slash-menu").hidden;
  if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const n = state.menuItems.length;
    state.menuIndex = (state.menuIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    showMenu();
  } else if (open && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && $("input").value.trim() !== menuText(state.menuItems[state.menuIndex] || { name: "" }).trim()))) {
    e.preventDefault();
    pick(state.menuIndex);
  } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  } else if (e.key === "Escape") {
    if (open) hideMenu();
    else if ($("input").value) {
      $("input").value = "";
      growInput();
    } else closePanel();
  }
});
$("stop").addEventListener("click", () => state.abort?.abort());
$("new-chat").addEventListener("click", newChat);
$("gbar-bell").addEventListener("click", () => setView("inbox"));
/* The top-right menu reaches what lives in the chat column on other pages. */
function closeMenu() {
  $("menu-pop").hidden = true;
  $("menu-btn").setAttribute("aria-expanded", "false");
}
document.addEventListener("pointermove", (e) => {
  const m = $("mascot");
  if (!m || reducedMotion() || $("app").getAttribute("data-empty") !== "true") return;
  const r = m.getBoundingClientRect();
  const dx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 400));
  const dy = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / 300));
  m.style.setProperty("--lx", dx.toFixed(2));
  m.style.setProperty("--ly", dy.toFixed(2));
});
$("overview-scroll").addEventListener("scroll", () => $("app").setAttribute("data-scrolled", String($("overview-scroll").scrollTop > 24)), { passive: true });
/** A small wave and happy eyes when the person starts to type. */
function robotReact() {
  const m = $("mascot");
  if (!m || reducedMotion()) return;
  m.classList.remove("is-wave", "is-happy");
  void m.getBoundingClientRect();
  m.classList.add("is-wave", "is-happy");
  setTimeout(() => m.classList.remove("is-wave", "is-happy"), 2300);
}
$("input").addEventListener("focus", robotReact);
$("menu-btn").addEventListener("click", () => {
  const open = $("menu-pop").hidden;
  $("menu-pop").hidden = !open;
  $("menu-btn").setAttribute("aria-expanded", String(open));
  if (open) $("menu-pop").querySelector("button")?.focus();
});
$("menu-pop").addEventListener("click", (e) => {
  const b = e.target instanceof Element ? e.target.closest("[data-menu]") : null;
  if (!b) return;
  closeMenu();
  $(b.getAttribute("data-menu")).click();
});
$("menu-pop").addEventListener("keydown", (e) => {
  const items = [...$("menu-pop").querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") {
    closeMenu();
    $("menu-btn").focus();
  } else if (e.key === "ArrowDown") items[(i + 1) % items.length].focus();
  else if (e.key === "ArrowUp") items[(i + items.length - 1) % items.length].focus();
  else return;
  e.preventDefault();
});
document.addEventListener("pointerdown", (e) => {
  if (!$("menu-pop").hidden && e.target instanceof Node && !e.target.closest(".menu-wrap")) closeMenu();
});
$("drawer-btn").addEventListener("click", () => setSide(!sideCollapsed(), true));
for (const n of document.querySelectorAll("[data-nav]")) {
  n.addEventListener("click", (e) => {
    e.preventDefault();
    setView(n.getAttribute("data-nav"));
  });
}

/* ---------- global search: chats by title (here) and notes, commits and files (GET /api/search) ---------- */
let gsTimer = 0;
let gsSeq = 0;
function closeGlobalSearch() {
  $("gsearch-results").hidden = true;
  $("global-search").setAttribute("aria-expanded", "false");
}
function gsRow(kind, title, meta, onPick) {
  const b = el("button", "gs-row");
  b.type = "button";
  b.setAttribute("role", "option");
  b.append(el("span", `gs-kind ${kind}`, kind), el("span", "gs-title", title), el("span", "gs-meta", meta || ""));
  b.addEventListener("click", () => {
    closeGlobalSearch();
    $("global-search").value = "";
    onPick();
  });
  return b;
}
async function runGlobalSearch() {
  const q = $("global-search").value.trim();
  const box = $("gsearch-results");
  if (q.length < 2) return closeGlobalSearch();
  const seq = ++gsSeq;
  const low = q.toLowerCase();
  const chats = (state.chats || []).filter((c) => (c.title || "").toLowerCase().includes(low)).slice(0, 4);
  const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
  if (seq !== gsSeq) return;
  box.replaceChildren();
  for (const c of chats) box.appendChild(gsRow("chat", c.title || "Untitled", "", async () => { setView("chat"); await openChat(c.id); }));
  const hits = r.ok ? r.data.hits || [] : [];
  for (const h of hits) box.appendChild(gsRow(h.kind, h.title, h.status || "", () => openSource({ ref: h.ref, kind: h.kind, title: h.title })));
  if (!box.children.length) box.appendChild(el("p", "gs-empty", r.ok ? "Nothing found." : "Search is not available right now."));
  box.hidden = false;
  $("global-search").setAttribute("aria-expanded", "true");
}
$("global-search").addEventListener("input", () => {
  clearTimeout(gsTimer);
  gsTimer = setTimeout(runGlobalSearch, 180);
});
$("global-search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeGlobalSearch();
    $("global-search").blur();
  } else if (e.key === "ArrowDown") {
    $("gsearch-results").querySelector(".gs-row")?.focus();
    e.preventDefault();
  }
});
$("gsearch-results").addEventListener("keydown", (e) => {
  const rows = [...$("gsearch-results").querySelectorAll(".gs-row")];
  const i = rows.indexOf(document.activeElement);
  if (e.key === "ArrowDown" && i < rows.length - 1) rows[i + 1].focus();
  else if (e.key === "ArrowUp") (i > 0 ? rows[i - 1] : $("global-search")).focus();
  else if (e.key === "Escape") {
    closeGlobalSearch();
    $("global-search").focus();
  } else return;
  e.preventDefault();
});
document.addEventListener("pointerdown", (e) => {
  if (!$("gsearch-results").hidden && e.target instanceof Node && !e.target.closest(".gsearch")) closeGlobalSearch();
});
$("panel-close").addEventListener("click", closePanel);
$("sidebar-toggle").addEventListener("click", () => setSide(!sideCollapsed(), true));
$("status-toggle").addEventListener("click", () => {
  const b = $("status-toggle");
  const open = b.getAttribute("aria-expanded") !== "true";
  b.setAttribute("aria-expanded", String(open));
  $("status-detail").hidden = !open;
  if (open) {
    renderStatusPanel();
    $("status-detail").querySelector(".sd-close")?.focus(); // keyboard users land inside the popover
    refreshStatus();
  }
});
// The popover closes on a click elsewhere or Escape.
document.addEventListener("pointerdown", (e) => {
  if (!$("status-detail").hidden && e.target instanceof Node && !$("status-detail").contains(e.target) && !$("status-toggle").contains(e.target)) closeStatus();
});
$("settings-btn").addEventListener("click", openSettings);
$("status-detail").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeStatus();
    $("status-toggle").focus();
  }
});
$("chat-search").addEventListener("input", (e) => {
  state.chatQuery = e.target.value;
  renderChatList();
});
$("pill-notes").addEventListener("click", () => {
  state.notesOnly = !state.notesOnly;
  syncPills();
});
$("pill-work").addEventListener("click", toggleWork);
$("top-work").addEventListener("click", toggleWork);
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Escape" && !$("status-detail").hidden) {
    closeStatus();
    $("status-toggle").focus();
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && e.key === ",") {
    e.preventDefault();
    openSettings();
  } else if (mod && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    newChat();
  } else if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    $("global-search").focus();
    $("global-search").select();
  } else if (mod && !e.altKey && e.key === "/") {
    e.preventDefault();
    setView("chat");
    $("input").focus();
  } else if (mod && !e.altKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    setSide(!sideCollapsed(), true);
  } else if (!mod && e.key === "/" && !(e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) && (!$("view-chat").hidden || !$("view-overview").hidden)) {
    e.preventDefault();
    $("input").focus();
    $("input").value = "/";
    state.menuIndex = 0;
    showMenu();
  }
});

async function boot() {
  const live = el("div", "sr-only");
  live.id = "live-status";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  document.body.appendChild(live);
  if (Prefs) Prefs.apply(state.prefs, document.documentElement);
  syncThemeToggle();
  startParticles($("hero-particles"));
  remountMarks(document, document, style());
  followStyleSidebar();
  syncPills();
  paintChrome();
  syncSend();
  $("brand-name").textContent = PRODUCT_SHORT;
  // The app opens straight into a new chat. The cards come from the server; a failed call uses the fallback.
  const [cmds, sug] = await Promise.all([api("/api/commands"), api("/api/suggestions"), refreshStatus(), refreshChats()]);
  state.commands = (cmds.data.commands || []).filter((c) => c.available);
  state.suggestions = sug.ok ? sug.data : null;
  state.chat = null;
  renderMessages();
  setView("overview");
  renderChatList();
  setInterval(() => !state.busy && refreshStatus(), 30000);
}
boot();
