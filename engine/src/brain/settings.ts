import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { envValue } from "../config.ts";
import type { GuardConfig } from "../types.ts";
import { DEFAULT_MODEL } from "./client.ts";
import { DEFAULT_ANTIGRAVITY_CLI_MODEL, DEFAULT_CLAUDE_CLI_MODEL } from "./backends.ts";
import { MODEL_BACKENDS, MODEL_ID_HELP, MODEL_ID_RE } from "./models.ts";
import type { ModelBackend } from "./models.ts";

export type BackendChoice = "auto" | ModelBackend;
export const BACKEND_CHOICES: readonly BackendChoice[] = ["auto", ...MODEL_BACKENDS];
export type Source = "env" | "settings" | "config" | "default";

const modelId = z.string().regex(MODEL_ID_RE);
export const settingsSchema = z.object({
  version: z.literal(1),
  brain: z.object({
    backend: z.custom<BackendChoice>((v) => (BACKEND_CHOICES as readonly unknown[]).includes(v)).optional(),
    models: z.object(
      Object.fromEntries(MODEL_BACKENDS.map((b) => [b, modelId.optional()])) as Record<ModelBackend, z.ZodOptional<typeof modelId>>,
    ).prefault({} as Record<ModelBackend, undefined>),
  }).default({ models: {} }),
});
export type GuardSettings = z.infer<typeof settingsSchema>;

export const emptySettings = (): GuardSettings => ({ version: 1, brain: { models: {} } });

/** Settings are per machine: they live in the project's data folder. */
export function machineDataDir(cfg: GuardConfig): string {
  return cfg.dataDir;
}

export const settingsFile = (dataDir: string): string => join(dataDir, "settings.json");

export interface LoadedSettings { settings: GuardSettings; problem?: string }

/** Never throws: a missing file is the default; a broken file is ignored and reported in `problem`. */
export function loadSettings(dataDir: string): LoadedSettings {
  const file = settingsFile(dataDir);
  if (!existsSync(file)) return { settings: emptySettings() };
  try {
    return { settings: settingsSchema.parse(JSON.parse(readFileSync(file, "utf8"))) };
  } catch {
    return { settings: emptySettings(), problem: "settings.json could not be read, so it is ignored. Fix or delete it." };
  }
}

/** Temp file + rename, so a crash never leaves half a file. The previous file is kept as settings.json.bak. */
export function saveSettings(dataDir: string, s: GuardSettings): void {
  const file = settingsFile(dataDir);
  const clean = settingsSchema.parse(s);
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n", "utf8");
    if (existsSync(file)) copyFileSync(file, `${file}.bak`);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export interface SettingsPatch { backend?: unknown; models?: unknown }
export type PatchResult = { ok: true; settings: GuardSettings } | { ok: false; error: string };

/** Validates a change and writes it. `models.<backend>: null` clears that choice. */
export function updateSettings(dataDir: string, patch: SettingsPatch): PatchResult {
  const cur = loadSettings(dataDir).settings;
  const next: GuardSettings = {
    version: 1,
    brain: { ...(cur.brain.backend ? { backend: cur.brain.backend } : {}), models: { ...cur.brain.models } },
  };
  if (patch.backend !== undefined) {
    if (typeof patch.backend !== "string" || !(BACKEND_CHOICES as readonly string[]).includes(patch.backend)) {
      return { ok: false, error: `The backend must be one of: ${BACKEND_CHOICES.join(", ")}.` };
    }
    next.brain.backend = patch.backend as BackendChoice;
  }
  if (patch.models !== undefined) {
    if (patch.models === null || typeof patch.models !== "object" || Array.isArray(patch.models)) {
      return { ok: false, error: "models must be an object, for example { \"claude-cli\": \"opus\" }." };
    }
    for (const [k, v] of Object.entries(patch.models as Record<string, unknown>)) {
      if (!(MODEL_BACKENDS as readonly string[]).includes(k)) return { ok: false, error: `Unknown backend "${k.slice(0, 40)}" in models.` };
      if (v === null || v === "") {
        delete next.brain.models[k as ModelBackend];
        continue;
      }
      if (typeof v !== "string" || !MODEL_ID_RE.test(v.trim())) return { ok: false, error: MODEL_ID_HELP };
      next.brain.models[k as ModelBackend] = v.trim();
    }
  }
  try {
    saveSettings(dataDir, next);
  } catch {
    return { ok: false, error: "Guard could not write its settings file." };
  }
  return { ok: true, settings: next };
}

export interface EffectiveBrain {
  backend: string;
  backendSource: Source;
  models: Record<ModelBackend, { id: string; source: Source }>;
  /** Set when settings.json exists but is unreadable. */
  problem?: string;
}

/** Every value: environment (QSB_* then AURA_GUARD_*) > settings.json > guard.config.local.json > built-in default. */
export function effectiveBrain(cfg: GuardConfig, env: Record<string, string | undefined> = process.env): EffectiveBrain {
  const loaded = loadSettings(machineDataDir(cfg));
  const s = loaded.settings.brain;
  const pick = (fromEnv: string | undefined, fromSettings: string | undefined, fromConfig: string | undefined, dflt: string): { id: string; source: Source } => {
    if (fromEnv?.trim()) return { id: fromEnv.trim(), source: "env" };
    if (fromSettings) return { id: fromSettings, source: "settings" };
    if (fromConfig?.trim()) return { id: fromConfig.trim(), source: "config" };
    return { id: dflt, source: "default" };
  };
  return {
    ...(() => {
      const b = pick(envValue("BRAIN", env), s.backend, cfg.brain?.backend, "auto");
      return { backend: b.id, backendSource: b.source };
    })(),
    models: {
      // The newer providers have no built-in model: "" until one is picked.
      ...(Object.fromEntries(MODEL_BACKENDS.map((b) => [b, pick(undefined, s.models[b], cfg.brain?.models?.[b], "")])) as EffectiveBrain["models"]),
      "anthropic-api": pick(envValue("MODEL", env), s.models["anthropic-api"], cfg.brain?.models?.["anthropic-api"], DEFAULT_MODEL),
      "claude-cli": pick(envValue("CLI_MODEL", env), s.models["claude-cli"], cfg.brain?.models?.["claude-cli"], DEFAULT_CLAUDE_CLI_MODEL),
      "antigravity-cli": pick(envValue("AGY_MODEL", env), s.models["antigravity-cli"], cfg.brain?.models?.["antigravity-cli"], DEFAULT_ANTIGRAVITY_CLI_MODEL),
    },
    ...(loaded.problem ? { problem: loaded.problem } : {}),
  };
}
