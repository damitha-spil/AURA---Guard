// One line per model call in <dataDir>/usage.jsonl: counts only, never prompt or reply text or keys.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface UsageRecord {
  ts: string;
  backend: string;
  model: string;
  role: string;
  session: string;
  /** Uncached input tokens. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  ok: boolean;
  /** False when the backend gave no token counts; the counts are then zero, not estimates. */
  reported: boolean;
}

export const usageFile = (dataDir: string): string => join(dataDir, "usage.jsonl");

/** Never throws: a failed write must not break an answer. */
export function recordUsage(dataDir: string, r: UsageRecord): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(usageFile(dataDir), JSON.stringify(r) + "\n", "utf8");
  } catch { /* usage is a by-product */ }
}

/** Every readable record; a damaged line is skipped. */
export function readUsage(dataDir: string): UsageRecord[] {
  let text: string;
  try { text = readFileSync(usageFile(dataDir), "utf8"); } catch { return []; }
  const out: UsageRecord[] = [];
  const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as UsageRecord;
      if (typeof v.ts !== "string" || typeof v.backend !== "string" || !Number.isFinite(Date.parse(v.ts))) continue;
      out.push({
        ...v, model: String(v.model ?? ""), session: String(v.session ?? ""),
        input: n(v.input), cacheRead: n(v.cacheRead), cacheWrite: n(v.cacheWrite), output: n(v.output), reported: v.reported === true,
      });
    } catch { /* skip */ }
  }
  return out;
}
