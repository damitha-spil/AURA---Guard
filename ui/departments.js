// Pure department logic: ids, tree edits, validation, health labels, templates, landing helpers.
// No DOM and no network, so Node tests can import it. Tree edits never change their input.

export const ROLE_INFO = [
  { key: "scribe", name: "Scribe diary", text: "Writes a short diary note after each work session." },
  { key: "reviewer", name: "Reviewer", text: "Checks changes against the rules and past decisions." },
  { key: "refactor", name: "Refactor advisor", text: "Suggests cleanups, never makes them." },
  { key: "qa", name: "QA planner", text: "Drafts test plans for a change." },
  { key: "rules", name: "Rules", text: "Keeps the written rules and checks code against them." },
  { key: "prs", name: "PR learning", text: "Learns from review comments on past pull requests." },
  { key: "supportWriter", name: "Support writer", text: "Drafts help text for customer support, for human review." },
  { key: "quiz", name: "Quiz", text: "Asks questions to test how well the knowledge answers." },
  { key: "daily", name: "Daily routine", text: "Runs the daily refresh and writes the daily report." },
];
export const ROLE_KEYS = ROLE_INFO.map((r) => r.key);

function pickRoles(on) {
  const o = {};
  for (const k of ROLE_KEYS) o[k] = on.includes(k);
  return o;
}

export const FALLBACK_TEMPLATES = [
  { id: "engineering", name: "Engineering", description: "A team that writes code in git repositories.", hint: "Add repositories as sources. Reviews, QA plans and rules are on.", roles: pickRoles(["scribe", "reviewer", "refactor", "qa", "rules", "prs", "quiz", "daily"]) },
  { id: "knowledge", name: "Knowledge", description: "A team that keeps documents, not code.", hint: "Add document folders as sources. Only notes and questions are on.", roles: pickRoles(["scribe", "rules", "quiz", "daily"]) },
  { id: "support", name: "Support", description: "A team that answers customers.", hint: "Add help documents. The support writer is on.", roles: pickRoles(["scribe", "supportWriter", "quiz", "daily"]) },
  { id: "analysis", name: "Analysis", description: "A team that studies requirements and data.", hint: "Add document folders and repositories. Rules and QA plans are on.", roles: pickRoles(["scribe", "qa", "rules", "quiz", "daily"]) },
  { id: "custom", name: "Custom", description: "Start empty and choose everything yourself.", hint: "Every role is off until you turn it on.", roles: pickRoles([]) },
];

// Department colours are names (the registry only accepts these); the screens turn them into a swatch.
export const COLOR_HEX = { blue: "#2f7de1", green: "#1f9d6b", orange: "#d9822b", rose: "#c2415a", violet: "#7b5cd6", teal: "#0e9aa7", amber: "#c99a1b", slate: "#5b6573" };
export const COLORS = Object.keys(COLOR_HEX);
export const DEFAULT_COLOR = "blue";
export const isColor = (c) => typeof c === "string" && Object.prototype.hasOwnProperty.call(COLOR_HEX, c);
/** The swatch colour for a name, or a neutral grey when there is none. */
export const colorHex = (c) => (isColor(c) ? COLOR_HEX[c] : "#8a8f98");

/** Roles for a template; templates from the server win over the built-in fallback. */
export function templateRoles(id, templates) {
  const list = Array.isArray(templates) && templates.length ? templates : FALLBACK_TEMPLATES;
  const t = list.find((x) => x.id === id) || FALLBACK_TEMPLATES.find((x) => x.id === id) || FALLBACK_TEMPLATES[FALLBACK_TEMPLATES.length - 1];
  const out = pickRoles([]);
  const src = t && t.roles && typeof t.roles === "object" && !Array.isArray(t.roles) ? t.roles : {};
  for (const k of ROLE_KEYS) out[k] = !!src[k];
  if (t && Array.isArray(t.roles)) for (const k of t.roles) if (k in out) out[k] = true;
  return out;
}

