// QA agent: the screen part. Builds the result card, the needs-input question and the confirm dialog.
// Every string from the server or the model is put in with textContent, never as HTML.
// The pure rules live in qa.js (tested in Node). `ctx` is what the chat screen lends this file:
//   ctx.storage, ctx.toast(text, {error}), ctx.say(text), ctx.fillComposer(text, {onlyIfEmpty}),
//   ctx.pickChip(option, node), ctx.runJourneys(), ctx.openInbox(), ctx.openReport(markdownPath) -> Promise<boolean>

import {
  CASE_TYPES, TYPE_LABEL, PRIORITIES, PRIORITY_NOTE, MAX_SHOWN_FILES, safeResult, riskInfo, groupByPriority, filterCases, priorityCounts, typeCounts,
  caseCountText, generatedText, journeyState, loadChecklist, saveChecklist, toMarkdown, targetChips, chipAction, usedChip,
} from "./qa.js";

const NS = "http://www.w3.org/2000/svg";
const ICON = {
  shield: "M12 3.5 5 6v5.5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-2.5ZM9 12l2.2 2.2L15.5 10",
  alert: "M12 8v5M12 16.5v.01M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z",
  flame: "M8.6 3.5h6.8l5.1 5.1v6.8l-5.1 5.1H8.6l-5.1-5.1V8.6l5.1-5.1ZM12 8v5M12 16v.01",
  info: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 11v5M12 8v.01",
  chev: "m6 9 6 6 6-6",
  copy: "M9 9h10v11H9V9Zm-4 6V4h10",
  doc: "M7 3.5h7.5L19 8v12.5H7v-17Zm7 0V8.5h5M10 13h6M10 16.5h6",
  bolt: "M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z",
  check: "m5 12.5 4.5 4.5L19 7.5",
  x: "m6 6 12 12M18 6 6 18",
  play: "M8 5.5v13l11-6.5-11-6.5Z",
  redo: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  target: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 11.5v1",
  term: "m5 8 4 4-4 4M12 16h7",
  image: "M4 5h16v14H4V5Zm0 11 5-5 4 4 3-3 4 4",
  video: "M3.5 6.5h11v11h-11v-11Zm11 4 6-3.5v10l-6-3.5",
  list: "M5 6h2M5 12h2M5 18h2M10 6h9M10 12h9M10 18h6",
  help: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM9.6 9.5a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1 .9-1 1.6M12 16.5v.01",
  inbox: "M4 13l2.5-7.5h11L20 13v5.5H4V13Zm0 0h5l1 2h4l1-2h5",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9h-13v-9Z",
  files: "M7 3.5h7.5L19 8v12.5H7v-17Zm7 0V8.5h5",
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const svg = (d, sw = 1.75) => {
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
let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

function button(cls, label, icon, onClick) {
  const b = el("button", cls);
  b.type = "button";
  if (icon) b.appendChild(svg(ICON[icon], 1.75));
  if (label) b.appendChild(el("span", "", label));
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

/** A small copy button. Shows "Copied" for a moment; says so plainly when the browser refuses. */
function copyButton(getText, label, ctx, cls = "qa-btn qa-btn-quiet") {
  const b = button(cls, label, "copy");
  const text = b.querySelector("span");
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      text.textContent = "Copied";
      ctx.say && ctx.say("Copied");
    } catch {
      text.textContent = "Copy failed";
    }
    setTimeout(() => (text.textContent = label), 1500);
  });
  return b;
}

const chipEl = (text, cls) => el("span", "qa-chip" + (cls ? " " + cls : ""), text);

function riskBadge(level, big) {
  const r = riskInfo(level);
  const b = el("span", "qa-risk" + (big ? " qa-risk-big" : ""));
  b.setAttribute("data-level", r.level);
  b.appendChild(svg(ICON[r.icon], 2));
  b.appendChild(el("span", "", big ? r.label : r.word));
  if (!big) b.setAttribute("aria-label", r.label);
  return b;
}

function section(title, count, id) {
  const s = el("section", "qa-sec");
  const h = el("h4", "qa-h");
  h.id = id;
  h.appendChild(el("span", "", title));
  if (count !== undefined && count !== null) h.appendChild(el("span", "qa-count", String(count)));
  s.setAttribute("aria-labelledby", id);
  s.appendChild(h);
  return s;
}

