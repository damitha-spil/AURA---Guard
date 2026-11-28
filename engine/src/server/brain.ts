// Model choice and API key API. Called from server.ts after the token cookie and the Host/Origin
// checks, so every route here is already behind them. It does not depend on the project:
// settings and the key are per machine. No response ever carries the key.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GuardConfig } from "../types.ts";
import { CLAUDE_INSTALL_HELP, discoverAgyModels, findClaude, runProgram, VERSION_TIMEOUT_MS } from "../brain/backends.ts";
import type { Launcher } from "../brain/backends.ts";
import { isModelBackend, loadCatalogue, MODEL_BACKENDS } from "../brain/models.ts";
import type { ModelBackend } from "../brain/models.ts";
import { discoverApiModels, forgetApiModels } from "../brain/openai-compat.ts";
import { discoverOpencodeModels } from "../brain/opencode.ts";
import { findProvider, OPENAI_COMPAT } from "../brain/providers.ts";
import type { OpenAiCompatProvider } from "../brain/providers.ts";
import { createKeyStore, KeyStoreError, scrubSecrets, validateApiKey } from "../brain/keystore.ts";
import type { KeyStore } from "../brain/keystore.ts";
import { createBrain, describeBackends, providerSlot } from "../brain/select.ts";
import type { SelectOptions } from "../brain/select.ts";
import type { CompleteFn } from "../brain/client.ts";
import { effectiveBrain, loadSettings, machineDataDir, updateSettings } from "../brain/settings.ts";
import type { EffectiveBrain } from "../brain/settings.ts";
import { sendJson } from "./http.ts";

/** These bodies are a few words or one key; anything bigger is refused. */
export const BRAIN_MAX_BODY_BYTES = 4 * 1024;

export interface BrainRouteOptions extends SelectOptions {
  /** Replaces the real model call in POST /api/brain/test (tests). */
  complete?: CompleteFn;
}

export interface BrainRouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  method: string;
  /** The server's config (settings are per machine). */
  cfg: GuardConfig;
  options?: BrainRouteOptions;
}

const LABELS: Record<string, string> = {
  "anthropic-api": "Anthropic API key",
  "claude-cli": "Claude plan (Claude Code)",
  "antigravity-cli": "Antigravity plan (Antigravity CLI)",
  "opencode-cli": "OpenCode sign-ins (OpenCode CLI)",
  ...Object.fromEntries(OPENAI_COMPAT.map((p) => [p.id, p.label])),
};
const TEST_TOKENS = 20;

class RouteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new RouteError(415, "Send JSON.");
  if (Number(req.headers["content-length"] ?? 0) > BRAIN_MAX_BODY_BYTES) throw new RouteError(413, "That request is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BRAIN_MAX_BODY_BYTES) throw new RouteError(413, "That request is too large.");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new RouteError(400, "That was not valid JSON.");
  }
}

/** Without a provider this is the Anthropic key. */
function keyStoreFor(cfg: GuardConfig, o: BrainRouteOptions, p?: OpenAiCompatProvider): KeyStore {
  const backend = p ? o.secretsFor?.(p.id) : o.secrets;
  return createKeyStore({ dataDir: machineDataDir(cfg), ...(p ? { slot: providerSlot(p) } : {}), ...(o.env ? { env: o.env } : {}), ...(backend ? { backend } : {}) });
}

/** Every key Guard knows, so error text can hide all of them. */
async function allSecrets(cfg: GuardConfig, o: BrainRouteOptions): Promise<string[]> {
  const stores = [keyStoreFor(cfg, o), ...OPENAI_COMPAT.map((p) => keyStoreFor(cfg, o, p))];
  return (await Promise.all(stores.map((s) => s.secretsForScrub().catch(() => [] as string[])))).flat();
}

async function planCli(o: BrainRouteOptions): Promise<{ found: boolean; version?: string; path?: string; help?: string }> {
  const env = o.env ?? process.env;
  const l: Launcher | null = o.launcher !== undefined ? o.launcher : findClaude({ env, ...(o.home ? { home: o.home } : {}) });
  if (!l) return { found: false, help: CLAUDE_INSTALL_HELP };
  const clean: Record<string, string | undefined> = { ...env };
  delete clean.ANTHROPIC_API_KEY;
  try {
    const r = await runProgram({ launcher: l, args: ["--version"], stdin: "", timeoutMs: VERSION_TIMEOUT_MS, env: clean });
    const version = r.code === 0 ? (r.stdout.trim().split("\n")[0] ?? "").slice(0, 80) : "";
    return { found: true, ...(version ? { version } : {}), path: l.command };
  } catch {
    return { found: true, path: l.command };
  }
}