/* ---------- ids ---------- */
export const MAX_ID = 40;
export function slug(text) {
  const s = String(text ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_ID).replace(/-+$/, "");
  return s || "item";
}
/** A slug not in `taken` (array or Set): "shape", "shape-2", "shape-3". */
export function uniqueId(text, taken) {
  const set = taken instanceof Set ? taken : new Set(taken || []);
  let base = slug(text);
  if (base.length < 2) base += "-1"; // ids are at least two characters
  if (!set.has(base)) return base;
  let n = 2;
  while (set.has(`${base}-${n}`.slice(-MAX_ID))) n++;
  return `${base}-${n}`.slice(-MAX_ID);
}

function sourcesOf(d) {
  const out = [...(d.sources || [])];
  for (const m of d.modules || []) {
    out.push(...(m.sources || []));
    for (const s of m.subModules || []) out.push(...(s.sources || []));
  }
  return out;
}
export const flatSources = sourcesOf;
export const countSources = (d) => sourcesOf(d).length;

/** Every module, sub-module and source id in the department. Ids are unique across all three. */
export function allIds(dept) {
  const ids = (dept.sources || []).map((s) => s.id);
  for (const m of dept.modules || []) {
    ids.push(m.id);
    ids.push(...(m.sources || []).map((s) => s.id));
    for (const s of m.subModules || []) {
      ids.push(s.id);
      ids.push(...(s.sources || []).map((x) => x.id));
    }
  }
  return ids;
}
const clone = (d) => JSON.parse(JSON.stringify(d));
const text = (s) => String(s ?? "").trim();

/* ---------- tree edits ---------- */
export function emptyDepartment() {
  return { id: "", name: "", description: "", owner: "", template: "engineering", color: DEFAULT_COLOR, roles: pickRoles([]), modules: [], sources: [] };
}

export function addModule(dept, name) {
  const d = clone(dept);
  const n = text(name);
  if (!n) return d;
  d.modules = d.modules || [];
  d.modules.push({ id: uniqueId(n, allIds(d)), name: n, subModules: [], sources: [] });
  return d;
}
export function addSubModule(dept, moduleId, name) {
  const d = clone(dept);
  const m = (d.modules || []).find((x) => x.id === moduleId);
  const n = text(name);
  if (!m || !n) return d;
  m.subModules = m.subModules || [];
  m.subModules.push({ id: uniqueId(n, allIds(d)), name: n, sources: [] });
  return d;
}
/** Renames a module or sub-module. The id stays the same, so links to it keep working. */
export function renameNode(dept, id, name) {
  const d = clone(dept);
  const n = text(name);
  if (!n) return d;
  for (const m of d.modules || []) {
    if (m.id === id) m.name = n;
    for (const s of m.subModules || []) if (s.id === id) s.name = n;
  }
  return d;
}
export function removeNode(dept, id) {
  const d = clone(dept);
  d.modules = (d.modules || []).filter((m) => m.id !== id);
  for (const m of d.modules) m.subModules = (m.subModules || []).filter((s) => s.id !== id);
  return d;
}
/** target: {} (department), {moduleId}, or {moduleId, subId}. */
function sourceList(d, target) {
  const t = target || {};
  const m = t.moduleId ? (d.modules || []).find((x) => x.id === t.moduleId) : null;
  if (t.moduleId && !m) return null;
  if (m && t.subId) {
    const s = (m.subModules || []).find((x) => x.id === t.subId);
    if (!s) return null;
    return (s.sources = s.sources || []);
  }
  if (m) return (m.sources = m.sources || []);
  return (d.sources = d.sources || []);
}
export function labelFromPath(path) {
  const parts = text(path).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || "Source";
}
export function addSource(dept, target, src) {
  const d = clone(dept);
  const list = sourceList(d, target);
  if (!list) return d;
  const label = text(src.label) || labelFromPath(src.path);
  const s = { id: uniqueId(label, allIds(d)), kind: src.kind === "docs" ? "docs" : "git", label, path: text(src.path) };
  if (text(src.branch)) s.branch = text(src.branch);
  if (text(src.remoteHint)) s.remoteHint = text(src.remoteHint);
  list.push(s);
  return d;
}
export function updateSource(dept, id, patch) {
  const d = clone(dept);
  for (const s of sourcesOf(d)) if (s.id === id) Object.assign(s, patch, { id });
  return d;
}
export function removeSource(dept, id) {
  const d = clone(dept);
  d.sources = (d.sources || []).filter((s) => s.id !== id);
  for (const m of d.modules || []) {
    m.sources = (m.sources || []).filter((s) => s.id !== id);
    for (const s of m.subModules || []) s.sources = (s.sources || []).filter((x) => x.id !== id);
  }
  return d;
}

