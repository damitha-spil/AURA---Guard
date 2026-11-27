import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CountUp } from "@/components/app/motion";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function Page({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 p-4 md:p-6">{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  loading,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="bg-muted rounded-2xl p-5">
      <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs font-medium tracking-wide uppercase">
        <span className="truncate">{label}</span>
        {icon}
      </div>
      <div className="mt-2 text-3xl font-bold tabular-nums">
        {loading ? <Skeleton className="h-9 w-16" /> : typeof value === "number" ? <CountUp value={value} /> : value}
      </div>
      {hint && <div className="text-muted-foreground mt-1 text-xs">{hint}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon: Icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
}) {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-2xl border border-dashed p-8 text-center">
      {Icon && (
        <div className="bg-muted text-foreground flex size-10 items-center justify-center rounded-2xl border">
          <Icon className="size-5" />
        </div>
      )}
      <div className="text-foreground text-sm font-medium">{title}</div>
      {description && <div className="max-w-xs text-xs">{description}</div>}
      {action}
    </div>
  );
}

/** Shows children only after a short delay, so fast loads never flash a loader. */
export function DelayedFallback({ children, ms = 150 }: { children: React.ReactNode; ms?: number }) {
  const [show, setShow] = React.useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setShow(true), ms);
    return () => window.clearTimeout(t);
  }, [ms]);
  return show ? <>{children}</> : null;
}

export function TableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/* Renders arbitrary JSON from the engine as cards/tables, with an optional raw toggle. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cell(v: unknown): React.ReactNode {
  if (v === null || v === undefined || v === "") return <span className="text-muted-foreground">—</span>;
  if (typeof v === "boolean") return <Badge variant={v ? "default" : "secondary"}>{v ? "yes" : "no"}</Badge>;
  if (typeof v === "object") return <span className="font-mono text-xs break-all">{JSON.stringify(v)}</span>;
  return <span className="break-words">{String(v)}</span>;
}

function ObjectTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).slice(0, 8);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {cols.map((c) => (
            <TableHead key={c}>{c}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            {cols.map((c) => (
              <TableCell key={c} className="max-w-xs whitespace-normal">
                {cell(r[c])}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Node({ value, depth }: { value: unknown; depth: number }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground text-sm">Empty</span>;
    if (value.every(isRecord)) return <ObjectTable rows={value as Record<string, unknown>[]} />;
    return (
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {value.map((v, i) => (
          <li key={i}>{cell(v)}</li>
        ))}
      </ul>
    );
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return (
      <dl className="divide-y rounded-2xl border text-sm">
        {entries.map(([k, v]) => (
          <div key={k} className="grid grid-cols-1 gap-1 p-3 sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground truncate font-medium">{k}</dt>
            <dd className="min-w-0">
              {typeof v === "object" && v !== null && depth < 2 ? <Node value={v} depth={depth + 1} /> : cell(v)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <div className="text-sm">{cell(value)}</div>;
}

export function ResultView({ data, title = "Result" }: { data: unknown; title?: string }) {
  const [raw, setRaw] = React.useState(false);
  const isError = isRecord(data) && typeof data.error === "string";
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {title}
            <Badge variant={isError ? "destructive" : "secondary"}>{isError ? "Error" : "Completed"}</Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Switch id="raw-toggle" checked={raw} onCheckedChange={setRaw} />
            <Label htmlFor="raw-toggle" className="text-xs">
              Raw
            </Label>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 overflow-x-auto">
        {raw ? (
          <pre className="bg-muted max-h-96 overflow-auto rounded-md p-4 font-mono text-xs">
            {JSON.stringify(data, null, 2)}
          </pre>
        ) : (
          <Node value={data} depth={0} />
        )}
      </CardContent>
    </Card>
  );
}

/** List row: icon in a rounded muted square, title and muted subtitle, optional right-aligned value. */
export function IconRow({
  icon: Icon,
  title,
  subtitle,
  right,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-xl">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium">{title}</span>
        {subtitle && <span className="text-muted-foreground block truncate text-xs">{subtitle}</span>}
      </span>
      {right && <span className="shrink-0 text-sm font-semibold tabular-nums">{right}</span>}
    </>
  );
  const cls = "flex w-full items-center gap-3 rounded-2xl p-2";
  return onClick ? (
    <button type="button" onClick={onClick} className={cls + " hover:bg-muted focus-visible:ring-ring/50 transition-colors focus-visible:ring-[3px] focus-visible:outline-none"}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-muted rounded-2xl p-4">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{children}</div>
    </div>
  );
}
