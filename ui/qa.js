// QA agent: the pure part. No DOM, importable in Node (tests in engine/test/ui-qa.test.ts).
// Everything here works on the plain data the server sends (see docs/qa-agent.md). Nothing in this
// file builds HTML: the screen (qa-view.js) shows every model-produced string with textContent.

import { applyStep, workSteps, formatDuration } from "./steps.js";

export const QA_LABEL = "QA agent";
export const PRIORITIES = ["P0", "P1", "P2"];
export const PRIORITY_NOTE = { P0: "Must pass first", P1: "Should pass", P2: "Nice to check" };
export const CASE_TYPES = ["functional", "regression", "edge", "negative", "security", "accessibility", "performance", "data", "compat"];
export const TYPE_LABEL = {
  functional: "Functional", regression: "Regression", edge: "Edge", negative: "Negative", security: "Security",
  accessibility: "Accessibility", performance: "Performance", data: "Data", compat: "Compatibility",
};
/** Sub-commands of the old command runner. `/qa <anything else>` is a request to the QA agent. */
export const QA_SUBCOMMANDS = ["status", "plan", "generate", "check", "run", "agent"];
/** Steps in the order the server sends them, in plain words (used when a step has no label of its own). */
export const STEP_NAMES = {
  understand: "Understanding the request", target: "Working out what to QA", context: "Reading the change",
  design: "Designing the tests", safety: "Checking the journeys are safe", run: "Running read-only journeys", report: "Writing the QA result",
};
export const MAX_SHOWN_FILES = 60;

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, d = "") => (typeof v === "string" ? v : v == null ? d : String(v));
const strs = (v) => arr(v).map((x) => str(x)).filter((x) => x !== "");

/* ---------- routing ---------- */

/** `/qa free text` goes to the QA agent (mode "qa"); `/qa status|plan|...` and a bare `/qa` stay with the command runner. */
export function routeSlash(text) {
  const t = String(text ?? "").trim();
  if (!t.startsWith("/")) return { kind: "ask", text: t };
  const m = /^\/qa(?:\s+([\s\S]*))?$/i.exec(t);
  if (!m) return { kind: "command", text: t };
  const rest = (m[1] ?? "").trim();
  if (!rest) return { kind: "command", text: t };
  const first = rest.split(/\s+/)[0].toLowerCase();
  if (QA_SUBCOMMANDS.includes(first)) return { kind: "command", text: t };
  return { kind: "qa", text: rest };
}

/** The extra rows the slash menu shows for `/qa`. `insert` is what picking a row puts in the box. */
export function qaSlashItems(value, projectName) {
  const t = String(value ?? "").toLowerCase();
  const m = /^\/qa(\s+([\s\S]*))?$/.exec(t);
  if (!m) return [];
  const project = str(projectName).trim() || "SPIL AURA";
  const all = [
    { name: "qa-change", usage: "/qa this change", help: `QA the latest change in ${project}`, insert: "/qa this change" },
    { name: "qa-pr", usage: "/qa PR ...", help: "QA a pull request by its number", insert: "/qa PR " },
    { name: "qa-cases", usage: "/qa write test cases for ...", help: `Write test cases for a feature of ${project}`, insert: "/qa write test cases for " },
  ];
  const q = (m[2] ?? "").replace(/\s+/g, " ");
  return all.filter((c) => !q || c.insert.toLowerCase().replace(/^\/qa /, "").startsWith(q)).map((c) => ({ ...c, available: true }));
}

/** A chip sends its value, unless the value ends in a space: then the person finishes it in the box. */
export function chipAction(option) {
  const value = str(option && option.value);
  if (!value.trim()) return { action: "none", text: "" };
  return /\s$/.test(value) ? { action: "fill", text: value } : { action: "send", text: value };
}

/** Chips for "Change target", built only from what the result itself names. */
export function targetChips(result) {
  const r = safeResult(result);
  const chips = [];
  const repos = [...new Set(r.target.repos.map((x) => x.repo).filter(Boolean))];
  for (const repo of repos.slice(0, 3)) {
    chips.push({ id: "latest-" + repo, label: `Latest change in ${repo}`, value: `QA the latest change in ${repo}` });
    chips.push({ id: "last3-" + repo, label: `Last 3 commits in ${repo}`, value: `QA the last 3 commits in ${repo}` });
  }
  chips.push({ id: "pr", label: "A pull request", value: "QA PR " });
  chips.push({ id: "feature", label: "A feature or requirement", value: "QA this feature: " });
  return chips;
}

