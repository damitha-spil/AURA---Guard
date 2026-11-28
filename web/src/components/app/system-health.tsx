// Settings > System health: GET /api/health.
import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TableSkeleton } from "@/components/app/page";
import { apiGet } from "@/lib/api";

type Status = "ok" | "warn" | "fail" | "unknown";
interface Row { id: string; label: string; status: Status; detail: string; fix: string | null; ms: number }
interface Report { checkedAt: string; status: Status; rows: Row[] }

const WORD: Record<Status, string> = { ok: "OK", warn: "Needs attention", fail: "Not working", unknown: "Unknown" };
const variant = (s: Status) => (s === "ok" ? ("default" as const) : s === "fail" ? ("destructive" as const) : ("secondary" as const));

export function SystemHealth() {
  const [report, setReport] = React.useState<Report | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setBusy(true);
    setError("");
    // An old result must not stay on screen as if it were new.
    setReport(null);
    const r = await apiGet<Report>("/api/health");
    setBusy(false);
    if (r.ok && Array.isArray(r.data.rows)) setReport(r.data);
    else setError(r.error || "The engine did not return a health report.");
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle>System health</CardTitle>
            <CardDescription>Local checks. No model is called. Each row says what was and was not checked.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={busy}>
            <RefreshCw className={busy ? "animate-spin" : undefined} />
            Check again
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2">
        {busy && <TableSkeleton rows={6} />}
        {error && <p role="alert" className="text-destructive text-sm break-words">{error}</p>}
        {report?.rows.map((r) => (
          <div key={r.id} className="grid gap-1 rounded-2xl border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{r.label}</span>
              <Badge variant={variant(r.status)}>{WORD[r.status] ?? r.status}</Badge>
            </div>
            <p className="text-muted-foreground text-xs break-words">{r.detail}</p>
            {r.fix && <p className="text-xs break-words">How to fix: {r.fix}</p>}
          </div>
        ))}
        {report && <p className="text-muted-foreground text-xs">Checked {new Date(report.checkedAt).toLocaleString()}.</p>}
      </CardContent>
    </Card>
  );
}
