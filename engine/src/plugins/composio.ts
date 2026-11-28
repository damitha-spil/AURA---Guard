// SPIL REO — Live Composio Integration (100+ OAuth-managed toolkits: Jira, Linear, Slack, GitHub, Notion, etc.).
// COMPOSIO_API_KEY is stored encrypted via createKeyStore; all outgoing params pass maskOutgoing first.

import { createKeyStore } from "../brain/keystore.ts";
import type { KeySlot, SecretBackend } from "../brain/keystore.ts";
import { maskOutgoing } from "../mask/mask.ts";
import { maskDeep } from "../qa/safe-out.ts";
import { listPlugins } from "./store.ts";

/** Encrypted key slot for Composio API key (never stored in plain JSON). */
export const COMPOSIO_KEY_SLOT: KeySlot = { name: "composio", env: "COMPOSIO_API_KEY" };
/** Default Composio v2 REST API base URL. */
export const COMPOSIO_DEFAULT_BASE_URL = "https://backend.composio.dev/api/v2";
/** Bounded timeout for Composio API calls. */
export const COMPOSIO_TIMEOUT_MS = 15_000;
/** Cap response size read from Composio API. */
export const COMPOSIO_MAX_RESPONSE_BYTES = 256 * 1024;

export interface ComposioOptions {
  env?: NodeJS.ProcessEnv;
  secrets?: SecretBackend;
  fetchFn?: typeof fetch;
}

export interface ComposioConnectionSummary {
  id: string;
  appName: string;
  status: string;
  createdAt: string;
}

export interface ComposioActionSummary {
  name: string;
  appName: string;
  description: string;
  displayName: string;
}

export function validateComposioEndpoint(raw: string): string {
  const text = raw.trim();
  if (!text) return COMPOSIO_DEFAULT_BASE_URL;
  if (/[\s\x00-\x1f]/.test(text)) throw new Error("Composio endpoint cannot contain spaces or control characters.");
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error("Composio endpoint must be a valid http:// or https:// URL.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("Composio endpoint must use http:// or https://.");
  }
  if (u.username || u.password) {
    throw new Error("Do not embed credentials in the Composio endpoint URL.");
  }
  return u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, ""));
}

export function composioKeyStore(dataDir: string, opts: ComposioOptions = {}) {
  return createKeyStore({
    dataDir,
    slot: COMPOSIO_KEY_SLOT,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.secrets ? { backend: opts.secrets } : {}),
  });
}

export async function getComposioStatus(dataDir: string, opts: ComposioOptions = {}): Promise<{
  enabled: boolean;
  endpoint: string;
  keySource: "env" | "stored" | null;
  canStore: boolean;
}> {
  const plugin = listPlugins(dataDir).find((p) => p.id === "composio");
  const keys = composioKeyStore(dataDir, opts);
  const [st, storage] = await Promise.all([
    keys.status().catch(() => ({ source: null })),
    keys.storage().catch(() => null),
  ]);
  let endpoint = plugin?.endpoint?.trim() || COMPOSIO_DEFAULT_BASE_URL;
  try {
    endpoint = validateComposioEndpoint(endpoint);
  } catch {
    /* keep raw draft for UI correction */
  }
  return {
    enabled: Boolean(plugin?.enabled),
    endpoint,
    keySource: st.source,
    canStore: Boolean(storage),
  };
}

