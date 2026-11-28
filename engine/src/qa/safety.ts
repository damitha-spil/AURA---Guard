// QA safety: what a test is NEVER allowed to do.
//
// HARD RULES (also in roles/qa-planner.yaml):
//  - Guard never writes into the Aura repo. Generated specs live in Guard's qa/generated/.
//  - A test only READS. It never saves, creates, submits, sends or deletes anything in the ERP or
//    outside the machine. The words that mean "commit something" are DATA in
//    qa/forbidden-actions.json (a company extends them in qa/forbidden-actions.local.json).
//  - This file is the static check (run on every spec before it runs) plus the matching helpers the
//    runtime guard in harness.ts uses. A spec that fails is never run.
//
// The static check is a scanner, not a full TypeScript parser. It fails closed: a click target it
// cannot trace to a visible name is rejected, so a spec must name what it clicks.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GUARD_ROOT } from "../config.ts";

export type SafetyTier = 0 | 1 | 2;

/** REO's window title. REO never controls a window or page that shows REO. */
export const OWN_WINDOW_TITLE = /\bSPIL[\s_-]*REO\b/i;

export interface ForbiddenList {
  /** Words and phrases an element name/text must not contain. `word*` matches a prefix. */
  names: string[];
  /** Regex sources tested against selector text and element attributes. */
  selectors: string[];
  /** Key combinations that commit something (normalised, lower case). */
  keys: string[];
  /** Hosts a test may talk to. Anything else is a remote host. */
  allowedHosts: string[];
  /** File uploads are only allowed from these folders (relative, forward slashes). */
  allowedUploadDirs: string[];
  /** Local-only sandbox UI actions allowed in Tier 1 when not on a Tier 2 screen. */
  tier1SafeNames?: string[];
  /** Hard-blocked ERP/destructive actions never permitted in any tier. */
  tier2HardBlockedNames?: string[];
  /** Screen contexts where interactive mutations (like "send") are always Tier 2 blocked. */
  tier2BlockedScreens?: string[];
}

export interface SafetyFinding {
  rule: string;
  line: number;
  message: string;
}

export interface SafetyResult {
  ok: boolean;
  findings: SafetyFinding[];
}

/** Safety limit: a spec bigger than this is not scanned or run (a runaway model reply). */
export const MAX_SPEC_BYTES = 200_000;

/** The only modules a spec may import. Anything else (child_process, http, fs) is rejected. */
const ALLOWED_IMPORTS = [/^playwright-core$/, /^(?:\.\.?\/)+helpers\/aura\.ts$/, /^node:path$/];

const EMPTY: ForbiddenList = { names: [], selectors: [], keys: [], allowedHosts: [], allowedUploadDirs: [] };

function readList(file: string): Partial<ForbiddenList> {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as Partial<ForbiddenList>;
}

/** Add `extra` to `base`. A company can only make the list longer, never shorter. */
export function extendForbidden(base: ForbiddenList, extra: Partial<ForbiddenList>): ForbiddenList {
  const merge = (a: string[], b: string[] | undefined) => [...new Set([...a, ...(b ?? [])])];
  const tier2HardBlockedNames = merge(base.tier2HardBlockedNames ?? [], extra.tier2HardBlockedNames);
  const blockedSet = new Set(tier2HardBlockedNames.map((s) => words(s).trim()));
  // tier1SafeNames can never override any Tier 2 hard-blocked phrase.
  const tier1SafeNames = (base.tier1SafeNames ?? []).filter((n) => !blockedSet.has(words(n).trim()));
  return {
    names: merge(base.names, extra.names),
    selectors: merge(base.selectors, extra.selectors),
    keys: merge(base.keys, extra.keys),
    allowedHosts: base.allowedHosts, // hosts are never widened by extra
    allowedUploadDirs: base.allowedUploadDirs,
    ...(tier1SafeNames.length ? { tier1SafeNames } : {}),
    ...(tier2HardBlockedNames.length ? { tier2HardBlockedNames } : {}),
    ...(merge(base.tier2BlockedScreens ?? [], extra.tier2BlockedScreens).length
      ? { tier2BlockedScreens: merge(base.tier2BlockedScreens ?? [], extra.tier2BlockedScreens) }
      : {}),
  };
}

