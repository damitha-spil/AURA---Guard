// Cua Driver MCP client for AURA Guard.
// Connects to `cua-driver mcp` via stdio (using @modelcontextprotocol/sdk) or an injected
// transport for tests. Never invokes shell strings, and hard-blocks focus-stealing / destructive tools.

import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { envValue } from "../config.ts";
import type { GuardConfig } from "../types.ts";

/** Safety limit: max wait for a single cua-driver MCP tool call. */
export const CUA_CALL_TIMEOUT_MS = 15_000;
/** Safety limit: max wait when probing if cua-driver is installed. */
export const CUA_PROBE_TIMEOUT_MS = 3_000;

/** The only tools REO calls. A new or renamed driver tool is refused until it is added here. */
export const ALLOWED_CUA_TOOLS = new Set([
  "list_windows", "get_window_state", "click", "type_text", "press_key", "scroll", "set_window_frame",
]);

/** Tools that are never exposed or invoked by AURA Guard (focus theft, full-screen privacy, process kill). */
export const BLOCKED_CUA_TOOLS = new Set([
  "kill_app",
  "bring_to_front",
  "get_desktop_state",
  "launch_app",
]);

export interface CuaWindowInfo {
  pid: number;
  windowId: string;
  title: string;
  processName: string;
  /** Runs as administrator. "unknown": the check failed. Absent: this backend cannot tell. */
  elevated?: boolean | "unknown";
}

export interface CuaBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CuaTreeNode {
  token: string;
  role: string;
  name: string;
  text: string;
  value: string;
  bounds?: CuaBounds;
  children?: CuaTreeNode[];
}

export interface CuaWindowState {
  pid: number;
  windowId: string;
  tree: CuaTreeNode[];
  screenshotBase64: string | null;
  mimeType: string | null;
}

export interface CuaTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<{ content?: { type?: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }>;
  close(): Promise<void>;
}

export class CuaToolBlockedError extends Error {
  constructor(tool: string) {
    super(`Blocked cua-driver tool "${tool}": AURA Guard forbids focus-stealing, full-desktop capture, and process termination.`);
    this.name = "CuaToolBlockedError";
  }
}

export class CuaBackgroundUnavailableError extends Error {
  constructor(detail: string) {
    super(`background_unavailable: ${detail}`);
    this.name = "CuaBackgroundUnavailableError";
  }
}

export function resolveCuaCommand(cfg: GuardConfig): string {
  const fromEnv = envValue("CUA_DRIVER_CMD");
  if (fromEnv) return fromEnv;
  if (cfg.cuaDriver?.command?.trim()) return cfg.cuaDriver.command.trim();
  return "cua-driver";
}

/** Checks whether the cua-driver binary is installed and callable (read-only `--version`). */
export function probeCuaDriver(cfg: GuardConfig): Promise<{ available: boolean; command: string; version: string | null; error?: string }> {
  const command = resolveCuaCommand(cfg);
  return new Promise((res) => {
    execFile(command, ["--version"], { windowsHide: true, timeout: CUA_PROBE_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        res({ available: false, command, version: null, error: err.message.split("\n")[0] ?? "not installed" });
      } else {
        res({ available: true, command, version: stdout.trim() || "installed" });
      }
    });
  });
}

export async function createMcpCuaTransport(cfg: GuardConfig): Promise<CuaTransport> {
  const command = resolveCuaCommand(cfg);
  const timeoutMs = Math.min(CUA_CALL_TIMEOUT_MS, cfg.cuaDriver?.timeoutMs ?? CUA_CALL_TIMEOUT_MS);
  const transport = new StdioClientTransport({ command, args: ["mcp"] });
  const client = new Client({ name: "aura-guard-qa", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    async callTool(name, args) {
      return await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }) as {
        content?: { type?: string; text?: string; data?: string; mimeType?: string }[];
        isError?: boolean;
      };
    },
    async close() {
      await client.close();
    },
  };
}

function parseJsonText(res: { content?: { type?: string; text?: string }[]; isError?: boolean }): unknown {
  const texts = (res.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string);
  const joined = texts.join("\n").trim();
  if (res.isError) {
    if (joined.includes("background_unavailable")) throw new CuaBackgroundUnavailableError(joined);
    throw new Error(joined || "cua-driver tool failed");
  }
  if (!joined) return {};
  try {
    return JSON.parse(joined);
  } catch {
    return { text: joined };
  }
}

/** Safety bounds for background window resize frames. */
export const MIN_FRAME_WIDTH = 320;
export const MAX_FRAME_WIDTH = 3840;
export const MIN_FRAME_HEIGHT = 240;
export const MAX_FRAME_HEIGHT = 2160;

