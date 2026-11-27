// List prices from roles/ai-pricing.json. An unknown model has no cost; nothing is guessed.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Price {
  input: number;
  output: number;
  cache_read: number;
  long_context_above_tokens?: number;
  long_input?: number;
  long_output?: number;
}
export interface PriceTable { cache_write_multiplier: number; models: Record<string, Price> }

export function loadPrices(root: string): PriceTable {
  try {
    const raw = JSON.parse(readFileSync(join(root, "roles", "ai-pricing.json"), "utf8")) as Partial<PriceTable>;
    return { cache_write_multiplier: raw.cache_write_multiplier ?? 1.25, models: raw.models ?? {} };
  } catch {
    return { cache_write_multiplier: 1.25, models: {} };
  }
}

/** The exact model, also with a "provider/" prefix, a date suffix or an effort suffix. */
export function findPrice(table: PriceTable, model: string): Price | null {
  const bare = model.trim().split("/").pop() ?? "";
  for (const id of [bare, bare.replace(/-\d{8}$/, ""), bare.replace(/-(?:low|medium|high|xhigh)$/, "")]) {
    if (Object.hasOwn(table.models, id)) return table.models[id] as Price;
  }
  return null;
}

export interface Tokens { input: number; cacheRead: number; cacheWrite: number; output: number }

/** Cost of one call in USD, split by token type, and what the cache reads saved. */
export function priceCall(table: PriceTable, price: Price, t: Tokens): { cost: Tokens; savings: number } {
  const long = price.long_context_above_tokens !== undefined && t.input + t.cacheRead + t.cacheWrite > price.long_context_above_tokens;
  const input = long ? price.long_input ?? price.input : price.input;
  const output = long ? price.long_output ?? price.output : price.output;
  const per = 1_000_000;
  return {
    cost: {
      input: (t.input * input) / per,
      cacheRead: (t.cacheRead * price.cache_read) / per,
      cacheWrite: (t.cacheWrite * input * table.cache_write_multiplier) / per,
      output: (t.output * output) / per,
    },
    savings: (t.cacheRead * Math.max(0, input - price.cache_read)) / per,
  };
}