/** The shape of GET /api/brain. No secrets: the key is described only by where it comes from. */
export async function brainView(cfg: GuardConfig, o: BrainRouteOptions = {}) {
  const env = o.env ?? process.env;
  const eff: EffectiveBrain = effectiveBrain(cfg, env);
  const d = await describeBackends(cfg, o);
  const keys = keyStoreFor(cfg, o);
  const status = await keys.status();
  const storage = await keys.storage();
  const catalogue = [...loadCatalogue(cfg.root)];
  // Turned-off providers are not asked for anything.
  const saved = loadSettings(machineDataDir(cfg)).settings.providers ?? {};
  const off = (id: string): boolean => saved[id]?.enabled === false;
  const liveAgy = off("antigravity-cli") ? [] : await discoverAgyModels({
    ...(o.env ? { env: o.env } : {}),
    ...(o.home ? { home: o.home } : {}),
    ...(o.launcher !== undefined ? { launcher: o.launcher } : {}),
  });
  for (const { id, label } of liveAgy) {
    if (!catalogue.some((m) => m.id === id && m.backends.includes("antigravity-cli"))) {
      catalogue.push({ id, label, note: "Available on your Antigravity CLI subscription.", backends: ["antigravity-cli"] });
    }
  }
  const opencodeIds = off("opencode-cli") ? [] : await discoverOpencodeModels({
    ...(o.env ? { env: o.env } : {}),
    ...(o.home ? { home: o.home } : {}),
    ...(o.launcher !== undefined ? { launcher: o.launcher } : {}),
  });
  for (const id of opencodeIds) catalogue.push({ id, label: id.replace("/", " / "), note: "", backends: ["opencode-cli"] });
  const providers = await Promise.all(OPENAI_COMPAT.map(async (p) => {
    const store = keyStoreFor(cfg, o, p);
    const st = await store.status();
    // The list is asked for only when this provider already has a key.
    const key = st.source && !off(p.id) ? await store.resolve().catch(() => null) : null;
    const ids = key ? await discoverApiModels(p, key.key, o.fetch) : [];
    return { row: { id: p.id as string, label: p.label as string, env: p.env as string, source: st.source }, ids };
  }));
  for (const { row, ids } of providers) {
    for (const id of ids) catalogue.push({ id, label: id, note: "", backends: [row.id as ModelBackend] });
  }
  const activeModel = isModelBackend(d.picked) ? eff.models[d.picked].id : "";
  return {
    wanted: d.wanted,
    wantedSource: eff.backendSource,
    picked: d.picked,
    reason: d.picked
      ? `Guard will use ${LABELS[d.picked] ?? d.picked}${activeModel ? ` (${activeModel})` : ""}.`
      : "No model is ready. Save an API key and pick its model, or sign in to a plan CLI.",
    backends: d.rows.map((r) => ({ id: r.id, kind: r.kind, label: LABELS[r.id] ?? r.id, available: r.status.ok, detail: r.status.detail })),
    models: {
      current: Object.fromEntries(MODEL_BACKENDS.map((b) => [b, eff.models[b].id])),
      sources: Object.fromEntries(MODEL_BACKENDS.map((b) => [b, eff.models[b].source])),
      catalogue,
    },
    apiKey: { source: status.source, storage, canStore: storage !== null },
    apiKeys: [
      { id: "anthropic-api", label: LABELS["anthropic-api"]!, env: "ANTHROPIC_API_KEY", source: status.source },
      ...providers.map((x) => x.row),
    ],
    planCli: off("claude-cli") ? { found: false, help: "The Claude plan is turned off in Providers." } : await planCli(o),
    ...(eff.problem ? { problem: eff.problem } : {}),
  };
}

