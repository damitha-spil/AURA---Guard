// Short chat titles from a first question. Pure: no DOM, importable in Node.

export const TITLE_MAX = 38;

/** "Why does the AI never get an ERP create tool?" -> "Why does the AI never get an ERP..." */
export function shortTitle(text, max = TITLE_MAX) {
  let t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "New chat";
  t = t.replace(/[?!.:;,\s]+$/, "");
  if (!t) return "New chat";
  if (t.length > max) {
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    t = (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "") + "...";
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/* ---------- chat list and chat screen helpers (pure, tested in Node) ---------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayNumber = (d) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
const validDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Whole local calendar days between `iso` and `now` (0 = today). null when the date is bad. */
export function daysAgo(iso, now = new Date()) {
  const d = validDate(iso);
  return d ? dayNumber(new Date(now)) - dayNumber(d) : null;
}

/** Chats grouped Today / Yesterday / Earlier by local date, newest first. Empty groups are left out. */
export function groupChats(chats, now = new Date()) {
  const sorted = [...(chats || [])].sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const groups = [
    { key: "today", label: "Today", chats: [] },
    { key: "yesterday", label: "Yesterday", chats: [] },
    { key: "earlier", label: "Earlier", chats: [] },
  ];
  for (const c of sorted) {
    const n = daysAgo(c.updated, now);
    groups[n !== null && n <= 0 ? 0 : n === 1 ? 1 : 2].chats.push(c);
  }
  return groups.filter((g) => g.chats.length);
}

/** "Just now", "5 min ago", "3 h ago", "Yesterday", "4 d ago", "Nov 3". Plain words, no clock digits. */
export function relativeTime(iso, now = new Date()) {
  const d = validDate(iso);
  if (!d) return "";
  const days = dayNumber(new Date(now)) - dayNumber(d);
  const mins = Math.floor((new Date(now).getTime() - d.getTime()) / 60000);
  if (days <= 0) return mins < 1 ? "Just now" : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ago`;
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} d ago`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** The search field only earns its place in a long list. */
export const CHAT_SEARCH_MIN = 8;
export const showChatSearch = (count) => count > CHAT_SEARCH_MIN;

export function filterChats(chats, query) {
  const q = String(query || "").trim().toLowerCase();
  return q ? (chats || []).filter((c) => String(c.title).toLowerCase().includes(q)) : chats || [];
}

/** Show work: what a click on the toggle sets, given the saved choice and the style's own default. */
export function currentWork(showWork, defaultLive) {
  return showWork === "on" ? true : showWork === "off" ? false : !!defaultLive;
}
export const flipWork = (showWork, defaultLive) => (currentWork(showWork, defaultLive) ? "off" : "on");

/** A plain title and the right actions for a failed answer. `message` is the text the server gave. */
export function errorInfo(message) {
  const m = String(message || "");
  if (/secret/i.test(m)) return { title: "Message not sent", retry: false };
  if (/stopped waiting/i.test(m)) return { title: "Stopped waiting", retry: true };
  if (/could not reach|did not arrive/i.test(m)) return { title: "Cannot reach AURA QA", retry: true };
  return { title: "AURA QA could not answer", retry: true };
}

/** Two letters for an avatar-less label: the first letter of the name, upper case. */
export const initialOf = (name) => (String(name || "").trim().charAt(0) || "?").toUpperCase();

/* ---------- project status and the first screen (pure, tested in Node) ----------
   The server sends facts (GET /api/project, /api/status, /api/suggestions); these helpers turn them
   into plain words and tolerate anything missing, so an older server never breaks the screen. */

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
/** An index older than this many days is called out of date. */
export const FRESH_DAYS = 7;

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const text = (v) => (typeof v === "string" ? v : "");
const stamp = (iso) => {
  if (iso === null || iso === undefined || iso === "") return null;
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
const plural = (n, one, many) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** "just now", "8 min ago", "3 h ago", "yesterday", "5 days ago", or "never". `now` is injectable. */
export function agoShort(iso, now = Date.now()) {
  const t = stamp(iso);
  if (t === null) return "never";
  const ms = Math.max(0, now - t);
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  const d = Math.floor(ms / DAY);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/**
 * How fresh an index is, in plain words.
 * {state:"never"|"fresh"|"stale", label (a sentence), short (for the sidebar pill)}.
 */
export function indexState(indexedAt, now = Date.now()) {
  const t = stamp(indexedAt);
  if (t === null) return { state: "never", label: "Not indexed yet", short: "never indexed" };
  const ago = agoShort(t, now);
  const days = Math.floor(Math.max(0, now - t) / DAY);
  if (days > FRESH_DAYS) return { state: "stale", label: `Indexed ${ago}. It is getting old.`, short: `index is ${days} days old` };
  return { state: "fresh", label: `Indexed ${ago}`, short: `indexed ${ago}` };
}

/** One row per repository for the popover, in plain words. Unknown fields are left out, never guessed. */
export function repoRows(repos, now = Date.now()) {
  if (!Array.isArray(repos)) return [];
  return repos
    .filter((r) => r && typeof r === "object")
    .map((r, i) => {
      const idx = indexState(r.indexedAt, now);
      const commits = stamp(r.lastCommitAt);
      return {
        key: text(r.id) || `repo-${i}`,
        label: text(r.label) || text(r.id) || "Repository",
        branch: text(r.branch),
        commitText: commits === null ? "No commits read yet" : `Last commit ${agoShort(commits, now)}`,
        indexText: idx.label,
        state: idx.state,
        commits: num(r.commits),
      };
    });
}

/**
 * Everything the sidebar pill and the popover need.
 * `status` is GET /api/status, `project` is GET /api/project (either may be null).
 * tone: "ok" | "warn" | "bad". The line is "Claude plan . indexed 8 min ago".
 */
export function statusSummary({ status, project, now = Date.now() } = {}) {
  const st = status && typeof status === "object" ? status : null;
  const pr = project && typeof project === "object" ? project : null;
  const backend = (st && st.backend) || null;
  const model = backend ? text(backend.label) || "No model" : "No model";
  const modelOk = !!(backend && backend.picked);
  const idxInfo = pr && pr.index && typeof pr.index === "object" ? pr.index : null;
  const index = idxInfo ? indexState(idxInfo.indexedAt, now) : null;
  const vault = pr && pr.vault && typeof pr.vault === "object" ? pr.vault : st && st.vault ? { notes: num(st.vault.notes), problems: num(st.vault.problems) } : null;
  const pending = pr && pr.inbox ? num(pr.inbox.pending) : null;
  const problems = vault ? num(vault.problems) : 0;
  let tone = "ok";
  if (!modelOk) tone = "bad";
  else if (index && index.state !== "fresh") tone = "warn";
  else if (!index && st && !st.index) tone = "warn";
  else if (problems) tone = "warn";
  const tail = index ? index.short : st ? (st.index ? `${num(st.index.note)} notes` : "no index") : "checking";
  const idx = idxInfo
    ? { commits: num(idxInfo.commits), files: num(idxInfo.files), notes: num(idxInfo.notes) }
    : st && st.index
      ? { commits: num(st.index.commit), files: num(st.index.file), notes: num(st.index.note) }
      : null;
  return {
    tone,
    model,
    modelOk,
    line: `${model} · ${tail}`,
    index,
    counts: idx,
    countsText: idx ? [plural(idx.commits, "commit", "commits"), plural(idx.files, "file", "files"), plural(idx.notes, "note", "notes")].join(" · ") : "Nothing indexed yet",
    vault: vault ? { notes: num(vault.notes), active: num(vault.active), proposed: num(vault.proposed), stale: num(vault.stale), problems } : null,
    vaultTone: problems ? "warn" : "ok",
    vaultText: problems ? `${plural(problems, "problem", "problems")} to fix in the vault` : "No problems in the vault",
    pending,
    pendingText: pending === null ? "" : pending === 0 ? "Nothing waiting for your review" : `${pending} ${pending === 1 ? "note needs" : "notes need"} your review`,
    repos: repoRows(pr && pr.repos, now),
    daily: pr && pr.lastDaily ? `Daily note ${agoShort(pr.lastDaily, now)}` : "",
    title: `${model}. ${index ? index.label : "Index unknown"}.`,
  };
}

/* ---------- first screen: suggestion cards ---------- */

const ICON_CYCLE = ["modules", "recent", "review", "draft"];
const ICON_BY_ID = { modules: "modules", recent: "recent", review: "review", unapproved: "draft", stale: "draft", changes: "recent", overview: "modules" };

/** Used when GET /api/suggestions fails or is empty. Neutral questions any SPIL AURA vault can answer. */
export const FALLBACK_SUGGESTIONS = [
  { id: "overview", icon: "modules", title: "How is SPIL AURA put together?", hint: "Its parts and what each one does", text: "How is SPIL AURA put together?" },
  { id: "recent", icon: "recent", title: "What changed recently?", hint: "Latest commits and notes", text: "What changed recently?" },
  { id: "review", icon: "review", title: "What needs my review?", hint: "Proposed notes waiting in the inbox", text: "What needs my review?" },
  { id: "unapproved", icon: "draft", title: "Which notes are still unapproved?", hint: "Drafts the answers handle with care", text: "Which notes are still unapproved?" },
];

/** The last card. It fills the box and waits: the person decides when to send. */
export const QA_CARD = { id: "qa-change", icon: "qa", title: "QA this change", hint: "Fills the box with the question. You press Send.", fill: "Can you QA the latest change?" };

/** Up to four valid cards from the server's list; the fallback when none are usable. */
export function normalizeSuggestions(raw) {
  const list = raw && Array.isArray(raw.suggestions) ? raw.suggestions : Array.isArray(raw) ? raw : [];
  const out = [];
  for (const s of list) {
    // The server may send plain question strings ("What is the rule: <title>?"): make a card of each.
    if (typeof s === "string") {
      const q = s.replace(/\s+/g, " ").trim().slice(0, 200);
      if (!q) continue;
      const m = q.match(/^what is the rule:\s*(.+?)\??$/i);
      out.push({ id: `s${out.length}`, icon: ICON_CYCLE[out.length % ICON_CYCLE.length], title: m ? m[1] : q, hint: m ? "A rule in the vault" : "", text: q });
      if (out.length === 4) break;
      continue;
    }
    if (!s || typeof s !== "object") continue;
    const title = text(s.title).trim();
    const send = text(s.text).trim() || title;
    if (!title || !send) continue;
    const id = text(s.id);
    out.push({ id: id || `s${out.length}`, icon: ICON_BY_ID[id] || ICON_CYCLE[out.length % ICON_CYCLE.length], title, hint: text(s.hint).trim(), text: send });
    if (out.length === 4) break;
  }
  return out.length ? out : FALLBACK_SUGGESTIONS.map((s) => ({ ...s }));
}

/** The cards to show: the question cards, then "QA this change" as the last one. */
export const suggestionCards = (raw) => [...normalizeSuggestions(raw), { ...QA_CARD }];