/** Load qa/forbidden-actions.json and the optional qa/forbidden-actions.local.json. */
export function loadForbidden(root: string): ForbiddenList {
  // A root without the list gets the shipped one: an empty list would allow everything.
  const mine = join(root, "qa", "forbidden-actions.json");
  const base = { ...EMPTY, ...readList(existsSync(mine) ? mine : join(GUARD_ROOT, "qa", "forbidden-actions.json")) } as ForbiddenList;
  return extendForbidden(base, readList(join(root, "qa", "forbidden-actions.local.json")));
}

// ---------- matching helpers (shared with the runtime guard) ----------

/** Lower case, punctuation to single spaces, padded with one space on each side. */
export function words(s: string): string {
  return " " + s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
}

/** The first forbidden name found in `text`, or null. */
export function matchForbiddenText(text: string, list: ForbiddenList): string | null {
  return matchPhraseList(text, list.names);
}

function matchPhraseList(text: string, phrases: string[]): string | null {
  const w = words(text);
  for (const term of phrases) {
    const prefix = term.endsWith("*");
    const t = words(prefix ? term.slice(0, -1) : term).trimEnd();
    if (t && (prefix ? w.includes(t) : w.includes(t + " "))) return term;
  }
  return null;
}

export interface TierActionInfo {
  tag?: string;
  role?: string | null;
  type?: string | null;
  name?: string;
  text?: string;
  title?: string;
  value?: string;
  id?: string;
  testid?: string;
  submits?: boolean;
  control?: boolean;
}

export interface TierJudgment {
  allowed: boolean;
  tier: SafetyTier;
  reason: string | null;
}

/**
 * Tiered safety gate (0 = pure read, 1 = local interactive sandbox, 2 = hard-blocked mutation).
 * Tier 2 hard-blocked names, blocked screens, and forbidden selectors are always refused.
 */
export function judgeActionByTier(
  info: TierActionInfo,
  selectorText: string,
  list: ForbiddenList,
  opts: { tier: 0 | 1; screenContext?: string },
): TierJudgment {
  const text = info.text ?? "";
  const textIsLabel = info.control ? text.length <= 200 : text.length <= 40;
  const named: [string, string][] = [
    ["name", info.name ?? ""],
    ["title", info.title ?? ""],
    ["value", info.value ?? ""],
    ["id", info.id ?? ""],
    ["test id", info.testid ?? ""],
    ...(textIsLabel ? ([["text", text]] as [string, string][]) : []),
  ];

  const hardList = list.tier2HardBlockedNames ?? [];
  const blockedScreens = list.tier2BlockedScreens ?? [];
  const screenHit = opts.screenContext ? matchPhraseList(opts.screenContext, blockedScreens) : null;

  for (const [what, v] of named) {
    if (!v) continue;
    const hardHit = matchPhraseList(v, hardList);
    if (hardHit) {
      return { allowed: false, tier: 2, reason: `the element's ${what} ("${v.slice(0, 60)}") matches hard-blocked Tier 2 action "${hardHit}"` };
    }
    if (screenHit && words(v).includes(" send ")) {
      return { allowed: false, tier: 2, reason: `"send" is Tier 2 hard-blocked on "${screenHit}" screen` };
    }
  }

  if (matchForbiddenSelector(selectorText, list)) {
    return { allowed: false, tier: 2, reason: "the selector looks like a save, submit or delete control" };
  }
  if (info.submits && screenHit) {
    return { allowed: false, tier: 2, reason: `form submission is Tier 2 hard-blocked on "${screenHit}" screen` };
  }

  if (opts.tier === 0) {
    for (const [what, v] of named) {
      const hit = v ? matchForbiddenText(v, list) : null;
      if (hit) {
        return { allowed: false, tier: 0, reason: `the element's ${what} ("${v.slice(0, 60)}") matches forbidden word "${hit}"` };
      }
    }
    if (info.submits) return { allowed: false, tier: 0, reason: "the element would submit a form" };
    return { allowed: true, tier: 0, reason: null };
  }

  // Tier 1: allow configured local-sandbox safe actions when not on a Tier 2 screen or hard-blocked.
  const tier1Safe = list.tier1SafeNames ?? [];
  for (const [what, v] of named) {
    if (!v) continue;
    const hit = matchForbiddenText(v, list);
    if (!hit) continue;
    const isTier1Safe = !screenHit && matchPhraseList(v, tier1Safe) !== null && matchPhraseList(hit, tier1Safe) !== null;
    if (!isTier1Safe) {
      return { allowed: false, tier: 1, reason: `the element's ${what} ("${v.slice(0, 60)}") matches forbidden word "${hit}"` };
    }
  }
  if (info.submits && !screenHit) {
    // Only allow submits in Tier 1 if explicitly matched by a tier1Safe name (e.g. "send" in chat).
    const labelStr = named.map(([, v]) => v).join(" ");
    const safeSubmit = matchPhraseList(labelStr, tier1Safe) !== null;
    if (!safeSubmit) return { allowed: false, tier: 1, reason: "the element would submit a form" };
  }
  return { allowed: true, tier: 1, reason: null };
}