/* ---------- shapes: tolerant reading of a stored result ---------- */

const levelOf = (v) => (v === "high" || v === "medium" || v === "low" ? v : "low");

/** Defensive copy: every list is a list, every text is a string. A damaged result still renders. */
export function safeResult(qa) {
  const q = qa && typeof qa === "object" ? qa : {};
  const t = q.target && typeof q.target === "object" ? q.target : {};
  const offer = q.journeys && q.journeys.offer && typeof q.journeys.offer === "object" ? q.journeys.offer : {};
  const run = q.run && typeof q.run === "object" ? q.run : null;
  const ctx = q.context && typeof q.context === "object" ? q.context : {};
  return {
    id: str(q.id), generatedAt: str(q.generatedAt), request: str(q.request), summary: str(q.summary),
    // The server keeps the old key for the project name in a QA result; it is read once, here.
      project: { id: str(q.department && q.department.id), name: str(q.department && q.department.name) },
    assumption: q.assumption ? str(q.assumption) : null, correction: q.correction ? str(q.correction) : null,
    target: {
      kind: str(t.kind), label: str(t.label, "the change"), fromConversation: !!t.fromConversation, description: t.description ? str(t.description) : null,
      pr: t.pr && typeof t.pr === "object" ? { id: t.pr.id, title: str(t.pr.title), status: str(t.pr.status), repo: str(t.pr.repo) } : null,
      repos: arr(t.repos).map((r) => ({ repo: str(r && r.repo), range: str(r && r.range), commits: Number(r && r.commits) || 0 })),
      skipped: strs(t.skipped),
    },
    risk: { level: levelOf(q.risk && q.risk.level), reasons: strs(q.risk && q.risk.reasons) },
    areas: arr(q.areas).map((a) => ({ name: str(a && a.name), why: str(a && a.why), risk: levelOf(a && a.risk) })),
    cases: arr(q.cases).map((c, i) => safeCase(c, i)),
    regressionChecklist: strs(q.regressionChecklist), notCovered: strs(q.notCovered), questions: strs(q.questions),
    evidence: { uiChange: !!(q.evidence && q.evidence.uiChange), needed: strs(q.evidence && q.evidence.needed) },
    checkCommands: arr(q.checkCommands).map((c) => (typeof c === "string" ? { command: c, source: "", approved: false } : { command: str(c && c.command), source: str(c && c.source), approved: !!(c && c.approved) })).filter((c) => c.command),
    journeys: {
      available: Number(q.journeys && q.journeys.available) || 0,
      offer: {
        runnable: arr(offer.runnable).map((j) => ({ journeyId: str(j && j.journeyId), title: str(j && j.title), specPath: str(j && j.specPath), caseIds: strs(j && j.caseIds) })),
        blocked: arr(offer.blocked).map((b) => ({ journeyId: str(b && b.journeyId), reason: str(b && b.reason) })),
        targetReachable: offer.targetReachable === true ? true : offer.targetReachable === false ? false : null,
        note: str(offer.note),
        safety: { checked: Number(offer.safety && offer.safety.checked) || 0, passed: Number(offer.safety && offer.safety.passed) || 0 },
      },
    },
    run: run && {
      status: str(run.status, "blocked"),
      runs: arr(run.runs).map((x) => ({ journeyId: str(x && x.journeyId), status: str(x && x.status), reportPath: x && x.reportPath ? str(x.reportPath) : null, defects: Number(x && x.defects) || 0, blocker: x && x.blocker ? str(x.blocker) : null })),
      defects: arr(run.defects).map((d) => ({ journeyId: str(d && d.journeyId), step: str(d && d.step), width: typeof (d && d.width) === "number" ? d.width : null, expected: str(d && d.expected), actual: str(d && d.actual), screenshot: d && d.screenshot ? str(d.screenshot) : null })),
      proposedIncidents: Number(run.proposedIncidents) || 0,
    },
    context: {
      files: Number(ctx.files) || 0, areas: Number(ctx.areas) || 0, commits: Number(ctx.commits) || 0, dependents: Number(ctx.dependents) || 0, notes: Number(ctx.notes) || 0,
      changedFiles: arr(ctx.changedFiles).map((f) => ({ repo: str(f && f.repo), path: str(f && f.path), category: str(f && f.category) })).filter((f) => f.path),
    },
    artifacts: { markdownPath: q.artifacts && q.artifacts.markdownPath ? str(q.artifacts.markdownPath) : null, jsonPath: q.artifacts && q.artifacts.jsonPath ? str(q.artifacts.jsonPath) : null },
    modelUsed: q.modelUsed !== false, modelNote: str(q.modelNote), backend: q.backend ? str(q.backend) : null,
    timings: { designSeconds: Number(q.timings && q.timings.designSeconds) || 0, totalSeconds: Number(q.timings && q.timings.totalSeconds) || 0 },
  };
}

