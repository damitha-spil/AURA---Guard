import { renderSafe } from "/render.js";
import { initReview } from "/review.js";
import { buildMark, remountMarks, setMarkState, STYLES, STYLE_NAMES, STYLE_BLURBS, WORK_DEFAULTS, styleDescriptor } from "/marks.js";
import { applyStep, workSteps, summarize, totalMs, formatDuration, stepIcon, splitEvents } from "/steps.js";
import { planReveal, revealedLength, shouldReveal } from "/reveal.js";
import { shortTitle } from "/titles.js";

// Suggestions are real questions the vault can answer.
const EXAMPLES = [
  "Why does the AI never get an ERP create tool?",
  "In what order should I run the checks, and why?",
  "How does the front desk choose a helper?",
  "What is the rule for the shared QA SQL Server?",
];
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
  prefs: Prefs ? Prefs.load(storage) : { style: "noir", mode: "system", motion: "auto", showWork: "auto" },
  chats: [], chat: null, commands: [], busy: false, abort: null, menuIndex: 0, menuItems: [],
  backend: "No model", runningChat: null, notesOnly: false, sideSet: false, reveal: null,
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
  if (remember) {
    state.sideSet = true;
    try {
      storage && storage.setItem("guard.side", collapsed ? "1" : "0");
    } catch {
      /* storage may be blocked; the sidebar still works */
    }
  }
}
const sideCollapsed = () => $("app").classList.contains("side-collapsed");
function followStyleSidebar() {
  const stored = sideStored();
  setSide(stored === null ? desc().sidebarDefault === "collapsed" : stored, false);
}

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.body !== undefined) {
    init.method = opts.method || "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, init);
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
  if (!state.chats.length) {
    box.appendChild(el("p", "empty-list", "No chats yet."));
    return;
  }
  for (const c of state.chats) {
    const row = el("div", "chat-item" + (state.chat && state.chat.id === c.id ? " active" : ""));
    const open = el("button", "chat-open");
    open.type = "button";
    open.title = c.title;
    open.appendChild(el("span", "chat-name", shortTitle(c.title)));
    if (state.runningChat === c.id) {
      const dots = el("span", "run-dots");
      dots.setAttribute("role", "img");
      dots.setAttribute("aria-label", "Working");
      dots.append(el("i"), el("i"), el("i"));
      open.appendChild(dots);
    } else open.appendChild(el("span", "chat-time", dayOrClock(c.updated)));
    open.addEventListener("click", () => openChat(c.id));
    const del = el("button", "chat-del");
    del.type = "button";
    del.setAttribute("aria-label", `Delete chat: ${c.title}`);
    del.appendChild(svg(ICON.trash));
    del.addEventListener("click", () => deleteChat(c.id, c.title));
    row.append(open, del);
    box.appendChild(row);
  }
}

function chip(label, value, cls) {
  const c = el("div", "chip" + (cls ? " " + cls : ""));
  c.append(el("span", "chip-label", label), el("span", "chip-value", value));
  return c;
}

