import { createHash } from "node:crypto";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import { auditOutgoing } from "../mask/audit.ts";
import { unmask } from "../mask/mask.ts";
import { anthropicApiBackend, antigravityCliBackend, claudeCliBackend } from "./backends.ts";
import type { Backend, BackendOptions, BackendStatus } from "./backends.ts";
import { createKeyStore } from "./keystore.ts";
import type { SecretBackend } from "./keystore.ts";
import { effectiveBrain, machineDataDir } from "./settings.ts";
import { maskAll } from "./client.ts";
import type { CompleteFn, CompleteRequest, CompleteResult } from "./client.ts";

/** Backends in the order `auto` tries them. */
export const BACKEND_IDS = ["anthropic-api", "claude-cli", "antigravity-cli"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

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
}

/** Backend and model come from env > settings.json > guard.config.local.json > default (settings.ts). */
export function buildBackends(cfg: GuardConfig, opts: SelectOptions = {}): Backend[] {
  const eff = effectiveBrain(cfg, opts.env ?? process.env);
  const keys = createKeyStore({ dataDir: machineDataDir(cfg), ...(opts.env ? { env: opts.env } : {}), ...(opts.secrets ? { backend: opts.secrets } : {}) });
  const storedKey = { exists: () => keys.hasStored(), get: async () => (await keys.resolve())?.key ?? null };
  const rest = { ...opts };
  delete rest.secrets;
  return [
    anthropicApiBackend({ ...rest, model: eff.models["anthropic-api"].id, storedKey }),
    claudeCliBackend({ ...rest, model: eff.models["claude-cli"].id }),
    antigravityCliBackend({ ...rest, model: eff.models["antigravity-cli"].id }),
  ];
}

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
  for (const b of all) {
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

  async function complete(req: CompleteRequest): Promise<CompleteResult> {
    const { parts, map, replaced } = maskAll([...req.system, req.user], req.dictionary);
    const picked = await pickBackend(cfg, opts);
    used = picked.backend.id;
    const r = await picked.backend.complete({
      role: req.role,
      system: parts.slice(0, -1),
      user: parts[parts.length - 1]!,
      maxTokens: req.maxTokens,
      audit: (outgoing, model) =>
        auditOutgoing(join(cfg.root, "logs"), {
          ts: now().toISOString(),
          role: req.role,
          model: `${picked.backend.id}:${model}`,
          sha256: createHash("sha256").update(outgoing).digest("hex"),
          blocked: [],
          replaced,
        }),
    });
    return { text: unmask(r.text, map), usage: r.usage };
  }
  return { complete, backendUsed: () => used };
}
