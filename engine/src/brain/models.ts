import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { OPENAI_COMPAT } from "./providers.ts";
import type { OpenAiCompatId } from "./providers.ts";

/** The backends a model can be chosen for. Same ids as select.ts BACKEND_IDS. */
export type ModelBackend = "anthropic-api" | "claude-cli" | "antigravity-cli" | "opencode-cli" | OpenAiCompatId;
export const MODEL_BACKENDS: readonly ModelBackend[] = [
  "anthropic-api", "claude-cli", "antigravity-cli", "opencode-cli", ...OPENAI_COMPAT.map((p) => p.id),
];
export const isModelBackend = (id: unknown): id is ModelBackend => (MODEL_BACKENDS as readonly unknown[]).includes(id);

/**
 * A model id ends up in an HTTP body and in a CLI argument (always an argument array, never a
 * shell). Only plain id characters, and never a leading "-" so it cannot look like a CLI flag.
 * (The brief's pattern was ^[A-Za-z0-9._:-]{1,80}$; the first character is stricter on purpose.)
 */
// "/" is for provider/model ids; "..", "//" and a trailing "/" are refused so an id never reads as a path walk.
export const MODEL_ID_RE = /^(?!.*(?:\.\.|\/\/|\/$))[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

export const MODEL_ID_HELP =
  "A model name may use letters, digits and . _ : / - only (120 characters at most, starting with a letter or digit).";

export interface ModelEntry {
  id: string;
  label: string;
  note: string;
  backends: ModelBackend[];
  default?: boolean;
}

export type ModelCheck = { ok: true; id: string } | { ok: false; error: string };

export function validateModelId(raw: unknown): ModelCheck {
  if (typeof raw !== "string") return { ok: false, error: "A model name must be text." };
  const id = raw.trim();
  if (!id) return { ok: false, error: "Type a model name." };
  if (!MODEL_ID_RE.test(id)) return { ok: false, error: MODEL_ID_HELP };
  return { ok: true, id };
}

/** Used when roles/models.json is missing or broken. Same content as the file. */
export const BUILTIN_MODELS: ModelEntry[] = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Balanced speed, quality and cost. The default.", backends: ["anthropic-api"], default: true },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Most capable. Slower and costs more.", backends: ["anthropic-api"] },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Fastest and cheapest. Good for short, simple jobs.", backends: ["anthropic-api"] },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2", note: "Another Anthropic model line. Use it if your key can access it.", backends: ["anthropic-api"] },
  { id: "sonnet", label: "Sonnet (plan)", note: "Balanced. The default for the Claude plan.", backends: ["claude-cli"], default: true },
  { id: "opus", label: "Opus (plan)", note: "Most capable. Slower, and uses more of your plan allowance.", backends: ["claude-cli"] },
  { id: "haiku", label: "Haiku (plan)", note: "Fastest, and uses the least of your plan allowance.", backends: ["claude-cli"] },
  { id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)", note: "Balanced speed and reasoning. The default for Antigravity.", backends: ["antigravity-cli"], default: true },
  { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)", note: "Fastest Gemini 4 Neon effort level for quick checks.", backends: ["antigravity-cli"] },
  { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)", note: "Higher-effort Gemini 4 Neon reasoning.", backends: ["antigravity-cli"] },
  { id: "gemini-4-neon-xhigh", label: "Gemini 4 Neon (XHigh)", note: "Maximum-effort Gemini 4 Neon reasoning.", backends: ["antigravity-cli"] },
  { id: "gemini-4-hydrogen-medium", label: "Gemini 4 Hydrogen (Medium)", note: "Deeper multi-step reasoning on Antigravity.", backends: ["antigravity-cli"] },
  { id: "gemini-4-hydrogen-low", label: "Gemini 4 Hydrogen (Low)", note: "Fast Gemini 4 Hydrogen reasoning.", backends: ["antigravity-cli"] },
  { id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)", note: "High-effort Gemini 4 Hydrogen reasoning.", backends: ["antigravity-cli"] },
  { id: "gemini-4-hydrogen-xhigh", label: "Gemini 4 Hydrogen (XHigh)", note: "Maximum-effort Gemini 4 Hydrogen reasoning.", backends: ["antigravity-cli"] },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", note: "Ultra-fast Gemini 3.8 Flash balanced effort.", backends: ["antigravity-cli"] },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", note: "Lowest-latency Gemini 3.8 Flash responses.", backends: ["antigravity-cli"] },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", note: "High-effort Gemini 3.8 Flash reasoning.", backends: ["antigravity-cli"] },
  { id: "gemini-4-carbon-medium", label: "Gemini 4 Carbon (Medium)", note: "High-capacity Gemini 4 Carbon balanced effort.", backends: ["antigravity-cli"] },
  { id: "gemini-4-carbon-low", label: "Gemini 4 Carbon (Low)", note: "Fast Gemini 4 Carbon effort level.", backends: ["antigravity-cli"] },
  { id: "gemini-4-carbon-high", label: "Gemini 4 Carbon (High)", note: "High-effort Gemini 4 Carbon reasoning.", backends: ["antigravity-cli"] },
  { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)", note: "Gemini 4 Argon balanced effort.", backends: ["antigravity-cli"] },
  { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)", note: "Fast Gemini 4 Argon effort level.", backends: ["antigravity-cli"] },
  { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)", note: "High-effort Gemini 4 Argon reasoning.", backends: ["antigravity-cli"] },
  { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)", note: "Claude Sonnet 5.5 via your Antigravity subscription.", backends: ["antigravity-cli"] },
  { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)", note: "High-effort Claude Sonnet 5.5 via Antigravity.", backends: ["antigravity-cli"] },
  { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)", note: "Claude Opus 5.5 via your Antigravity subscription.", backends: ["antigravity-cli"] },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", note: "Open-weight 120B model via Antigravity.", backends: ["antigravity-cli"] },
];

const entrySchema = z.object({
  id: z.string(),
  label: z.string().min(1).max(80),
  note: z.string().max(300),
  backends: z.array(z.custom<ModelBackend>(isModelBackend)).min(1),
  default: z.boolean().optional(),
});
const fileSchema = z.object({ version: z.literal(1), models: z.array(entrySchema) });

/** The picker list: roles/models.json under the repo root; entries with a bad id are dropped. */
export function loadCatalogue(root: string): ModelEntry[] {
  const file = join(root, "roles", "models.json");
  if (!existsSync(file)) return BUILTIN_MODELS;
  try {
    const parsed = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    const seen = new Set<string>();
    const out: ModelEntry[] = [];
    for (const m of parsed.models) {
      const v = validateModelId(m.id);
      const key = `${m.backends.join()}|${v.ok ? v.id : ""}`;
      if (!v.ok || seen.has(key)) continue;
      seen.add(key);
      out.push({ id: v.id, label: m.label, note: m.note, backends: m.backends, ...(m.default ? { default: true } : {}) });
    }
    return out.length > 0 ? out : BUILTIN_MODELS;
  } catch {
    return BUILTIN_MODELS;
  }
}
