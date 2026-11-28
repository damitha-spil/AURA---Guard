// Unified Hybrid AuraDriver: combines Cua Driver (background UIA + PrintWindow + set_window_frame)
// with optional Playwright WebView2 CDP (ARIA snapshots, DOM layout/form metrics, console/pageerror tap).
// Every mutating action is checked by judgeActionByTier BEFORE execution.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { GuardConfig } from "../types.ts";
import type { CuaClient, CuaTreeNode, CuaWindowInfo } from "./cua_client.ts";
import { flattenTree, judgeTargetWindow, nodeToElementInfo } from "./cua_harness.ts";
import { DESCRIBE_ELEMENT, ForbiddenActionError, STEP_WAIT_MS } from "./harness.ts";
import type { ElementInfo } from "./harness.ts";
import type { ConsoleEvent, FormButtonInfo, LayoutMetrics, NetworkEvent } from "./oracles.ts";
import { isCommitKey, isEnterKey, isSafeKey, isSearchTarget, judgeActionByTier } from "./safety.ts";
import type { ForbiddenList } from "./safety.ts";

/** Fallback window height when neither CDP nor Cua specifies one. */
const DEFAULT_FRAME_HEIGHT = 760;

export type TelemetryMode = "hybrid" | "cua-only" | "cdp-only";

export interface ObservedControl {
  name: string;
  role: string;
  token?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  safeTier: 0 | 1 | 2;
}

export interface DriverObservation {
  telemetryMode: TelemetryMode;
  width: number;
  visibleText: string;
  ariaSnapshot: string;
  controls: ObservedControl[];
  screenshotPath?: string;
}

export interface OracleCollection {
  width: number;
  layout?: LayoutMetrics;
  consoleEvents: ConsoleEvent[];
  networkEvents: NetworkEvent[];
  formButtons: FormButtonInfo[];
  visibleText: string;
  ariaSnapshot: string;
  currentPng?: Buffer;
}

