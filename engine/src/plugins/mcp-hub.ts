// SPIL REO — Dynamic External MCP Client Hub.
// Connects REO to external stdio, Streamable HTTP, or SSE MCP servers, discovers their tools,
// exposes them in REO's Tool Library & Agents, and masks outgoing arguments via maskOutgoing.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { maskOutgoing } from "../mask/mask.ts";
import { maskDeep } from "../qa/safe-out.ts";
import type { ToolEntry } from "../tools/registry.ts";

/** Hard cap on configured external MCP servers. */
export const MAX_EXTERNAL_MCP_SERVERS = 30;
/** Timeout for probing or calling an external MCP server. */
export const MCP_HUB_TIMEOUT_MS = 15_000;

const BLOCKED_SHELL_BINS = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "sh", "zsh", "wscript.exe", "cscript.exe"]);

export type McpTransportKind = "stdio" | "http" | "sse";

export interface DiscoveredMcpTool {
  name: string;
  description: string;
}

export interface ExternalMcpServer {
  id: string;
  name: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  discoveredTools: DiscoveredMcpTool[];
  lastConnectedAt?: string;
  lastError?: string;
}

export interface McpClientLike {
  listTools: () => Promise<{ tools?: Array<{ name?: string; description?: string }> }>;
  callTool: (input: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
  close: () => Promise<void>;
}

export type McpConnectFn = (server: ExternalMcpServer) => Promise<McpClientLike>;

function serversFile(dataDir: string): string {
  const dir = join(dataDir, "plugins");
  mkdirSync(dir, { recursive: true });
  return join(dir, "mcp-servers.json");
}

function saveServers(dataDir: string, list: ExternalMcpServer[]): void {
  writeFileSync(serversFile(dataDir), JSON.stringify(maskDeep(list), null, 2), "utf8");
}

export function listExternalMcpServers(dataDir: string): ExternalMcpServer[] {
  const file = serversFile(dataDir);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as ExternalMcpServer[]) : [];
  } catch {
    return [];
  }
}

function validateServerConfig(input: {
  name: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  url?: string;
}): void {
  if (!input.name.trim()) throw new Error("Server name is required.");
  if (input.transport === "stdio") {
    const cmd = input.command?.trim() || "";
    if (!cmd) throw new Error("stdio transport requires a command binary.");
    if (/[\x00-\x1f]/.test(cmd)) throw new Error("Command contains invalid control characters.");
    const base = basename(cmd).toLowerCase();
    if (BLOCKED_SHELL_BINS.has(base)) {
      throw new Error(`Refused shell binary "${base}" for MCP stdio command; specify the executable directly.`);
    }
    for (const a of input.args ?? []) {
      if (/[\x00-\x1f]/.test(a)) throw new Error("Command arguments contain invalid control characters.");
    }
  } else {
    const rawUrl = input.url?.trim() || "";
    if (!rawUrl) throw new Error(`${input.transport} transport requires a url.`);
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      throw new Error("MCP server URL must be valid http:// or https://.");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error("MCP server URL must use http:// or https://.");
    }
    if (u.username || u.password) {
      throw new Error("Do not embed credentials inside the MCP server URL.");
    }
  }
}

export function upsertExternalMcpServer(
  dataDir: string,
  input: {
    id?: string;
    name: string;
    transport: McpTransportKind;
    command?: string;
    args?: string[];
    url?: string;
    enabled?: boolean;
  },
): ExternalMcpServer {
  validateServerConfig(input);
  const all = listExternalMcpServers(dataDir);
  const idx = input.id ? all.findIndex((s) => s.id === input.id) : -1;
  const slug = input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "mcp";

  if (idx >= 0) {
    const existing = all[idx]!;
    const updated: ExternalMcpServer = {
      ...existing,
      name: input.name.trim().slice(0, 80),
      transport: input.transport,
      ...(input.transport === "stdio"
        ? { command: input.command!.trim(), args: (input.args ?? []).map((x) => x.trim()).filter(Boolean) }
        : { url: input.url!.trim() }),
      enabled: input.enabled ?? existing.enabled,
    };
    if (input.transport === "stdio") delete updated.url;
    else {
      delete updated.command;
      delete updated.args;
    }
    all[idx] = updated;
    saveServers(dataDir, all);
    return updated;
  }

  if (all.length >= MAX_EXTERNAL_MCP_SERVERS) {
    throw new Error(`Maximum of ${MAX_EXTERNAL_MCP_SERVERS} external MCP servers reached.`);
  }
  const id = input.id?.trim() || `mcp-${slug}-${randomUUID().slice(0, 6)}`;
  const created: ExternalMcpServer = {
    id,
    name: input.name.trim().slice(0, 80),
    transport: input.transport,
    ...(input.transport === "stdio"
      ? { command: input.command!.trim(), args: (input.args ?? []).map((x) => x.trim()).filter(Boolean) }
      : { url: input.url!.trim() }),
    enabled: input.enabled ?? true,
    discoveredTools: [],
  };
  saveServers(dataDir, [created, ...all]);
  return created;
}

