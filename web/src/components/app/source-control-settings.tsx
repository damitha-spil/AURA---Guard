import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import type { SourceControl } from "@/lib/repos";

const STATUS = { ready: "Ready", "not-authenticated": "Not signed in", "not-installed": "Not installed" } as const;

function Row({ name, extra, badge, ok, detail }: { name: string; extra?: string | null; badge: string; ok: boolean; detail: string }) {
  return (
    <div className="grid gap-1 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{name}</span>
        {extra && <code className="text-muted-foreground font-mono text-xs">{extra}</code>}
        <Badge variant={ok ? "secondary" : "outline"} className="ml-auto">
          {badge}
        </Badge>
      </div>
      {detail && <p className="text-muted-foreground text-xs break-words whitespace-pre-wrap">{detail}</p>}
    </div>
  );
}

export function SourceControlSettings() {
  const [state, setState] = React.useState<{ data?: SourceControl; error?: string } | null>(null);

  const load = React.useCallback(() => {
    setState(null);
    apiGet<SourceControl>("/api/source-control").then((r) =>
      setState(r.ok && r.data.git && Array.isArray(r.data.providers) ? { data: r.data } : { error: r.error || "The engine did not return this." }),
    );
  }, []);
  React.useEffect(load, [load]);

  const data = state?.data;
  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Version control</h2>
        <Button variant="outline" size="icon" aria-label="Check again" onClick={load}>
          <RefreshCw />
        </Button>
      </div>
      {!state && <Skeleton className="h-32 w-full" />}
      {state?.error && (
        <p role="alert" className="text-destructive rounded-2xl border p-4 text-sm">
          Could not check source control: {state.error}
        </p>
      )}
      {data && (
        <>
          <div className="rounded-2xl border">
            <Row
              name="Git"
              extra={data.git.version}
              badge={data.git.available ? "Available" : "Not found"}
              ok={data.git.available}
              detail={data.git.available ? "" : "Install Git from https://git-scm.com/, make sure git is on PATH, then restart REO."}
            />
          </div>
          <h2 className="text-sm font-semibold">Source control providers</h2>
          <div className="divide-y rounded-2xl border">
            {data.providers.length === 0 && <p className="text-muted-foreground p-4 text-sm">No providers reported.</p>}
            {data.providers.map((p) => (
              <Row key={p.id} name={p.label} badge={STATUS[p.status] ?? p.status} ok={p.status === "ready"} detail={p.detail} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