function listOf(items, ordered) {
  const l = el(ordered ? "ol" : "ul", "qa-list");
  for (const t of items) l.appendChild(el("li", "", t));
  return l;
}

/* ---------- test cases ---------- */

function caseBody(c) {
  const body = el("div", "qa-case-body");
  const block = (title, node) => {
    const b = el("div", "qa-block");
    b.append(el("h5", "qa-block-h", title), node);
    body.appendChild(b);
  };
  if (c.preconditions.length) block("Before you start", listOf(c.preconditions, false));
  if (c.steps.length) block("Steps", listOf(c.steps, true));
  if (c.expected.length) block("Expected", listOf(c.expected, false));
  if (c.data) block("Data", el("pre", "qa-data", c.data));
  if (c.journeyId) block("Journey", el("code", "qa-code", c.journeyId));
  if (!body.children.length) body.appendChild(el("p", "qa-muted", "This case has no details."));
  return body;
}

function caseRow(c, openIds) {
  const item = el("div", "qa-case");
  item.setAttribute("data-priority", c.priority);
  const head = el("button", "qa-case-head");
  head.type = "button";
  const hid = nextId("qa-case");
  head.id = hid;
  const bid = hid + "-body";
  head.setAttribute("aria-controls", bid);
  head.setAttribute("aria-expanded", "false");
  const pri = el("span", "qa-pri", c.priority);
  pri.setAttribute("data-p", c.priority);
  pri.setAttribute("aria-label", `Priority ${c.priority}`);
  const id = el("span", "qa-case-id", c.id);
  const title = el("span", "qa-case-title", c.title);
  const chev = svg(ICON.chev, 1.75);
  chev.setAttribute("class", "qa-chev");
  const meta = el("span", "qa-case-meta");
  const t = chipEl(TYPE_LABEL[c.type], "qa-type");
  t.setAttribute("data-type", c.type);
  meta.appendChild(t);
  if (c.automatable) {
    const a = chipEl("", "qa-auto");
    a.append(svg(ICON.bolt, 2), el("span", "", "Automatable"));
    a.title = "A script could run this case";
    meta.appendChild(a);
  }
  for (const f of c.cites.slice(0, 3)) {
    const ch = chipEl(f, "qa-cite");
    ch.title = f;
    meta.appendChild(ch);
  }
  if (c.cites.length > 3) meta.appendChild(chipEl(`+${c.cites.length - 3}`, "qa-cite qa-cite-more"));
  head.append(pri, id, title, chev, meta);
  const body = el("div", "qa-case-panel");
  body.id = bid;
  body.setAttribute("role", "region");
  body.setAttribute("aria-labelledby", hid);
  body.hidden = true;
  const setOpen = (open) => {
    head.setAttribute("aria-expanded", String(open));
    item.classList.toggle("open", open);
    body.hidden = !open;
    if (open && !body.firstChild) body.appendChild(caseBody(c)); // built on first open: a long list stays fast
    if (open) openIds.add(c.id);
    else openIds.delete(c.id);
  };
  head.addEventListener("click", () => setOpen(body.hidden));
  item.append(head, body);
  if (openIds.has(c.id)) setOpen(true);
  return item;
}

