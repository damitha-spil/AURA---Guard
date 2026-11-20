// QA harness: attach to an Aura the owner already started, wrap the page so it cannot commit
// anything, and record steps. Specs import this through qa/helpers/aura.ts.
//
// HARD RULES: never launch Aura, never run cargo, never write into the Aura repo. We only attach over
// CDP to a WebView the owner started with a debugging port (AURA_CDP_URL). The runtime guard below
// re-checks every click/fill/press target against qa/forbidden-actions.json and throws BEFORE acting.

import type { Browser, Locator, Page } from "playwright-core";
import {
  isCommitKey, isEnterKey, isLocalUrl, isSearchTarget, matchForbiddenSelector, matchForbiddenText,
} from "./safety.ts";
import type { ForbiddenList } from "./safety.ts";

export const CDP_ENV = "AURA_CDP_URL";
/** The environment variable the owner sets when starting Aura so its WebView opens a debugging port. */
export const WEBVIEW_ARGS_ENV = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
export const DEFAULT_WIDTHS = [800, 1100, 1440];

/** Safety limit: how long one wait for an element may take before the step fails. */
export const STEP_WAIT_MS = 5_000;
/** Safety limit: how long the CDP endpoint check waits, so a closed port reports quickly. */
export const CDP_CHECK_MS = 3_000;

export class ForbiddenActionError extends Error {
  readonly action: string;
  constructor(action: string, reason: string) {
    super(`Blocked before acting: ${action} ${reason}. Tests only read; they never save, create, submit, send or delete.`);
    this.name = "ForbiddenActionError";
    this.action = action;
  }
}

// ---------- the runtime guard ----------

export interface ElementInfo {
  tag?: string;
  role?: string | null;
  type?: string | null;
  name?: string;
  text?: string;
  title?: string;
  value?: string;
  id?: string;
  testid?: string;
  /** true when clicking would submit a form */
  submits?: boolean;
  control?: boolean;
}

/** Runs inside the page. A string, so this file needs no DOM types. Read-only. */
export const DESCRIBE_ELEMENT = `(el) => {
  const clip = (s) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, 200);
  const role = el.getAttribute("role");
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute("type");
  const control = ["button", "a", "input", "select", "summary", "textarea"].includes(tag) ||
    ["button", "link", "menuitem", "tab", "checkbox", "switch", "option", "menuitemcheckbox"].includes(role || "");
  let name = clip(el.getAttribute("aria-label"));
  const lb = el.getAttribute("aria-labelledby");
  if (!name && lb) name = clip(lb.split(/\\s+/).map((i) => { const e = document.getElementById(i); return e ? e.textContent : ""; }).join(" "));
  const form = el.closest ? el.closest("form") : null;
  const isSubmitInput = tag === "input" && (type === "submit" || type === "image");
  const isButton = tag === "button";
  const submits = isSubmitInput || (isButton && (type === "submit" || (type === null && !!form)));
  return {
    tag, role, type, name,
    text: clip(el.innerText || el.textContent),
    title: clip(el.getAttribute("title")),
    value: tag === "input" && ["submit", "button", "reset", "image"].includes(type || "") ? clip(el.value) : "",
    id: clip(el.id), testid: clip(el.getAttribute("data-testid")), submits, control,
  };
}`;

/** Why an element must not be acted on, or null when it is fine. Pure, so it can be tested. */
export function judgeElement(info: ElementInfo, selectorText: string, list: ForbiddenList): string | null {
  const text = info.text ?? "";
  // A long block of text is a container, not a label. Only short text, or a control's text, names an action.
  const textIsLabel = info.control ? text.length <= 200 : text.length <= 40;
  const named: [string, string][] = [
    ["name", info.name ?? ""], ["title", info.title ?? ""], ["value", info.value ?? ""],
    ["id", info.id ?? ""], ["test id", info.testid ?? ""], ...(textIsLabel ? ([["text", text]] as [string, string][]) : []),
  ];
  for (const [what, v] of named) {
    const hit = v ? matchForbiddenText(v, list) : null;
    if (hit) return `the element's ${what} ("${v.slice(0, 60)}") matches the forbidden word "${hit}"`;
  }
  const sel = matchForbiddenSelector(selectorText, list);
  if (sel) return "the selector looks like a save, submit or delete control";
  if (info.submits) return "the element would submit a form";
  return null;
}

