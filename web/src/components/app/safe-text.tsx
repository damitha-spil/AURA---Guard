// REO's own small renderer, part 2: React elements for assistant replies. It builds ONLY React elements from
// parsed data (lib/safe-text.ts): no HTML strings, no dangerouslySetInnerHTML, no markdown library. Links
// are shown as plain text with a Copy button; nothing here can navigate. Cards are drawn from validated,
// capped data; an invalid card is shown as plain text.
import * as React from "react";
import { Check, Copy, TriangleAlert, X, Info } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { layoutDiagram, parseBlocks } from "@/lib/safe-text";
import type { Block, Card, Inline } from "@/lib/safe-text";

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Could not copy.");
  }
}

function Inlines({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((n, i) => {
        switch (n.t) {
          case "text": return <React.Fragment key={i}>{n.s}</React.Fragment>;
          case "b": return <strong key={i}><Inlines items={n.c} /></strong>;
          case "i": return <em key={i}><Inlines items={n.c} /></em>;
          case "code": return <code key={i} className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">{n.s}</code>;
          case "link":
            return (
              <span key={i}>
                {n.s} <span className="text-muted-foreground break-all">({n.url})</span>{" "}
                <button type="button" className="text-muted-foreground hover:text-foreground inline-flex items-center align-middle" title="Copy link" aria-label={`Copy link ${n.url}`} onClick={() => void copyText(n.url, "Link")}>
                  <Copy className="size-3" />
                </button>
              </span>
            );
        }
      })}
    </>
  );
}

function CodeBlock({ lang, s }: { lang: string; s: string }) {
  return (
    <div className="bg-muted/60 relative rounded-xl border">
      <div className="text-muted-foreground flex items-center justify-between px-3 pt-1.5 text-xs">
        <span>{lang || "code"}</span>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void copyText(s, "Code")}>
          <Copy /> Copy
        </Button>
      </div>
      <pre className="overflow-x-auto px-3 pt-1 pb-3 font-mono text-xs whitespace-pre">{s}</pre>
    </div>
  );
}

const STATUS_STYLE = {
  ok: { icon: Check, cls: "text-emerald-600 dark:text-emerald-400" },
  warn: { icon: TriangleAlert, cls: "text-amber-600 dark:text-amber-400" },
  fail: { icon: X, cls: "text-destructive" },
  info: { icon: Info, cls: "text-muted-foreground" },
} as const;
const chartConfig = { value: { label: "Value", color: "var(--chart-1)" } } satisfies ChartConfig;

