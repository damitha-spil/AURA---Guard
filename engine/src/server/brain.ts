// Model choice and API key API. Called from server.ts after the token cookie and the Host/Origin
// checks, so every route here is already behind them. It does not depend on the project:
// settings and the key are per machine. No response ever carries the key.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GuardConfig } from "../types.ts";
import { CLAUDE_INSTALL_HELP, findClaude, runProgram, VERSION_TIMEOUT_MS } from "../brain/backends.ts";
import type { Launcher } from "../brain/backends.ts";
import { loadCatalogue } from "../brain/models.ts";
import { createKeyStore, KeyStoreError, scrubSecrets, validateApiKey } from "../brain/keystore.ts";
import type { KeyStore } from "../brain/keystore.ts";
import { createBrain, describeBackends } from "../brain/select.ts";
import type { SelectOptions } from "../brain/select.ts";
import type { CompleteFn } from "../brain/client.ts";
import { effectiveBrain, machineDataDir, updateSettings } from "../brain/settings.ts";
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

const LABELS: Record<string, string> = { "anthropic-api": "Anthropic API key", "claude-cli": "Claude plan (Claude Code)" };
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

function keyStoreFor(cfg: GuardConfig, o: BrainRouteOptions): KeyStore {
  return createKeyStore({ dataDir: machineDataDir(cfg), ...(o.env ? { env: o.env } : {}), ...(o.secrets ? { backend: o.secrets } : {}) });
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
  return {
    wanted: d.wanted,
    wantedSource: eff.backendSource,
    picked: d.picked,
    reason: d.picked
      ? `Guard will use ${LABELS[d.picked] ?? d.picked}.`
      : "No model is ready. Save an API key, or sign in to Claude Code.",
    backends: d.rows.map((r) => ({ id: r.id, kind: r.kind, label: LABELS[r.id] ?? r.id, available: r.status.ok, detail: r.status.detail })),
    models: {
      current: { "anthropic-api": eff.models["anthropic-api"].id, "claude-cli": eff.models["claude-cli"].id },
      sources: { "anthropic-api": eff.models["anthropic-api"].source, "claude-cli": eff.models["claude-cli"].source },
      catalogue: loadCatalogue(cfg.root),
    },
    apiKey: { source: status.source, storage, canStore: storage !== null },
    planCli: await planCli(o),
    ...(eff.problem ? { problem: eff.problem } : {}),
  };
}

/** Runs one tiny masked round trip through whatever is selected now. */
async function runTest(cfg: GuardConfig, o: BrainRouteOptions, keys: KeyStore) {
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
    const model = backend === "anthropic-api" || backend === "claude-cli" ? eff.models[backend].id : "";
    const ok = /\bok\b/i.test(r.text);
    return { ok, backend, model, ms: Date.now() - t0, ...(ok ? {} : { error: "The model answered, but not with the expected word." }) };
  } catch (e) {
    const brain = backend;
    const model = brain === "anthropic-api" || brain === "claude-cli" ? eff.models[brain].id : "";
    const text = scrubSecrets(e instanceof Error ? e.message : "The test failed.", await keys.secretsForScrub()).slice(0, 400);
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
  const keys = keyStoreFor(cfg, o);
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

    if (path === "/api/brain/key") {
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
          ? { ok: true, source: "env", stored: true, message: "Saved. The ANTHROPIC_API_KEY environment variable is set and is used instead of the saved key." }
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
        return sendJson(res, 200, await runTest(cfg, o, keys)), true;
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
    const known = await keys.secretsForScrub().catch(() => [] as string[]);
    const msg = e instanceof KeyStoreError ? scrubSecrets(e.message, known) : "Something went wrong with the model settings.";
    return sendJson(res, 500, { error: msg }), true;
  }
}

