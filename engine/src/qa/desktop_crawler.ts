// Multi-backend Open-Source Desktop App UI Crawler for AURA Sentinel:
// Supports:
//   1. Built-in Windows UIA Crawler (bin/win-uia-crawler.ps1 via .NET UIAutomationClient - zero installs)
//   2. Cua Driver MCP (trycua/cua) when installed
//   3. Python pywinauto / uiautomation detection
// Enforces judgeTargetWindow (denylist + allowedApps) and judgeActionByTier BEFORE every click; the window
// is judged again just before each one. The crawler never types.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import { probeCuaDriver } from "./cua_client.ts";
import type { CuaBounds, CuaWindowInfo } from "./cua_client.ts";
import { judgeTargetWindow, selectTargetWindow } from "./cua_harness.ts";
import type { JourneyDsl } from "./dsl.ts";
import { ForbiddenActionError } from "./harness.ts";
import { draftJourneyFromRecording } from "./recorder.ts";
import { maskDeep } from "./safe-out.ts";
import { judgeActionByTier, loadForbidden } from "./safety.ts";
import type { SafetyTier } from "./safety.ts";

/** Safety cap: maximum UI actions executed in one autonomous desktop crawl. */
export const MAX_CRAWL_ACTIONS = 10;
/** Safety timeout per Windows UIA PowerShell call in ms. */
export const CRAWL_TIMEOUT_MS = 12_000;

export interface CrawledNode {
  token: string;
  role: string;
  name: string;
  automationId?: string;
  enabled: boolean;
  offscreen: boolean;
  bounds?: CuaBounds;
  safetyTier: SafetyTier;
}

export interface DesktopCrawlerTransport {
  readonly backendName: string;
  listWindows(): Promise<CuaWindowInfo[]>;
  /** `win` pins the exact window and program that were judged. */
  inspectTree(pid: number, win?: CuaWindowInfo): Promise<CrawledNode[]>;
  click(pid: number, name: string, win?: CuaWindowInfo): Promise<void>;
  type(pid: number, name: string, text: string, win?: CuaWindowInfo): Promise<void>;
}

export interface CrawlerAvailability {
  windowsUia: { available: boolean; scriptPath: string };
  cuaDriver: { available: boolean; command: string; version: string | null };
  python: { available: boolean; command: string };
}

function execFileAsync(cmd: string, args: string[], timeoutMs = CRAWL_TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err?.message ?? "")) });
    });
  });
}

export async function probeDesktopCrawlers(cfg: GuardConfig): Promise<CrawlerAvailability> {
  const scriptPath = join(cfg.root, "bin", "win-uia-crawler.ps1");
  const cua = await probeCuaDriver(cfg);
  const venvPy = join(cfg.root, ".venv", "Scripts", "python.exe");
  const pyCmd = existsSync(venvPy) ? venvPy : "python";
  const pyCheck = await execFileAsync(pyCmd, ["--version"], 2500);
  return {
    windowsUia: { available: process.platform === "win32" && existsSync(scriptPath), scriptPath },
    cuaDriver: { available: cua.available, command: cua.command, version: cua.version },
    python: { available: pyCheck.ok, command: pyCmd },
  };
}

export function createWindowsUiaTransport(cfg: GuardConfig): DesktopCrawlerTransport {
  const script = join(cfg.root, "bin", "win-uia-crawler.ps1");
  const pin = (win: CuaWindowInfo | undefined): string[] => {
    if (!win) throw new Error("The judged window is required.");
    return ["-WindowHandle", win.windowId, "-ExpectedProcess", win.processName];
  };
  async function runPs(args: string[]): Promise<unknown> {
    const r = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args]);
    if (!r.ok) throw new Error(r.stderr.trim() || "win-uia-crawler failed");
    const txt = r.stdout.trim();
    return txt ? JSON.parse(txt) : {};
  }

  return {
    backendName: "windows-uia-powershell",
    async listWindows() {
      const raw = await runPs(["-Action", "list-windows"]);
      const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return arr.map((w) => {
        const o = w as Record<string, unknown>;
        return {
          pid: Number(o["pid"] ?? 0),
          windowId: String(o["windowId"] ?? ""),
          title: String(o["title"] ?? ""),
          processName: String(o["processName"] ?? "").toLowerCase(),
          // This backend can check, so anything but a clear no is refused.
          elevated: o["elevated"] === false ? false : o["elevated"] === true ? true : ("unknown" as const),
        };
      });
    },
    async inspectTree(pid: number, win?: CuaWindowInfo) {
      const raw = (await runPs(["-Action", "inspect-tree", "-TargetPid", String(pid), ...pin(win)])) as { nodes?: Record<string, unknown>[] };
      return (raw.nodes ?? []).map((n) => ({
        token: String(n["token"] ?? ""),
        role: String(n["role"] ?? ""),
        name: String(n["name"] ?? ""),
        ...(n["automationId"] ? { automationId: String(n["automationId"]) } : {}),
        enabled: Boolean(n["enabled"] ?? true),
        offscreen: Boolean(n["offscreen"] ?? false),
        ...(n["bounds"] ? { bounds: n["bounds"] as CuaBounds } : {}),
        safetyTier: 0 as SafetyTier,
      }));
    },
    async click(pid: number, name: string, win?: CuaWindowInfo) {
      await runPs(["-Action", "click", "-TargetPid", String(pid), "-TargetName", name, ...pin(win)]);
    },
    async type(pid: number, name: string, text: string, win?: CuaWindowInfo) {
      await runPs(["-Action", "type", "-TargetPid", String(pid), "-TargetName", name, "-Text", text, ...pin(win)]);
    },
  };
}