function safeCase(c, i) {
  const o = c && typeof c === "object" ? c : {};
  return {
    id: str(o.id) || `TC-${i + 1}`, title: str(o.title, "Untitled case"),
    type: CASE_TYPES.includes(o.type) ? o.type : "functional", priority: PRIORITIES.includes(o.priority) ? o.priority : "P2",
    cites: strs(o.cites), preconditions: strs(o.preconditions), steps: strs(o.steps), expected: strs(o.expected),
    data: o.data ? str(o.data) : "", automatable: !!o.automatable, journeyId: o.journeyId ? str(o.journeyId) : "",
  };
}

/* ---------- risk, cases, filters ---------- */

const RISK = {
  low: { label: "Low risk", word: "Low", icon: "shield" },
  medium: { label: "Medium risk", word: "Medium", icon: "alert" },
  high: { label: "High risk", word: "High", icon: "flame" },
};
/** Plain words, a level key (the CSS maps it to a token) and an icon key, so risk never relies on colour alone. */
export function riskInfo(level) {
  const l = levelOf(level);
  return { level: l, ...RISK[l] };
}

/** Cases sorted by priority (P0 first), then in the order the plan gave them. Groups with no case are left out. */
export function groupByPriority(cases) {
  const list = arr(cases).map((c, i) => ({ c, i }));
  const groups = [];
  for (const p of PRIORITIES) {
    const items = list.filter((x) => x.c.priority === p).sort((a, b) => a.i - b.i).map((x) => x.c);
    if (items.length) groups.push({ priority: p, note: PRIORITY_NOTE[p], cases: items });
  }
  return groups;
}

/** @param {{priority?: string, type?: string}} f  "all" or empty means no filter */
export function filterCases(cases, f = {}) {
  const p = f.priority && f.priority !== "all" ? f.priority : null;
  const t = f.type && f.type !== "all" ? f.type : null;
  return arr(cases).filter((c) => (!p || c.priority === p) && (!t || c.type === t));
}

export function priorityCounts(cases) {
  const out = { all: arr(cases).length, P0: 0, P1: 0, P2: 0 };
  for (const c of arr(cases)) if (out[c.priority] !== undefined) out[c.priority]++;
  return out;
}

/** The types that really occur, in a fixed order, with their counts (after the priority filter, so a chip never leads to an empty list). */
export function typeCounts(cases, priority) {
  const base = filterCases(cases, { priority });
  return CASE_TYPES.map((type) => ({ type, count: base.filter((c) => c.type === type).length })).filter((x) => x.count > 0);
}

export function caseCountText(shown, total) {
  return shown === total ? `${total} ${total === 1 ? "case" : "cases"}` : `${shown} of ${total} cases`;
}

/* ---------- plain-word helpers ---------- */

