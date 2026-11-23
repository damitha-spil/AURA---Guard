// Safety-guarded Cua Driver QA harness for AURA Guard.
// Enforces:
// 1. Background-only execution (delivery_mode: "background" always; never steals focus).
// 2. Process & window allowlist/denylist (never touches shells, SQL tools, Guard itself, or SPIL Glass ERP unless configured).
// 3. Pre-action qa/safety.ts validation on every element_token before click/type/press.
// 4. Saves window-scoped screenshots into .artifacts/qa/<runId>/ for Replay & Failure Inspector.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import { CuaClient } from "./cua_client.ts";
import type { CuaTreeNode, CuaWindowInfo, CuaWindowState } from "./cua_client.ts";
import { ForbiddenActionError, judgeElement } from "./harness.ts";
import type { ElementInfo, StepRecord } from "./harness.ts";
import { isCommitKey, isEnterKey, isSearchTarget } from "./safety.ts";
import type { ForbiddenList } from "./safety.ts";

/** Built-in process denylist: shells, admin consoles, Guard itself, and ERP clients. */
export const BUILTIN_DENY_PROCESSES = [
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "wt.exe",
  "windowsterminal.exe",
  "ssms.exe",
  "regedit.exe",
  "taskmgr.exe",
  "aura-guard",
  "spilglass.exe",
  "spil.exe",
];

/** Safety limit: max nodes walked per UIA tree lookup to prevent runaway recursion. */
export const MAX_TREE_NODES = 2_000;

export function flattenTree(nodes: CuaTreeNode[], out: CuaTreeNode[] = []): CuaTreeNode[] {
  for (const n of nodes) {
    if (out.length >= MAX_TREE_NODES) break;
    out.push(n);
    if (n.children?.length) flattenTree(n.children, out);
  }
  return out;
}

export function nodeToElementInfo(node: CuaTreeNode): ElementInfo {
  const role = node.role.toLowerCase();
  const control = ["button", "link", "menuitem", "tab", "checkbox", "switch", "textbox", "edit", "combobox"].some((r) => role.includes(r));
  return {
    tag: role,
    role: node.role,
    name: node.name,
    text: node.text || node.name,
    value: node.value,
    control,
    submits: false,
  };
}

/** Validates whether a target window is permitted for background QA. Returns error reason or null. */
export function judgeTargetWindow(win: CuaWindowInfo, cfg: GuardConfig): string | null {
  const proc = win.processName.toLowerCase();
  const extraDeny = (cfg.cuaDriver?.denyApps ?? []).map((s) => s.toLowerCase());
  if ([...BUILTIN_DENY_PROCESSES, ...extraDeny].some((d) => proc.includes(d))) {
    return `process "${win.processName}" is on the protected denylist`;
  }
  const allow = (cfg.cuaDriver?.allowedApps ?? []).map((s) => s.toLowerCase());
  if (allow.length > 0 && !allow.some((a) => proc.includes(a) || win.title.toLowerCase().includes(a))) {
    return `window "${win.title}" (${win.processName}) is not in cuaDriver.allowedApps`;
  }
  return null;
}

/** Picks the best matching permitted window from list_windows(). */
export function selectTargetWindow(windows: CuaWindowInfo[], cfg: GuardConfig, matchTitle?: string): CuaWindowInfo {
  const query = matchTitle?.toLowerCase();
  for (const w of windows) {
    if (judgeTargetWindow(w, cfg) !== null) continue;
    if (!query || w.title.toLowerCase().includes(query) || w.processName.toLowerCase().includes(query)) {
      return w;
    }
  }
  throw new Error("No permitted background window matched for Cua Driver QA.");
}

export interface CuaStepContext {
  readonly window: CuaWindowInfo;
  observe(includeScreenshot?: boolean): Promise<CuaWindowState>;
  findToken(query: string): Promise<CuaTreeNode>;
  clickByName(query: string): Promise<void>;
  typeByName(query: string, text: string): Promise<void>;
  pressKey(key: string, targetQuery?: string): Promise<void>;
  saveScreenshot(label: string): Promise<string | undefined>;
  step(title: string, expected: string, fn: () => Promise<void>): Promise<void>;
}

export function createCuaStepContext(opts: {
  client: CuaClient;
  window: CuaWindowInfo;
  forbidden: ForbiddenList;
  shotDir: string;
  record: (s: StepRecord) => void;
}): CuaStepContext {
  const { client, window, forbidden, shotDir, record } = opts;
  let lastState: CuaWindowState | null = null;
  let stepN = 0;

  async function observe(includeScreenshot = true): Promise<CuaWindowState> {
    lastState = await client.getWindowState(window.pid, window.windowId, includeScreenshot);
    return lastState;
  }

  async function findToken(query: string): Promise<CuaTreeNode> {
    const state = lastState ?? (await observe(false));
    const q = query.toLowerCase();
    const nodes = flattenTree(state.tree).filter((n) => n.token);
    const hit =
      nodes.find((n) => n.name.toLowerCase() === q || n.text.toLowerCase() === q) ??
      nodes.find((n) => n.name.toLowerCase().includes(q) || n.text.toLowerCase().includes(q));
    if (!hit) throw new Error(`Element "${query}" not found in background window "${window.title}".`);
    return hit;
  }

  async function clickByName(query: string): Promise<void> {
    const node = await findToken(query);
    const bad = judgeElement(nodeToElementInfo(node), query, forbidden);
    if (bad) throw new ForbiddenActionError("click", bad);
    await client.clickToken(node.token);
  }

  async function typeByName(query: string, text: string): Promise<void> {
    const node = await findToken(query);
    const bad = judgeElement(nodeToElementInfo(node), query, forbidden);
    if (bad) throw new ForbiddenActionError("type_text", bad);
    await client.typeText(node.token, text);
  }

  async function pressKey(key: string, targetQuery?: string): Promise<void> {
    if (isCommitKey(key, forbidden)) {
      throw new ForbiddenActionError("press_key", `key "${key}" is a forbidden commit shortcut`);
    }
    if (isEnterKey(key)) {
      const targetText = targetQuery ?? "";
      if (!isSearchTarget(targetText)) {
        throw new ForbiddenActionError("press_key", `Enter is only allowed inside a search field (got "${targetText || "unknown"}")`);
      }
    }
    await client.pressKey(window.pid, window.windowId, key);
  }

  async function saveScreenshot(label: string): Promise<string | undefined> {
    try {
      const st = await observe(true);
      if (!st.screenshotBase64) return undefined;
      mkdirSync(shotDir, { recursive: true });
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shot";
      const file = join(shotDir, `${slug}.png`);
      writeFileSync(file, Buffer.from(st.screenshotBase64, "base64"));
      return file;
    } catch {
      return undefined;
    }
  }

  async function step(title: string, expected: string, fn: () => Promise<void>): Promise<void> {
    const n = ++stepN;
    const t0 = Date.now();
    try {
      await fn();
      record({ n, width: null, title, expected, status: "passed", ms: Date.now() - t0 });
    } catch (e) {
      const screenshot = await saveScreenshot(`fail-${n}-${title}`);
      record({
        n,
        width: null,
        title,
        expected,
        status: "failed",
        ms: Date.now() - t0,
        error: (e as Error).message.split("\n")[0] ?? "failed",
        ...(screenshot ? { screenshot } : {}),
      });
      throw e;
    }
  }

  return { window, observe, findToken, clickByName, typeByName, pressKey, saveScreenshot, step };
}
