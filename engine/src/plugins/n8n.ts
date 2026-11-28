// SPIL REO — n8n Automation Integration (workflows, executions, and masked webhook triggers).
// API key is stored encrypted via createKeyStore; outgoing webhook payloads pass maskOutgoing first.

import { createKeyStore } from "../brain/keystore.ts";
import type { KeySlot, SecretBackend } from "../brain/keystore.ts";
import { maskOutgoing } from "../mask/mask.ts";
import { listPlugins } from "./store.ts";

/** Encrypted key slot for n8n API keys (never saved in plain JSON). */
export const N8N_KEY_SLOT: KeySlot = { name: "n8n", env: "N8N_API_KEY" };
/** Bound network calls so an unreachable n8n server never hangs REO. */
export const N8N_TIMEOUT_MS = 15_000;
/** Cap response size read from n8n REST or webhook calls. */
export const N8N_MAX_RESPONSE_BYTES = 128 * 1024;

export interface N8nWorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string;
  tags: string[];
  webhookPaths: string[];
}

export interface N8nExecutionSummary {
  id: string;
  workflowId: string;
  status: string;
  startedAt: string;
  stoppedAt: string;
  mode: string;
}

export interface N8nOptions {
  env?: NodeJS.ProcessEnv;
  secrets?: SecretBackend;
  fetchFn?: typeof fetch;
}

export function validateN8nEndpoint(raw: string): string {
  const text = raw.trim();
  if (!text) throw new Error("n8n endpoint URL is required.");
  if (/[\s\x00-\x1f]/.test(text)) throw new Error("n8n endpoint URL cannot contain spaces or control characters.");
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error("n8n endpoint must be a valid http:// or https:// URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("n8n endpoint must use http:// or https://.");
  }
  if (u.username || u.password) {
    throw new Error("Do not embed credentials in the n8n URL.");
  }
  return u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, ""));
}

export function n8nKeyStore(dataDir: string, opts: N8nOptions = {}) {
  return createKeyStore({
    dataDir,
    slot: N8N_KEY_SLOT,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.secrets ? { backend: opts.secrets } : {}),
  });
}

export async function getN8nStatus(dataDir: string, opts: N8nOptions = {}): Promise<{
  enabled: boolean;
  endpoint: string;
  keySource: "env" | "stored" | null;
  canStore: boolean;
}> {
  const plugin = listPlugins(dataDir).find((p) => p.id === "n8n");
  const keys = n8nKeyStore(dataDir, opts);
  const [st, storage] = await Promise.all([
    keys.status().catch(() => ({ source: null })),
    keys.storage().catch(() => null),
  ]);
  let endpoint = plugin?.endpoint?.trim() || "";
  if (endpoint) {
    try {
      endpoint = validateN8nEndpoint(endpoint);
    } catch {
      /* leave invalid draft as-is for UI error feedback */
    }
  }
  return {
    enabled: Boolean(plugin?.enabled),
    endpoint,
    keySource: st.source,
    canStore: Boolean(storage),
  };
}

function requireEndpoint(dataDir: string): string {
  const plugin = listPlugins(dataDir).find((p) => p.id === "n8n");
  if (!plugin?.enabled) {
    throw new Error("n8n Automation plugin is disabled. Enable it in Plugins -> n8n Automation.");
  }
  return validateN8nEndpoint(plugin.endpoint || "");
}

async function readLimitedText(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > N8N_MAX_RESPONSE_BYTES ? text.slice(0, N8N_MAX_RESPONSE_BYTES) : text;
}

