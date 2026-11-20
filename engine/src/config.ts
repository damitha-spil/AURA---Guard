import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GuardConfig } from "./types.ts";

/** AURA Guard's own root folder (two levels above engine/src). */
export const GUARD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Reads guard.config.local.json (per machine, not committed), falling back to
 * guard.config.example.json. Relative dirs resolve against GUARD_ROOT.
 */
export function loadConfig(root: string = GUARD_ROOT): GuardConfig {
  const local = join(root, "guard.config.local.json");
  const file = existsSync(local) ? local : join(root, "guard.config.example.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<GuardConfig>;
  return {
    department: raw.department ?? "dev",
    dataDir: resolve(root, raw.dataDir ?? "data"),
    vaultDir: resolve(root, raw.vaultDir ?? "vault"),
    repos: raw.repos ?? [],
    busyProcesses: raw.busyProcesses ?? [],
    ...(raw.brain ? { brain: raw.brain } : {}),
    root,
  };
}

export function dbPath(cfg: GuardConfig): string {
  return join(cfg.dataDir, "guard.db");
}