/** The first forbidden selector pattern found in `raw`, or null. */
export function matchForbiddenSelector(raw: string, list: ForbiddenList): string | null {
  for (const src of list.selectors) {
    if (new RegExp(src, "i").test(raw)) return src;
  }
  return null;
}

/** "Ctrl+S" and "control+s" and "S+Control" all become "control+s". */
export function normalizeKey(key: string): string {
  const parts = key.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const alias: Record<string, string> = { ctrl: "control", cmd: "meta", command: "meta", esc: "escape" };
  const mapped = parts.map((p) => alias[p] ?? p);
  const mods = new Set(["control", "meta", "alt", "shift"]);
  const mod = mapped.filter((p) => mods.has(p)).sort();
  const rest = mapped.filter((p) => !mods.has(p));
  return [...mod, ...rest].join("+");
}

export function isCommitKey(key: string, list: ForbiddenList): boolean {
  const k = normalizeKey(key);
  return list.keys.map(normalizeKey).includes(k);
}

/** The only keys a driver may send besides Enter in a search box: they move around and change nothing. */
const SAFE_KEYS = new Set(["tab", "shift+tab", "escape", "arrowup", "arrowdown", "arrowleft", "arrowright", "up", "down", "left", "right", "pageup", "pagedown", "home", "end"]);
export function isSafeKey(key: string): boolean {
  return SAFE_KEYS.has(normalizeKey(key));
}

/** Enter submits forms. It is only allowed in something that is clearly a search box. */
export function isEnterKey(key: string): boolean {
  const k = normalizeKey(key);
  return k === "enter" || k === "numpadenter" || k === "return";
}

export function isSearchTarget(text: string): boolean {
  return words(text).includes(" search ") || words(text).includes(" searchbox ");
}

export function isLocalHost(host: string, list: ForbiddenList): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return list.allowedHosts.map((x) => x.toLowerCase()).includes(h);
}

/** True when the url is a local one a test may read from. `ipc.localhost` (native commands) is never allowed. */
export function isLocalUrl(url: string, list: ForbiddenList): boolean {
  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase().startsWith("ipc.")) return false;
    return isLocalHost(u.hostname, list);
  } catch {
    return false;
  }
}

// ---------- the static scanner ----------

interface Lexed {
  clean: string;
  /** true where the character is inside a string or regex literal */
  lit: boolean[];
}

