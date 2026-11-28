import { createHash, randomBytes } from "node:crypto";
import { recordUsage } from "../usage/record.ts";
import { saveLimits } from "../usage/limits.ts";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import { auditOutgoing } from "../mask/audit.ts";
import { unmask } from "../mask/mask.ts";
import { anthropicApiBackend, antigravityCliBackend, claudeCliBackend } from "./backends.ts";
import type { Backend, BackendOptions, BackendStatus } from "./backends.ts";
import { createKeyStore } from "./keystore.ts";
import { MODEL_BACKENDS } from "./models.ts";
import type { ModelBackend } from "./models.ts";
import { openAiCompatBackend } from "./openai-compat.ts";
import { opencodeCliBackend } from "./opencode.ts";
import { OPENAI_COMPAT } from "./providers.ts";
import type { SecretBackend } from "./keystore.ts";
import { effectiveBrain, loadSettings, machineDataDir } from "./settings.ts";
import { binaryPathProblem, HOME_DIR_ENV, homeDirProblem } from "./provider-config.ts";
import { maskAll } from "./client.ts";
import type { CompleteFn, CompleteRequest, CompleteResult } from "./client.ts";

/** Backends in the order `auto` tries them. */
export const AUTO_BACKEND_IDS: readonly string[] = ["anthropic-api", "claude-cli", "antigravity-cli"];
export const BACKEND_IDS = MODEL_BACKENDS;
export type BackendId = ModelBackend;

/** The saved-key slot for an OpenAI-compatible provider. */
export const providerSlot = (p: { id: string; env: string }) => ({ name: p.id.replace(/-api$/, ""), env: p.env });

export class NoBackendError extends Error {
  constructor(detail: string) {
    super(
      "No model backend is available. Set ANTHROPIC_API_KEY, or install Claude Code and sign in " +
        "(it then uses your Claude plan). " + detail,
    );
    this.name = "NoBackendError";
  }
}

export interface SelectOptions extends BackendOptions {
  now?: () => Date;
  /** Replaces the OS secure store for the saved API key (tests). */
  secrets?: SecretBackend;
  /** The same for the other providers' keys, one store per provider id (tests). */
  secretsFor?: (providerId: string) => SecretBackend;
}

/** Backend and model come from env > settings.json > guard.config.local.json > default (settings.ts). */
export function buildBackends(cfg: GuardConfig, opts: SelectOptions = {}): Backend[] {
  const eff = effectiveBrain(cfg, opts.env ?? process.env);
  const keys = createKeyStore({ dataDir: machineDataDir(cfg), ...(opts.env ? { env: opts.env } : {}), ...(opts.secrets ? { backend: opts.secrets } : {}) });
  const storedKey = { exists: () => keys.hasStored(), get: async () => (await keys.resolve())?.key ?? null };
  const rest = { ...opts };
  delete rest.secrets;
  delete rest.secretsFor;
  const settings = loadSettings(machineDataDir(cfg)).settings.providers ?? {};
  /** The saved program path and settings folder of a CLI. A path that no longer passes the checks is not started. */
  const cli = (id: BackendId): BackendOptions => {
    const entry = settings[id] ?? {};
    const out: BackendOptions = { ...rest, model: eff.models[id].id };
    if (entry.binaryPath && opts.launcher === undefined && opts.opencodeLauncher === undefined) {
      const launcher = binaryPathProblem(id, entry.binaryPath) ? null : { command: entry.binaryPath, prefixArgs: [] };
      if (id === "opencode-cli") out.opencodeLauncher = launcher;
      else out.launcher = launcher;
    }
    const variable = HOME_DIR_ENV[id];
    if (variable && entry.homeDir && !homeDirProblem(id, entry.homeDir)) out.env = { ...(opts.env ?? process.env), [variable]: entry.homeDir };
    return out;
  };
  const all: Backend[] = [
    anthropicApiBackend({ ...rest, model: eff.models["anthropic-api"].id, storedKey }),
    claudeCliBackend(cli("claude-cli")),
    antigravityCliBackend(cli("antigravity-cli")),
    opencodeCliBackend(cli("opencode-cli")),
    ...OPENAI_COMPAT.map((p) => {
      const secret = opts.secretsFor?.(p.id);
      const store = createKeyStore({ dataDir: machineDataDir(cfg), slot: providerSlot(p), ...(opts.env ? { env: opts.env } : {}), ...(secret ? { backend: secret } : {}) });
      return openAiCompatBackend(p, {
        ...rest, model: eff.models[p.id].id,
        storedKey: { exists: () => store.hasStored(), get: async () => (await store.resolve())?.key ?? null },
      });
    }),
  ];
  // A turned-off provider is never probed, picked or called.
  return all.map((b) => (settings[b.id]?.enabled === false
    ? { id: b.id, kind: b.kind, available: async () => ({ ok: false, detail: TURNED_OFF }), complete: async () => { throw new NoBackendError(`${b.id}: ${TURNED_OFF}`); } }
    : b));
}

