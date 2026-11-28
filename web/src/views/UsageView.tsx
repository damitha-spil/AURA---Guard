import * as React from "react";
import { ArrowDown, ArrowUp, Gauge, Info, RefreshCw } from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, Page, PageHeader } from "@/components/app/page";
import { apiGet } from "@/lib/api";
import { useAppearance } from "@/lib/appearance";
import {
  RANGES,
  clampPercent,
  count,
  dayLabel,
  money,
  percent,
  resetsIn,
  seriesColor,
  share,
  type Limits,
  type Range,
  type Usage,
} from "@/lib/usage";
import { cn } from "@/lib/utils";

type Tab = "cost" | "tokens" | "limits";
const ALL = "all";

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="bg-muted flex max-w-full flex-wrap gap-0.5 rounded-2xl p-[3px]">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "focus-visible:ring-ring/50 rounded-xl px-3 py-1 text-sm font-medium outline-none focus-visible:ring-[3px]",
            value === v ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

const Dot = ({ colour }: { colour: string }) => <span className="size-2 shrink-0 rounded-full" style={{ background: colour }} />;

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="bg-muted flex items-start gap-2 rounded-2xl p-3 text-xs">
      <Info className="size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function DailyChart({ data, tab, shown }: { data: Usage; tab: "cost" | "tokens"; shown: { id: string; label: string; colour: string }[] }) {
  const { reduceMotion } = useAppearance();
  // No "color" in the config: ChartContainer would add a <style> tag, which the CSP blocks.
  const config: ChartConfig = Object.fromEntries(shown.map((p) => [p.id, { label: p.label }]));
  const rows = data.daily.map((d) => ({
    date: dayLabel(d.date),
    ...Object.fromEntries(shown.map((p) => [p.id, d.byProvider[p.id]?.[tab] ?? 0])),
  }));
  if (shown.length === 0 || rows.length === 0) {
    return <EmptyState title={tab === "cost" ? "No cost figures to chart" : "Nothing to chart"} />;
  }
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <AreaChart data={rows}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={32} />
        <YAxis width={56} tickLine={false} axisLine={false} tickFormatter={(v: number) => (tab === "cost" ? `$${count(v)}` : count(v))} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name) => (
                <span className="flex w-full justify-between gap-4">
                  <span className="text-muted-foreground">{config[String(name)]?.label ?? String(name)}</span>
                  <span className="font-medium tabular-nums">{tab === "cost" ? money(Number(value)) : count(Number(value))}</span>
                </span>
              )}
            />
          }
        />
        {shown.map((p) => (
          <Area
            key={p.id}
            dataKey={p.id}
            type="monotone"
            stroke={p.colour}
            fill={p.colour}
            fillOpacity={0.15}
            strokeWidth={2}
            dot={rows.length < 3}
            isAnimationActive={reduceMotion ? false : "auto"}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}

const TYPES = [
  ["input", "Input", "var(--chart-2)"],
  ["cacheRead", "Cache read", "var(--chart-4)"],
  ["cacheWrite", "Cache write", "var(--chart-1)"],
  ["output", "Output", "var(--foreground)"],
] as const;

function ByType({ title, values, format }: { title: string; values: Record<(typeof TYPES)[number][0], number> | null; format: (v: number) => string }) {
  const total = values ? TYPES.reduce((sum, [k]) => sum + values[k], 0) : 0;
  return (
    <section className="grid gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="bg-muted flex h-2 gap-0.5 overflow-hidden rounded-full">
        {values && total > 0 && TYPES.map(([k, , colour]) => <span key={k} style={{ width: `${(values[k] / total) * 100}%`, background: colour }} />)}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {TYPES.map(([k, label, colour]) => (
          <span key={k} className="flex items-center gap-1.5">
            <Dot colour={colour} />
            <span className="text-muted-foreground">{label}</span>
            <span className="font-medium tabular-nums">{values ? format(values[k]) : "—"}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

interface Line {
  key: string;
  name: string;
  colour: string | null;
  cost: number | null;
  tokens: number;
}

function Breakdown({ data, tab, selected, colourOf }: { data: Usage; tab: "cost" | "tokens"; selected: string; colourOf: (id: string) => string }) {
  const [by, setBy] = React.useState<"model" | "day">("model");
  const [ascending, setAscending] = React.useState(false);
  let lines: Line[];
  if (by === "model") {
    lines = data.models
      .filter((m) => selected === ALL || m.provider === selected)
      .map((m) => ({ key: `${m.provider}/${m.model}`, name: m.model, colour: colourOf(m.provider), cost: m.cost, tokens: m.tokens }));
  } else if (selected === ALL) {
    lines = data.days.map((d) => ({ key: d.date, name: dayLabel(d.date), colour: null, cost: d.cost, tokens: d.tokens }));
  } else {
    // "days" has no provider, so one provider's days come from the daily series.
    const priced = data.providers.find((p) => p.id === selected)?.cost != null;
    // The 24-hour series is hourly, so its hours are added up into local days.
    const days = new Map<string, Line>();
    for (const d of data.daily) {
      const v = d.byProvider[selected];
      if (!v) continue;
      const day = d.date.includes("T") ? new Date(d.date).toLocaleDateString("en-CA") : d.date;
      const line = days.get(day) ?? { key: day, name: dayLabel(day), colour: colourOf(selected), cost: priced ? 0 : null, tokens: 0 };
      if (line.cost !== null) line.cost += v.cost;
      line.tokens += v.tokens;
      days.set(day, line);
    }
    lines = [...days.values()];
  }
  const whole = lines.reduce((sum, l) => sum + (l[tab] ?? 0), 0);
  // Unknown values stay at the end in both directions.
  lines.sort((a, b) => {
    const x = a[tab];
    const y = b[tab];
    if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
    return ascending ? x - y : y - x;
  });
  const sortHead = (measure: "cost" | "tokens", label: string) => (
    <TableHead className="text-right" aria-sort={tab === measure ? (ascending ? "ascending" : "descending") : undefined}>
      {tab === measure ? (
        <button type="button" onClick={() => setAscending((v) => !v)} className="focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-md font-medium outline-none focus-visible:ring-[3px]">
          {label}
          {ascending ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
        </button>
      ) : (
        label
      )}
    </TableHead>
  );
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Breakdown</h2>
        <Segmented label="Group by" value={by} options={[["model", "Model"], ["day", "Day"]]} onChange={setBy} />
      </div>
      <div className="overflow-x-auto rounded-2xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">#</TableHead>
              <TableHead>{by === "model" ? "Model" : "Day"}</TableHead>
              {sortHead("cost", "Cost")}
              <TableHead className="text-right">Share</TableHead>
              {sortHead("tokens", "Tokens")}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground text-center">
                  No rows.
                </TableCell>
              </TableRow>
            )}
            {lines.map((l, i) => {
              const part = share(l[tab], whole);
              return (
                <TableRow key={l.key}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="min-w-40">
                    <div className="font-medium break-all whitespace-normal">{l.name}</div>
                    <div className="mt-1 h-0.5 rounded-full" style={{ width: `${part ?? 0}%`, background: l.colour ?? "var(--primary)" }} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.cost)}</TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">{percent(part)}</TableCell>
                  <TableCell className="text-right tabular-nums">{count(l.tokens)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function Spend({ data, tab, selected }: { data: Usage; tab: "cost" | "tokens"; selected: string }) {
  if (data.calls === 0) {
    return <EmptyState icon={Gauge} title="No usage in this period" description="Calls made through REO appear here. Ask a question in the Workspace, or choose a longer period." />;
  }
  const colourOf = (id: string) => seriesColor(data.providers.findIndex((p) => p.id === id));
  const providers = data.providers.filter((p) => selected === ALL || p.id === selected);
  const one = selected === ALL ? null : providers[0];
  if (selected !== ALL && !one) return <EmptyState icon={Gauge} title="No calls from this provider in this period" />;
  const allTokens = data.providers.reduce((sum, p) => sum + p.tokens, 0);
  const cost = one ? one.cost : data.cost;
  const tokens = one ? one.tokens : data.totals.processed;
  const shown = providers
    .filter((p) => tab === "tokens" || p.cost !== null)
    .map((p) => ({ id: p.id, label: p.label, colour: colourOf(p.id) }));
  const missingCost = tab === "cost" ? providers.filter((p) => p.cost === null) : [];

  return (
    <div className="@container grid min-w-0 grid-cols-[minmax(0,1fr)] gap-8">
      {(data.unpricedCalls > 0 || data.unreportedCalls > 0) && (
        <Notice>
          {one ? "Across all providers: " : ""}
          {data.unpricedCalls > 0 && `${data.unpricedCalls} call(s) have no known price, so cost figures leave them out. `}
          {data.unreportedCalls > 0 && `${data.unreportedCalls} call(s) did not report usage, so totals may be low.`}
        </Notice>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 @3xl:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <div>
            <div className="text-4xl font-bold tabular-nums">{tab === "cost" ? money(cost) : count(tokens)}</div>
            <div className="text-muted-foreground flex items-center gap-1 text-xs">
              {one ? one.sessions : data.sessions} sessions
              {tab === "cost" && (
                <>
                  {" · "}
                  <Tooltip>
                    <TooltipTrigger className="focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-md outline-none focus-visible:ring-[3px]">
                      API estimate
                      <Info className="size-3" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">
                      An estimate from per-token API prices. It is not a bill, and a subscription may charge differently.
                    </TooltipContent>
                  </Tooltip>
                </>
              )}
            </div>
          </div>
          {providers.map((p) => (
            <div key={p.id}>
              <div className="flex items-center gap-2 text-sm">
                <Dot colour={colourOf(p.id)} />
                <span className="min-w-0 truncate font-medium">{p.label}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{p.sessions} sessions</span>
                <span className="ml-auto shrink-0 font-semibold tabular-nums">{tab === "cost" ? money(p.cost) : count(p.tokens)}</span>
              </div>
              <div className="text-muted-foreground text-xs">
                {tab === "cost"
                  ? `${percent(share(p.cost, data.cost))} of cost · ${count(p.tokens)} tokens`
                  : `${percent(share(p.tokens, allTokens))} of tokens · ${money(p.cost)}`}
              </div>
            </div>
          ))}
        </div>
        <div className="grid min-w-0 content-start gap-2">
          <h2 className="text-sm font-semibold">
            {data.range === "24h" ? "Hourly" : "Daily"} {tab === "cost" ? "cost" : "processed tokens"}
          </h2>
          <DailyChart data={data} tab={tab} shown={shown} />
          {missingCost.length > 0 && (
            <p className="text-muted-foreground text-xs">Not charted, cost unknown: {missingCost.map((p) => p.label).join(", ")}.</p>
          )}
        </div>
      </div>

      {one ? (
        <Notice>Token types and cache savings are only known for all providers together. Choose "All providers" to see them.</Notice>
      ) : (
        <>
          <section className="grid gap-2">
            <h2 className="text-sm font-semibold">Totals</h2>
            <dl className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @3xl:grid-cols-5">
              {[
                ["Processed tokens", count(data.totals.processed)],
                ["Cached input", count(data.totals.cacheRead)],
                ["Uncached input", count(data.totals.input)],
                ["Output", count(data.totals.output)],
                ["Cache savings", money(data.totals.cacheSavings)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground text-xs">{label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          {tab === "cost" ? (
            <ByType title="Cost by type" values={data.cost === null ? null : data.costByType} format={money} />
          ) : (
            <ByType title="Tokens by type" values={data.totals} format={count} />
          )}
        </>
      )}

      <Breakdown data={data} tab={tab} selected={selected} colourOf={colourOf} />
    </div>
  );
}

function LimitCards({ limits, selected }: { limits: Limits; selected: string }) {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const providers = limits.providers.filter((p) => selected === ALL || p.id === selected);
  if (providers.length === 0) {
    return <EmptyState icon={Gauge} title="No limit information" description="No provider here reports its limits." />;
  }
  return (
    <div className="grid gap-6">
      {providers.map((p, i) => (
        <section key={p.id} className="grid gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Dot colour={seriesColor(i)} />
            {p.label}
          </h2>
          {p.windows.length === 0 && <p className="text-muted-foreground rounded-2xl border p-4 text-sm">{p.note || "No limits reported."}</p>}
          {p.windows.map((w) => {
            const left = clampPercent(w.percentLeft);
            const reset = w.resetsAt ? resetsIn(w.resetsAt, now) : null;
            return (
              <div key={w.label} className="bg-card flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border p-4">
                <div className="w-40">
                  <div className="text-sm font-medium">{w.label}</div>
                  <div className="text-3xl font-bold tabular-nums">
                    {Math.round(left)}% <span className="text-muted-foreground text-sm font-normal">left</span>
                  </div>
                </div>
                <div className="grid min-w-48 flex-1 justify-items-end gap-1.5">
                  <div className="relative h-8 w-full">
                    <div
                      role="meter"
                      aria-label={`${p.label} ${w.label}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(left)}
                      aria-valuetext={`${Math.round(left)}% left`}
                      className="usage-used h-full w-full overflow-hidden rounded-lg"
                    >
                      <div className="bg-primary h-full opacity-90" style={{ width: `${left}%` }} />
                    </div>
                    {/* The line shows how much of the window's time is still to come. */}
                    {w.elapsedPercent !== null && (
                      <span
                        className="bg-foreground ring-background absolute inset-y-0 w-0.5 -translate-x-1/2 ring-1"
                        style={{ left: `${100 - clampPercent(w.elapsedPercent)}%` }}
                        title={`${Math.round(clampPercent(w.elapsedPercent))}% of this window's time has passed`}
                      />
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {w.elapsedPercent !== null && (
                      <span className="text-muted-foreground text-xs">{Math.round(clampPercent(w.elapsedPercent))}% of the time has passed</span>
                    )}
                    {reset && <Badge variant="outline">{reset}</Badge>}
                  </div>
                </div>
              </div>
            );
          })}
          {p.windows.length > 0 && p.note && <p className="text-muted-foreground text-xs">{p.note}</p>}
        </section>
      ))}
      {!Number.isNaN(Date.parse(limits.checkedAt)) && (
        <p className="text-muted-foreground text-xs">Checked {new Date(limits.checkedAt).toLocaleString()}.</p>
      )}
    </div>
  );
}

type Result = { key: string; usage?: Usage; limits?: Limits; error?: string };

export function UsageView() {
  const [tab, setTab] = React.useState<Tab>("cost");
  const [range, setRange] = React.useState<Range>("30d");
  const [selected, setSelected] = React.useState(ALL);
  const [reload, setReload] = React.useState(0);
  const [result, setResult] = React.useState<Result | null>(null);
  const [known, setKnown] = React.useState<Record<string, string>>({});
  const key = tab === "limits" ? "limits" : range;

  React.useEffect(() => {
    let cancelled = false;
    setResult(null);
    const url = key === "limits" ? "/api/usage/limits" : `/api/usage?range=${key}`;
    apiGet<Usage & Limits>(url).then((r) => {
      if (cancelled) return;
      if (!r.ok || !Array.isArray(r.data.providers)) {
        setResult({ key, error: r.error || "The engine did not return usage data." });
        return;
      }
      setResult(key === "limits" ? { key, limits: r.data } : { key, usage: r.data });
      setKnown((k) => ({ ...k, ...Object.fromEntries(r.data.providers.map((p) => [p.id, p.label])) }));
    });
    return () => {
      cancelled = true;
    };
  }, [key, reload]);

  // A result for another range or tab must not be shown under the new heading.
  const current = result?.key === key ? result : null;

  return (
    <Page>
      <PageHeader
        title="Usage"
        description="Covers only calls made through REO. Use of the same accounts elsewhere is not counted, except where a provider's own limits include it."
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="w-52" aria-label="Provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All providers</SelectItem>
            {Object.entries(known).map(([id, label]) => (
              <SelectItem key={id} value={id}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap items-center gap-2">
          {tab !== "limits" && <Segmented label="Period" value={range} options={RANGES} onChange={setRange} />}
          <Segmented label="View" value={tab} options={[["cost", "Cost"], ["tokens", "Tokens"], ["limits", "Limits"]]} onChange={setTab} />
          <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw />
          </Button>
        </div>
      </div>

      {!current && <Skeleton className="h-64 w-full" />}
      {current?.error && <EmptyState icon={Gauge} title="Could not load usage" description={current.error} />}
      {current?.usage && tab !== "limits" && <Spend data={current.usage} tab={tab} selected={selected} />}
      {current?.limits && <LimitCards limits={current.limits} selected={selected} />}
    </Page>
  );
}
