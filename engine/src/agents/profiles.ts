// Per-machine configurable agent profiles (Hermes-style prompt, model & execution budgets).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PREBUILT_AGENTS } from "./registry.ts";
import type { AgentId, SubAgentSpec } from "./registry.ts";

/** Hard safety bounds for autonomous agent execution budgets. */
export const MAX_TOOL_CALLS_LIMIT = 50;
export const MAX_TIME_SECONDS_LIMIT = 600;
export const MAX_SYSTEM_PROMPT_CHARS = 4000;
export const DEFAULT_TOOL_CALLS = 15;
export const DEFAULT_TIME_SECONDS = 120;

export interface AgentProfileOverride {
  enabled?: boolean;
  systemPrompt?: string;
  modelOverride?: string;
  maxToolCalls?: number;
  maxTimeSeconds?: number;
}

export interface EffectiveAgentProfile extends SubAgentSpec {
  systemPrompt: string;
  modelOverride: string | null;
  maxToolCalls: number;
  maxTimeSeconds: number;
}

function profilesPath(dataDir: string): string {
  return join(dataDir, "agent-profiles.json");
}

function defaultPrompt(a: SubAgentSpec): string {
  return `You are SPIL REO's ${a.name} (${a.role}). ${a.description} Follow active Vault rules, cite evidence, and stay strictly within your risk tier (${a.riskTier}).`;
}

export function loadAgentProfiles(dataDir: string): Partial<Record<AgentId, AgentProfileOverride>> {
  const file = profilesPath(dataDir);
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    return raw as Partial<Record<AgentId, AgentProfileOverride>>;
  } catch {
    return {};
  }
}

export function getEffectiveAgents(dataDir: string): EffectiveAgentProfile[] {
  const overrides = loadAgentProfiles(dataDir);
  return PREBUILT_AGENTS.map((a) => {
    const ov = overrides[a.id] ?? {};
    return {
      ...a,
      enabled: ov.enabled ?? a.enabled,
      systemPrompt: typeof ov.systemPrompt === "string" && ov.systemPrompt.trim() ? ov.systemPrompt : defaultPrompt(a),
      modelOverride: typeof ov.modelOverride === "string" && ov.modelOverride.trim() ? ov.modelOverride.trim() : null,
      maxToolCalls: typeof ov.maxToolCalls === "number" ? ov.maxToolCalls : DEFAULT_TOOL_CALLS,
      maxTimeSeconds: typeof ov.maxTimeSeconds === "number" ? ov.maxTimeSeconds : DEFAULT_TIME_SECONDS,
    };
  });
}

export function saveAgentProfile(
  dataDir: string,
  id: AgentId,
  patch: AgentProfileOverride & { reset?: boolean },
): EffectiveAgentProfile {
  const base = PREBUILT_AGENTS.find((a) => a.id === id);
  if (!base) throw new Error(`Unknown agent "${id}".`);

  const all = loadAgentProfiles(dataDir);
  if (patch.reset) {
    delete all[id];
  } else {
    const next: AgentProfileOverride = { ...(all[id] ?? {}) };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (typeof patch.systemPrompt === "string") {
      const text = patch.systemPrompt.trim().slice(0, MAX_SYSTEM_PROMPT_CHARS);
      if (text) next.systemPrompt = text;
      else delete next.systemPrompt;
    }
    if (typeof patch.modelOverride === "string") {
      const m = patch.modelOverride.trim();
      if (m) next.modelOverride = m;
      else delete next.modelOverride;
    }
    if (typeof patch.maxToolCalls === "number" && Number.isFinite(patch.maxToolCalls)) {
      next.maxToolCalls = Math.max(1, Math.min(MAX_TOOL_CALLS_LIMIT, Math.round(patch.maxToolCalls)));
    }
    if (typeof patch.maxTimeSeconds === "number" && Number.isFinite(patch.maxTimeSeconds)) {
      next.maxTimeSeconds = Math.max(10, Math.min(MAX_TIME_SECONDS_LIMIT, Math.round(patch.maxTimeSeconds)));
    }
    if (Object.keys(next).length > 0) all[id] = next;
    else delete all[id];
  }

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(profilesPath(dataDir), JSON.stringify(all, null, 2), "utf8");
  return getEffectiveAgents(dataDir).find((a) => a.id === id)!;
}
