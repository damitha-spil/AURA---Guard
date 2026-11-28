// An estimate of what the next call will send, so the person can see how full the context is. It is an
// estimate: about 4 characters per token, the engine's own caps, and a fixed allowance for REO's rules and
// tool list. The model's real count can differ. The context size is shown only where it is known.

export const CHARS_PER_TOKEN = 4;
/** REO's rules, identity and agent tool list (engine/src/chat/prompt.ts, agent-loop.ts): an allowance, not exact. */
export const SYSTEM_ALLOWANCE_CHARS = 5500;
/** Mirrors the engine: MAX_HISTORY_TURNS, MAX_TURN_CHARS, FULL_ATTACHMENT_CHARS, MEMORY_PROMPT_CHARS, the skill cap. */
export const HISTORY_TURNS = 10;
export const TURN_CHARS = 2500;
export const ATTACHMENT_CHARS = 30_000;
export const MEMORY_CHARS = 1500;
export const SKILL_CHARS = 4000;

export const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/** Known context windows by model id. Unknown ids give null and the meter says so. */
const WINDOWS: [RegExp, number][] = [
  [/claude|^(opus|sonnet|haiku)\b/i, 200_000],
  [/gemini/i, 1_000_000],
  [/gpt-4\.1|gpt-5/i, 400_000],
  [/gpt-4o|gpt-4-turbo/i, 128_000],
  [/deepseek/i, 128_000],
];
export function contextWindow(modelId: string | undefined): number | null {
  if (!modelId) return null;
  for (const [re, n] of WINDOWS) if (re.test(modelId)) return n;
  return null;
}

export interface MeterInput {
  question: number;
  /** Character counts of earlier messages, oldest first. */
  history: number[];
  attachments: number;
  memory: number;
  skill: number;
  modelId?: string;
}
export interface Meter { total: number; window: number | null; parts: { label: string; tokens: number }[] }

export function meter(i: MeterInput): Meter {
  const hist = [...i.history].reverse().slice(0, HISTORY_TURNS).reduce((n, c) => n + Math.min(c, TURN_CHARS), 0);
  const parts = [
    { label: "Rules and tools", tokens: estimateTokens(SYSTEM_ALLOWANCE_CHARS) },
    { label: "Memory", tokens: estimateTokens(Math.min(i.memory, MEMORY_CHARS)) },
    { label: "Skill", tokens: estimateTokens(Math.min(i.skill, SKILL_CHARS)) },
    { label: "Earlier messages", tokens: estimateTokens(hist) },
    { label: "Attached files", tokens: estimateTokens(Math.min(i.attachments, ATTACHMENT_CHARS)) },
    { label: "This message", tokens: estimateTokens(i.question) },
  ];
  return { total: parts.reduce((n, p) => n + p.tokens, 0), window: contextWindow(i.modelId), parts };
}

export function meterLine(m: Meter): string {
  const t = `About ${m.total.toLocaleString("en-US")} tokens`;
  return m.window
    ? `${t} of ${m.window.toLocaleString("en-US")} (${Math.max(1, Math.round((m.total / m.window) * 100))}%)`
    : `${t}; this model's context size is unknown`;
}