async function refreshStatus() {
  const { ok, data } = await api("/api/status");
  const box = $("status");
  box.replaceChildren();
  if (!ok) return;
  const idx = data.index;
  const indexText = idx ? `${idx.note || 0} notes, ${idx.commit || 0} commits, ${idx.file || 0} files` : "not built - run /index";
  box.appendChild(chip("Index", indexText, idx ? "" : "warn"));
  box.appendChild(chip("Model", data.backend.label, data.backend.picked ? "" : "bad"));
  box.appendChild(chip("Vault", data.vault.problems ? `${data.vault.problems} problems` : `${data.vault.notes} notes, no problems`, data.vault.problems ? "warn" : ""));
  state.backend = data.backend.label;
  $("backend-chip").textContent = data.backend.label;
  $("status-line").textContent = `${data.backend.label} · ${idx ? (idx.note || 0) + " notes" : "no index"}`;
  const dot = $("status-dot");
  dot.className = "status-dot " + (!data.backend.picked ? "bad" : !idx || data.vault.problems ? "warn" : "ok");
  $("status-toggle").title = `Model: ${data.backend.label}. Index: ${indexText}. Vault: ${data.vault.notes} notes.`;
  setBusy(data.running);
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
  const ctl = { box, steps: initial.steps || [], live: !!initial.live, open: initial.open, ms: initial.ms || 0, sources: initial.sources || [], t0: Date.now(), timer: null };
  const render = () => {
    box.setAttribute("data-open", String(ctl.open));
    box.setAttribute("data-live", String(ctl.live));
    box.replaceChildren();
    const head = el("button", "trace-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(ctl.open));
    const label = el("span", ctl.live ? "shimmer" : "");
    label.textContent = ctl.live ? `Thinking ${formatDuration(Date.now() - ctl.t0).replace("under 1 s", "")}`.trim() : summarize(ctl.steps, ctl.ms);
    const chev = svg(ICON.chev, 2);
    chev.setAttribute("class", "chev");
    head.append(label, chev);
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
      if (s.detail) text.appendChild(el("span", "step-detail", s.detail));
      li.append(stepIconNode(s), text);
      if (s.status !== "running" && typeof s.ms === "number" && s.ms > 0) li.appendChild(el("span", "step-ms", formatDuration(s.ms)));
      list.appendChild(li);
    }
    box.appendChild(list);
    if (!ctl.live && ctl.sources.length) {
      box.appendChild(el("p", "trace-sources", "Sources used: " + ctl.sources.map((s) => s.title).join("; ")));
    }
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
    ctl.timer = setInterval(() => ctl.live && render(), 1000);
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
  if (s.status === "proposed") b.appendChild(el("span", "tag-unapproved", "Unapproved"));
  b.addEventListener("click", () => openSource(s));
  return b;
}

function actionButton(icon, label, onClick, pressable) {
  const b = el("button", "act");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.appendChild(svg(icon, 1.8));
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
    if (m.trace) parts.push(formatDuration(totalMs(m.trace, 0)));
  }
  return parts.filter(Boolean).join(" · ");
}

function messageShell(role, m) {
  const wrap = el("div", `msg ${role}${m && m.error ? " error" : ""}`);
  const av = el("div", "msg-avatar");
  av.appendChild(mark("idle"));
  const top = el("div", "msg-top");
  top.append(el("span", "msg-role", role === "user" ? "You" : "Guard"), el("span", "msg-meta", m ? metaText(m) : ""));
  const main = el("div", "msg-main");
  wrap.append(av, top, main);
  return { wrap, main, av, top };
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
  if (m.trace && m.trace.length) {
    const w = workMode();
    main.appendChild(createTrace({ steps: m.trace, live: false, open: w.expanded, ms: totalMs(m.trace, 0), sources: m.sources || [] }).box);
  }
  const ans = el("div", "answer bubble");
  ans.innerHTML = renderSafe(m.text, known); // renderSafe escapes all text before adding tags
  main.appendChild(ans);
  if (m.sources && m.sources.length) {
    const row = el("div", "src-row");
    row.setAttribute("aria-label", "Sources");
    for (const s of m.sources) row.appendChild(sourceChip(s));
    main.appendChild(row);
  }
  main.appendChild(actionsFor(m, index).wrap);
  return wrap;
}