export const TURNED_OFF = "Turned off in Providers";

/** The wanted backend (see effectiveBrain): env QSB_BRAIN / AURA_GUARD_BRAIN, settings.json, config, else "auto". */
export function wantedBackend(cfg: GuardConfig, env: Record<string, string | undefined> = process.env): string {
  return effectiveBrain(cfg, env).backend.trim();
}

export interface Picked { backend: Backend; status: BackendStatus }

/**
 * Aura only uses a plan CLI when the person turns it on or picks a claude/ model; it never falls
 * back silently. Guard follows the brief: `auto` = API key if set, else the first available plan CLI.
 * A named backend is used as named (no fallback) and fails with its own reason.
 */
export async function pickBackend(cfg: GuardConfig, opts: SelectOptions = {}): Promise<Picked> {
  const env = opts.env ?? process.env;
  const want = wantedBackend(cfg, env);
  const all = buildBackends(cfg, opts);
  if (want !== "auto") {
    const b = all.find((x) => x.id === want);
    if (!b) throw new Error(`Unknown brain backend "${want}". Use auto, ${BACKEND_IDS.join(" or ")}.`);
    const status = await b.available();
    if (!status.ok) throw new NoBackendError(`${b.id}: ${status.detail}.`);
    return { backend: b, status };
  }
  const notes: string[] = [];
  // The other providers are only used when named: a key that happens to be in the environment
  // must not send project text to a company nobody chose.
  for (const b of all.filter((x) => AUTO_BACKEND_IDS.includes(x.id))) {
    const status = await b.available();
    if (status.ok) return { backend: b, status };
    notes.push(`${b.id}: ${status.detail}.`);
  }
  throw new NoBackendError(notes.join(" "));
}

/** Every backend with its status, and the id `auto`/config would pick (null when none). No secrets. */
export async function describeBackends(
  cfg: GuardConfig, opts: SelectOptions = {},
): Promise<{ wanted: string; rows: { id: string; kind: string; status: BackendStatus }[]; picked: string | null }> {
  const rows = [];
  for (const b of buildBackends(cfg, opts)) rows.push({ id: b.id, kind: b.kind, status: await b.available() });
  let picked: string | null = null;
  try { picked = (await pickBackend(cfg, opts)).backend.id; } catch { /* none */ }
  return { wanted: wantedBackend(cfg, opts.env ?? process.env), rows, picked };
}

/**
 * The one entry point for every role. Same pipeline whatever the backend:
 * mask (one shared map; blocked => nothing is run or sent) -> choose backend -> audit the exact
 * outgoing text -> run -> unmask locally.
 */
export function createBrain(
  cfg: GuardConfig, opts: SelectOptions = {},
): { complete: CompleteFn; backendUsed: () => string | null } {
  const now = opts.now ?? (() => new Date());
  let used: string | null = null;
  // Calls outside a chat are grouped by this run.
  const runId = `run-${randomBytes(6).toString("hex")}`;

  async function complete(req: CompleteRequest): Promise<CompleteResult> {
    const { parts, map, replaced } = maskAll([...req.system, req.user], req.dictionary);
    const picked = await pickBackend(cfg, opts);
    used = picked.backend.id;
    let model = "";
    const record = (r: CompleteResult | null): void => {
      const u = r?.usage;
      const reported = !!u && u.reported !== false;
      const n = (x: number | undefined): number => (reported && Number.isFinite(x) ? (x as number) : 0);
      recordUsage(cfg.dataDir, {
        ts: now().toISOString(), backend: picked.backend.id, model: r?.model ?? model, role: req.role, session: req.sessionId ?? runId,
        input: n(u?.input_tokens), cacheRead: n(u?.cache_read_input_tokens), cacheWrite: n(u?.cache_creation_input_tokens), output: n(u?.output_tokens),
        ok: r !== null, reported,
      });
    };
    const call = picked.backend.complete({
      role: req.role,
      system: parts.slice(0, -1),
      user: parts[parts.length - 1]!,
      maxTokens: req.maxTokens,
      limits: (windows) => saveLimits(cfg.dataDir, picked.backend.id, windows, now()),
      audit: (outgoing, sentModel) => {
        // The CLI backends put their own name in front of the model.
        model = sentModel.startsWith(`${picked.backend.id}/`) ? sentModel.slice(picked.backend.id.length + 1) : sentModel;
        auditOutgoing(join(cfg.root, "logs"), {
          ts: now().toISOString(),
          role: req.role,
          model: `${picked.backend.id}:${sentModel}`,
          sha256: createHash("sha256").update(outgoing).digest("hex"),
          blocked: [],
          replaced,
        });
      },
    });
    const r = await call.catch((e: unknown) => {
      // Only a call that got as far as sending counts.
      if (model) record(null);
      throw e;
    });
    record(r);
    return { text: unmask(r.text, map), usage: r.usage };
  }
  return { complete, backendUsed: () => used };
}