/** Runs one tiny masked round trip through whatever is selected now. */
async function runTest(cfg: GuardConfig, o: BrainRouteOptions) {
  const eff = effectiveBrain(cfg, o.env ?? process.env);
  const t0 = Date.now();
  let backend: string | null = null;
  try {
    const brain = o.complete ? null : createBrain(cfg, o);
    const complete: CompleteFn = o.complete ?? brain!.complete;
    if (o.complete) backend = (await describeBackends(cfg, o)).picked ?? eff.backend;
    const r = await complete({
      role: "brain-test",
      system: ["You are a connectivity check. Reply with exactly one word."],
      user: "Reply with the word OK",
      maxTokens: TEST_TOKENS,
    });
    backend = brain?.backendUsed() ?? backend;
    const model = isModelBackend(backend) ? eff.models[backend].id : "";
    const ok = /\bok\b/i.test(r.text);
    return { ok, backend, model, ms: Date.now() - t0, ...(ok ? {} : { error: "The model answered, but not with the expected word." }) };
  } catch (e) {
    const brain = backend;
    const model = isModelBackend(brain) ? eff.models[brain].id : "";
    const text = scrubSecrets(e instanceof Error ? e.message : "The test failed.", await allSecrets(cfg, o)).slice(0, 400);
    return { ok: false, backend: brain, model, ms: Date.now() - t0, error: text };
  }
}

let testRunning = false;

/** Returns false when the path is not a brain route, so the caller keeps routing. */
export async function handleBrainRoute(ctx: BrainRouteCtx): Promise<boolean> {
  const { req, res, path, method, cfg } = ctx;
  if (path !== "/api/brain" && !path.startsWith("/api/brain/")) return false;
  const o = ctx.options ?? {};
  res.setHeader("Cache-Control", "no-store");
  const dir = machineDataDir(cfg);
  const wrongMethod = (): never => { throw new RouteError(405, "That method is not allowed here."); };
  try {
    if (path === "/api/brain") {
      if (method === "GET") return sendJson(res, 200, await brainView(cfg, o)), true;
      if (method !== "PUT") return wrongMethod();
      const body = await readBody(req);
      for (const k of Object.keys(body)) if (k !== "backend" && k !== "models") throw new RouteError(400, `Unknown field "${k.slice(0, 40)}".`);
      const r = updateSettings(dir, { backend: body["backend"], models: body["models"] });
      if (!r.ok) throw new RouteError(400, r.error);
      return sendJson(res, 200, await brainView(cfg, o)), true;
    }

    // /api/brain/key is the Anthropic key; /api/brain/key/<provider id> is another provider's.
    if (path === "/api/brain/key" || path.startsWith("/api/brain/key/")) {
      const id = path.slice("/api/brain/key/".length);
      const provider = findProvider(id);
      if (id && !provider && id !== "anthropic-api") throw new RouteError(404, "Not found.");
      const keys = keyStoreFor(cfg, o, provider);
      if (provider && method !== "GET") forgetApiModels(provider.id);
      if (method === "PUT") {
        const body = await readBody(req);
        const v = validateApiKey(body["key"]);
        if (!v.ok) throw new RouteError(400, v.error);
        try {
          await keys.set(v.key);
        } catch (e) {
          if (e instanceof KeyStoreError) throw new RouteError(400, scrubSecrets(e.message, [v.key]));
          throw e;
        }
        const st = await keys.status();
        return sendJson(res, 200, st.source === "env"
          ? { ok: true, source: "env", stored: true, message: `Saved. The ${provider?.env ?? "ANTHROPIC_API_KEY"} environment variable is set and is used instead of the saved key.` }
          : { ok: true, source: "stored", stored: true }), true;
      }
      if (method === "DELETE") {
        await keys.remove();
        const st = await keys.status();
        return sendJson(res, 200, { ok: true, source: st.source, stored: false }), true;
      }
      return wrongMethod();
    }

    if (path === "/api/brain/test") {
      if (method !== "POST") return wrongMethod();
      if (testRunning) throw new RouteError(409, "A test is already running.");
      testRunning = true;
      try {
        return sendJson(res, 200, await runTest(cfg, o)), true;
      } finally {
        testRunning = false;
      }
    }
    throw new RouteError(404, "Not found.");
  } catch (e) {
    if (res.headersSent) { res.end(); return true; }
    if (e instanceof RouteError) {
      if (e.status === 413) res.setHeader("Connection", "close");
      return sendJson(res, e.status, { error: e.message }), true;
    }
    const known = await allSecrets(cfg, o);
    const msg = e instanceof KeyStoreError ? scrubSecrets(e.message, known) : "Something went wrong with the model settings.";
    return sendJson(res, 500, { error: msg }), true;
  }
}