async function n8nApiJson(dataDir: string, pathAndQuery: string, opts: N8nOptions = {}): Promise<unknown> {
  const base = requireEndpoint(dataDir);
  const resolved = await n8nKeyStore(dataDir, opts).resolve().catch(() => null);
  const key = resolved?.key ?? null;
  if (!key) {
    throw new Error("No N8N_API_KEY configured. Save your n8n API key in Plugins -> n8n Automation.");
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`${base}${pathAndQuery}`, {
    method: "GET",
    headers: { Accept: "application/json", "X-N8N-API-KEY": key },
    signal: AbortSignal.timeout(N8N_TIMEOUT_MS),
  });
  const bodyText = await readLimitedText(res);
  if (!res.ok) {
    throw new Error(`n8n API returned HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error("n8n API returned non-JSON output.");
  }
}

function extractWebhookPaths(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return [];
  const paths: string[] = [];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const rec = n as Record<string, unknown>;
    const type = typeof rec["type"] === "string" ? rec["type"] : "";
    if (!type.toLowerCase().includes("webhook")) continue;
    const params = rec["parameters"];
    if (params && typeof params === "object") {
      const p = (params as Record<string, unknown>)["path"];
      if (typeof p === "string" && p.trim()) paths.push(p.trim());
    }
  }
  return paths;
}

export async function n8nListWorkflows(dataDir: string, opts: N8nOptions = {}): Promise<N8nWorkflowSummary[]> {
  const parsed = (await n8nApiJson(dataDir, "/api/v1/workflows?limit=25", opts)) as Record<string, unknown>;
  const list = Array.isArray(parsed?.["data"]) ? (parsed["data"] as unknown[]) : Array.isArray(parsed) ? parsed : [];
  return list
    .filter((w): w is Record<string, unknown> => Boolean(w && typeof w === "object"))
    .map((w) => ({
      id: String(w["id"] ?? ""),
      name: String(w["name"] ?? "Untitled workflow"),
      active: Boolean(w["active"]),
      updatedAt: typeof w["updatedAt"] === "string" ? w["updatedAt"] : "",
      tags: Array.isArray(w["tags"])
        ? w["tags"].map((t) => (typeof t === "string" ? t : String((t as Record<string, unknown>)?.["name"] ?? ""))).filter(Boolean)
        : [],
      webhookPaths: extractWebhookPaths(w["nodes"]),
    }));
}

export async function n8nListExecutions(
  dataDir: string,
  workflowId?: string,
  opts: N8nOptions = {},
): Promise<N8nExecutionSummary[]> {
  const safeId = workflowId?.trim();
  if (safeId && !/^[a-zA-Z0-9_-]{1,64}$/.test(safeId)) {
    throw new Error("Invalid workflowId format.");
  }
  const q = safeId ? `?limit=15&workflowId=${encodeURIComponent(safeId)}` : "?limit=15";
  const parsed = (await n8nApiJson(dataDir, `/api/v1/executions${q}`, opts)) as Record<string, unknown>;
  const list = Array.isArray(parsed?.["data"]) ? (parsed["data"] as unknown[]) : Array.isArray(parsed) ? parsed : [];
  return list
    .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === "object"))
    .map((e) => ({
      id: String(e["id"] ?? ""),
      workflowId: String(e["workflowId"] ?? ""),
      status: String(e["status"] ?? (e["finished"] ? "success" : "unknown")),
      startedAt: typeof e["startedAt"] === "string" ? e["startedAt"] : "",
      stoppedAt: typeof e["stoppedAt"] === "string" ? e["stoppedAt"] : "",
      mode: typeof e["mode"] === "string" ? e["mode"] : "webhook",
    }));
}

function resolveWebhookUrl(baseEndpoint: string, pathOrUrl: string): string {
  const raw = pathOrUrl.trim();
  if (!raw || /[\s\x00-\x1f]/.test(raw)) {
    throw new Error("Webhook path or URL is required.");
  }
  if (/^https?:\/\//i.test(raw)) {
    const baseUrl = new URL(baseEndpoint);
    const targetUrl = new URL(raw);
    if (targetUrl.origin !== baseUrl.origin) {
      throw new Error(`Webhook URL origin (${targetUrl.origin}) must match configured n8n endpoint (${baseUrl.origin}).`);
    }
    return targetUrl.toString();
  }
  const clean = raw.replace(/^\/+/, "");
  if (clean.startsWith("webhook/") || clean.startsWith("webhook-test/")) {
    return `${baseEndpoint}/${clean}`;
  }
  return `${baseEndpoint}/webhook/${clean}`;
}

export async function n8nTriggerWebhook(
  dataDir: string,
  input: { pathOrUrl: string; payload?: Record<string, unknown>; method?: "GET" | "POST" },
  opts: N8nOptions = {},
): Promise<{ ok: boolean; status: number; url: string; body: string }> {
  const base = requireEndpoint(dataDir);
  const url = resolveWebhookUrl(base, input.pathOrUrl);
  const method = input.method === "GET" ? "GET" : "POST";

  const rawJson = JSON.stringify(input.payload ?? {});
  const masked = maskOutgoing(rawJson);
  if (!masked.ok) {
    const kinds = masked.blocked.map((b) => b.kind).join(", ");
    throw new Error(`Blocked n8n webhook trigger: secret detected in payload (${kinds}).`);
  }

  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(url, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
    ...(method === "POST" ? { body: masked.text } : {}),
    signal: AbortSignal.timeout(N8N_TIMEOUT_MS),
  });
  const body = await readLimitedText(res);
  return { ok: res.ok, status: res.status, url, body };
}

export function buildN8nQaEventPayload(opts: {
  event: string;
  verdict?: string;
  summary: string;
  defects?: Array<{ id: string; title: string; severity: string }>;
}): Record<string, unknown> {
  return {
    source: "spil-reo",
    event: opts.event,
    ...(opts.verdict ? { verdict: opts.verdict } : {}),
    summary: opts.summary,
    defects: (opts.defects ?? []).slice(0, 10),
    timestamp: new Date().toISOString(),
  };
}