export interface AuraDriver {
  readonly telemetryMode: TelemetryMode;
  observe(): Promise<DriverObservation>;
  resize(width: number, height?: number): Promise<{ applied: boolean; note?: string }>;
  click(target: string, tier: 0 | 1, screenContext?: string): Promise<void>;
  type(target: string, text: string, tier: 0 | 1, screenContext?: string): Promise<void>;
  press(key: string, target?: string, tier?: 0 | 1, screenContext?: string): Promise<void>;
  capture(label: string): Promise<{ path?: string; buffer?: Buffer }>;
  collectOracles(width: number): Promise<OracleCollection>;
  close(): Promise<void>;
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "shot";

export function createHybridDriver(opts: {
  cfg: GuardConfig;
  cuaClient?: CuaClient;
  window?: CuaWindowInfo;
  page?: Page;
  forbidden: ForbiddenList;
  shotDir: string;
}): AuraDriver {
  const { cuaClient, window: win, page, forbidden, shotDir } = opts;
  if (win) {
    const refused = judgeTargetWindow(win, opts.cfg);
    if (refused) throw new ForbiddenActionError("target window", refused);
  }
  const telemetryMode: TelemetryMode = cuaClient && win && page ? "hybrid" : cuaClient && win ? "cua-only" : "cdp-only";

  let currentWidth = 1100;
  let lastTree: CuaTreeNode[] = [];
  const consoleEvents: ConsoleEvent[] = [];
  const networkEvents: NetworkEvent[] = [];

  if (page) {
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleEvents.push({ level: "error", text: msg.text() });
    });
    page.on("pageerror", (err) => {
      consoleEvents.push({ level: "pageerror", text: err.message });
    });
    page.on("response", (res) => {
      if (res.status() >= 400) {
        networkEvents.push({ url: res.url(), method: res.request().method(), status: res.status() });
      }
    });
    page.on("requestfailed", (req) => {
      networkEvents.push({
        url: req.url(),
        method: req.method(),
        status: 0,
        failed: true,
        errorText: req.failure()?.errorText ?? "request failed",
      });
    });
  }

  function findCuaNode(tree: CuaTreeNode[], query: string): CuaTreeNode {
    const q = query.toLowerCase();
    const nodes = flattenTree(tree).filter((n) => n.token);
    const hit =
      nodes.find((n) => n.name.toLowerCase() === q || n.text.toLowerCase() === q) ??
      nodes.find((n) => n.name.toLowerCase().includes(q) || n.text.toLowerCase().includes(q));
    if (!hit) throw new Error(`Element "${query}" not found in background window.`);
    return hit;
  }

  async function refreshCuaTree(): Promise<CuaTreeNode[]> {
    if (!cuaClient || !win) return [];
    const st = await cuaClient.getWindowState(win.pid, win.windowId, false);
    lastTree = st.tree;
    return st.tree;
  }

  async function resolvePageLocator(target: string) {
    if (!page) throw new Error("CDP page is not attached.");
    const byRole = page.getByRole("button", { name: target }).or(page.getByRole("link", { name: target })).or(page.getByRole("textbox", { name: target }));
    if ((await byRole.count().catch(() => 0)) > 0) return byRole.first();
    const byText = page.getByText(target, { exact: false });
    if ((await byText.count().catch(() => 0)) > 0) return byText.first();
    return page.locator(target).first();
  }

  async function observe(): Promise<DriverObservation> {
    let visibleText = "";
    let ariaSnapshot = "";
    const controls: ObservedControl[] = [];

    if (cuaClient && win) {
      const st = await cuaClient.getWindowState(win.pid, win.windowId, false);
      lastTree = st.tree;
      const flat = flattenTree(st.tree);
      visibleText = flat.map((n) => n.text || n.name).filter(Boolean).join("\n");
      for (const n of flat) {
        if (!n.token) continue;
        const info = nodeToElementInfo(n);
        if (!info.control) continue;
        const t0 = judgeActionByTier(info, n.name, forbidden, { tier: 0 });
        const t1 = t0.allowed ? t0 : judgeActionByTier(info, n.name, forbidden, { tier: 1 });
        controls.push({
          name: n.name || n.text,
          role: n.role,
          token: n.token,
          ...(n.bounds ? { bounds: n.bounds } : {}),
          safeTier: t0.allowed ? 0 : t1.allowed ? 1 : 2,
        });
      }
    }

    if (page) {
      try {
        ariaSnapshot = await page.locator("body").ariaSnapshot({ timeout: STEP_WAIT_MS });
      } catch {
        ariaSnapshot = "";
      }
      if (!visibleText) {
        visibleText = String(await page.evaluate("document.body ? document.body.innerText : ''").catch(() => ""));
      }
      if (controls.length === 0) {
        const domControls = await page.evaluate(`(() => {
          return Array.from(document.querySelectorAll('button,a,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"]'))
            .slice(0, 60)
            .map((el) => {
              const r = el.getBoundingClientRect();
              const name = el.getAttribute('aria-label') || (el.innerText || el.textContent || '').trim().slice(0, 80);
              return { name, role: el.getAttribute('role') || el.tagName.toLowerCase(), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
            });
        })()`).catch(() => []) as { name: string; role: string; rect: { x: number; y: number; width: number; height: number } }[];
        for (const c of domControls) {
          if (!c.name) continue;
          const info: ElementInfo = { tag: c.role, role: c.role, name: c.name, text: c.name, control: true };
          const t0 = judgeActionByTier(info, c.name, forbidden, { tier: 0 });
          const t1 = t0.allowed ? t0 : judgeActionByTier(info, c.name, forbidden, { tier: 1 });
          controls.push({ name: c.name, role: c.role, bounds: c.rect, safeTier: t0.allowed ? 0 : t1.allowed ? 1 : 2 });
        }
      }
    }

    return { telemetryMode, width: currentWidth, visibleText, ariaSnapshot, controls };
  }

  async function resize(width: number, height = DEFAULT_FRAME_HEIGHT): Promise<{ applied: boolean; note?: string }> {
    currentWidth = width;
    if (cuaClient && win) {
      try {
        await cuaClient.setWindowFrame(win.pid, win.windowId, width, height);
        return { applied: true };
      } catch (e) {
        if (!page) return { applied: false, note: (e as Error).message };
      }
    }
    if (page) {
      try {
        await page.setViewportSize({ width, height });
        return { applied: true };
      } catch (e) {
        return { applied: false, note: (e as Error).message };
      }
    }
    return { applied: false, note: "Neither Cua Driver nor CDP page is available to resize." };
  }

  async function click(target: string, tier: 0 | 1, screenContext?: string): Promise<void> {
    if (cuaClient && win) {
      const tree = lastTree.length ? lastTree : await refreshCuaTree();
      const node = findCuaNode(tree, target);
      const judgment = judgeActionByTier(nodeToElementInfo(node), target, forbidden, { tier, ...(screenContext ? { screenContext } : {}) });
      if (!judgment.allowed) throw new ForbiddenActionError("click", judgment.reason ?? "blocked by safety tier");
      await cuaClient.clickToken(node.token);
      lastTree = [];
      return;
    }
    const loc = await resolvePageLocator(target);
    const info = (await loc.evaluate(DESCRIBE_ELEMENT as unknown as (e: never) => ElementInfo, undefined, { timeout: STEP_WAIT_MS })) as ElementInfo;
    const judgment = judgeActionByTier(info, target, forbidden, { tier, ...(screenContext ? { screenContext } : {}) });
    if (!judgment.allowed) throw new ForbiddenActionError("click", judgment.reason ?? "blocked by safety tier");
    await loc.click({ timeout: STEP_WAIT_MS });
  }

  async function type(target: string, text: string, tier: 0 | 1, screenContext?: string): Promise<void> {
    if (/[\r\n]/.test(text)) {
      throw new ForbiddenActionError("type", "typed text contains a line break that may submit a form");
    }
    if (cuaClient && win) {
      const tree = lastTree.length ? lastTree : await refreshCuaTree();
      const node = findCuaNode(tree, target);
      const judgment = judgeActionByTier(nodeToElementInfo(node), target, forbidden, { tier, ...(screenContext ? { screenContext } : {}) });
      if (!judgment.allowed) throw new ForbiddenActionError("type", judgment.reason ?? "blocked by safety tier");
      await cuaClient.typeText(node.token, text);
      lastTree = [];
      return;
    }
    const loc = await resolvePageLocator(target);
    const info = (await loc.evaluate(DESCRIBE_ELEMENT as unknown as (e: never) => ElementInfo, undefined, { timeout: STEP_WAIT_MS })) as ElementInfo;
    const judgment = judgeActionByTier(info, target, forbidden, { tier, ...(screenContext ? { screenContext } : {}) });
    if (!judgment.allowed) throw new ForbiddenActionError("type", judgment.reason ?? "blocked by safety tier");
    await loc.fill(text, { timeout: STEP_WAIT_MS });
  }

  async function press(key: string, target?: string, _tier: 0 | 1 = 0, _screenContext?: string): Promise<void> {
    if (isCommitKey(key, forbidden)) {
      throw new ForbiddenActionError("press", `key "${key}" is a forbidden commit shortcut`);
    }
    if (isEnterKey(key) && !isSearchTarget(target ?? "")) {
      throw new ForbiddenActionError("press", `Enter is only allowed inside a search field (got "${target || "unknown"}")`);
    }
    if (!isEnterKey(key) && !isSafeKey(key)) {
      throw new ForbiddenActionError("press", `key "${key}" is not a navigation key; keys such as Space can press the focused button`);
    }
    if (cuaClient && win) {
      await cuaClient.pressKey(win.pid, win.windowId, key);
      lastTree = [];
      return;
    }
    if (page) {
      await page.keyboard.press(key);
      return;
    }
    throw new Error("No active driver to press key.");
  }

  async function capture(label: string): Promise<{ path?: string; buffer?: Buffer }> {
    let buffer: Buffer | undefined;
    if (cuaClient && win) {
      const st = await cuaClient.getWindowState(win.pid, win.windowId, true);
      lastTree = st.tree;
      if (st.screenshotBase64) buffer = Buffer.from(st.screenshotBase64, "base64");
    }
    if (!buffer && page) {
      buffer = await page.screenshot({ type: "png" });
    }
    if (!buffer) return {};
    mkdirSync(shotDir, { recursive: true });
    const file = join(shotDir, `${slug(label)}.png`);
    writeFileSync(file, buffer);
    return { path: file, buffer };
  }

  async function collectOracles(width: number): Promise<OracleCollection> {
    let layout: LayoutMetrics | undefined;
    let formButtons: FormButtonInfo[] = [];
    let visibleText = "";
    let ariaSnapshot = "";

    if (page) {
      layout = (await page.evaluate(`(() => {
        const panes = Array.from(document.querySelectorAll('main,aside,[role="main"],[data-pane]')).slice(0, 12).map((el) => {
          const r = el.getBoundingClientRect();
          return { name: el.getAttribute('aria-label') || el.tagName.toLowerCase(), width: Math.round(r.width), clipped: r.right > window.innerWidth + 2 };
        });
        const rects = Array.from(document.querySelectorAll('button,a,input,select')).slice(0, 40).map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40) };
        });
        return { innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, panes, interactiveRects: rects };
      })()`).catch(() => undefined)) as LayoutMetrics | undefined;

      formButtons = (await page.evaluate(`(() => {
        return Array.from(document.querySelectorAll('form button')).slice(0, 50).map((b) => ({
          label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 60),
          inForm: true,
          typeAttr: b.getAttribute('type'),
        }));
      })()`).catch(() => [])) as FormButtonInfo[];

      visibleText = String(await page.evaluate("document.body ? document.body.innerText : ''").catch(() => ""));
      try {
        ariaSnapshot = await page.locator("body").ariaSnapshot({ timeout: STEP_WAIT_MS });
      } catch {
        ariaSnapshot = "";
      }
    } else if (cuaClient && win) {
      const tree = lastTree.length ? lastTree : await refreshCuaTree();
      const flat = flattenTree(tree);
      visibleText = flat.map((n) => n.text || n.name).filter(Boolean).join("\n");
      const rects = flat
        .filter((n) => n.bounds)
        .slice(0, 40)
        .map((n) => ({ ...n.bounds!, label: n.name || n.text }));
      const maxRight = rects.reduce((m, r) => Math.max(m, r.x + r.width), 0);
      layout = {
        innerWidth: width,
        scrollWidth: Math.max(width, Math.round(maxRight)),
        interactiveRects: rects,
      };
    }

    const drainedEvents = consoleEvents.splice(0, consoleEvents.length);
    const drainedNetwork = networkEvents.splice(0, networkEvents.length);
    return {
      width,
      ...(layout ? { layout } : {}),
      consoleEvents: drainedEvents,
      networkEvents: drainedNetwork,
      formButtons,
      visibleText,
      ariaSnapshot,
    };
  }

  async function close(): Promise<void> {
    if (cuaClient) await cuaClient.close().catch(() => {});
  }

  return { telemetryMode, observe, resize, click, type, press, capture, collectOracles, close };
}
