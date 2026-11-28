// Safety-guarded Cua Driver QA harness for AURA Guard.
// Enforces:
// 1. Background-only execution (delivery_mode: "background" always; never steals focus).
// 2. Only apps named in cuaDriver.allowedApps (exact program name). Shells, terminals, SQL and admin tools,
//    ERP clients, REO's own window and elevated windows are always refused; local settings only add blocks.
// 3. Pre-action qa/safety.ts validation on every element_token before click/type/press.
// 4. Saves window-scoped screenshots into .artifacts/qa/<runId>/ for Replay & Failure Inspector.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import { CuaClient } from "./cua_client.ts";
import type { CuaTreeNode, CuaWindowInfo, CuaWindowState } from "./cua_client.ts";
import { ForbiddenActionError, judgeElement } from "./harness.ts";
import type { ElementInfo, StepRecord } from "./harness.ts";
import { isCommitKey, isEnterKey, isSafeKey, isSearchTarget, OWN_WINDOW_TITLE } from "./safety.ts";
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

/**
 * More programs that are always refused, matched on the whole program name without ".exe" (so
 * "sh" does not match "refresh"). Editors with a built-in terminal and script hosts count as shells.
 */
export const SHELL_PROCESS_NAMES = [
  "cmd", "powershell", "powershell_ise", "pwsh", "wt", "windowsterminal", "openconsole", "conhost",
  "bash", "sh", "zsh", "fish", "dash", "nu", "wsl", "wslhost", "ubuntu", "debian", "git-bash", "git-cmd",
  "mintty", "alacritty", "wezterm", "wezterm-gui", "kitty", "hyper", "tabby", "warp", "conemu", "conemu64",
  "conemuc", "conemuc64", "cmder", "putty", "kitty_portable", "mobaxterm", "ssh", "telnet",
  "wscript", "cscript", "mshta", "mmc", "explorer", "code", "code - insiders", "cursor", "windsurf", "devenv",
  "regedit", "taskmgr", "ssms", "terminal", "iterm2", "gnome-terminal", "gnome-terminal-server", "konsole", "xterm",
];

/** REO's own program names. Its window title is checked too: a browser window showing REO is REO. */
const OWN_PROCESS = /spil[\s_-]*reo|aura-guard/i;

/** "C:\\x\\Foo.EXE" -> "foo". */
export const processStem = (name: string): string =>
  (name.trim().split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");

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

/** The blocks no setting can lift. Returns the reason, or null. Fails closed on missing facts. */
export function judgeProtectedWindow(win: CuaWindowInfo, extraDeny: string[] = []): string | null {
  const proc = win.processName.toLowerCase();
  const stem = processStem(proc);
  if (!stem || stem === "unknown") return "the window's program could not be identified";
  if (!Number.isInteger(win.pid) || win.pid <= 0) return "the window's process id is not valid";
  if (win.pid === process.pid || win.pid === process.ppid || OWN_PROCESS.test(proc) || OWN_WINDOW_TITLE.test(win.title)) {
    return "REO never controls its own window or process";
  }
  const extra = extraDeny.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (SHELL_PROCESS_NAMES.includes(stem) || [...BUILTIN_DENY_PROCESSES, ...extra].some((d) => proc.includes(d))) {
    return `process "${win.processName}" is on the protected denylist`;
  }
  if (win.elevated === true) return `process "${win.processName}" runs as administrator`;
  if (win.elevated === "unknown") return `it could not be checked whether "${win.processName}" runs as administrator`;
  return null;
}

/** Validates whether a target window is permitted for background QA. Returns error reason or null. */
export function judgeTargetWindow(win: CuaWindowInfo, cfg: GuardConfig): string | null {
  const blocked = judgeProtectedWindow(win, cfg.cuaDriver?.denyApps ?? []);
  if (blocked) return blocked;
  const allow = (cfg.cuaDriver?.allowedApps ?? []).map(processStem).filter(Boolean);
  if (allow.length === 0) return "no app is allowed yet: add its program name to cuaDriver.allowedApps";
  // The program name only, exactly. A window title is text any program can set.
  if (!allow.includes(processStem(win.processName))) {
    return `process "${win.processName}" is not in cuaDriver.allowedApps`;
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
  const none = (cfg.cuaDriver?.allowedApps ?? []).some((a) => a.trim()) ? "" : " No app is allowed yet: add its program name to cuaDriver.allowedApps.";
  throw new Error(`No permitted background window matched for Cua Driver QA.${none}`);
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
  const refused = judgeProtectedWindow(window);
  if (refused) throw new ForbiddenActionError("target window", refused);
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
      // The named field must really be a text field on this window.
      const field = await findToken(targetText);
      if (!/text|edit|search|combo/i.test(field.role)) {
        throw new ForbiddenActionError("press_key", `Enter is only allowed inside a search field ("${targetText}" is a ${field.role || "control of unknown kind"})`);
      }
    } else if (!isSafeKey(key)) {
      throw new ForbiddenActionError("press_key", `key "${key}" is not a navigation key; keys such as Space can press the focused button`);
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