/** Blank out comments; mark string, template and regex literal characters. */
function lex(src: string): Lexed {
  const n = src.length;
  const out: string[] = new Array(n);
  const lit: boolean[] = new Array(n).fill(false);
  let i = 0;
  let prevSig = "";
  while (i < n) {
    const c = src[i] as string;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && d === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out[i] = src[i] === "\n" ? "\n" : " "; i++; }
      if (i < n) { out[i++] = " "; out[i++] = " "; }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out[i] = c; lit[i] = true; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < n) { out[i] = src[i] as string; lit[i] = true; i++; }
        out[i] = src[i] as string; lit[i] = true; i++;
      }
      if (i < n) { out[i] = q; lit[i] = true; i++; }
      prevSig = q;
      continue;
    }
    if (c === "/" && (prevSig === "" || "(,=:[!&|?{};".includes(prevSig))) {
      // regex literal
      out[i] = c; lit[i] = true; i++;
      let inClass = false;
      while (i < n && (src[i] !== "/" || inClass) && src[i] !== "\n") {
        if (src[i] === "\\" && i + 1 < n) { out[i] = src[i] as string; lit[i] = true; i++; }
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        out[i] = src[i] as string; lit[i] = true; i++;
      }
      if (i < n && src[i] === "/") { out[i] = "/"; lit[i] = true; i++; }
      while (i < n && /[a-z]/i.test(src[i] as string)) { out[i] = src[i] as string; lit[i] = true; i++; }
      prevSig = "/";
      continue;
    }
    out[i] = c;
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return { clean: out.join(""), lit };
}