export function deleteExternalMcpServer(dataDir: string, id: string): boolean {
  const all = listExternalMcpServers(dataDir);
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return false;
  saveServers(dataDir, next);
  return true;
}

async function defaultConnect(server: ExternalMcpServer): Promise<McpClientLike> {
  const client = new Client({ name: "spil-reo-hub", version: "0.1.0" }, { capabilities: {} });
  let transport;
  if (server.transport === "stdio") {
    transport = new StdioClientTransport({
      command: server.command || "",
      args: server.args ?? [],
    });
  } else if (server.transport === "sse") {
    transport = new SSEClientTransport(new URL(server.url || ""));
  } else {
    transport = new StreamableHTTPClientTransport(new URL(server.url || ""));
  }
  await Promise.race([
    client.connect(transport),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("MCP server connection timed out.")), MCP_HUB_TIMEOUT_MS)),
  ]);
  return {
    listTools: () => client.listTools(),
    callTool: (req) => client.callTool(req),
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

/** Connect to a configured external MCP server, discover tools, and persist them locally. */
export async function probeExternalMcpServer(
  dataDir: string,
  id: string,
  connectFn: McpConnectFn = defaultConnect,
): Promise<ExternalMcpServer> {
  const all = listExternalMcpServers(dataDir);
  const idx = all.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error(`Unknown external MCP server: ${id}`);
  const server = all[idx]!;
  let client: McpClientLike | null = null;
  try {
    client = await connectFn(server);
    const listed = await client.listTools();
    const tools: DiscoveredMcpTool[] = (listed.tools ?? [])
      .filter((t): t is { name: string; description?: string } => typeof t?.name === "string" && t.name.length > 0)
      .slice(0, 60)
      .map((t) => ({ name: t.name, description: (t.description || "").slice(0, 200) }));

    const updated: ExternalMcpServer = {
      ...server,
      discoveredTools: tools,
      lastConnectedAt: new Date().toISOString(),
    };
    delete updated.lastError;
    all[idx] = updated;
    saveServers(dataDir, all);
    return updated;
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const failed: ExternalMcpServer = { ...server, lastError: errMsg };
    all[idx] = failed;
    saveServers(dataDir, all);
    throw new Error(errMsg);
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

/** Call a tool on a configured & enabled external MCP server (args pass maskOutgoing first). */
export async function callExternalMcpTool(
  dataDir: string,
  serverId: string,
  toolName: string,
  args: Record<string, unknown> = {},
  connectFn: McpConnectFn = defaultConnect,
): Promise<unknown> {
  const server = listExternalMcpServers(dataDir).find((s) => s.id === serverId);
  if (!server) throw new Error(`Unknown external MCP server: ${serverId}`);
  if (!server.enabled) throw new Error(`External MCP server "${server.name}" is disabled.`);

  const masked = maskOutgoing(JSON.stringify(args));
  if (!masked.ok) {
    throw new Error(`Blocked external MCP call: secret detected (${masked.blocked.map((b) => b.kind).join(", ")}).`);
  }
  const safeArgs = JSON.parse(masked.text) as Record<string, unknown>;

  let client: McpClientLike | null = null;
  try {
    client = await connectFn(server);
    const result = await Promise.race([
      client.callTool({ name: toolName, arguments: safeArgs }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("MCP tool call timed out.")), MCP_HUB_TIMEOUT_MS)),
    ]);
    return maskDeep(result);
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

/** Build ToolEntry descriptors for all discovered tools from enabled external MCP servers. */
export function listDiscoveredMcpTools(dataDir: string): ToolEntry[] {
  const out: ToolEntry[] = [];
  for (const s of listExternalMcpServers(dataDir)) {
    if (!s.enabled) continue;
    for (const t of s.discoveredTools) {
      out.push({
        id: `mcp__${s.id}__${t.name}`,
        name: `${s.name}: ${t.name}`,
        category: "plugin",
        riskTier: "local_action",
        requiresConfirmation: true,
        source: "mcp",
        description: t.description || `External MCP tool "${t.name}" from ${s.name}`,
      });
    }
  }
  return out;
}
