// Shapes and formatting for GET /api/usage and GET /api/usage/limits.

export const RANGES = [
  ["24h", "Past 24h"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
] as const;
export type Range = (typeof RANGES)[number][0];

export interface Usage {
  range: string;
  from: string;
  to: string;
  sessions: number;
  calls: number;
  unreportedCalls: number;
  unpricedCalls: number;
  cost: number | null;
  totals: { processed: number; cacheRead: number; cacheWrite: number; input: number; output: number; cacheSavings: number | null };
  costByType: { input: number; cacheRead: number; cacheWrite: number; output: number };
  providers: { id: string; label: string; sessions: number; calls: number; cost: number | null; tokens: number }[];
  daily: { date: string; byProvider: Record<string, { cost: number; tokens: number }> }[];
  models: { model: string; provider: string; cost: number | null; tokens: number; calls: number }[];
  days: { date: string; cost: number | null; tokens: number; calls: number }[];
}

export interface LimitWindow {
  label: string;
  percentLeft: number;
  resetsAt: string | null;
  elapsedPercent: number | null;
}
export interface Limits {
  checkedAt: string;
  providers: { id: string; label: string; windows: LimitWindow[]; note: string | null }[];
}

const SERIES = ["var(--chart-2)", "var(--chart-4)", "var(--chart-1)", "var(--chart-5)", "var(--chart-3)"];
export const seriesColor = (index: number) => SERIES[Math.max(0, index) % SERIES.length];

/** An unknown cost is a dash, never zero. */
export function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v > 0 && v < 0.01) return "<$0.01";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
export const count = (v: number) => compact.format(v);

export const share = (part: number | null, whole: number | null): number | null =>
  part === null || !whole ? null : (part / whole) * 100;
export const percent = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);

export const clampPercent = (v: number) => Math.min(100, Math.max(0, v));

export function resetsIn(resetsAt: string, now: number): string | null {
  const ms = Date.parse(resetsAt) - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "reset due";
  const mins = Math.ceil(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  return `resets in ${d ? `${d}d ${h}h` : h ? `${h}h ${mins % 60}m` : `${mins}m`}`;
}

/** "2026-01-31" to "Jan 31". Read as a calendar date, so the time zone cannot move it. */
export function dayLabel(date: string): string {
  const t = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? date : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