const isIdent = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);
const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/** Index of the closer for the opener at `open`, skipping literals; -1 when unbalanced. */
function matchClose(lx: Lexed, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < lx.clean.length; i++) {
    if (lx.lit[i]) continue;
    const c = lx.clean[i] as string;
    if (pairs[c]) stack.push(pairs[c] as string);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Index of the opener for the closer at `close`, skipping literals; -1 when unbalanced. */
function matchOpen(lx: Lexed, close: number): number {
  const opens: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  for (let i = close; i >= 0; i--) {
    if (lx.lit[i]) continue;
    const c = lx.clean[i] as string;
    if (opens[c]) stack.push(opens[c] as string);
    else if (c === "(" || c === "[" || c === "{") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Start index of the receiver chain that ends just before the "." at `dot`. */
function receiverStart(lx: Lexed, dot: number): number {
  const s = lx.clean;
  let p = dot - 1;
  let start = dot;
  for (;;) {
    while (p >= 0 && isSpace(s[p])) p--;
    if (p >= 0 && (s[p] === ")" || s[p] === "]") && !lx.lit[p]) {
      const o = matchOpen(lx, p);
      if (o < 0) return start;
      start = o;
      p = o - 1;
      while (p >= 0 && isSpace(s[p])) p--;
      if (!isIdent(s[p])) {
        // e.g. `(await x).click()`: the group is the receiver
        return start;
      }
    }
    if (!isIdent(s[p])) return start;
    while (p >= 0 && isIdent(s[p])) p--;
    start = p + 1;
    while (p >= 0 && isSpace(s[p])) p--;
    if (s[p] === ".") {
      p--;
      if (s[p] === "?") p--;
      continue;
    }
    return start;
  }
}

/** The text of the expression `const NAME = <expr>;`, or null when NAME is not declared. */
function definitionOf(lx: Lexed, name: string): string | null {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\b\\s*(?::[^=;]+)?=`, "g");
  const m = re.exec(lx.clean);
  if (!m) return null;
  let i = m.index + m[0].length;
  const begin = i;
  let depth = 0;
  for (; i < lx.clean.length; i++) {
    if (lx.lit[i]) continue;
    const c = lx.clean[i] as string;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth <= 0) break;
    else if (c === "\n" && depth <= 0) {
      let j = i + 1;
      while (j < lx.clean.length && isSpace(lx.clean[j])) j++;
      if (lx.clean[j] !== ".") break;
    }
  }
  return lx.clean.slice(begin, i);
}

const PAGE_LIKE = new Set(["page", "frame"]);

/** Receiver text with variables replaced by what they were set to; marks an untraceable name. */
function traceTarget(lx: Lexed, recv: string): { text: string; unresolved: string | null } {
  let text = recv;
  let next = /^[A-Za-z_$][\w$]*/.exec(recv)?.[0];
  for (let depth = 0; next && depth < 4; depth++) {
    if (PAGE_LIKE.has(next)) return { text, unresolved: null };
    const def = definitionOf(lx, next);
    if (def === null) {
      // `page.keyboard`, `page.mouse` start with page and were handled above; anything else is unknown.
      return { text, unresolved: next };
    }
    text += " " + def;
    next = /^\s*([A-Za-z_$][\w$]*)/.exec(def)?.[1];
  }
  return { text, unresolved: null };
}

const lineOf = (src: string, idx: number): number => {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
};

/** Text of the first call argument starting at the "(" index, and all arguments. */
function callArgs(lx: Lexed, open: number): { first: string; all: string } {
  const close = matchClose(lx, open);
  const all = lx.clean.slice(open + 1, close < 0 ? undefined : close);
  let depth = 0;
  let end = all.length;
  for (let i = 0; i < all.length; i++) {
    const abs = open + 1 + i;
    if (lx.lit[abs]) continue;
    const c = all[i] as string;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) { end = i; break; }
  }
  return { first: all.slice(0, end), all };
}

const ACTIONS = [
  "click", "dblclick", "fill", "type", "pressSequentially", "press", "check", "uncheck", "setChecked",
  "tap", "selectOption", "setInputFiles", "dragTo", "dragAndDrop", "dispatchEvent", "clear",
];

/** Things that are never wanted in a read-only spec, in any form. */
const DANGEROUS: { re: RegExp; rule: string; message: string }[] = [
  { re: /__TAURI(?:_INTERNALS_|_IPC_)?__|\binvoke\s*\(|ipc\.localhost/, rule: "native-call", message: "calls Aura's native commands directly" },
  { re: /\.route\s*\(|routeFromHAR|\.fulfill\s*\(/, rule: "mock-api", message: "mocks the network; mock APIs are not evidence" },
  { re: /\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\bEventSource\b/, rule: "network", message: "opens its own network connection" },
  { re: /\beval\s*\(|new\s+Function\b/, rule: "dynamic-code", message: "runs dynamic code" },
  { re: /\.submit\s*\(|\brequestSubmit\b|\bdispatchEvent\b/, rule: "programmatic-submit", message: "submits or fires events by code" },
  { re: /\b(?:localStorage|sessionStorage|indexedDB)\b/, rule: "storage-write", message: "touches browser storage" },
  { re: /\bprocess\s*\.\s*(?:exit|kill|abort)\b/, rule: "process", message: "controls the process" },
];

/** Static check of one Playwright spec. Never throws. */
export function checkSpec(source: string, list: ForbiddenList): SafetyResult {
  const findings: SafetyFinding[] = [];
  const add = (rule: string, idx: number, message: string) => findings.push({ rule, line: lineOf(source, idx), message });
  if (Buffer.byteLength(source) > MAX_SPEC_BYTES) {
    add("too-big", 0, `the spec is larger than ${MAX_SPEC_BYTES} bytes`);
    return { ok: false, findings };
  }
  const lx = lex(source);
  const s = lx.clean;

  // imports: a short allow-list only
  for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/g)) {
    const spec = m[2] as string;
    if (!ALLOWED_IMPORTS.some((re) => re.test(spec))) add("import-not-allowed", m.index ?? 0, `imports "${spec}"; only playwright-core and ../helpers/aura.ts are allowed`);
  }

  for (const d of DANGEROUS) {
    const m = d.re.exec(s);
    if (m) add(d.rule, m.index, `${d.message} (${m[0].trim()})`);
  }

  // every URL in the file must be a local one
  for (const m of s.matchAll(/\b(?:https?|wss?|ftp):\/\/[^\s'"`)\\]+/gi)) {
    if (!isLocalUrl(m[0], list)) add("remote-host", m.index ?? 0, `talks to a non-local address: ${m[0].slice(0, 60)}`);
  }

  // fetch and page.request: local GET only
  for (const m of s.matchAll(/(?<![\w$.])fetch\s*\(|\.request\s*\.\s*(\w+)\s*\(/g)) {
    const idx = m.index ?? 0;
    const open = idx + m[0].length - 1;
    const verb = (m[1] ?? "get").toLowerCase();
    const a = callArgs(lx, open);
    if (!["get", "head"].includes(verb)) add("write-request", idx, `${verb.toUpperCase()} requests can change data; only local GET is allowed`);
    else if (!/^\s*["'`]/.test(a.first) || !(isLocalUrl(a.first.replace(/^\s*["'`]|["'`]\s*$/g, ""), list) || /^\s*["'`]\//.test(a.first))) {
      add("unverifiable-request", idx, "a request must use a literal local URL");
    } else if (/method\s*:\s*["'`](?!get|head)/i.test(a.all)) add("write-request", idx, "a request with a non-GET method");
  }

  // goto must be a literal
  for (const m of s.matchAll(/\.goto\s*\(/g)) {
    const a = callArgs(lx, (m.index ?? 0) + m[0].length - 1);
    if (!/^\s*["'`]/.test(a.first)) add("unverifiable-goto", m.index ?? 0, "page.goto needs a literal address");
  }

  // actions
  const re = new RegExp(`\\.\\s*(${ACTIONS.join("|")})\\s*\\(`, "g");
  for (const m of s.matchAll(re)) {
    const dot = m.index ?? 0;
    if (lx.lit[dot]) continue;
    const action = m[1] as string;
    const open = dot + m[0].length - 1;
    const start = receiverStart(lx, dot);
    const recv = s.slice(start, dot).trim();
    const a = callArgs(lx, open);

    if (/(^|\.)mouse$/.test(recv)) {
      add("mouse-click", dot, "coordinate clicks cannot be checked against a name; click a named element");
      continue;
    }
    const isKeyboard = /(^|\.)keyboard$/.test(recv);
    const pageLike = /^(?:page|frame)$/.test(recv);
    let targetText = "";
    if (!isKeyboard) {
      if (pageLike) targetText = a.first; // page.click("selector")
      else {
        const t = traceTarget(lx, recv);
        if (t.unresolved) {
          add("unverifiable-target", dot, `.${action}() on "${t.unresolved}", which is not a locator set earlier in the spec`);
          continue;
        }
        targetText = t.text;
      }
      const hit = matchForbiddenText(targetText, list);
      if (hit) add("forbidden-action", dot, `.${action}() on a target that matches the forbidden word "${hit}"`);
      const sel = matchForbiddenSelector(targetText, list);
      if (sel) add("forbidden-selector", dot, `.${action}() on a selector that looks like a submit or save control`);
    }

    if (action === "press" || action === "pressSequentially") {
      const keys = [...a.first.matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1] as string);
      if (keys.length === 0) add("unverifiable-key", dot, "press needs a literal key");
      for (const k of keys) {
        if (isCommitKey(k, list)) add("commit-key", dot, `the key ${k} commits or deletes`);
        else if (isEnterKey(k) && !isSearchTarget(targetText)) add("enter-may-submit", dot, "Enter can submit a form; use it only on a named search box");
      }
    }
    if (action === "type" && /\\n|\\r/.test(a.all)) add("enter-may-submit", dot, "typed text contains a line break");

    if (action === "setInputFiles") {
      const files = [...a.first.matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1] as string);
      const ok = files.length > 0 && files.every((f) => list.allowedUploadDirs.some((d) => f.replace(/\\/g, "/").replace(/^(\.\.?\/)+/, "").startsWith(d)));
      if (!ok) add("upload-outside-fixtures", dot, `file uploads must come from ${list.allowedUploadDirs.join(", ")}`);
    }
  }

  if (!/\bjourney\s*\(/.test(s)) add("no-journey", 0, "the spec does not call journey(...) from ../helpers/aura.ts");
  return { ok: findings.length === 0, findings };
}

/** One plain line per finding, for the CLI and for the retry prompt. */
export function describeFindings(findings: SafetyFinding[]): string[] {
  return findings.map((f) => `line ${f.line}: [${f.rule}] ${f.message}`);
}
