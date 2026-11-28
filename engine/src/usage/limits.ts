// Plan and rate limits, only from what a provider itself returns to Guard: rate-limit headers on
// Guard's own API calls, the Claude CLI's rate_limit_event, and OpenRouter's key endpoint.
// No other app's credential files and no private endpoints. Nothing is estimated.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyStore } from "../brain/keystore.ts";
import type { SecretBackend } from "../brain/keystore.ts";
import { OPENAI_COMPAT } from "../brain/providers.ts";
import { loadSettings, machineDataDir } from "../brain/settings.ts";
import type { GuardConfig } from "../types.ts";
import { providerLabel } from "./report.ts";
import { readUsage } from "./record.ts";

export interface StoredWindow { label: string; percentLeft: number; resetsAt: string | null; windowSeconds: number | null }
interface Stored { capturedAt: string; windows: StoredWindow[] }

const limitsFile = (dataDir: string): string => join(dataDir, "usage-limits.json");

function readStored(dataDir: string): Record<string, Stored> {
  try { return JSON.parse(readFileSync(limitsFile(dataDir), "utf8")) as Record<string, Stored>; } catch { return {}; }
}

/** Never throws. An empty list keeps what was known before. */
export function saveLimits(dataDir: string, provider: string, windows: StoredWindow[], now: Date = new Date()): void {
  if (!windows.length) return;
  try {
    const all = readStored(dataDir);
    const merged = new Map((all[provider]?.windows ?? []).map((w) => [w.label, w]));
    for (const w of windows) merged.set(w.label, w);
    all[provider] = { capturedAt: now.toISOString(), windows: [...merged.values()] };
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(limitsFile(dataDir), JSON.stringify(all, null, 2), "utf8");
  } catch { /* limits are a by-product */ }
}

const percent = (x: number): number => Math.round(Math.min(100, Math.max(0, x)) * 10) / 10;

/** "1s", "6m0s", "20ms", "1h2m3.5s" as milliseconds; null when it is something else. */
export function parseDuration(text: string): number | null {
  if (!/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/.test(text)) return null;
  const unit: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  return [...text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)].reduce((sum, m) => sum + Number(m[1]) * (unit[m[2] as string] as number), 0);
}

/** Anthropic's anthropic-ratelimit-* headers and the x-ratelimit-* headers of OpenAI-style APIs. */
export function windowsFromHeaders(headers: { get(name: string): string | null }, now: Date = new Date()): StoredWindow[] {
  const out: StoredWindow[] = [];
  const add = (label: string, limit: string | null, remaining: string | null, resetsAt: string | null): void => {
    const l = Number(limit);
    if (limit === null || remaining === null || !(l > 0) || !Number.isFinite(Number(remaining))) return;
    out.push({ label, percentLeft: percent((Number(remaining) / l) * 100), resetsAt, windowSeconds: null });
  };
  for (const kind of ["requests", "tokens", "input-tokens", "output-tokens"]) {
    const label = `API ${kind.replace("-", " ")}`;
    const a = `anthropic-ratelimit-${kind}`;
    const at = headers.get(`${a}-reset`);
    add(label, headers.get(`${a}-limit`), headers.get(`${a}-remaining`), at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null);
    const ms = parseDuration(headers.get(`x-ratelimit-reset-${kind}`) ?? "");
    add(label, headers.get(`x-ratelimit-limit-${kind}`), headers.get(`x-ratelimit-remaining-${kind}`), ms === null ? null : new Date(now.getTime() + ms).toISOString());
  }
  return out;
}

const CLI_WINDOWS: Record<string, { label: string; seconds: number }> = {
  five_hour: { label: "5-hour limit", seconds: 5 * 3600 },
  seven_day: { label: "Weekly limit", seconds: 7 * 86_400 },
  seven_day_opus: { label: "Weekly Opus limit", seconds: 7 * 86_400 },
  seven_day_sonnet: { label: "Weekly Sonnet limit", seconds: 7 * 86_400 },
};

/** The rate_limit_event lines of `claude --output-format stream-json`. utilization is the used share, 0 to 1. */
export function windowsFromClaudeStream(stdout: string): StoredWindow[] {
  const found = new Map<string, StoredWindow>();
  for (const line of stdout.split("\n")) {
    if (!line.includes("rate_limit_event")) continue;
    let info: any;
    try {
      const v = JSON.parse(line.trim());
      if (v?.type !== "rate_limit_event") continue;
      info = v.rate_limit_info;
    } catch { continue; }
    if (!info) continue;
    const entries: [string, any][] = info.unifiedWindows ? Object.entries(info.unifiedWindows) : [[String(info.rateLimitType ?? ""), info]];
    for (const [type, w] of entries) {
      // "rejected" is the provider saying the limit is used up. Without a number there is no percentage.
      const used = typeof w?.utilization === "number" ? w.utilization : w?.status === "rejected" ? 1 : null;
      if (!type || used === null) continue;
      const known = Object.hasOwn(CLI_WINDOWS, type) ? CLI_WINDOWS[type] : undefined;
      found.set(type, {
        label: known?.label ?? type.replace(/_/g, " ").slice(0, 40),
        percentLeft: percent((1 - used) * 100),
        resetsAt: typeof w.resetsAt === "number" ? new Date(w.resetsAt * 1000).toISOString() : null,
        windowSeconds: known?.seconds ?? null,
      });
    }
  }
  return [...found.values()];
}

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const LIMIT_TIMEOUT_MS = 6_000;