function emptyState() {
  const d = desc();
  const box = el("div", "empty");
  const hero = el("div", "hero-mark");
  hero.appendChild(mark("idle"));
  box.append(hero);
  box.appendChild(el("p", "prompt-line", "> aura-guard ready"));
  box.append(el("h2", "", "What do you want to know about Aura?"));
  box.append(el("p", "", "Answers come only from the vault notes and the indexed code, with sources. Type / for commands."));
  const grid = el("div", "examples");
  EXAMPLES.forEach((q, i) => {
    const b = el("button", "example");
    b.type = "button";
    if (d.empty === "terminal") b.appendChild(el("span", "example-n", String(i + 1).padStart(2, "0")));
    b.appendChild(el("span", "example-q", q));
    b.addEventListener("click", () => {
      $("input").value = q;
      send();
    });
    grid.appendChild(b);
  });
  box.appendChild(grid);
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
  box.scrollTop = box.scrollHeight;
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

async function deleteChat(id, title) {
  if (!confirm(`Delete this chat?\n\n${title}`)) return;
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
  for (const m of document.querySelectorAll(".brand-mark")) setMarkState(m, on ? "thinking" : "idle");
}

function revealInto(node, text, known, done) {
  const d = desc();
  if (d.reveal === "none" || !shouldReveal({ reducedMotion: reducedMotion(), text })) {
    node.innerHTML = renderSafe(text, known);
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

async function send(forced) {
  const input = $("input");
  const text = (typeof forced === "string" ? forced : input.value).trim();
  if (!text || state.busy) return;
  setView("chat");
  hideMenu();
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
    if (text.startsWith("/")) await runCommand(text, chat, controller.signal);
    else await runAsk(text, chat, controller.signal);
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    document.querySelector(".msg.live")?.remove();
    const s = messageShell("assistant", { role: "assistant", ts: new Date().toISOString(), error: true });
    s.main.appendChild(el("div", "answer", aborted ? "Stopped waiting. If the answer arrives, it is saved in this chat; reopen the chat to see it." : "Could not reach Guard. Is its window still running?"));
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

async function runAsk(text, chat, signal) {
  const w = workMode();
  const s = messageShell("assistant", { role: "assistant", ts: new Date().toISOString() });
  s.wrap.classList.add("live", "entering");
  setMarkState(s.av.firstChild, "thinking");
  const tr = createTrace({ steps: [], live: true, open: w.live });
  tr.start();
  s.main.appendChild(tr.box);
  thread().appendChild(s.wrap);
  toBottom(true);
  say("Guard is working");
  let result = null;
  const reply = await streamPost(`/api/chats/${chat.id}/ask`, { question: text, ...(state.notesOnly ? { notesOnly: true } : {}) }, signal, (ev) => {
    if (ev.type === "step") tr.add(ev.step);
    else if (ev.type === "answer" || ev.type === "error") result = ev;
  });
  tr.stop();
  if (!result && reply.json) {
    const j = reply.json;
    result = j.text !== undefined ? { type: j.ok ? "answer" : "error", text: j.text, message: j.text, sources: j.sources, chat: j.chat } : { type: "error", message: j.error || "No answer.", chat: null };
  }
  if (!result) result = { type: "error", message: "The answer did not arrive.", chat: null };
  if (result.chat) state.chat = result.chat;
  const failed = result.type === "error";
  const body = failed ? result.message : result.text;
  const sources = failed ? [] : result.sources || [];
  const ms = totalMs(tr.steps, Date.now() - tr.t0);
  s.wrap.classList.remove("live");
  if (failed) s.wrap.classList.add("error");
  setMarkState(s.av.firstChild, failed ? "error" : "done");
  s.top.querySelector(".msg-meta").textContent = [clock(new Date().toISOString()), state.backend, formatDuration(ms)].filter(Boolean).join(" · ");
  tr.set({ live: false, ms, sources, open: w.expanded });
  if (!workSteps(tr.steps).length) tr.box.remove();
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
    say(failed ? "Guard could not answer: " + body : "Answer ready");
    toBottom(false);
  };
  if (failed) {
    ans.textContent = body;
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
  const i = $("input");
  if (typeof CSS !== "undefined" && CSS.supports && CSS.supports("field-sizing", "content")) return;
  i.style.height = "auto";
  i.style.height = Math.min(200, i.scrollHeight) + "px";
}
function syncPills() {
  $("pill-notes").setAttribute("aria-pressed", String(state.notesOnly));
  const on = workMode().live;
  $("pill-work").setAttribute("aria-pressed", String(on));
  $("top-work").setAttribute("aria-pressed", String(on));
}
function toggleWork() {
  state.prefs.showWork = workMode().live ? "off" : "on";
  savePrefs();
  syncPills();
  renderPopover();
}

function menuMatches(value) {
  if (!value.startsWith("/") || /\s/.test(value)) return [];
  const q = value.slice(1).toLowerCase();
  return state.commands.filter((c) => c.name.startsWith(q));
}

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
  input.value = `/${c.name} `;
  hideMenu();
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
const review = initReview({ api, el, $, openNote: openNoteDoc, closePanel });
function toast(text) {
  const t = el("div", "toast");
  t.appendChild(el("span", "toast-text", text));
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), 1600);
}

function setView(name) {
  for (const v of ["chat", "inbox", "reports"]) {
    $(`view-${v}`).hidden = v !== name;
    const tab = $(`tab-${v}`);
    tab.classList.toggle("active", v === name);
    tab.setAttribute("aria-selected", String(v === name));
  }
  for (const n of document.querySelectorAll(".chat-only")) n.hidden = name !== "chat";
  closePanel();
  review.show(name);
  if (name === "chat") $("input").focus();
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
  const sec = el("div", "pop-section");
  sec.appendChild(el("h3", "pop-title", "Style"));
  const grid = el("div", "style-grid");
  grid.setAttribute("role", "radiogroup");
  grid.setAttribute("aria-label", "Style");
  for (const s of STYLES) {
    const c = el("button", "style-card");
    c.type = "button";
    c.setAttribute("role", "radio");
    c.setAttribute("data-s", s);
    c.setAttribute("data-k", "style-" + s);
    c.setAttribute("aria-checked", String(s === style()));
    c.tabIndex = s === style() ? 0 : -1;
    const prev = el("div", "style-prev");
    prev.append(buildMark(document, s, "thinking"), el("span", "style-name", STYLE_NAMES[s]));
    c.append(prev, el("span", "style-sample", SAMPLE[s]), el("span", "style-sample", STYLE_BLURBS[s]));
    c.addEventListener("click", () => setPrefs({ style: s }));
    grid.appendChild(c);
  }
  radioKeys(grid);
  sec.appendChild(grid);
  pop.appendChild(sec);
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
  const reset = el("button", "btn", "Reset to default (Noir)");
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

function applyAll() {
  Prefs.apply(state.prefs, document.documentElement);
  remountMarks(document, document, style());
  for (const m of document.querySelectorAll(".brand-mark")) setMarkState(m, state.busy ? "thinking" : "idle");
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
  } else if (open && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && $("input").value.trim() !== `/${state.menuItems[state.menuIndex]?.name}`))) {
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
$("panel-close").addEventListener("click", closePanel);
$("sidebar-toggle").addEventListener("click", () => setSide(!sideCollapsed(), true));
$("status-toggle").addEventListener("click", () => {
  const b = $("status-toggle");
  const open = b.getAttribute("aria-expanded") !== "true";
  b.setAttribute("aria-expanded", String(open));
  $("status-detail").hidden = !open;
});
$("pill-notes").addEventListener("click", () => {
  state.notesOnly = !state.notesOnly;
  syncPills();
});
$("pill-work").addEventListener("click", toggleWork);
$("top-work").addEventListener("click", toggleWork);
for (const b of document.querySelectorAll("[data-cmd]")) {
  b.addEventListener("click", () => {
    $("input").value = b.getAttribute("data-cmd");
    send();
  });
}
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    newChat();
  } else if (mod && !e.altKey && e.key === "/") {
    e.preventDefault();
    setView("chat");
    $("input").focus();
  } else if (mod && !e.altKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    setSide(!sideCollapsed(), true);
  } else if (!mod && e.key === "/" && !(e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) && !$("view-chat").hidden) {
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
  remountMarks(document, document, style());
  followStyleSidebar();
  syncPills();
  const [cmds] = await Promise.all([api("/api/commands"), refreshStatus(), refreshChats()]);
  state.commands = (cmds.data.commands || []).filter((c) => c.available);
  if (state.chats[0]) await openChat(state.chats[0].id);
  else renderMessages();
  $("input").focus();
  review.refreshCount();
  setInterval(() => !state.busy && refreshStatus(), 30000);
}
boot();
