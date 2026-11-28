// GET and PUT /api/providers. The server has already checked the cookie, Host and Origin.

import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { findAgy, findClaude } from "../brain/backends.ts";
import { createKeyStore } from "../brain/keystore.ts";
import { isModelBackend, MODEL_BACKENDS } from "../brain/models.ts";
import type { ModelBackend } from "../brain/models.ts";
import { findOpencode } from "../brain/opencode.ts";
import {
  binaryPathProblem, CLI_PROGRAMS, DEFAULT_HEALTH_SECONDS, HOME_DIR_ENV, homeDirProblem, MAX_DISPLAY_NAME,
  MAX_HEALTH_SECONDS, MIN_HEALTH_SECONDS,
} from "../brain/provider-config.ts";
import type { ProviderEntry } from "../brain/provider-config.ts";
import { findProvider } from "../brain/providers.ts";
import { buildBackends, pickBackend, providerSlot } from "../brain/select.ts";
import { effectiveBrain, loadSettings, machineDataDir, saveSettings } from "../brain/settings.ts";
import { providerLabel } from "../usage/report.ts";
import type { GuardConfig } from "../types.ts";
import type { BrainRouteOptions } from "./brain.ts";
import { HttpError, readJson, sendJson } from "./http.ts";

const SIGNIN_ARGS: Record<string, readonly string[]> = {
  "antigravity-cli": ["auth", "login"],
  "claude-cli": ["auth", "login"],
  "opencode-cli": ["auth", "login"],
};

async function providersView(cfg: GuardConfig, o: BrainRouteOptions) {
  const env = o.env ?? process.env;
  const dir = machineDataDir(cfg);
  const settings = loadSettings(dir).settings;
  const eff = effectiveBrain(cfg, env);
  const backends = buildBackends(cfg, o);
  let picked: string | null = null;
  try { picked = (await pickBackend(cfg, o)).backend.id; } catch { /* none is ready */ }
  const find = { "claude-cli": findClaude, "antigravity-cli": findAgy, "opencode-cli": findOpencode } as const;
  const providers = await Promise.all(backends.map(async (b) => {
    const id = b.id as ModelBackend;
    const entry: ProviderEntry = settings.providers?.[id] ?? {};
    const enabled = entry.enabled !== false;
    const api = findProvider(id);
    const envVar = id === "anthropic-api" ? "ANTHROPIC_API_KEY" : api?.env ?? null;
    let keySource: "env" | "stored" | null = null;
    if (envVar) {
      const secret = api ? o.secretsFor?.(id) : o.secrets;
      const keys = createKeyStore({ dataDir: dir, ...(api ? { slot: providerSlot(api) } : {}), ...(o.env ? { env: o.env } : {}), ...(secret ? { backend: secret } : {}) });
      keySource = (await keys.status().catch(() => ({ source: null }))).source;
    }
    // A disabled provider's `available` answers without probing anything.
    const status = await b.available().catch(() => ({ ok: false, detail: "The check failed." }));
    const badPath = enabled && entry.binaryPath ? binaryPathProblem(id, entry.binaryPath) : null;
    const cli = id in CLI_PROGRAMS;
    return {
      id, label: providerLabel(id), displayName: entry.displayName ?? null, kind: b.kind, enabled,
      available: status.ok, inUse: picked === id,
      version: cli && enabled ? /\b\d+\.\d+\.\d+\b/.exec(status.detail)?.[0] ?? null : null,
      detail: badPath ? `The saved program path cannot be used: ${badPath}`
        : status.ok && !cli ? `${status.detail}. The key has not been checked with the provider.` : status.detail,
      model: eff.models[id].id,
      keySource, envVar,
      binaryPath: entry.binaryPath ?? null,
      detectedPath: cli && enabled ? find[id as keyof typeof find]({ env, ...(o.home ? { home: o.home } : {}) })?.command ?? null : null,
      homeDir: entry.homeDir ?? null,
      supportsHomeDir: id in HOME_DIR_ENV,
    };
  }));
  return { checkedAt: new Date().toISOString(), healthCheckSeconds: settings.healthCheckSeconds ?? DEFAULT_HEALTH_SECONDS, providers };
}

type View = Awaited<ReturnType<typeof providersView>>;

/** Applies one provider's change; `null` or "" clears a value. */
function changedEntry(id: string, current: ProviderEntry, body: Record<string, unknown>): ProviderEntry {
  const next: ProviderEntry = body["reset"] === true ? {} : { ...current };
  for (const [key, value] of Object.entries(body)) {
    if (key === "reset") {
      if (value !== true) throw new HttpError(400, "reset must be true.");
    } else if (key === "enabled") {
      if (typeof value !== "boolean" && value !== null) throw new HttpError(400, "enabled must be true or false.");
      if (value === false) next.enabled = false;
      else delete next.enabled;
    } else if (key === "displayName" || key === "binaryPath" || key === "homeDir") {
      if (value === null || value === "") { delete next[key]; continue; }
      if (typeof value !== "string") throw new HttpError(400, `${key} must be text.`);
      const text = value.trim();
      const problem = key === "binaryPath" ? binaryPathProblem(id, text)
        : key === "homeDir" ? homeDirProblem(id, text)
        : !text || text.length > MAX_DISPLAY_NAME || /[\x00-\x1f]/.test(text) ? `A name is 1 to ${MAX_DISPLAY_NAME} characters.` : null;
      if (problem) throw new HttpError(400, problem);
      next[key] = text;
    } else throw new HttpError(400, `Unknown field "${key.slice(0, 40)}".`);
  }
  return next;
}

