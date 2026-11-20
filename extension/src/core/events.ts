import { createHash } from "node:crypto";
import { maskOutgoing } from "./mask.ts";

export type EventKind = "commit" | "save" | "task" | "terminal" | "diagnostics" | "idea" | "decision" | "correction" | "chat";

export interface GuardEvent {
  v: 1;
  id: string;
  ts: string;
  kind: EventKind;
  repo: string;
  branch: string;
  dev: string;
  data: Record<string, unknown>;
}

// Caps from the contract.
export const MAX_TEXT = 1000;
export const MAX_ANSWER = 4000;
export const MAX_BODY = 600;
export const MAX_COMMIT_FILES = 40;
export const DAILY_CAP = 5000;

// Fields that are identifiers, not prose. Masking a 40-character commit id would
// treat it as a random secret and drop every commit.
const UNMASKED_KEYS = new Set(["sha", "windowStart", "windowEnd", "language", "participant"]);

export function eventId(kind: string, ts: string, stableKey: string): string {
  return createHash("sha256").update(kind + ts + stableKey).digest("hex").slice(0, 16);
}

export function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * Masks every string in `value`. Returns ok:false as soon as any string holds a
 * secret; the caller must then drop the whole event and never store `value`.
 */
export function maskDeep(value: unknown, key = ""): { ok: boolean; value: unknown } {
  if (typeof value === "string") {
    if (UNMASKED_KEYS.has(key)) return { ok: true, value };
    const r = maskOutgoing(value);
    return r.ok ? { ok: true, value: r.text } : { ok: false, value: undefined };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) {
      const r = maskDeep(v, key);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = maskDeep(v, k);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value };
}

export interface BuildInput {
  kind: EventKind;
  ts: Date;
  repo: string;
  branch: string;
  dev: string;
  data: Record<string, unknown>;
  stableKey: string;
}

/** Returns the masked event, or null when a secret was found (drop it). */
export function buildEvent(i: BuildInput): GuardEvent | null {
  const m = maskDeep(i.data);
  if (!m.ok) return null;
  const meta = maskDeep({ branch: i.branch });
  if (!meta.ok) return null;
  const ts = i.ts.toISOString();
  return {
    v: 1,
    id: eventId(i.kind, ts, i.stableKey),
    ts,
    kind: i.kind,
    repo: i.repo,
    branch: (meta.value as { branch: string }).branch,
    dev: i.dev,
    data: m.value as Record<string, unknown>,
  };
}