export interface LimitsOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  secretsFor?: (providerId: string) => SecretBackend;
  now?: () => Date;
}

async function openRouterWindow(key: string, doFetch: typeof fetch): Promise<{ windows: StoredWindow[]; note: string | null }> {
  try {
    const res = await doFetch(OPENROUTER_KEY_URL, { headers: { authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(LIMIT_TIMEOUT_MS) });
    if (!res.ok) return { windows: [], note: `OpenRouter answered ${res.status} when asked about the key's limit.` };
    const d = ((await res.json()) as { data?: { limit?: unknown; limit_remaining?: unknown; limit_reset?: unknown } }).data;
    if (typeof d?.limit !== "number" || !(d.limit > 0) || typeof d.limit_remaining !== "number") {
      return { windows: [], note: "No spending limit is set on this OpenRouter key." };
    }
    const reset = typeof d.limit_reset === "string" ? ` (resets ${d.limit_reset.slice(0, 20)})` : "";
    return { windows: [{ label: `Key credit limit${reset}`, percentLeft: percent((d.limit_remaining / d.limit) * 100), resetsAt: null, windowSeconds: null }], note: null };
  } catch {
    return { windows: [], note: "OpenRouter could not be reached." };
  }
}

const NO_DATA: Record<string, string> = {
  "claude-cli": "No limit data yet. Claude Code reports it while answering, so ask one question with the Claude plan.",
  "antigravity-cli": "The Antigravity CLI has no command or output that reports plan limits to REO.",
  "opencode-cli": "OpenCode does not report the limits of the plans it signs in to.",
};

export async function limitsReport(cfg: GuardConfig, o: LimitsOptions = {}) {
  const now = o.now?.() ?? new Date();
  const env = o.env ?? process.env;
  const stored = readStored(cfg.dataDir);
  const used = new Set(readUsage(cfg.dataDir).map((r) => r.backend));
  const withKey = new Set<string>();
  let openRouterKey = "";
  for (const p of OPENAI_COMPAT) {
    const secret = o.secretsFor?.(p.id);
    const store = createKeyStore({
      dataDir: machineDataDir(cfg), slot: { name: p.id.replace(/-api$/, ""), env: p.env }, env, ...(secret ? { backend: secret } : {}),
    });
    // Only OpenRouter's key is read here (it goes to OpenRouter only); the others only decide whether to be listed.
    if (p.id === "openrouter-api") {
      openRouterKey = (await store.resolve().catch(() => null))?.key ?? "";
      if (openRouterKey) withKey.add(p.id);
    } else if (env[p.env] || (await store.hasStored().catch(() => false))) withKey.add(p.id);
  }
  const ids = ["claude-cli", "anthropic-api", "antigravity-cli", "opencode-cli",
    ...OPENAI_COMPAT.map((p) => p.id as string).filter((id) => withKey.has(id) || used.has(id) || stored[id])];

  const providers = [];
  for (const id of ids) {
    const s = stored[id];
    // A window whose reset time has passed no longer says anything.
    const live = (s?.windows ?? []).filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > now.getTime());
    let note: string | null = s && live.length ? `Last reported ${s.capturedAt} during a REO call.`
      : s ? `The last report (${s.capturedAt}) is out of date: its limit windows have reset.`
      : NO_DATA[id] ?? "No limit data yet. It appears if the provider sends rate-limit headers on a REO call.";
    let extra: StoredWindow[] = [];
    if (id === "openrouter-api" && openRouterKey && loadSettings(cfg.dataDir).settings.providers?.[id]?.enabled !== false) {
      const r = await openRouterWindow(openRouterKey, o.fetch ?? fetch);
      extra = r.windows;
      if (!live.length) note = r.note;
    }
    providers.push({
      id, label: providerLabel(id),
      windows: [...extra, ...live].map((w) => ({
        label: w.label, percentLeft: w.percentLeft, resetsAt: w.resetsAt,
        elapsedPercent: w.resetsAt && w.windowSeconds ? percent((1 - (Date.parse(w.resetsAt) - now.getTime()) / (w.windowSeconds * 1000)) * 100) : null,
      })),
      note,
    });
  }
  return { checkedAt: now.toISOString(), providers };
}