/* ---------- validation ---------- */
/** Returns "" when the path is an absolute local path, otherwise a plain sentence. */
export function validatePath(path) {
  const p = String(path ?? "").trim();
  if (!p) return "Enter a folder path.";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return "That is a web address. Use a folder on this computer.";
  if (/^\\\\|^\/\//.test(p)) return "Network (UNC) paths are not allowed. Use a folder on this computer.";
  if (/[\u0000-\u001f]/.test(p)) return "The path has characters that are not allowed.";
  const win = /^[a-zA-Z]:[\\/]/.test(p);
  if (!win && !p.startsWith("/")) return "Use a full path, for example D:\\Projects\\Aura.";
  if (p.split(/[\\/]+/).some((seg) => seg === "..")) return "A path may not contain \"..\".";
  return "";
}
export function validateName(name) {
  const n = text(name);
  if (!n) return "Enter a name.";
  if (n.length > 80) return "Keep the name under 80 characters.";
  return "";
}
/** All problems with a department, as plain sentences. Empty array means it can be saved. */
export function validateDepartment(d) {
  const errs = [];
  const nameErr = validateName(d.name);
  if (nameErr) errs.push(nameErr);
  const seen = new Set();
  const dup = new Set();
  for (const id of allIds(d)) (seen.has(id) ? dup : seen).add(id);
  for (const id of dup) errs.push(`The id "${id}" is used twice. Rename one of them.`);
  for (const m of d.modules || []) {
    if (!text(m.name)) errs.push("A module has no name.");
    for (const s of m.subModules || []) if (!text(s.name)) errs.push("A sub-module has no name.");
  }
  for (const s of sourcesOf(d)) {
    const e = validatePath(s.path);
    if (e) errs.push(`Source "${s.label || s.id}": ${e}`);
  }
  if (d.color && !isColor(d.color)) errs.push("Pick a colour from the list.");
  return errs;
}

/* ---------- health ---------- */
export const FRESH_DAYS = 7;
const DAY = 86400000;
/** {state:"never"|"fresh"|"stale", label, days}. `now` is injectable. */
export function indexAge(indexedAt, now = Date.now()) {
  if (!indexedAt) return { state: "never", label: "Never indexed", days: null };
  const t = typeof indexedAt === "number" ? indexedAt : Date.parse(indexedAt);
  if (Number.isNaN(t)) return { state: "never", label: "Never indexed", days: null };
  const n = typeof now === "number" ? now : now.getTime();
  const days = Math.max(0, Math.floor((n - t) / DAY));
  const label = days === 0 ? "Indexed today" : days === 1 ? "Indexed yesterday" : `Indexed ${days} days ago`;
  return { state: days > FRESH_DAYS ? "stale" : "fresh", label, days };
}
export function ago(iso, now = Date.now()) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const days = Math.floor((now - t) / DAY);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}
export const needsSources = (dept) => !!(dept.health && dept.health.needsSources) || (dept.counts ? dept.counts.sources === 0 : false);