function CardView({ card }: { card: Card }) {
  const shell = "bg-card rounded-2xl border p-3 text-sm";
  switch (card.card) {
    case "table":
      return (
        <div className={cn(shell, "overflow-x-auto")}>
          <table className="w-full text-left text-xs">
            <thead><tr>{card.columns.map((c, i) => <th key={i} className="border-b px-2 py-1 font-medium">{c}</th>)}</tr></thead>
            <tbody>{card.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="border-b px-2 py-1 break-words">{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    case "checklist":
      return (
        <ul className={cn(shell, "space-y-1")}>
          {card.items.map((it, i) => (
            <li key={i} className="flex items-start gap-2">
              <span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border", it.done && "bg-primary text-primary-foreground")}>{it.done && <Check className="size-3" />}</span>
              <span className={cn(it.done && "text-muted-foreground line-through")}>{it.text}</span>
              <span className="sr-only">{it.done ? "done" : "not done"}</span>
            </li>
          ))}
        </ul>
      );
    case "keyvalue":
      return (
        <dl className={cn(shell, "grid grid-cols-[auto_1fr] gap-x-4 gap-y-1")}>
          {card.pairs.map((p, i) => (
            <React.Fragment key={i}><dt className="text-muted-foreground">{p.k}</dt><dd className="break-words">{p.v}</dd></React.Fragment>
          ))}
        </dl>
      );
    case "status":
      return (
        <ul className={cn(shell, "space-y-1")}>
          {card.items.map((it, i) => {
            const S = STATUS_STYLE[it.status];
            return <li key={i} className="flex items-center gap-2"><S.icon className={cn("size-4 shrink-0", S.cls)} /><span>{it.label}</span><span className="text-muted-foreground text-xs">({it.status})</span></li>;
          })}
        </ul>
      );
    case "progress": {
      const pct = Math.min(100, Math.round((card.value / card.max) * 100));
      return (
        <div className={shell} role="group" aria-label={card.label}>
          <div className="mb-1 flex justify-between text-xs"><span>{card.label}</span><span>{card.value} / {card.max} ({pct}%)</span></div>
          <div className="bg-muted h-2 overflow-hidden rounded-full" role="progressbar" aria-valuenow={card.value} aria-valuemin={0} aria-valuemax={card.max}>
            <div className="bg-primary h-full" style={{ width: `${pct}%` }} />
          </div>
        </div>
      );
    }
    case "chart":
      return (
        <div className={shell}>
          <ChartContainer config={chartConfig} className="h-44 w-full">
            {card.type === "bar" ? (
              <BarChart data={card.data}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis width={32} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="value" fill="var(--color-value)" radius={4} isAnimationActive={false} />
              </BarChart>
            ) : (
              <LineChart data={card.data}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis width={32} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line dataKey="value" stroke="var(--color-value)" dot={false} isAnimationActive={false} />
              </LineChart>
            )}
          </ChartContainer>
          <p className="sr-only">{card.data.map((d) => `${d.label}: ${d.value}`).join(", ")}</p>
        </div>
      );
    case "diagram": {
      const g = layoutDiagram(card.nodes, card.edges);
      return (
        <div className={cn(shell, "overflow-x-auto")}>
          <svg width={g.w} height={g.h} viewBox={`0 0 ${g.w} ${g.h}`} role="img" aria-label={`Diagram: ${card.nodes.map((n) => n.label).join(", ")}`} className="text-foreground">
            <defs><marker id="reo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
            {g.lines.map((l, i) => <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="currentColor" strokeWidth={1.2} markerEnd="url(#reo-arrow)" />)}
            {g.boxes.map((b) => (
              <g key={b.id}>
                <rect x={b.x} y={b.y} width={120} height={34} rx={8} fill="none" stroke="currentColor" />
                <text x={b.x + 60} y={b.y + 21} textAnchor="middle" fontSize={11} fill="currentColor">{b.label.length > 18 ? `${b.label.slice(0, 17)}...` : b.label}</text>
              </g>
            ))}
          </svg>
        </div>
      );
    }
  }
}

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case "p": return <p className="whitespace-pre-wrap"><Inlines items={b.c} /></p>;
    case "h": return <p className={cn("font-semibold", b.level === 1 ? "text-base" : "text-sm")} role="heading" aria-level={b.level + 2}><Inlines items={b.c} /></p>;
    case "ul": return <ul className="list-disc space-y-0.5 pl-5">{b.items.map((it, i) => <li key={i}><Inlines items={it} /></li>)}</ul>;
    case "ol": return <ol className="list-decimal space-y-0.5 pl-5">{b.items.map((it, i) => <li key={i}><Inlines items={it} /></li>)}</ol>;
    case "code": return <CodeBlock lang={b.lang} s={b.s} />;
    case "table":
      return (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-xs">
            <thead><tr>{b.head.map((c, i) => <th key={i} className="bg-muted/50 border-b px-2 py-1 font-medium"><Inlines items={c} /></th>)}</tr></thead>
            <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="border-b px-2 py-1 break-words"><Inlines items={c} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    case "card": return <CardView card={b.card} />;
    case "badcard": return <CodeBlock lang="card (not shown: it did not match the card format)" s={b.raw} />;
  }
}

/** A formatted assistant reply. Falls back to plain text if anything unexpected happens while parsing. */
export function SafeText({ text }: { text: string }) {
  const blocks = React.useMemo(() => {
    try { return parseBlocks(text); } catch { return null; }
  }, [text]);
  if (!blocks) return <>{text}</>;
  return <div className="flex flex-col gap-2">{blocks.map((b, i) => <BlockView key={i} b={b} />)}</div>;
}
