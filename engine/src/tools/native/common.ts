// Shared pieces of Guard's native tools. Guard runs a tool only when the user asks; models are
// never given tools. Ported from the general built-in tools of the desktop agent.

import { maskOutgoing } from "../../mask/mask.ts";
import { detectSecrets } from "../../mask/detectors.ts";

/** Longest tool output shown in chat or given to a model (about 2,000 tokens). */
export const MAX_OUTPUT_CHARS = 8_000;

/** A tool refused or failed; the message is safe to show to the user. */
export class ToolError extends Error {
  /** True when the masking gate or a safety rule stopped it. */
  blocked: boolean;
  constructor(message: string, blocked = false) {
    super(message);
    this.name = "ToolError";
    this.blocked = blocked;
  }
}

export const truncate = (s: string, n = MAX_OUTPUT_CHARS): string => (s.length > n ? `${s.slice(0, n)}\n... (cut short)` : s);

/**
 * The gate for text that is about to leave the machine (a search query, a URL). It is sent only
 * when the masking step would leave it exactly as it is.
 */
export function assertMayLeave(what: string, ...forms: string[]): void {
  for (const text of forms) {
    const r = maskOutgoing(text);
    if (!r.ok || r.text !== text) {
      const kinds = [...r.blocked, ...r.replaced].map((k) => k.kind).join(", ");
      throw new ToolError(`Not sent: the ${what} contains something the masking step would hide (${kinds}). Remove it and try again.`, true);
    }
  }
}

/** Replaces secret-looking values in local file text before it is shown. */
export function redactSecrets(text: string): string {
  const spans = detectSecrets(text).sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let pos = 0;
  for (const s of spans) {
    if (s.end <= pos) continue;
    if (s.start >= pos) out += text.slice(pos, s.start) + `[SECRET_${s.kind}]`;
    pos = s.end;
  }
  return out + text.slice(pos);
}

/** A code block whose fence is longer than any run of backticks inside it. */
export function fenced(text: string): string {
  let longest = 2;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}
