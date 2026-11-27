// The numbers behind GET /api/usage.

import { findProvider } from "../brain/providers.ts";
import { findPrice, priceCall } from "./prices.ts";
import type { PriceTable } from "./prices.ts";
import type { UsageRecord } from "./record.ts";

export const RANGES = ["24h", "7d", "30d", "90d"] as const;
export type Range = (typeof RANGES)[number];

const NAMES: Record<string, string> = {
  "anthropic-api": "Anthropic API key", "claude-cli": "Claude plan", "antigravity-cli": "Antigravity plan", "opencode-cli": "OpenCode",
};
export const providerLabel = (id: string): string => NAMES[id] ?? findProvider(id)?.label ?? id;

const pad = (n: number): string => String(n).padStart(2, "0");
const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hourKey = (d: Date): string => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000).toISOString();

/** A running sum whose cost stays unknown (null) while calls exist but none could be priced. */
interface Sum { calls: number; priced: number; cost: number; tokens: number; sessions: Set<string> }
const newSum = (): Sum => ({ calls: 0, priced: 0, cost: 0, tokens: 0, sessions: new Set() });
const costOf = (s: Sum): number | null => (s.calls && !s.priced ? null : s.cost);
function get<T>(map: Map<string, T>, key: string, make: () => T): T {
  let v = map.get(key);
  if (v === undefined) map.set(key, (v = make()));
  return v;
}

export function usageReport(records: UsageRecord[], range: Range, prices: PriceTable, now: Date = new Date()) {
  // Buckets: whole hours for 24h, whole local days otherwise; the last one is the current one.
  const buckets: string[] = [];
  let from: Date;
  if (range === "24h") {
    from = new Date(Date.parse(hourKey(now)) - 23 * 3_600_000);
    for (let i = 0; i < 24; i++) buckets.push(new Date(from.getTime() + i * 3_600_000).toISOString());
  } else {
    const n = parseInt(range, 10);
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1));
    for (let i = 0; i < n; i++) buckets.push(dayKey(new Date(from.getFullYear(), from.getMonth(), from.getDate() + i)));
  }
  const inRange = records.filter((r) => { const t = Date.parse(r.ts); return t >= from.getTime() && t <= now.getTime(); });

  const all = newSum();
  const totals = { processed: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0, cacheSavings: 0 };
  const costByType = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const providers = new Map<string, Sum>();
  const models = new Map<string, Sum & { model: string; provider: string }>();
  const daily = new Map(buckets.map((b) => [b, {} as Record<string, { cost: number; tokens: number }>]));
  const days = new Map<string, Sum>();
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d <= now; d.setDate(d.getDate() + 1)) days.set(dayKey(d), newSum());
  let unreported = 0;
  let unpriced = 0;

  for (const r of inRange) {
    const at = new Date(r.ts);
    const tokens = r.input + r.cacheRead + r.cacheWrite + r.output;
    const price = r.reported ? findPrice(prices, r.model) : null;
    const p = price ? priceCall(prices, price, r) : null;
    const cost = p ? p.cost.input + p.cost.cacheRead + p.cost.cacheWrite + p.cost.output : 0;
    if (!r.reported) unreported++;
    else if (!price) unpriced++;
    totals.input += r.input;
    totals.cacheRead += r.cacheRead;
    totals.cacheWrite += r.cacheWrite;
    totals.output += r.output;
    totals.processed += tokens;
    if (p) {
      totals.cacheSavings += p.savings;
      for (const k of ["input", "cacheRead", "cacheWrite", "output"] as const) costByType[k] += p.cost[k];
    }
    const sums: Sum[] = [
      all, get(providers, r.backend, newSum),
      get(models, `${r.backend}\0${r.model}`, () => ({ ...newSum(), model: r.model, provider: r.backend })),
      get(days, dayKey(at), newSum),
    ];
    for (const s of sums) {
      s.calls++;
      s.tokens += tokens;
      s.cost += cost;
      if (p) s.priced++;
      s.sessions.add(r.session);
    }
    const bucket = daily.get(range === "24h" ? hourKey(at) : dayKey(at));
    if (bucket) {
      const e = (bucket[r.backend] ??= { cost: 0, tokens: 0 });
      e.cost += cost;
      e.tokens += tokens;
    }
  }

  return {
    range, from: from.toISOString(), to: now.toISOString(),
    sessions: all.sessions.size, calls: all.calls, unreportedCalls: unreported, unpricedCalls: unpriced,
    cost: costOf(all),
    totals: { ...totals, cacheSavings: all.calls && !all.priced ? null : totals.cacheSavings },
    costByType,
    providers: [...providers].map(([id, s]) => ({ id, label: providerLabel(id), sessions: s.sessions.size, calls: s.calls, cost: costOf(s), tokens: s.tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    daily: [...daily].map(([date, byProvider]) => ({ date, byProvider })),
    models: [...models.values()].map((s) => ({ model: s.model, provider: s.provider, cost: costOf(s), tokens: s.tokens, calls: s.calls }))
      .sort((a, b) => b.tokens - a.tokens),
    days: [...days].map(([date, s]) => ({ date, cost: costOf(s), tokens: s.tokens, calls: s.calls })),
  };
}