type Guardable = Record<string | symbol, unknown>;
const GUARDED_LOCATOR_ACTIONS = new Set([
  "click", "dblclick", "fill", "type", "pressSequentially", "press", "check", "uncheck", "setChecked",
  "tap", "selectOption", "setInputFiles", "dragTo", "dispatchEvent", "clear",
]);
const PAGE_SELECTOR_ACTIONS = new Set(["click", "dblclick", "fill", "type", "press", "check", "uncheck", "setChecked", "tap", "selectOption", "setInputFiles", "dispatchEvent", "dragAndDrop"]);
const COMMIT_IN_PAGE_CODE = /\.(?:submit|requestSubmit|dispatchEvent)\s*\(|\bfetch\s*\(|XMLHttpRequest|sendBeacon|__TAURI|\binvoke\s*\(|\.click\s*\(/;

const looksLikeLocator = (v: unknown): v is Locator =>
  typeof v === "object" && v !== null && typeof (v as Guardable).click === "function" && typeof (v as Guardable).evaluate === "function";

/** Wrap a locator: its actions look at the real element first. Read-only calls pass straight through. */
function guardLocator(loc: Locator, list: ForbiddenList): Locator {
  return new Proxy(loc as unknown as Guardable, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      const name = String(prop);
      if (GUARDED_LOCATOR_ACTIONS.has(name)) {
        return async (...args: unknown[]) => {
          await assertSafeTarget(target as unknown as Locator, name, list);
          if (name === "press" || name === "pressSequentially") assertKey(String(args[0] ?? ""), name, list, String(target));
          if (name === "setInputFiles") throw new ForbiddenActionError("setInputFiles", "is not allowed at run time; uploads are not part of read-only tests");
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (name === "evaluate" || name === "evaluateAll" || name === "evaluateHandle") {
        return (...args: unknown[]) => {
          assertPageCode(args[0], name);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (...args: unknown[]) => {
        const r = (v as (...a: unknown[]) => unknown).apply(target, args);
        return looksLikeLocator(r) ? guardLocator(r, list) : r;
      };
    },
  }) as unknown as Locator;
}

async function assertSafeTarget(loc: Locator, action: string, list: ForbiddenList): Promise<void> {
  let info: ElementInfo;
  try {
    info = (await loc.evaluate(DESCRIBE_ELEMENT as unknown as (e: never) => ElementInfo, undefined, { timeout: STEP_WAIT_MS })) as ElementInfo;
  } catch (e) {
    // Fail closed: if the target cannot be inspected it cannot be proven safe.
    throw new ForbiddenActionError(action, `on a target that could not be inspected (${(e as Error).message.split("\n")[0]})`);
  }
  const why = judgeElement(info, String(loc), list);
  if (why) throw new ForbiddenActionError(action, `because ${why}`);
}

function assertKey(key: string, action: string, list: ForbiddenList, targetText: string): void {
  if (isCommitKey(key, list)) throw new ForbiddenActionError(action, `with ${key}, which commits or deletes`);
  if (isEnterKey(key) && !isSearchTarget(targetText)) throw new ForbiddenActionError(action, "with Enter outside a named search box, because Enter can submit a form");
}

function assertPageCode(fn: unknown, action: string): void {
  const src = typeof fn === "function" ? Function.prototype.toString.call(fn) : String(fn ?? "");
  const m = COMMIT_IN_PAGE_CODE.exec(src);
  if (m) throw new ForbiddenActionError(action, `with page code that contains "${m[0].trim()}"`);
}

const LOCATOR_FACTORIES = new Set([
  "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTitle", "getByTestId", "getByAltText", "locator", "frameLocator",
]);

/**
 * Wrap a Playwright page so a test cannot commit anything. `click`, `fill`, `press` and the rest
 * re-check the target's accessible name against the forbidden list and throw before acting.
 * Raw network, routing and coordinate clicks are refused outright.
 */
export function guardPage(page: Page, list: ForbiddenList): Page {
  const kb = ((page as unknown as Guardable).keyboard ?? {}) as Guardable;
  const keyboard = new Proxy(kb, {
    get(t, p) {
      const v = t[p];
      if (typeof v !== "function") return v;
      const name = String(p);
      return async (...args: unknown[]) => {
        if (name === "press") assertKey(String(args[0] ?? ""), "keyboard.press", list, "");
        if (name === "type" || name === "insertText") {
          if (/[\r\n]/.test(String(args[0] ?? ""))) throw new ForbiddenActionError("keyboard.type", "with a line break, which can submit a form");
        }
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  const refuse = (what: string, why: string) => () => { throw new ForbiddenActionError(what, why); };
  return new Proxy(page as unknown as Guardable, {
    get(target, prop) {
      const name = String(prop);
      const v = target[prop];
      if (name === "keyboard") return keyboard;
      if (name === "mouse") {
        return new Proxy({}, { get: (_t, p) => (["move", "wheel"].includes(String(p)) ? (target.mouse as Guardable)[p] : refuse(`mouse.${String(p)}`, "because a coordinate cannot be checked against a name")) });
      }
      if (name === "request") return refuse("page.request", "because tests do not make their own requests");
      if (name === "route" || name === "routeFromHAR" || name === "unroute") return refuse(`page.${name}`, "because mocking the network is not evidence");
      if (name === "context") return () => { throw new ForbiddenActionError("page.context", "because a test works on the page it was given"); };
      if (name === "goto") {
        return (url: string, ...rest: unknown[]) => {
          if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !isLocalUrl(url, list)) throw new ForbiddenActionError("page.goto", `to a non-local address (${url.slice(0, 60)})`);
          return (v as (...a: unknown[]) => unknown).apply(target, [url, ...rest]);
        };
      }
      if (typeof v !== "function") return v;
      if (LOCATOR_FACTORIES.has(name)) {
        return (...args: unknown[]) => {
          const r = (v as (...a: unknown[]) => unknown).apply(target, args);
          return looksLikeLocator(r) ? guardLocator(r, list) : r;
        };
      }
      if (PAGE_SELECTOR_ACTIONS.has(name)) {
        return async (selector: string, ...rest: unknown[]) => {
          const loc = (target.locator as (s: string) => Locator).call(target, selector);
          await assertSafeTarget(loc, `page.${name}`, list);
          if (name === "press") assertKey(String(rest[0] ?? ""), `page.${name}`, list, selector);
          if (name === "setInputFiles") throw new ForbiddenActionError("page.setInputFiles", "is not allowed at run time");
          return (v as (...a: unknown[]) => unknown).apply(target, [selector, ...rest]);
        };
      }
      if (name === "evaluate" || name === "evaluateHandle" || name === "addScriptTag" || name === "addInitScript" || name === "exposeFunction") {
        return (...args: unknown[]) => {
          if (name !== "evaluate" && name !== "evaluateHandle") throw new ForbiddenActionError(`page.${name}`, "because tests do not inject scripts");
          assertPageCode(args[0], `page.${name}`);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (...args: unknown[]) => (v as (...a: unknown[]) => unknown).apply(target, args);
    },
  }) as unknown as Page;
}

// ---------- journeys and steps ----------

export interface StepRecord {
  n: number;
  width: number | null;
  title: string;
  expected: string;
  status: "passed" | "failed";
  ms: number;
  screenshot?: string;
  error?: string;
}

export interface Recorder {
  shot: (label: string) => Promise<string | undefined>;
  record: (s: StepRecord) => void;
  width: number | null;
}

export interface JourneyContext {
  /** The guarded page. Use roles and visible words (from Aura's copy.ts), never CSS paths. */
  page: Page;
  /** One numbered step. A screenshot is taken after it. `expected` is the plain-language result. */
  step: (title: string, fn: () => Promise<void>, expected?: string) => Promise<void>;
  /** Fails the step unless the locator is visible within STEP_WAIT_MS. */
  visible: (loc: Locator, what: string) => Promise<void>;
  /** Fails the step unless the locator's text matches. */
  hasText: (loc: Locator, expected: string | RegExp, what: string) => Promise<void>;
  /** Fails the step unless the condition holds. */
  ok: (cond: boolean, message: string) => void;
  /** The width this run emulates, or null when the window's own size is used. */
  width: number | null;
}

export type JourneyFn = (ctx: JourneyContext) => Promise<void>;

const registry = new Map<string, JourneyFn>();

/** Register a journey. A spec file calls this once; the runner then runs it. */
export function journey(id: string, fn: JourneyFn): void {
  registry.set(id, fn);
}
export function registeredJourneys(): Map<string, JourneyFn> {
  return registry;
}

export class StepFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepFailed";
  }
}

export function makeContext(page: Page, rec: Recorder): JourneyContext {
  let n = 0;
  return {
    page,
    width: rec.width,
    async step(title, fn, expected) {
      n++;
      const t0 = Date.now();
      try {
        await fn();
        const shot = await rec.shot(`${String(n).padStart(2, "0")}-${title}`);
        rec.record({ n, width: rec.width, title, expected: expected ?? title, status: "passed", ms: Date.now() - t0, ...(shot ? { screenshot: shot } : {}) });
      } catch (e) {
        const shot = await rec.shot(`${String(n).padStart(2, "0")}-FAILED-${title}`).catch(() => undefined);
        const msg = (e as Error).message.split("\n").slice(0, 3).join(" ");
        rec.record({ n, width: rec.width, title, expected: expected ?? title, status: "failed", ms: Date.now() - t0, error: msg, ...(shot ? { screenshot: shot } : {}) });
        throw new StepFailed(msg);
      }
    },
    async visible(loc, what) {
      try {
        await loc.first().waitFor({ state: "visible", timeout: STEP_WAIT_MS });
      } catch {
        throw new Error(`Expected ${what} to be visible, but it did not appear within ${STEP_WAIT_MS / 1000} s.`);
      }
    },
    async hasText(loc, expected, what) {
      const actual = (await loc.first().innerText({ timeout: STEP_WAIT_MS })).trim();
      const good = typeof expected === "string" ? actual.includes(expected) : expected.test(actual);
      if (!good) throw new Error(`Expected ${what} to show ${String(expected)}, but it shows "${actual.slice(0, 80)}".`);
    },
    ok(cond, message) {
      if (!cond) throw new Error(message);
    },
  };
}

// ---------- attaching ----------

export class CdpUnreachable extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "CdpUnreachable";
  }
}

/** Plain steps the owner follows to give Aura a debugging port. */
export function cdpHowTo(url = "http://127.0.0.1:9222"): string[] {
  const port = /:(\d+)/.exec(url)?.[1] ?? "9222";
  return [
    "Close Aura if it is running, then start it again from a shell where this is set first:",
    `  PowerShell:  $env:${WEBVIEW_ARGS_ENV} = "--remote-debugging-port=${port}"`,
    "  then start Aura the usual way (for example `cargo tauri dev` in the Aura folder, or the installed app from that same shell).",
    `In the shell where you run Guard, set:  $env:${CDP_ENV} = "http://127.0.0.1:${port}"`,
    "Use the QA or local test database you normally use. Guard never changes Aura's settings and never starts Aura.",
  ];
}

/** Loopback only: a debugging port on another machine is never used. */
export function assertLoopback(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new CdpUnreachable(`${CDP_ENV} is not a valid address: ${url}`); }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname)) {
    throw new CdpUnreachable(`${CDP_ENV} must point at this computer (127.0.0.1 or localhost), not ${u.hostname}.`);
  }
  return u;
}

/** Ask the debugging port who it is. Returns the browser string, or throws CdpUnreachable. */
export async function probeCdp(url: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const u = assertLoopback(url);
  try {
    const res = await fetchFn(new URL("/json/version", u), { signal: AbortSignal.timeout(CDP_CHECK_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { Browser?: string };
    return j.Browser ?? "unknown browser";
  } catch (e) {
    throw new CdpUnreachable(`Nothing answered at ${u.origin} (${(e as Error).message}).`);
  }
}

export interface Attached {
  browser: Browser;
  page: Page;
  /** Disconnect. Does not close Aura (assumption for connectOverCDP; see the report). */
  detach: () => Promise<void>;
}

/** Pick Aura's own page: its title or address, else the first page that is not DevTools. */
export function pickAuraPage(pages: Page[]): Page | undefined {
  const real = pages.filter((p) => !p.url().startsWith("devtools://"));
  return (
    real.find((p) => /tauri\.localhost|127\.0\.0\.1:1420|localhost:1420/.test(p.url())) ??
    real.find((p) => p.url().startsWith("http") || p.url().startsWith("tauri:")) ??
    real[0]
  );
}

/** Attach over CDP to the Aura the owner started. Never launches anything. */
export async function attachAura(url: string): Promise<Attached> {
  await probeCdp(url);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(url, { timeout: 10_000 });
  const pages = browser.contexts().flatMap((c) => c.pages());
  const page = pickAuraPage(pages);
  if (!page) {
    await browser.close().catch(() => undefined);
    throw new CdpUnreachable(`Connected to ${url} but found no Aura window. Is Aura's main window open?`);
  }
  return { browser, page, detach: () => browser.close() };
}