function casesSection(r, ctx) {
  const sec = section("Test cases", r.cases.length, nextId("qa-h"));
  sec.classList.add("qa-cases-sec");
  if (!r.cases.length) {
    sec.appendChild(el("p", "qa-muted", "The plan has no test cases."));
    return sec;
  }
  const f = { priority: "all", type: "all" };
  const openIds = new Set();
  const collapsed = new Set(r.cases.length > 12 ? ["P2"] : []);
  const bar = el("div", "qa-filters");
  const seg = el("div", "qa-seg");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "Show priority");
  const types = el("div", "qa-types");
  types.setAttribute("role", "group");
  types.setAttribute("aria-label", "Filter by type");
  const count = el("span", "qa-shown");
  count.setAttribute("role", "status");
  const list = el("div", "qa-groups");

  const drawSeg = () => {
    const counts = priorityCounts(r.cases);
    seg.replaceChildren();
    for (const v of ["all", ...PRIORITIES]) {
      const b = el("button", "qa-seg-btn");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(f.priority === v));
      b.tabIndex = f.priority === v ? 0 : -1;
      b.setAttribute("data-v", v);
      b.append(el("span", "", v === "all" ? "All" : v), el("span", "qa-seg-n", String(counts[v])));
      if (v !== "all" && counts[v] === 0) b.disabled = true;
      b.addEventListener("click", () => {
        f.priority = v;
        if (!typeCounts(r.cases, v).some((x) => x.type === f.type)) f.type = "all";
        draw();
        seg.querySelector(`[data-v="${v}"]`)?.focus();
      });
      seg.appendChild(b);
    }
  };
  seg.addEventListener("keydown", (e) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    const items = [...seg.querySelectorAll("button:not(:disabled)")];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].click();
  });

  const drawTypes = () => {
    types.replaceChildren();
    const tc = typeCounts(r.cases, f.priority);
    if (tc.length < 2) return;
    for (const v of [{ type: "all", count: filterCases(r.cases, { priority: f.priority }).length }, ...tc]) {
      const b = el("button", "qa-tfilter");
      b.type = "button";
      b.setAttribute("aria-pressed", String(f.type === v.type));
      if (v.type !== "all") b.setAttribute("data-type", v.type);
      b.append(el("span", "", v.type === "all" ? "All types" : TYPE_LABEL[v.type]), el("span", "qa-seg-n", String(v.count)));
      b.addEventListener("click", () => {
        f.type = v.type;
        draw();
        types.querySelector(f.type === "all" ? "button" : `[data-type="${f.type}"]`)?.focus();
      });
      types.appendChild(b);
    }
  };

  const drawList = () => {
    list.replaceChildren();
    const shown = filterCases(r.cases, f);
    count.textContent = caseCountText(shown.length, r.cases.length);
    if (!shown.length) {
      list.appendChild(el("p", "qa-muted", "No case matches those filters."));
      return;
    }
    for (const g of groupByPriority(shown)) {
      const gw = el("div", "qa-group");
      gw.setAttribute("data-priority", g.priority);
      const gh = el("button", "qa-group-head");
      gh.type = "button";
      const gid = nextId("qa-group");
      const isOpen = !collapsed.has(g.priority);
      gh.setAttribute("aria-expanded", String(isOpen));
      gh.setAttribute("aria-controls", gid);
      const pri = el("span", "qa-pri", g.priority);
      pri.setAttribute("data-p", g.priority);
      const chev = svg(ICON.chev, 1.75);
      chev.setAttribute("class", "qa-chev");
      gh.append(pri, el("span", "qa-group-note", g.note), el("span", "qa-count", String(g.cases.length)), chev);
      const rows = el("div", "qa-rows");
      rows.id = gid;
      rows.hidden = !isOpen;
      if (isOpen) for (const c of g.cases) rows.appendChild(caseRow(c, openIds));
      let built = isOpen;
      gh.addEventListener("click", () => {
        const open = rows.hidden;
        rows.hidden = !open;
        gh.setAttribute("aria-expanded", String(open));
        if (open) collapsed.delete(g.priority);
        else collapsed.add(g.priority);
        if (open && !built) {
          built = true;
          for (const c of g.cases) rows.appendChild(caseRow(c, openIds));
        }
      });
      gw.append(gh, rows);
      list.appendChild(gw);
    }
  };

  function draw() {
    drawSeg();
    drawTypes();
    drawList();
  }
  const row = el("div", "qa-filter-row");
  row.append(seg, count);
  bar.append(row, types);
  draw();
  sec.append(bar, list);
  return sec;
}

/* ---------- other sections ---------- */

function areasSection(r) {
  const sec = section("Areas touched", r.areas.length, nextId("qa-h"));
  const grid = el("ul", "qa-areas");
  for (const a of r.areas) {
    const li = el("li", "qa-area");
    li.setAttribute("data-level", a.risk);
    const top = el("div", "qa-area-top");
    top.append(el("span", "qa-area-name", a.name), riskBadge(a.risk, false));
    li.append(top, el("p", "qa-area-why", a.why));
    grid.appendChild(li);
  }
  sec.appendChild(grid);
  return sec;
}