export function generatedText(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const same = d.toDateString() === new Date(now).toDateString();
  return same ? `Today ${hh}` : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hh}`;
}

/** The words under a running step. A design step can take a minute on a big change. */
export function progressNote(stepId, elapsedMs) {
  const s = Math.max(0, Math.floor((elapsedMs || 0) / 1000));
  if (stepId !== "design") return s >= 20 ? `Still working, ${s} s so far.` : "";
  if (s < 6) return "";
  if (s < 25) return `${s} s so far. Designing tests for a change can take up to a minute.`;
  return `${s} s so far. Still designing: a big change can take more than a minute. Nothing is stuck. You can stop waiting; the result is saved in this chat if it finishes.`;
}

/** A coarse bucket so the screen reader hears an update every 15 s, not every second. */
export const announceBucket = (elapsedMs) => Math.floor((elapsedMs || 0) / 15000);

/** "QA agent worked for 42 s - 6 steps" (middle dot). */
export function qaSummary(steps, totalMs) {
  const n = workSteps(steps).length;
  return `${QA_LABEL} worked for ${formatDuration(totalMs) || "under 1 s"} · ${n} ${n === 1 ? "step" : "steps"}`;
}

/** Total time of a QA turn: the result's own timing when it has one, else the sum of the steps. */
export function qaTotalMs(steps, qa) {
  const t = qa && qa.timings && Number(qa.timings.totalSeconds);
  if (t > 0) return t * 1000;
  return arr(steps).reduce((n, s) => n + (typeof (s && s.ms) === "number" ? s.ms : 0), 0);
}

export const stepName = (s) => str(s && s.label) || STEP_NAMES[s && s.id] || "Working";

/** Is a stored message from the QA agent? */
export function isQaMessage(m) {
  return !!(m && (m.qa || m.needsInput || arr(m.trace).some((t) => t && t.agent === "qa")));
}

/** Title and retry for a failed QA turn. A blocked message (a secret in the text) is not retried. */
export function qaErrorInfo(message, kind) {
  const m = str(message);
  if (kind === "blocked" || /secret/i.test(m)) return { title: "Message not sent", retry: false };
  if (/stopped waiting/i.test(m)) return { title: "Stopped waiting", retry: true };
  if (/no qa result in this chat/i.test(m)) return { title: "Nothing to run yet", retry: false };
  return { title: "QA agent could not finish", retry: true };
}

/** Which chip was used: chips are used once a later message exists; the chosen one is the one whose value was sent. */
export function usedChip(needsInput, laterUserText) {
  if (laterUserText == null) return { used: false, chosen: null };
  const t = str(laterUserText).trim();
  const hit = t ? arr(needsInput && needsInput.options).find((o) => str(o.value).trim() === t) : null;
  return { used: true, chosen: hit ? hit.id : null };
}

/** What the journeys section can offer. Running needs a confirm click; this only says what is possible. */
export function journeyState(result, isLatest) {
  const r = safeResult(result);
  const o = r.journeys.offer;
  return {
    hasRun: !!r.run,
    canRun: !!isLatest && !r.run && o.runnable.length > 0,
    runnable: o.runnable, blocked: o.blocked, note: o.note, targetReachable: o.targetReachable,
    none: !r.run && o.runnable.length === 0 && o.blocked.length === 0 && !o.note,
    needsApp: o.targetReachable === false,
  };
}

/** The request body for a confirmed run. The server reads the stored result from the chat. Sent only after the person confirms. */
export function runBody() {
  return { question: "Run the read-only journeys for this QA result", runJourneys: true };
}

/* ---------- checklist memory (per result id, never throws) ---------- */

export const checklistKey = (id) => `guard.qa.checklist.${str(id)}`;

export function loadChecklist(storage, id, length) {
  try {
    const raw = storage && storage.getItem(checklistKey(id));
    const v = raw ? JSON.parse(raw) : null;
    if (Array.isArray(v)) return Array.from({ length }, (_, i) => v[i] === true);
  } catch {
    /* storage blocked or damaged: start unchecked */
  }
  return Array.from({ length }, () => false);
}

/** @returns {boolean} true when it was saved */
export function saveChecklist(storage, id, checked) {
  try {
    if (!storage) return false;
    storage.setItem(checklistKey(id), JSON.stringify(arr(checked).map((x) => x === true)));
    return true;
  } catch {
    return false;
  }
}

/* ---------- events -> state (the reducer) ---------- */

export function qaInitial() {
  return { active: false, label: QA_LABEL, agentState: null, steps: [], result: null, needsInput: null, answer: null, sources: [], error: null, errorKind: null, chat: null, startedAt: 0 };
}

/** Applies one ndjson event. Pure: a new object each time. Events the QA part does not know are ignored. */
export function reduceQaEvent(state, ev, now = Date.now()) {
  if (!ev || typeof ev !== "object") return state;
  switch (ev.type) {
    case "agent":
      if (ev.agent !== "qa") return state;
      return { ...state, active: true, label: str(ev.label, QA_LABEL), agentState: ev.state === "done" || ev.state === "error" ? ev.state : "started", startedAt: state.startedAt || now };
    case "step":
      if (!ev.step || typeof ev.step !== "object") return state;
      if (ev.step.agent !== "qa" && !state.active) return state;
      return { ...state, active: true, steps: applyStep(state.steps, ev.step, now) };
    case "qa":
      return ev.result && typeof ev.result === "object" ? { ...state, active: true, result: ev.result } : state;
    case "needs-input":
      return { ...state, active: true, needsInput: { question: str(ev.question), options: arr(ev.options).map((o) => ({ id: str(o && o.id), label: str(o && o.label), value: str(o && o.value) })).filter((o) => o.label) } };
    case "answer":
      return { ...state, answer: str(ev.text), sources: arr(ev.sources), chat: ev.chat || state.chat, error: null };
    case "error":
      return { ...state, error: str(ev.message, "The QA agent could not finish."), errorKind: ev.kind || null, chat: ev.chat || state.chat };
    default:
      return state;
  }
}

/** The same state from the plain JSON reply (an old server, or a client that did not ask for a stream). */
export function qaFromJson(j) {
  let s = qaInitial();
  if (!j || j.agent !== "qa") return s;
  s = reduceQaEvent(s, { type: "agent", agent: "qa", label: QA_LABEL, state: j.ok ? "done" : "error" });
  for (const step of arr(j.trace)) s = reduceQaEvent(s, { type: "step", step: { agent: "qa", ...step } });
  if (j.qa) s = reduceQaEvent(s, { type: "qa", result: j.qa });
  if (j.needsInput) s = reduceQaEvent(s, { type: "needs-input", question: j.needsInput.question, options: j.needsInput.options });
  s = reduceQaEvent(s, j.ok === false ? { type: "error", message: j.text, kind: j.error, chat: j.chat } : { type: "answer", text: j.text, sources: j.sources, chat: j.chat });
  return s;
}

/* ---------- Markdown export ---------- */

/** One line of ordinary text for Markdown: no line breaks, and the characters that would change the layout are escaped. */
export function mdText(s) {
  return str(s).replace(/\s*[\r\n]+\s*/g, " ").trim().replace(/([\\`|*_<>[\]])/g, "\\$1");
}
/** Inline code: the fence is longer than any backtick run inside, so nothing can break out of it. */
export function mdCode(s) {
  const t = str(s).replace(/\s*[\r\n]+\s*/g, " ").trim();
  const runs = t.match(/`+/g) || [];
  const n = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const fence = "`".repeat(n + 1);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}
const cell = (s) => mdText(s).replace(/\|/g, "\\|");

/** The whole result as readable Markdown. `checked` (optional) marks checklist items. */
export function toMarkdown(result, checked = []) {
  const r = safeResult(result);
  const L = [];
  const risk = riskInfo(r.risk.level);
  L.push(`# QA result: ${mdText(r.target.label)}`, "");
  L.push([r.project.name ? `Project: ${mdText(r.project.name)}` : "", `Risk: ${risk.label}`, r.generatedAt ? `Generated: ${mdText(r.generatedAt)}` : ""].filter(Boolean).join(" · "), "");
  if (!r.modelUsed) L.push(`> Planned from templates: the model was not used.${r.modelNote ? " " + mdText(r.modelNote) : ""}`, "");
  if (r.assumption) L.push(`> Assumption: ${mdText(r.assumption)}${r.correction ? " " + mdText(r.correction) : ""}`, "");
  if (r.summary) L.push(mdText(r.summary), "");
  if (r.risk.reasons.length) L.push("## Risk reasons", "", ...r.risk.reasons.map((x) => `- ${mdText(x)}`), "");
  if (r.areas.length) L.push("## Areas", "", ...r.areas.map((a) => `- **${mdText(a.name)}** (${riskInfo(a.risk).label.toLowerCase()}): ${mdText(a.why)}`), "");
  if (r.cases.length) {
    L.push("## Test cases", "", "| ID | Priority | Type | Title |", "| --- | --- | --- | --- |");
    for (const c of r.cases) L.push(`| ${cell(c.id)} | ${c.priority} | ${TYPE_LABEL[c.type]} | ${cell(c.title)} |`);
    L.push("");
    for (const g of groupByPriority(r.cases)) {
      L.push(`### ${g.priority}: ${g.note}`, "");
      for (const c of g.cases) {
        L.push(`#### ${mdText(c.id)}: ${mdText(c.title)}`, "", `${TYPE_LABEL[c.type]}${c.automatable ? ", can be automated" : ""}${c.journeyId ? `, journey ${mdCode(c.journeyId)}` : ""}`, "");
        if (c.cites.length) L.push(`Cites: ${c.cites.map(mdCode).join(", ")}`, "");
        if (c.preconditions.length) L.push("Preconditions:", ...c.preconditions.map((x) => `- ${mdText(x)}`), "");
        if (c.steps.length) L.push("Steps:", ...c.steps.map((x, i) => `${i + 1}. ${mdText(x)}`), "");
        if (c.expected.length) L.push("Expected:", ...c.expected.map((x) => `- ${mdText(x)}`), "");
        if (c.data) L.push(`Data: ${mdText(c.data)}`, "");
      }
    }
  }
  if (r.regressionChecklist.length) L.push("## Regression checklist", "", ...r.regressionChecklist.map((x, i) => `- [${checked[i] === true ? "x" : " "}] ${mdText(x)}`), "");
  if (r.evidence.uiChange || r.evidence.needed.length) {
    L.push("## Evidence needed", "");
    if (r.evidence.uiChange) L.push("- Real-app screenshots at 800, 1100 and 1440 px, and a walkthrough video");
    L.push(...r.evidence.needed.map((x) => `- ${mdText(x)}`), "");
  }
  if (r.checkCommands.length) L.push("## Check commands", "", "AURA QA never runs these. Run them yourself.", "", ...r.checkCommands.map((c) => `- ${mdCode(c.command)}`), "");
  if (r.notCovered.length) L.push("## Not covered", "", ...r.notCovered.map((x) => `- ${mdText(x)}`), "");
  if (r.questions.length) L.push("## Questions", "", ...r.questions.map((x) => `- ${mdText(x)}`), "");
  if (r.run) {
    L.push("## Journey run", "", `Result: ${mdText(r.run.status)}`, "");
    for (const x of r.run.runs) L.push(`- ${mdCode(x.journeyId)}: ${mdText(x.status)}, ${x.defects} ${x.defects === 1 ? "defect" : "defects"}${x.blocker ? `, blocked: ${mdText(x.blocker)}` : ""}`);
    for (const d of r.run.defects) L.push(`- Defect in ${mdCode(d.journeyId)} at ${mdText(d.step)}${d.width ? ` (${d.width} px)` : ""}: expected ${mdText(d.expected)}; got ${mdText(d.actual)}${d.screenshot ? `; evidence ${mdCode(d.screenshot)}` : ""}`);
    if (r.run.proposedIncidents) L.push(`- ${r.run.proposedIncidents} incident ${r.run.proposedIncidents === 1 ? "note" : "notes"} proposed in the inbox`);
    L.push("");
  }
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Suffix match of a result's report file against the Reports list (paths are relative there). */
export function findReportPath(markdownPath, reports) {
  const full = str(markdownPath).replace(/\\/g, "/");
  if (!full) return null;
  const hit = arr(reports).map((r) => str(r && r.path)).filter(Boolean).sort((a, b) => b.length - a.length).find((p) => full === p || full.endsWith("/" + p));
  return hit || null;
}

/** Computes a deterministic Evaluation Scorecard and Release Gate verdict from a QA result. */
export function computeScorecard(qa) {
  const r = safeResult(qa);
  const counts = priorityCounts(r.cases);
  const safetyChecked = r.journeys.offer.safety.checked;
  const safetyPassed = r.journeys.offer.safety.passed;
  const defectsCount = r.run ? r.run.defects.length : 0;
  const runStatus = r.run ? r.run.status : "planned";
  const totalRuns = r.run ? r.run.runs.length : 0;
  const passedRuns = r.run ? r.run.runs.filter((x) => x.status === "passed").length : 0;
  const passRate = totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : null;

  let gate = "pass";
  let gateReason = "All checked journeys and safety gates passed.";
  if (runStatus === "rejected" || (safetyChecked > 0 && safetyPassed < safetyChecked)) {
    gate = "block";
    gateReason = "Safety gate failed on one or more journey specs.";
  } else if (defectsCount > 0 || runStatus === "failed") {
    gate = "block";
    gateReason = `${defectsCount} defect${defectsCount === 1 ? "" : "s"} recorded during journey execution.`;
  } else if (r.risk.level === "high" && totalRuns === 0) {
    gate = "warn";
    gateReason = "High-risk change has no executed browser journeys yet.";
  } else if (runStatus === "blocked") {
    gate = "warn";
    gateReason = "Journey execution was blocked; manual verification required.";
  } else if (totalRuns === 0) {
    gate = "warn";
    gateReason = `${r.cases.length} cases designed; no live journey run recorded.`;
  }
  return { totalCases: r.cases.length, counts, safetyChecked, safetyPassed, runStatus, defectsCount, passRate, gate, gateReason };
}

/** Groups defects by journeyId for root-cause inspection. */
export function groupDefects(defects) {
  const by = new Map();
  for (const d of arr(defects)) {
    const j = str(d && (d.journeyId ?? d.journey), "unknown");
    if (!by.has(j)) by.set(j, []);
    by.get(j).push(d);
  }
  return [...by.entries()].map(([journey, items]) => ({ journey, items }));
}