async function composioRequest(
  dataDir: string,
  method: "GET" | "POST",
  pathAndQuery: string,
  opts: ComposioOptions & { body?: unknown } = {},
): Promise<unknown> {
  const plugin = listPlugins(dataDir).find((p) => p.id === "composio");
  if (!plugin?.enabled) {
    throw new Error("Composio plugin is disabled. Enable it in Plugins -> Composio.");
  }
  const base = validateComposioEndpoint(plugin.endpoint || COMPOSIO_DEFAULT_BASE_URL);
  const resolved = await composioKeyStore(dataDir, opts).resolve().catch(() => null);
  const key = resolved?.key ?? null;
  if (!key) {
    throw new Error("No COMPOSIO_API_KEY configured. Save your API key in Plugins -> Composio.");
  }

  let bodyStr: string | undefined;
  if (opts.body !== undefined) {
    const raw = JSON.stringify(opts.body);
    const masked = maskOutgoing(raw);
    if (!masked.ok) {
      throw new Error(
        `Blocked Composio call: secret detected in parameters (${masked.blocked.map((b) => b.kind).join(", ")}).`,
      );
    }
    bodyStr = masked.text;
  }

  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`${base}${pathAndQuery}`, {
    method,
    headers: {
      Accept: "application/json",
      "X-API-Key": key,
      ...(bodyStr !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(bodyStr !== undefined ? { body: bodyStr } : {}),
    signal: AbortSignal.timeout(COMPOSIO_TIMEOUT_MS),
  });
  const text = await res.text();
  const capped = text.length > COMPOSIO_MAX_RESPONSE_BYTES ? text.slice(0, COMPOSIO_MAX_RESPONSE_BYTES) : text;
  if (!res.ok) {
    throw new Error(`Composio API returned HTTP ${res.status}: ${capped.slice(0, 200)}`);
  }
  try {
    return JSON.parse(capped) as unknown;
  } catch {
    throw new Error("Composio API returned non-JSON output.");
  }
}

export async function composioListConnections(
  dataDir: string,
  opts: ComposioOptions = {},
): Promise<ComposioConnectionSummary[]> {
  const parsed = (await composioRequest(dataDir, "GET", "/connectedAccounts?pageSize=25", opts)) as Record<string, unknown>;
  const list = Array.isArray(parsed?.["items"]) ? (parsed["items"] as unknown[]) : Array.isArray(parsed) ? parsed : [];
  return maskDeep(
    list
      .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"))
      .map((c) => ({
        id: String(c["id"] ?? ""),
        appName: String(c["appName"] ?? c["appUniqueId"] ?? "unknown"),
        status: String(c["status"] ?? "UNKNOWN"),
        createdAt: typeof c["createdAt"] === "string" ? c["createdAt"] : "",
      })),
  );
}

export async function composioListActions(
  dataDir: string,
  opts: ComposioOptions & { apps?: string; search?: string } = {},
): Promise<ComposioActionSummary[]> {
  const qs = new URLSearchParams({ limit: "30" });
  if (opts.apps?.trim()) qs.set("apps", opts.apps.trim());
  if (opts.search?.trim()) qs.set("filterImportantActions", "true");
  const parsed = (await composioRequest(dataDir, "GET", `/actions?${qs.toString()}`, opts)) as Record<string, unknown>;
  const list = Array.isArray(parsed?.["items"]) ? (parsed["items"] as unknown[]) : Array.isArray(parsed) ? parsed : [];
  return maskDeep(
    list
      .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"))
      .map((a) => ({
        name: String(a["name"] ?? ""),
        appName: String(a["appName"] ?? "unknown"),
        displayName: String(a["displayName"] ?? a["name"] ?? ""),
        description: String(a["description"] ?? "").slice(0, 200),
      })),
  );
}

export async function composioExecuteAction(
  dataDir: string,
  input: { actionName: string; entityId?: string; connectedAccountId?: string; params?: Record<string, unknown> },
  opts: ComposioOptions = {},
): Promise<{ ok: boolean; actionName: string; data: unknown }> {
  const action = input.actionName.trim();
  if (!action || !/^[A-Za-z0-9_.-]{2,120}$/.test(action)) {
    throw new Error("Invalid Composio actionName.");
  }
  const payload: Record<string, unknown> = {
    input: input.params ?? {},
    ...(input.entityId?.trim() ? { entityId: input.entityId.trim() } : { entityId: "default" }),
    ...(input.connectedAccountId?.trim() ? { connectedAccountId: input.connectedAccountId.trim() } : {}),
  };
  const out = await composioRequest(dataDir, "POST", `/actions/${encodeURIComponent(action)}/execute`, {
    ...opts,
    body: payload,
  });
  return maskDeep({ ok: true, actionName: action, data: out });
}