function checklistSection(r, ctx) {
  const sec = section("Regression checklist", r.regressionChecklist.length, nextId("qa-h"));
  const checked = loadChecklist(ctx.storage, r.id, r.regressionChecklist.length);
  const prog = el("p", "qa-progress");
  prog.setAttribute("role", "status");
  const sync = () => {
    const n = checked.filter(Boolean).length;
    prog.textContent = `${n} of ${checked.length} checked${n === checked.length ? ". All done." : ""}`;
  };
  const list = el("ul", "qa-checks");
  r.regressionChecklist.forEach((text, i) => {
    const li = el("li", "qa-check-row");
    const label = el("label", "qa-check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = checked[i];
    box.addEventListener("change", () => {
      checked[i] = box.checked;
      if (!saveChecklist(ctx.storage, r.id, checked)) ctx.toast && ctx.toast("This browser would not remember the checklist.", { error: true });
      sync();
    });
    label.append(box, el("span", "qa-check-text", text));
    li.appendChild(label);
    list.appendChild(li);
  });
  sync();
  sec.append(prog, list);
  sec.getChecked = () => checked.slice();
  return sec;
}

function evidenceSection(r) {
  const sec = section("Evidence to attach", null, nextId("qa-h"));
  sec.classList.add("qa-evidence");
  const l = el("ul", "qa-evidence-list");
  const add = (icon, text) => {
    const li = el("li", "qa-ev");
    const ic = el("span", "qa-ev-ic");
    ic.appendChild(svg(ICON[icon], 1.75));
    li.append(ic, el("span", "", text));
    l.appendChild(li);
  };
  const hasShots = r.evidence.needed.some((t) => /screenshot/i.test(t));
  const hasVideo = r.evidence.needed.some((t) => /video/i.test(t));
  if (r.evidence.uiChange && !hasShots) add("image", "Real-app screenshots at 800, 1100 and 1440 px");
  if (r.evidence.uiChange && !hasVideo) add("video", "A walkthrough video of the changed screen in use");
  if (false) {
    add("image", "Real-app screenshots at 800, 1100 and 1440 px");
    add("video", "A walkthrough video of the changed screen in use");
  }
  for (const t of r.evidence.needed) add(/test database|production|erp|never/i.test(t) ? "lock" : "doc", t);
  sec.appendChild(l);
  return sec;
}

function commandsSection(r, ctx) {
  const sec = section("Check commands", r.checkCommands.length, nextId("qa-h"));
  sec.appendChild(el("p", "qa-note", "AURA QA never runs these. Run them yourself in your own terminal."));
  for (const c of r.checkCommands) {
    const row = el("div", "qa-cmd");
    const ic = el("span", "qa-cmd-ic");
    ic.appendChild(svg(ICON.term, 1.75));
    const code = el("code", "qa-cmd-text", c.command);
    code.tabIndex = 0;
    row.append(ic, code);
    if (c.source) row.appendChild(chipEl(c.source, "qa-cmd-src"));
    if (!c.approved) row.appendChild(el("span", "tag-unapproved", "Unapproved"));
    row.appendChild(copyButton(() => c.command, "Copy", ctx, "qa-btn qa-btn-quiet qa-btn-sm"));
    sec.appendChild(row);
  }
  return sec;
}

function journeysSection(r, ctx, isLatest) {
  const js = journeyState(r, isLatest);
  const sec = section("Journeys", null, nextId("qa-h"));
  sec.classList.add("qa-journeys");
  if (js.none) {
    sec.appendChild(el("p", "qa-muted", "No journey is linked to these cases, so nothing can be run for this change."));
    return sec;
  }
  if (js.runnable.length) {
    sec.appendChild(el("p", "qa-note", `${js.runnable.length} read-only ${js.runnable.length === 1 ? "journey is" : "journeys are"} ready to run in the app that is already open. Nothing runs until you confirm.`));
    const l = el("ul", "qa-jlist");
    for (const j of js.runnable) {
      const li = el("li", "qa-j");
      li.append(el("span", "qa-j-title", j.title || j.journeyId), el("span", "qa-j-cases", j.caseIds.length ? `Cases: ${j.caseIds.join(", ")}` : ""));
      l.appendChild(li);
    }
    sec.appendChild(l);
  }
  if (js.blocked.length || js.needsApp || (js.note && !js.runnable.length)) {
    const blk = el("div", "qa-blocked");
    const top = el("div", "qa-blocked-top");
    top.append(svg(ICON.info, 1.75), el("strong", "", js.runnable.length ? "Some journeys cannot run" : "Journeys cannot run yet"));
    blk.appendChild(top);
    if (js.note) blk.appendChild(el("p", "", js.note));
    if (js.blocked.length) {
      const l = el("ul", "qa-list");
      for (const b of js.blocked) l.appendChild(el("li", "", `${b.journeyId}: ${b.reason}`));
      blk.appendChild(l);
    }
    if (js.needsApp) {
      blk.appendChild(el("p", "", "To run them, start the app yourself with a debugging port, for example with the flag --remote-debugging-port=<port>, and give AURA QA its address (the AURA_CDP_URL setting). AURA QA attaches to a running app. It never starts one."));
    }
    sec.appendChild(blk);
  }
  if (js.canRun) {
    const go = button("qa-btn qa-btn-primary qa-run", "Run read-only journeys", "play");
    go.addEventListener("click", async () => {
      const ok = await confirmRun(r, go);
      if (ok) {
        go.disabled = true;
        ctx.runJourneys();
      }
    });
    sec.appendChild(go);
  } else if (js.runnable.length && !js.hasRun) {
    sec.appendChild(el("p", "qa-muted", "A newer message came after this result. Run the journeys from the newest result."));
  }
  return sec;
}

function runSection(r, ctx) {
  const run = r.run;
  const sec = section("Journey run", null, nextId("qa-h"));
  sec.classList.add("qa-run-sec");
  const st = el("span", "qa-run-status");
  st.setAttribute("data-status", run.status);
  st.appendChild(svg(run.status === "passed" ? ICON.check : run.status === "failed" ? ICON.x : ICON.alert, 2.2));
  st.appendChild(el("span", "", run.status === "passed" ? "Passed" : run.status === "failed" ? "Failed" : "Blocked"));
  sec.firstChild.appendChild(st);
  for (const x of run.runs) {
    const row = el("div", "qa-run-row");
    row.setAttribute("data-status", x.status);
    const top = el("div", "qa-run-top");
    const ic = el("span", "qa-run-ic");
    ic.appendChild(svg(x.status === "passed" ? ICON.check : x.status === "failed" ? ICON.x : ICON.alert, 2.2));
    top.append(ic, el("span", "qa-run-name", x.journeyId), el("span", "qa-run-res", `${x.status === "passed" ? "Passed" : x.status === "failed" ? "Failed" : "Blocked"}${x.defects ? `, ${x.defects} ${x.defects === 1 ? "defect" : "defects"}` : ""}`));
    row.appendChild(top);
    if (x.blocker) row.appendChild(el("p", "qa-run-blocker", x.blocker));
    if (x.reportPath) row.appendChild(pathRow("Report", x.reportPath, ctx));
    sec.appendChild(row);
  }
  if (run.defects.length) {
    sec.appendChild(el("h5", "qa-block-h", "Defects"));
    for (const d of run.defects) {
      const card = el("div", "qa-defect");
      card.appendChild(el("p", "qa-defect-top", `${d.journeyId} at "${d.step}"${d.width ? ` (${d.width} px wide)` : ""}`));
      const exp = el("p", "qa-defect-line");
      exp.append(el("strong", "", "Expected: "), document.createTextNode(d.expected));
      const act = el("p", "qa-defect-line");
      act.append(el("strong", "", "Got: "), document.createTextNode(d.actual));
      card.append(exp, act);
      if (d.screenshot) card.appendChild(pathRow("Evidence", d.screenshot, ctx));
      sec.appendChild(card);
    }
  }
  if (run.proposedIncidents) {
    const n = el("div", "qa-incident");
    n.appendChild(el("span", "", `${run.proposedIncidents} incident ${run.proposedIncidents === 1 ? "note was" : "notes were"} proposed. Nothing is approved until a person reviews it in the inbox.`));
    n.appendChild(button("qa-btn qa-btn-quiet qa-btn-sm", "Open inbox", "inbox", () => ctx.openInbox()));
    sec.appendChild(n);
  } else if (run.defects.length === 0 && run.status === "passed") sec.appendChild(el("p", "qa-muted", "No defects, so no incident note was proposed."));
  return sec;
}

function pathRow(label, path, ctx) {
  const row = el("div", "qa-path");
  row.append(el("span", "qa-path-label", label), el("code", "qa-path-text", path), copyButton(() => path, "Copy", ctx, "qa-btn qa-btn-quiet qa-btn-sm"));
  return row;
}

function filesSection(r) {
  const files = r.context.changedFiles;
  if (!files.length) return null;
  const d = el("details", "qa-files");
  const sum = el("summary", "qa-files-sum");
  sum.append(svg(ICON.files, 1.75), el("span", "", `Changed files (${files.length})`));
  d.appendChild(sum);
  d.addEventListener("toggle", () => {
    if (!d.open || d.querySelector("ul")) return;
    const l = el("ul", "qa-filelist");
    for (const f of files.slice(0, MAX_SHOWN_FILES)) {
      const li = el("li", "qa-file");
      li.append(el("code", "qa-file-path", f.path), f.category ? chipEl(f.category, "qa-file-cat") : document.createTextNode(""));
      l.appendChild(li);
    }
    if (files.length > MAX_SHOWN_FILES) l.appendChild(el("li", "qa-muted", `and ${files.length - MAX_SHOWN_FILES} more`));
    d.appendChild(l);
  });
  return d;
}

/* ---------- the card ---------- */

export function renderQaCard(qa, ctx, { isLatest = false } = {}) {
  const r = safeResult(qa);
  const risk = riskInfo(r.risk.level);
  const card = el("article", "qa-card");
  card.setAttribute("data-level", risk.level);
  card.setAttribute("aria-label", `QA result. ${risk.label}.`);
  if (r.id) card.setAttribute("data-id", r.id);

  const head = el("header", "qa-head");
  const mark = el("span", "qa-mark");
  mark.appendChild(svg(ICON.shield, 1.6));
  const main = el("div", "qa-head-main");
  const titleRow = el("div", "qa-title-row");
  titleRow.appendChild(el("h3", "qa-title", "QA result"));
  if (r.project.name) titleRow.appendChild(el("span", "qa-project", r.project.name));
  const tgt = el("p", "qa-target");
  tgt.appendChild(svg(ICON.target, 1.75));
  tgt.appendChild(el("span", "qa-target-text", r.target.label));
  if (r.target.fromConversation) tgt.appendChild(chipEl("from this chat", "qa-tag"));
  main.append(titleRow, tgt);
  const side = el("div", "qa-head-side");
  side.appendChild(riskBadge(risk.level, true));
  const when = generatedText(r.generatedAt);
  if (when) {
    const t = el("time", "qa-time", when);
    t.setAttribute("datetime", r.generatedAt);
    side.appendChild(t);
  }
  head.append(mark, main, side);
  card.appendChild(head);

  if (!r.modelUsed) {
    const n = el("div", "qa-banner");
    n.setAttribute("role", "note");
    n.appendChild(svg(ICON.info, 1.75));
    const t = el("div", "qa-banner-text");
    t.appendChild(el("strong", "", "Planned from templates: the model was not used."));
    if (r.modelNote) t.appendChild(el("span", "", " " + r.modelNote));
    n.appendChild(t);
    card.appendChild(n);
  }

  const chipsBox = el("div", "qa-target-chips");
  chipsBox.hidden = true;
  const changeTarget = () => {
    chipsBox.hidden = false;
    ctx.fillComposer && ctx.fillComposer("QA ", { onlyIfEmpty: true });
    chipsBox.querySelector("button")?.focus();
    ctx.say && ctx.say("Choose another target, or finish your message in the box");
  };
  if (r.assumption) {
    const a = el("div", "qa-assume");
    a.setAttribute("role", "note");
    const ic = el("span", "qa-assume-ic");
    ic.appendChild(svg(ICON.help, 1.75));
    const body = el("div", "qa-assume-body");
    body.appendChild(el("p", "qa-assume-text", r.assumption));
    if (r.correction) body.appendChild(el("p", "qa-assume-fix", r.correction));
    const change = button("qa-btn qa-btn-sm", "Change target", "target", changeTarget);
    a.append(ic, body, change);
    card.appendChild(a);
  }
  for (const c of targetChips(r)) {
    const b = el("button", "qa-pick", c.label);
    b.type = "button";
    b.setAttribute("data-action", chipAction(c).action);
    b.addEventListener("click", () => ctx.pickChip && ctx.pickChip(c, card));
    chipsBox.appendChild(b);
  }
  card.appendChild(chipsBox);

  if (r.summary) card.appendChild(el("p", "qa-summary", r.summary));

  const stats = el("ul", "qa-stats");
  stats.setAttribute("aria-label", "What was read");
  const stat = (n, w) => {
    const li = el("li", "qa-stat");
    li.append(el("strong", "", String(n)), el("span", "", w));
    stats.appendChild(li);
  };
  if (r.context.files) stat(r.context.files, r.context.files === 1 ? "file changed" : "files changed");
  if (r.context.areas) stat(r.context.areas, r.context.areas === 1 ? "area" : "areas");
  if (r.context.commits) stat(r.context.commits, r.context.commits === 1 ? "commit" : "commits");
  stat(r.cases.length, r.cases.length === 1 ? "test case" : "test cases");
  const counts = priorityCounts(r.cases);
  if (counts.P0) stat(counts.P0, "must pass first");
  card.appendChild(stats);

  // actions
  const acts = el("div", "qa-actions");
  acts.setAttribute("role", "group");
  acts.setAttribute("aria-label", "QA result actions");
  let checklist = null;
  const md = copyButton(() => toMarkdown(r, checklist && checklist.getChecked ? checklist.getChecked() : []), "Copy as Markdown", ctx);
  acts.appendChild(md);
  const pathBox = el("div", "qa-paths");
  pathBox.hidden = true;
  if (r.artifacts.markdownPath) {
    const open = button("qa-btn qa-btn-quiet", "Open report", "doc");
    open.addEventListener("click", async () => {
      let opened = false;
      try {
        opened = ctx.openReport ? await ctx.openReport(r.artifacts.markdownPath) : false;
      } catch {
        opened = false;
      }
      if (!opened) {
        pathBox.hidden = false;
        pathBox.focus();
      }
    });
    acts.appendChild(open);
    pathBox.tabIndex = -1;
    pathBox.appendChild(el("p", "qa-note", "The Reports list does not show this file. Here is where it is saved:"));
    pathBox.appendChild(pathRow("Markdown", r.artifacts.markdownPath, ctx));
    if (r.artifacts.jsonPath) pathBox.appendChild(pathRow("JSON", r.artifacts.jsonPath, ctx));
  } else acts.appendChild(el("span", "qa-muted qa-nofile", "No report file was written."));
  acts.appendChild(button("qa-btn qa-btn-quiet", "Re-run with a different target", "redo", changeTarget));
  card.append(acts, pathBox);

  if (r.risk.reasons.length) {
    const s = section("Why this risk", r.risk.reasons.length, nextId("qa-h"));
    s.appendChild(listOf(r.risk.reasons, false));
    s.classList.add("qa-risk-sec");
    card.appendChild(s);
  }
  if (r.areas.length) card.appendChild(areasSection(r));
  card.appendChild(casesSection(r, ctx));
  if (r.regressionChecklist.length) {
    checklist = checklistSection(r, ctx);
    card.appendChild(checklist);
  }
  if (r.evidence.uiChange || r.evidence.needed.length) card.appendChild(evidenceSection(r));
  if (r.checkCommands.length) card.appendChild(commandsSection(r, ctx));
  if (r.notCovered.length || r.questions.length) {
    const two = el("div", "qa-two");
    if (r.notCovered.length) {
      const s = section("Not covered", r.notCovered.length, nextId("qa-h"));
      s.appendChild(listOf(r.notCovered, false));
      two.appendChild(s);
    }
    if (r.questions.length) {
      const s = section("Open questions", r.questions.length, nextId("qa-h"));
      s.appendChild(listOf(r.questions, false));
      two.appendChild(s);
    }
    card.appendChild(two);
  }
  card.appendChild(journeysSection(r, ctx, isLatest));
  if (r.run) card.appendChild(runSection(r, ctx));
  const files = filesSection(r);
  if (files) card.appendChild(files);

  const foot = el("p", "qa-foot");
  const bits = [];
  if (r.backend && r.modelUsed) bits.push(`Planned with ${r.backend}`);
  if (r.timings.totalSeconds) bits.push(`${r.timings.totalSeconds} s in all${r.timings.designSeconds ? `, ${r.timings.designSeconds} s designing` : ""}`);
  bits.push("Read-only: AURA QA never changes the code, the database or the ERP.");
  foot.textContent = bits.join(" · ");
  card.appendChild(foot);
  return card;
}

/* ---------- needs input ---------- */

/** The question and its answer chips. `state` is {used, chosen} from usedChip() (or null for a live one). */
export function renderNeedsInput(ni, ctx, state) {
  const box = el("div", "qa-ask");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "QA needs one answer");
  const head = el("div", "qa-ask-head");
  const ic = el("span", "qa-ask-ic");
  ic.appendChild(svg(ICON.help, 1.75));
  head.append(ic, el("h3", "qa-ask-title", "QA needs one answer before it starts"));
  box.append(head, el("p", "qa-ask-q", ni.question));
  const chips = el("div", "qa-ask-chips");
  for (const o of ni.options) {
    const act = chipAction(o);
    const b = el("button", "qa-answer");
    b.type = "button";
    b.setAttribute("data-id", o.id);
    b.setAttribute("aria-pressed", "false");
    const label = el("span", "qa-answer-label", o.label);
    b.appendChild(label);
    if (act.action === "fill") {
      const more = el("span", "qa-answer-hint", "you finish it");
      b.appendChild(more);
    }
    b.addEventListener("click", () => {
      if (b.disabled) return;
      box.setAttribute("data-pending", o.id);
      for (const x of chips.children) x.setAttribute("aria-pressed", String(x === b));
      ctx.pickChip(o, box);
    });
    chips.appendChild(b);
  }
  box.appendChild(chips);
  box.appendChild(el("p", "qa-ask-hint", "Pick one, or type your own answer in the box below."));
  if (state && state.used) markAskUsed(box, state.chosen);
  return box;
}