/** One short health state for a tile: {tone:"ok"|"warn"|"bad", label}. */
export function tileHealth(dept, now = Date.now()) {
  const h = dept.health || {};
  if (needsSources(dept)) return { tone: "bad", label: "Needs sources" };
  const age = indexAge(h.indexedAt, now);
  if (age.state === "never") return { tone: "warn", label: "Not indexed" };
  if (age.state === "stale") return { tone: "warn", label: "Stale index" };
  if (h.inbox > 0) return { tone: "ok", label: `${h.inbox} in inbox` };
  return { tone: "ok", label: "Fresh" };
}
/** Counts across departments for the summary strip. */
export function summarizeAll(list, now = Date.now()) {
  const s = { departments: 0, modules: 0, subModules: 0, sources: 0, inbox: 0, needSources: 0, stale: 0, problems: 0 };
  for (const d of list || []) {
    if (d.archived) continue;
    s.departments++;
    s.modules += (d.counts && d.counts.modules) || 0;
    s.subModules += (d.counts && d.counts.subModules) || 0;
    s.sources += (d.counts && d.counts.sources) || 0;
    s.inbox += (d.health && d.health.inbox) || 0;
    s.problems += (d.health && d.health.problems) || 0;
    if (needsSources(d)) s.needSources++;
    if (indexAge(d.health && d.health.indexedAt, now).state === "stale") s.stale++;
  }
  return s;
}

/* ---------- landing ---------- */
export const LAST_KEY = "guard.lastDepartment";
export function loadLast(storage) {
  try {
    const v = storage && storage.getItem(LAST_KEY);
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}
export function saveLast(storage, id) {
  try {
    storage.setItem(LAST_KEY, String(id));
    return true;
  } catch {
    return false;
  }
}
export const activeDepartments = (list) => (list || []).filter((d) => !d.archived);
/** The shortcut target: the remembered department if it still exists and is not archived. */
export function continueTarget(list, lastId) {
  return activeDepartments(list).find((d) => d.id === lastId) || null;
}
/** Narrows departments by name, id, description, owner and module names (`moduleNames`, if given). */
export function filterDepartments(list, query) {
  const q = String(query ?? "").trim().toLowerCase();
  const act = activeDepartments(list);
  if (!q) return act;
  const words = q.split(/\s+/);
  return act.filter((d) => {
    const hay = [d.name, d.id, d.description, d.owner, ...(d.moduleNames || [])].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
/** Keys "1".."9" open the first nine visible tiles. Returns the department or null. */
export function numberKeyTarget(key, visible) {
  if (!/^[1-9]$/.test(String(key))) return null;
  return (visible || [])[Number(key) - 1] || null;
}
/** Arrow movement in `count` tiles laid out in `cols` columns. Returns the new index, -1 when empty. */
export function moveIndex(index, key, count, cols = 1) {
  if (!count) return -1;
  let i = index < 0 ? 0 : index;
  if (key === "ArrowRight") i += 1;
  else if (key === "ArrowLeft") i -= 1;
  else if (key === "ArrowDown") i += cols;
  else if (key === "ArrowUp") i -= cols;
  else if (key === "Home") i = 0;
  else if (key === "End") i = count - 1;
  return Math.min(count - 1, Math.max(0, i));
}
/** "empty" (first run), "one", or "many": what the landing page shows. */
export function landingMode(list) {
  const n = activeDepartments(list).length;
  return n === 0 ? "empty" : n === 1 ? "one" : "many";
}

/* ---------- saving with an etag ---------- */
/** Turns an API reply into what the screen does next. */
export function classifySave(res) {
  if (res && res.ok) return { kind: "ok" };
  if (res && res.status === 409) return { kind: "conflict", message: "Someone else changed this department. It was reloaded, so please make your change again." };
  return { kind: "error", message: (res && res.data && res.data.error) || "That change could not be saved." };
}