export function createProviderRoutes() {
  let cached: { at: number; view: Promise<View> } | null = null;

  /** The health check is repeated after healthCheckSeconds; with 0 only when asked to refresh. */
  function view(cfg: GuardConfig, o: BrainRouteOptions, refresh: boolean): Promise<View> {
    const seconds = loadSettings(machineDataDir(cfg)).settings.healthCheckSeconds ?? DEFAULT_HEALTH_SECONDS;
    if (!refresh && cached && (seconds === 0 || Date.now() - cached.at < seconds * 1000)) return cached.view;
    const next = providersView(cfg, o);
    cached = { at: Date.now(), view: next };
    next.catch(() => { cached = null; });
    return next;
  }

  /** Forget what was checked, after any model setting or key change. */
  const forget = (): void => { cached = null; };

  async function handle(c: { req: IncomingMessage; res: ServerResponse; path: string; method: string; cfg: GuardConfig; options: BrainRouteOptions }): Promise<boolean> {
    const m = /^\/api\/providers(?:\/([^/]+?)(?:\/(signin))?)?$/.exec(c.path);
    if (!m) return false;
    const id = m[1];
    const action = m[2];
    if (action === "signin") {
      if (c.method !== "POST") throw new HttpError(405, "That method is not allowed here.");
      if (!id || !isModelBackend(id) || !MODEL_BACKENDS.includes(id)) throw new HttpError(404, "No such provider.");
      const args = SIGNIN_ARGS[id];
      if (!args) throw new HttpError(400, "This provider uses an API key instead of CLI sign-in.");
      const env = c.options.env ?? process.env;
      const dir = machineDataDir(c.cfg);
      const loaded = loadSettings(dir);
      const entry: ProviderEntry = loaded.settings.providers?.[id] ?? {};
      const find = { "claude-cli": findClaude, "antigravity-cli": findAgy, "opencode-cli": findOpencode } as const;
      const customOk = entry.binaryPath && !binaryPathProblem(id, entry.binaryPath) ? entry.binaryPath : null;
      const binPath = customOk ?? find[id as keyof typeof find]({ env, ...(c.options.home ? { home: c.options.home } : {}) })?.command ?? null;
      if (!binPath) throw new HttpError(400, `Could not find the ${CLI_PROGRAMS[id]} CLI on this computer.`);
      const childEnv = { ...env, ...(entry.homeDir && HOME_DIR_ENV[id] ? { [HOME_DIR_ENV[id]]: entry.homeDir } : {}) };
      const child = spawn(binPath, [...args], { detached: true, stdio: "ignore", env: childEnv });
      child.on("error", () => { /* ignored: detached sign-in process */ });
      child.unref();
      forget();
      sendJson(c.res, 200, { ok: true, message: "Official sign-in started. Complete sign-in in your browser, then refresh status." });
      return true;
    }
    const done = async (refresh: boolean): Promise<true> => (sendJson(c.res, 200, await view(c.cfg, c.options, refresh)), true);
    if (!id && c.method === "GET") return done(new URL(c.req.url ?? "/", "http://x").searchParams.get("refresh") === "1");
    if (c.method !== "PUT") throw new HttpError(405, "That method is not allowed here.");
    if (id && (!isModelBackend(id) || !MODEL_BACKENDS.includes(id))) throw new HttpError(404, "No such provider.");
    const body = await readJson(c.req);
    const dir = machineDataDir(c.cfg);
    const loaded = loadSettings(dir);
    // Saving over an unreadable file would silently turn providers back on.
    if (loaded.problem) throw new HttpError(409, loaded.problem);
    const settings = loaded.settings;
    if (id) {
      const providers = { ...settings.providers };
      const entry = changedEntry(id, providers[id] ?? {}, body);
      if (Object.keys(entry).length) providers[id] = entry;
      else delete providers[id];
      saveSettings(dir, { ...settings, providers });
    } else {
      const s = body["healthCheckSeconds"];
      if (Object.keys(body).length !== 1 || typeof s !== "number" || !Number.isInteger(s) || (s !== 0 && (s < MIN_HEALTH_SECONDS || s > MAX_HEALTH_SECONDS))) {
        throw new HttpError(400, `Send healthCheckSeconds: 0, or ${MIN_HEALTH_SECONDS} to ${MAX_HEALTH_SECONDS}.`);
      }
      saveSettings(dir, { ...settings, healthCheckSeconds: s });
    }
    forget();
    return done(true);
  }
  return { handle, forget };
}