/** After an answer is sent: chips are disabled and the chosen one is marked. */
export function markAskUsed(box, chosenId) {
  if (!box || box.getAttribute("data-used") === "1") return;
  box.setAttribute("data-used", "1");
  const chosen = chosenId || box.getAttribute("data-pending") || null;
  for (const b of box.querySelectorAll(".qa-answer")) {
    const mine = chosen !== null && b.getAttribute("data-id") === chosen;
    b.disabled = true;
    b.setAttribute("aria-pressed", String(mine));
    if (mine && !b.querySelector("svg")) b.prepend(svg(ICON.check, 2.4));
  }
  const hint = box.querySelector(".qa-ask-hint");
  if (hint) hint.textContent = chosen ? "Answered." : "This question was answered in a later message.";
}

/* ---------- confirm dialog ---------- */

/**
 * Plain confirm dialog for the journey run. Resolves true only when the person presses the run button.
 * Focus goes to Cancel first (the safe choice), Tab stays inside, Esc and a click outside cancel.
 */
export function confirmRun(qa, opener) {
  const r = safeResult(qa);
  const js = journeyState(r, true);
  return new Promise((resolve) => {
    const back = el("div", "qa-modal");
    const dlg = el("div", "qa-dialog");
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-modal", "true");
    const tid = nextId("qa-dlg-t");
    const did = nextId("qa-dlg-d");
    dlg.setAttribute("aria-labelledby", tid);
    dlg.setAttribute("aria-describedby", did);
    const title = el("h3", "qa-dlg-title", "Run read-only journeys?");
    title.id = tid;
    const desc = el("div", "qa-dlg-desc");
    desc.id = did;
    desc.appendChild(el("p", "", "AURA QA will attach to the app that is already running on this computer. It does not start the app."));
    const l = el("ul", "qa-list");
    for (const t of [
      "The journeys only look. They never save, create, send or delete anything.",
      "A safety guard stops a step that would change data.",
      "A step that fails is written down as a defect, and an incident note is proposed in the inbox for a person to review.",
    ]) l.appendChild(el("li", "", t));
    desc.appendChild(l);
    if (js.runnable.length) {
      desc.appendChild(el("p", "qa-dlg-sub", js.runnable.length === 1 ? "It will run this journey:" : `It will run these ${js.runnable.length} journeys:`));
      const jl = el("ul", "qa-list");
      for (const j of js.runnable) jl.appendChild(el("li", "", j.title || j.journeyId));
      desc.appendChild(jl);
    }
    if (js.blocked.length) desc.appendChild(el("p", "qa-muted", `${js.blocked.length} other ${js.blocked.length === 1 ? "journey is" : "journeys are"} blocked and will not run.`));
    const foot = el("div", "qa-dlg-foot");
    const cancel = button("qa-btn", "Cancel");
    const go = button("qa-btn qa-btn-primary", "Run read-only journeys", "play");
    foot.append(cancel, go);
    dlg.append(title, desc, foot);
    back.appendChild(dlg);
    const finish = (ok) => {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      if (opener && opener.isConnected) opener.focus();
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === "Tab") {
        const f = [cancel, go];
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? f.length - 1 : 1) + (i < 0 ? 0 : 0)) % f.length].focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => finish(false));
    go.addEventListener("click", () => finish(true));
    back.addEventListener("mousedown", (e) => {
      if (e.target === back) finish(false);
    });
    document.body.appendChild(back);
    cancel.focus();
  });
}

export { usedChip, CASE_TYPES, PRIORITY_NOTE };
