import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { FlaskConical, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { CountUp } from "@/components/app/motion";
import { DataTable, SortHeader } from "@/components/app/data-table";
import { EmptyState, Page, PageHeader, StatCard, Tile } from "@/components/app/page";
import { apiGet } from "@/lib/api";
import { useMediaQuery } from "@/lib/hooks";

interface Scorecard {
  totalCases: number;
  p0Count: number;
  p1Count: number;
  p2Count: number;
  safetyChecked: number;
  safetyPassed: number;
  runStatus: string;
  defectsCount: number;
  passRate: number | null;
  releaseGate: string;
  gateReason: string;
}

interface RunItem {
  id: string;
  generatedAt: string;
  request: string;
  summary: string;
  targetLabel: string;
  riskLevel: string;
  backend: string | null;
  modelUsed: boolean;
  totalSeconds: number;
  scorecard: Scorecard;
}

interface Kpis {
  totalRuns: number;
  executedRuns: number;
  passRate: number | null;
  totalDefects: number;
  avgSeconds: number;
  modelRuns: number;
}

interface Span {
  id: string;
  label: string;
  kind: string;
  status: string;
  startMs: number;
  durationMs: number;
  detail: string;
}

interface RunDetail {
  result: { id: string; request: string; summary: string; cases?: Record<string, unknown>[]; run?: { defects?: Record<string, unknown>[] } | null };
  scorecard: Scorecard;
  spans: Span[];
  screenshots: { journey: string; step: string; path: string }[];
}

function gateVariant(g: string) {
  return g === "blocked" || g === "fail" ? ("destructive" as const) : ("secondary" as const);
}

function RunDetailPanel({ id, onClose }: { id: string; onClose?: () => void }) {
  const [detail, setDetail] = React.useState<RunDetail | null>(null);
  const [error, setError] = React.useState("");
  const [raw, setRaw] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    setDetail(null);
    setError("");
    apiGet<RunDetail>(`/api/qa/run?id=${encodeURIComponent(id)}`).then((r) => {
      if (!live) return;
      if (r.ok) setDetail(r.data);
      else setError(r.error || "Could not load this run.");
    });
    return () => {
      live = false;
    };
  }, [id]);

  const total = Math.max(1, ...(detail?.spans || []).map((s) => s.startMs + s.durationMs));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b p-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{detail?.result.request || id}</div>
          <div className="text-muted-foreground truncate font-mono text-xs">{id}</div>
        </div>
        {onClose && (
          <Button variant="ghost" size="icon" aria-label="Close run" onClick={onClose}>
            <X />
          </Button>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {error && <EmptyState title="Run unavailable" description={error} />}
          {!detail && !error && (
            <>
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </>
          )}
          {detail && (
            <>
              <p className="text-muted-foreground text-sm">{detail.result.summary}</p>
              <div className="grid grid-cols-2 gap-3">
                <Tile label="Pass rate">
                  {detail.scorecard.passRate === null ? "n/a" : <><CountUp value={detail.scorecard.passRate} />%</>}
                </Tile>
                <Tile label="Defects"><CountUp value={detail.scorecard.defectsCount} /></Tile>
                <Tile label="Cases P0 / P1 / P2">
                  <span className="text-lg">{detail.scorecard.totalCases} · {detail.scorecard.p0Count}/{detail.scorecard.p1Count}/{detail.scorecard.p2Count}</span>
                </Tile>
                <Tile label="Release gate">
                  <Badge variant={gateVariant(detail.scorecard.releaseGate)}>{detail.scorecard.releaseGate}</Badge>
                </Tile>
              </div>
              {detail.scorecard.gateReason && <p className="text-muted-foreground text-xs">{detail.scorecard.gateReason}</p>}

              <div>
                <h3 className="mb-2 text-sm font-medium">Steps</h3>
                {detail.spans.length === 0 ? (
                  <EmptyState title="No step timeline" description="This run recorded no timing spans." />
                ) : (
                  <ol className="before:bg-border relative space-y-3 pl-5 before:absolute before:top-1 before:bottom-1 before:left-[5px] before:w-px">
                    {detail.spans.map((s) => (
                      <li key={s.id} className="relative">
                        <span className="bg-background absolute top-1.5 -left-5 size-3 rounded-full border" />
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm">{s.label}</span>
                          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                            <CountUp value={s.durationMs} /> ms
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <Badge variant="outline">{s.kind}</Badge>
                          <Badge variant={s.status === "error" ? "destructive" : "secondary"}>{s.status}</Badge>
                        </div>
                        <Progress value={Math.min(100, (s.durationMs / total) * 100)} className="mt-2 h-1.5" />
                        {s.detail && <p className="text-muted-foreground mt-1 text-xs break-words">{s.detail}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium">Findings</h3>
                  <div className="flex items-center gap-2">
                    <Switch id="run-raw" checked={raw} onCheckedChange={setRaw} />
                    <Label htmlFor="run-raw" className="text-xs">Raw</Label>
                  </div>
                </div>
                {raw ? (
                  <pre className="bg-muted max-h-72 overflow-auto rounded-md p-3 font-mono text-xs">
                    {JSON.stringify(detail.result.run ?? detail.result.cases ?? {}, null, 2)}
                  </pre>
                ) : (detail.result.run?.defects || []).length === 0 ? (
                  <EmptyState title="No defects found" description="This run did not report any defects." />
                ) : (
                  <div className="space-y-2">
                    {(detail.result.run?.defects || []).map((d, i) => (
                      <div key={i} className="rounded-2xl border p-3 text-xs">
                        <div className="font-medium break-words">{String(d.title ?? d.message ?? d.step ?? `Defect ${i + 1}`)}</div>
                        <div className="text-muted-foreground mt-1 break-words">
                          {[d.journeyId, d.step, d.severity].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function RunsView() {
  const [runs, setRuns] = React.useState<RunItem[]>([]);
  const [kpis, setKpis] = React.useState<Kpis | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const wide = useMediaQuery("(min-width: 1100px)");

  React.useEffect(() => {
    apiGet<{ runs: RunItem[]; kpis: Kpis }>("/api/qa/runs").then((r) => {
      if (r.ok) {
        setRuns((r.data.runs || []).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)));
        setKpis(r.data.kpis || null);
      }
      setLoaded(true);
    });
  }, []);

  const columns = React.useMemo<ColumnDef<RunItem>[]>(
    () => [
      { accessorKey: "generatedAt", header: ({ column }) => <SortHeader column={column}>When</SortHeader>, cell: ({ row }) => row.original.generatedAt.replace("T", " ").slice(0, 16) },
      { accessorKey: "request", header: "Request", cell: ({ row }) => <span className="font-medium">{row.original.request || row.original.id}</span> },
      { accessorFn: (r) => r.scorecard.runStatus, id: "status", header: "Status", cell: ({ row }) => <Badge variant="outline">{row.original.scorecard.runStatus}</Badge> },
      { accessorFn: (r) => r.scorecard.passRate ?? -1, id: "pass", header: ({ column }) => <SortHeader column={column}>Pass</SortHeader>, cell: ({ row }) => (row.original.scorecard.passRate === null ? "n/a" : `${row.original.scorecard.passRate}%`) },
      { accessorFn: (r) => r.scorecard.defectsCount, id: "defects", header: ({ column }) => <SortHeader column={column}>Defects</SortHeader> },
      { accessorKey: "totalSeconds", header: ({ column }) => <SortHeader column={column}>Seconds</SortHeader> },
    ],
    [],
  );

  const table = (
    <div className="min-w-0 space-y-4 p-4 md:p-6">
      <PageHeader title="QA runs" description="History of generated QA plans and executed runs. Select a run to see its steps." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total runs" value={kpis?.totalRuns ?? 0} loading={!loaded} />
        <StatCard label="Executed" value={kpis?.executedRuns ?? 0} loading={!loaded} />
        <StatCard label="Avg pass rate" value={kpis?.passRate ?? 0} hint={kpis?.passRate === null ? "No executed runs yet" : "percent"} loading={!loaded} />
        <StatCard label="Defects found" value={kpis?.totalDefects ?? 0} loading={!loaded} />
      </div>
      {loaded && runs.length === 0 ? (
        <EmptyState icon={FlaskConical} title="No QA runs yet" description="Run a QA mission from the Workspace and it will be saved here." />
      ) : (
        <Card className="p-4"><DataTable columns={columns} data={runs} loading={!loaded} onRowClick={(r) => setSelected(r.id)} filterPlaceholder="Filter runs..." /></Card>
      )}
    </div>
  );

  if (selected && wide) {
    return (
      <ResizablePanelGroup orientation="horizontal" className="h-full">
        <ResizablePanel defaultSize="55%" minSize="30%">
          <ScrollArea className="h-full">{table}</ScrollArea>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="45%" minSize="30%">
          <RunDetailPanel id={selected} onClose={() => setSelected(null)} />
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  return (
    <>
      <Page>{table}</Page>
      <Sheet open={selected !== null && !wide} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full gap-0 sm:max-w-xl">
          <SheetHeader className="sr-only">
            <SheetTitle>Run detail</SheetTitle>
            <SheetDescription>Steps and findings for the selected run</SheetDescription>
          </SheetHeader>
          {selected && <RunDetailPanel id={selected} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