function normalizeBounds(raw: unknown): CuaBounds | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const x = Number(o["x"] ?? o["left"]);
  const y = Number(o["y"] ?? o["top"]);
  const width = Number(o["width"] ?? (o["right"] !== undefined && Number.isFinite(x) ? Number(o["right"]) - x : NaN));
  const height = Number(o["height"] ?? (o["bottom"] !== undefined && Number.isFinite(y) ? Number(o["bottom"]) - y : NaN));
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  return { x, y, width, height };
}

function normalizeTree(raw: unknown): CuaTreeNode[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((n) => {
    const o = (n && typeof n === "object" ? n : {}) as Record<string, unknown>;
    const bounds = normalizeBounds(o["bounds"] ?? o["rect"] ?? o["bbox"]);
    return {
      token: String(o["element_token"] ?? o["token"] ?? ""),
      role: String(o["role"] ?? ""),
      name: String(o["name"] ?? o["label"] ?? ""),
      text: String(o["text"] ?? o["title"] ?? ""),
      value: String(o["value"] ?? ""),
      ...(bounds ? { bounds } : {}),
      ...(Array.isArray(o["children"]) ? { children: normalizeTree(o["children"]) } : {}),
    };
  });
}

export class CuaClient {
  private readonly transport: CuaTransport;

  constructor(transport: CuaTransport) {
    this.transport = transport;
  }

  private async invoke(tool: string, args: Record<string, unknown>) {
    if (BLOCKED_CUA_TOOLS.has(tool) || !ALLOWED_CUA_TOOLS.has(tool)) throw new CuaToolBlockedError(tool);
    return await this.transport.callTool(tool, args);
  }

  async listWindows(): Promise<CuaWindowInfo[]> {
    const res = await this.invoke("list_windows", {});
    const parsed = parseJsonText(res) as { windows?: unknown[] } | unknown[];
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.windows) ? parsed.windows : [];
    return list.map((w) => {
      const o = (w && typeof w === "object" ? w : {}) as Record<string, unknown>;
      return {
        pid: Number(o["pid"] ?? 0),
        windowId: String(o["window_id"] ?? o["windowId"] ?? o["id"] ?? ""),
        title: String(o["title"] ?? ""),
        processName: String(o["process_name"] ?? o["processName"] ?? o["app"] ?? "").toLowerCase(),
        ...(o["elevated"] !== undefined || o["is_elevated"] !== undefined
          ? { elevated: typeof (o["elevated"] ?? o["is_elevated"]) === "boolean" ? ((o["elevated"] ?? o["is_elevated"]) as boolean) : ("unknown" as const) }
          : {}),
      };
    });
  }

  async getWindowState(pid: number, windowId: string, includeScreenshot = true): Promise<CuaWindowState> {
    const res = await this.invoke("get_window_state", {
      pid,
      window_id: windowId,
      include_screenshot: includeScreenshot,
    });
    const parsed = parseJsonText(res) as Record<string, unknown>;
    const img = (res.content ?? []).find((c) => c.type === "image" && typeof c.data === "string");
    return {
      pid,
      windowId,
      tree: normalizeTree(parsed["tree"] ?? parsed["elements"] ?? parsed["nodes"]),
      screenshotBase64: img?.data ?? null,
      mimeType: img?.mimeType ?? (img ? "image/png" : null),
    };
  }

  async clickToken(elementToken: string): Promise<void> {
    const res = await this.invoke("click", { element_token: elementToken, delivery_mode: "background" });
    parseJsonText(res);
  }

  async typeText(elementToken: string, text: string): Promise<void> {
    const res = await this.invoke("type_text", { element_token: elementToken, text, delivery_mode: "background" });
    parseJsonText(res);
  }

  async pressKey(pid: number, windowId: string, key: string): Promise<void> {
    const res = await this.invoke("press_key", { pid, window_id: windowId, key, delivery_mode: "background" });
    parseJsonText(res);
  }

  async scroll(elementToken: string, deltaY: number): Promise<void> {
    const res = await this.invoke("scroll", { element_token: elementToken, delta_y: deltaY, delivery_mode: "background" });
    parseJsonText(res);
  }

  async setWindowFrame(pid: number, windowId: string, width: number, height: number): Promise<void> {
    if (!Number.isFinite(width) || width < MIN_FRAME_WIDTH || width > MAX_FRAME_WIDTH) {
      throw new Error(`Invalid window frame width ${width}; must be between ${MIN_FRAME_WIDTH} and ${MAX_FRAME_WIDTH}.`);
    }
    if (!Number.isFinite(height) || height < MIN_FRAME_HEIGHT || height > MAX_FRAME_HEIGHT) {
      throw new Error(`Invalid window frame height ${height}; must be between ${MIN_FRAME_HEIGHT} and ${MAX_FRAME_HEIGHT}.`);
    }
    const res = await this.invoke("set_window_frame", {
      pid,
      window_id: windowId,
      width: Math.round(width),
      height: Math.round(height),
      delivery_mode: "background",
    });
    parseJsonText(res);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