export interface DesktopCrawlResult {
  backend: string;
  window: CuaWindowInfo;
  nodesCount: number;
  controls: CrawledNode[];
  clicked: string[];
  blockedControls: string[];
  draftedJourney: JourneyDsl;
}

const CLICKABLE_ROLES = new Set(["button", "tabitem", "menuitem", "hyperlink", "treeitem", "listitem"]);

export async function crawlDesktopApp(
  cfg: GuardConfig,
  opts: { matchTitle?: string; maxActions?: number; tier?: 0 | 1; dryRun?: boolean; screenContext?: string } = {},
  transport: DesktopCrawlerTransport = createWindowsUiaTransport(cfg),
): Promise<DesktopCrawlResult> {
  const forbidden = loadForbidden(cfg.root);
  const windows = await transport.listWindows();
  const win = selectTargetWindow(windows, cfg, opts.matchTitle);

  const tier = opts.tier ?? 0;
  // A value that is not a number must not remove the cap.
  const wanted = Number.isFinite(opts.maxActions) ? (opts.maxActions as number) : 5;
  const maxActions = Math.max(1, Math.min(MAX_CRAWL_ACTIONS, wanted));
  const rawNodes = await transport.inspectTree(win.pid, win);

  const controls: CrawledNode[] = [];
  const blockedControls: string[] = [];

  for (const n of rawNodes) {
    const role = n.role.toLowerCase();
    const isInteractive = CLICKABLE_ROLES.has(role) || role.includes("button") || role.includes("edit") || role.includes("tab");
    if (!isInteractive || !n.name.trim()) continue;
    const t0 = judgeActionByTier({ role, name: n.name, text: n.name, control: true, ...(n.automationId ? { id: n.automationId } : {}) }, n.name, forbidden, { tier: 0, ...(opts.screenContext ? { screenContext: opts.screenContext } : {}) });
    const t1 = t0.allowed ? t0 : judgeActionByTier({ role, name: n.name, text: n.name, control: true, ...(n.automationId ? { id: n.automationId } : {}) }, n.name, forbidden, { tier: 1, ...(opts.screenContext ? { screenContext: opts.screenContext } : {}) });
    const safetyTier: SafetyTier = t0.allowed ? 0 : t1.allowed ? 1 : 2;
    if (safetyTier > tier) blockedControls.push(n.name);
    controls.push({ ...n, safetyTier });
  }

  const clicked: string[] = [];
  if (!opts.dryRun) {
    for (const c of controls) {
      if (clicked.length >= maxActions) break;
      if (c.safetyTier > tier || !c.enabled || c.offscreen) continue;
      if (!CLICKABLE_ROLES.has(c.role.toLowerCase()) && !c.role.toLowerCase().includes("button")) continue;
      const check = judgeActionByTier({ role: c.role, name: c.name, text: c.name, control: true, ...(c.automationId ? { id: c.automationId } : {}) }, c.name, forbidden, { tier, ...(opts.screenContext ? { screenContext: opts.screenContext } : {}) });
      if (!check.allowed) throw new ForbiddenActionError("click", check.reason ?? "blocked by safety tier");
      // The window can change between steps (closed, id reused, restarted as administrator).
      const now = (await transport.listWindows()).find((w) => w.pid === win.pid && w.windowId === win.windowId);
      const refused = now ? judgeTargetWindow(now, cfg) : "the window is gone";
      if (!now || refused) throw new ForbiddenActionError("click", refused ?? "the window is gone");
      await transport.click(now.pid, c.name, now);
      clicked.push(c.name);
    }
  }

  const drafted = draftJourneyFromRecording(cfg, {
    id: `crawl-${win.processName.replace(/\.exe$/i, "")}`,
    title: `Crawled UI flow: ${win.title}`,
    area: "desktop-crawl",
    tier,
    events: clicked.map((name) => ({ action: "click" as const, target: name })),
    writeProposal: false,
  });

  return maskDeep({
    backend: transport.backendName,
    window: win,
    nodesCount: rawNodes.length,
    controls: controls.slice(0, 60),
    clicked,
    blockedControls: [...new Set(blockedControls)],
    draftedJourney: drafted.dsl,
  });
}
