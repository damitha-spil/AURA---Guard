import * as React from "react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import { Download, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { ColumnDef } from "@tanstack/react-table";
import { DailyDigest } from "@/components/app/daily-digest";
import { DataTable, SortHeader } from "@/components/app/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, Page, PageHeader, StatCard } from "@/components/app/page";
import { apiGet, apiPatch, apiPost } from "@/lib/api";

interface Defect {
  id: string;
  appName: string;
  branch: string;
  testedDate: string;
  testedBy: string;
  assignedTo: string;
  agentSource: string;
  severity: "critical" | "high" | "medium" | "low";
  status: string;
  title: string;
  expected: string;
  actual: string;
  reproSteps: string[];
  codeSuggestion: string;
  fileRef?: string;
  evidencePaths: string[];
  sentTeamsAt?: string;
  recurrenceCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  acknowledged?: boolean;
  acknowledgedAt?: string;
  resolvedAt?: string;
  sample?: boolean;
  history?: { at: string; event: string; note?: string }[];
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
  teamsWebhookOrId: string;
}

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const STATUSES = ["open", "triaged", "notified", "fixed", "resolved", "false_positive"] as const;

const seen = (d: Defect) => d.recurrenceCount ?? 1;
const when = (iso?: string) => (iso ? iso.replace("T", " ").slice(0, 16) : "");

function sevBadge(sev: Defect["severity"]) {
  if (sev === "critical" || sev === "high") return "destructive" as const;
  if (sev === "medium") return "default" as const;
  return "secondary" as const;
}

const chartConfig = {
  count: { label: "Defects", color: "var(--chart-3)" },
} satisfies ChartConfig;

export function DefectsView() {
  const [defects, setDefects] = React.useState<Defect[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [team, setTeam] = React.useState<TeamMember[]>([]);
  const [query, setQuery] = React.useState("");
  const [sevFilter, setSevFilter] = React.useState("all");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [selected, setSelected] = React.useState<Defect | null>(null);
  const [showNew, setShowNew] = React.useState(false);
  const [showTeams, setShowTeams] = React.useState(false);
  const [teamsPreview, setTeamsPreview] = React.useState(false);

  const [title, setTitle] = React.useState("");
  const [appName, setAppName] = React.useState("SPIL AURA");
  const [branch, setBranch] = React.useState("development");
  const [testedBy, setTestedBy] = React.useState("QA Engineer");
  const [assignedTo, setAssignedTo] = React.useState("");
  const [severity, setSeverity] = React.useState<Defect["severity"]>("high");
  const [codeSuggestion, setCodeSuggestion] = React.useState("");

  const [memberId, setMemberId] = React.useState("none");
  const [webhookUrl, setWebhookUrl] = React.useState("");
  const [teamsNote, setTeamsNote] = React.useState("");

  async function load() {
    const [d, p] = await Promise.all([
      apiGet<{ defects: Defect[] }>("/api/defects"),
      apiGet<{ team: TeamMember[] }>("/api/plugins"),
    ]);
    if (d.ok) setDefects(d.data.defects || []);
    if (p.ok) setTeam(p.data.team || []);
    setLoaded(true);
  }

  React.useEffect(() => {
    load();
  }, []);

  const filtered = defects.filter((d) => {
    if (sevFilter !== "all" && d.severity !== sevFilter) return false;
    if (statusFilter !== "all" && d.status !== statusFilter) return false;
    const q = query.trim().toLowerCase();
    if (q && !`${d.id} ${d.title} ${d.appName} ${d.branch} ${d.testedBy}`.toLowerCase().includes(q)) return false;
    return true;
  });

  // Sample records are listed and marked, but never counted, charted, exported or sent.
  const real = defects.filter((d) => !d.sample);
  const sampleCount = defects.length - real.length;
  const shareable = filtered.filter((d) => !d.sample);
  const chartData = SEVERITIES.map((s) => ({ severity: s, count: real.filter((d) => d.severity === s).length }));

  async function createDefect(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const r = await apiPost<{ defect: Defect }>("/api/defects", {
      title,
      appName,
      branch,
      testedBy,
      assignedTo,
      severity,
      codeSuggestion,
    });
    if (r.ok) {
      setShowNew(false);
      setTitle("");
      setCodeSuggestion("");
      toast.success(`Saved defect ${r.data.defect.id}`);
      load();
    } else toast.error(r.error || "Could not save defect");
  }

  async function exportPdf(list: Defect[]) {
    const r = await apiPost<{ path: string; html: string }>("/api/defects/report", {
      ids: list.map((x) => x.id),
      appName: list[0]?.appName,
      branch: list[0]?.branch,
    });
    if (r.ok) {
      toast.success(`Generated report: ${r.data.path}`);
      const url = URL.createObjectURL(new Blob([r.data.html], { type: "text/html" }));
      window.open(url, "_blank", "noopener");
    } else toast.error(r.error || "Report failed");
  }

  async function sendTeams(confirmed: boolean) {
    const m = team.find((x) => x.id === memberId);
    const r = await apiPost<{ sent: boolean; count?: number }>("/api/defects/notify-teams", {
      recipientName: m?.name || "Engineering Team",
      note: teamsNote,
      ids: shareable.map((d) => d.id),
      webhookUrl,
      confirmed,
    });
    if (r.ok) {
      if (r.data.sent) {
        toast.success(`Dispatched ${r.data.count} defect(s) to MS Teams.`);
        setShowTeams(false);
        setTeamsPreview(false);
        load();
      } else {
        setTeamsPreview(true);
        toast("Teams MessageCard preview ready.");
      }
    } else toast.error(r.error || "Teams request failed");
  }

  async function setStatus(d: Defect, st: string) {
    const r = await apiPatch(`/api/defects/${encodeURIComponent(d.id)}`, { status: st });
    if (r.ok) toast.success(`${d.id} marked ${st.replace("_", " ")}`);
    else toast.error(r.error || "Update failed");
    await load();
    setSelected(null);
  }

  async function change(d: Defect, patch: { acknowledged?: boolean; resolved?: boolean }, done: string) {
    const r = await apiPatch<{ defect: Defect }>(`/api/defects/${encodeURIComponent(d.id)}`, patch);
    if (r.ok) {
      toast.success(`${d.id} ${done}`);
      setSelected(r.data.defect);
    } else toast.error(r.error || "Update failed");
    await load();
  }

  const columns = React.useMemo<ColumnDef<Defect>[]>(
    () => [
      { accessorKey: "id", header: ({ column }) => <SortHeader column={column}>ID</SortHeader>, cell: ({ row }) => <span className="font-mono text-xs">{row.original.id}</span> },
      { accessorKey: "title", header: ({ column }) => <SortHeader column={column}>Defect</SortHeader>, cell: ({ row }) => (
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {row.original.title}
          {row.original.sample && <Badge variant="outline">Sample data</Badge>}
        </span>
      ) },
      { id: "seen", header: ({ column }) => <SortHeader column={column}>Seen</SortHeader>, accessorFn: (d) => seen(d), cell: ({ row }) => (seen(row.original) > 1 ? <Badge variant="destructive">{seen(row.original)} times</Badge> : "Once") },
      { accessorKey: "severity", header: ({ column }) => <SortHeader column={column}>Severity</SortHeader>, cell: ({ row }) => <Badge variant={sevBadge(row.original.severity)}>{row.original.severity}</Badge> },
      { id: "app", header: "App / branch", accessorFn: (d) => `${d.appName} / ${d.branch}`, cell: ({ row }) => <span className="text-muted-foreground">{row.original.appName} / {row.original.branch}</span> },
      { accessorKey: "testedDate", header: ({ column }) => <SortHeader column={column}>Tested</SortHeader>, cell: ({ row }) => <span className="text-muted-foreground">{row.original.testedDate} · {row.original.testedBy}</span> },
      { accessorKey: "assignedTo", header: "Assigned", cell: ({ row }) => row.original.assignedTo || "Unassigned" },
      { accessorKey: "status", header: ({ column }) => <SortHeader column={column}>Status</SortHeader>, cell: ({ row }) => (
        <span className="flex flex-wrap gap-1">
          <Badge variant="outline">{row.original.status.replace("_", " ")}</Badge>
          {row.original.acknowledged && <Badge variant="secondary">Acknowledged</Badge>}
        </span>
      ) },
    ],
    [],
  );

  async function moveDefect(id: string, to: string) {
    const d = defects.find((x) => x.id === id);
    if (!d || d.status === to) return;
    setDefects((prev) => prev.map((x) => (x.id === id ? { ...x, status: to } : x)));
    const r = await apiPatch(`/api/defects/${encodeURIComponent(id)}`, to === "resolved" ? { resolved: true } : { status: to });
    if (r.ok) toast.success(`${id} moved to ${to.replace("_", " ")}`);
    else toast.error(r.error || "Update failed");
    load();
  }

  return (
    <Page>
      <PageHeader
        title="Defects"
        description="Track branch bugs, review AI patch suggestions, export reports and notify engineers."
        actions={
          <>
            <Button variant="outline" onClick={() => setShowNew(true)}>
              <Plus />
              Log defect
            </Button>
            <Button variant="outline" onClick={() => setShowTeams(true)} disabled={shareable.length === 0}>
              <Send />
              Send to Teams
            </Button>
            <Button onClick={() => exportPdf(shareable)} disabled={shareable.length === 0}>
              <Download />
              Export PDF
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total" value={real.length} hint={sampleCount ? `Sample records not counted: ${sampleCount}` : undefined} loading={!loaded} />
        <StatCard label="Open" value={real.filter((d) => d.status === "open").length} hint={`Acknowledged: ${real.filter((d) => d.status === "open" && d.acknowledged).length}`} loading={!loaded} />
        <StatCard
          label="Critical / high"
          value={real.filter((d) => d.severity === "critical" || d.severity === "high").length}
          hint={`Came back: ${real.filter((d) => seen(d) > 1).length}`}
          loading={!loaded}
        />
        <StatCard label="Fixed or resolved" value={real.filter((d) => d.status === "fixed" || d.status === "resolved").length} hint={`${real.filter((d) => Boolean(d.sentTeamsAt)).length} sent to Teams`} loading={!loaded} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Defects by severity</CardTitle>
          <CardDescription>All tracked applications. Sample data is not counted.</CardDescription>
        </CardHeader>
        <CardContent>
          {!loaded ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <ChartContainer config={chartConfig} className="h-40 w-full">
              <BarChart data={chartData}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="severity" tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                <Bar dataKey="count" fill="var(--chart-3)" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search defects..." className="w-full sm:max-w-xs" aria-label="Search defects" />
        <Select value={sevFilter} onValueChange={setSevFilter}>
          <SelectTrigger className="w-40" aria-label="Severity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s.replace("_", " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="table">
        <TabsList>
          <TabsTrigger value="table">Table</TabsTrigger>
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="digest">Daily digest</TabsTrigger>
        </TabsList>
        <TabsContent value="digest">
          <DailyDigest />
        </TabsContent>
        <TabsContent value="table">
          <Card className="p-4"><DataTable columns={columns} data={filtered} loading={!loaded} hideFilter onRowClick={setSelected} empty="No defects matching your filter." /></Card>
        </TabsContent>
        <TabsContent value="board">
          {filtered.length === 0 ? (
            <EmptyState title="Nothing to show" description="No defects match the current filters." />
          ) : (
            <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
              {STATUSES.map((st) => {
                const col = filtered.filter((d) => d.status === st);
                return (
                  <div
                    key={st}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      moveDefect(e.dataTransfer.getData("text/plain"), st);
                    }}
                    className="bg-muted/40 flex min-h-24 min-w-0 flex-col gap-2 rounded-2xl border p-2"
                  >
                    <div className="flex items-center justify-between px-1 text-sm font-medium capitalize">
                      {st.replace("_", " ")}
                      <Badge variant="secondary">{col.length}</Badge>
                    </div>
                    {col.map((d) => (
                      <Card
                        key={d.id}
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData("text/plain", d.id)}
                        className="hover:bg-accent cursor-grab gap-2 py-3 transition-colors active:cursor-grabbing"
                        onClick={() => setSelected(d)}
                      >
                        <CardHeader className="px-3">
                          <CardTitle className="line-clamp-2 text-sm break-words">{d.title}</CardTitle>
                          <CardDescription className="truncate font-mono text-xs">{d.id}</CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-wrap gap-1 px-3">
                          <Badge variant={sevBadge(d.severity)}>{d.severity}</Badge>
                          {seen(d) > 1 && <Badge variant="outline">Seen {seen(d)} times</Badge>}
                          {d.acknowledged && <Badge variant="secondary">Acknowledged</Badge>}
                          {d.sample && <Badge variant="outline">Sample data</Badge>}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <form onSubmit={createDefect} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Log defect</DialogTitle>
              <DialogDescription>Record a new defect. Duplicates are merged by the engine.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="d-title">Title *</Label>
              <Input id="d-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Severity</Label>
                <Select value={severity} onValueChange={(v) => setSeverity(v as Defect["severity"])}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="d-app">App name</Label>
                <Input id="d-app" value={appName} onChange={(e) => setAppName(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="d-branch">Branch</Label>
                <Input id="d-branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="d-by">Tested by</Label>
                <Input id="d-by" value={testedBy} onChange={(e) => setTestedBy(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="d-assigned">Assigned engineer</Label>
              <Input id="d-assigned" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="d-fix">Code review suggestion / fix patch</Label>
              <Textarea id="d-fix" value={codeSuggestion} onChange={(e) => setCodeSuggestion(e.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
              <Button type="submit" disabled={!title.trim()}>Save defect</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showTeams} onOpenChange={(o) => { setShowTeams(o); if (!o) setTeamsPreview(false); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send to MS Teams</DialogTitle>
            <DialogDescription>Sends the {shareable.length} defect(s) in the current filter. Sample records are not sent. Preview first.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>Team member</Label>
              <Select
                value={memberId}
                onValueChange={(v) => {
                  setMemberId(v);
                  const hit = team.find((x) => x.id === v);
                  if (hit?.teamsWebhookOrId) setWebhookUrl(hit.teamsWebhookOrId);
                }}
              >
                <SelectTrigger className="w-full"><SelectValue placeholder="Select team member" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Engineering Team</SelectItem>
                  {team.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name} ({m.role})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="t-hook">Webhook URL</Label>
              <Input id="t-hook" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="HTTPS Teams webhook URL" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="t-note">Message note</Label>
              <Input id="t-note" value={teamsNote} onChange={(e) => setTeamsNote(e.target.value)} />
            </div>
            {teamsPreview && <Badge variant="secondary" className="w-fit">Preview ready. Confirm to send.</Badge>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => sendTeams(false)}>Preview card</Button>
            <Button onClick={() => sendTeams(true)}>Confirm &amp; send</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="break-words">{selected.id}: {selected.title}</SheetTitle>
                <SheetDescription>
                  {selected.appName} · {selected.branch} · {selected.testedDate}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-4 px-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={sevBadge(selected.severity)}>{selected.severity}</Badge>
                  <Badge variant="outline">{selected.status.replace("_", " ")}</Badge>
                  <Badge variant="secondary">Agent: {selected.agentSource.toUpperCase()}</Badge>
                  {selected.acknowledged && <Badge variant="secondary">Acknowledged {when(selected.acknowledgedAt)}</Badge>}
                  {selected.sample && <Badge variant="outline">Sample data</Badge>}
                </div>
                <p className="text-muted-foreground text-xs">
                  {seen(selected) > 1 ? `Seen ${seen(selected)} times.` : "Seen once."}
                  {selected.firstSeen && ` First: ${when(selected.firstSeen)}.`}
                  {selected.lastSeen && ` Last: ${when(selected.lastSeen)}.`}
                  {selected.resolvedAt && ` Resolved: ${when(selected.resolvedAt)}.`}
                </p>
                {selected.expected && (
                  <div>
                    <div className="text-muted-foreground text-xs font-medium uppercase">Expected</div>
                    <p className="mt-1">{selected.expected}</p>
                  </div>
                )}
                {selected.actual && (
                  <div>
                    <div className="text-muted-foreground text-xs font-medium uppercase">Actual</div>
                    <p className="mt-1">{selected.actual}</p>
                  </div>
                )}
                {selected.reproSteps?.length > 0 && (
                  <div>
                    <div className="text-muted-foreground text-xs font-medium uppercase">Steps to reproduce</div>
                    <ol className="mt-1 list-decimal space-y-1 pl-5">
                      {selected.reproSteps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </div>
                )}
                {selected.codeSuggestion && (
                  <div>
                    <div className="text-muted-foreground text-xs font-medium uppercase">
                      Code review suggestion {selected.fileRef ? `(${selected.fileRef})` : ""}
                    </div>
                    <pre className="bg-muted mt-1 overflow-auto rounded-md p-3 font-mono text-xs">{selected.codeSuggestion}</pre>
                  </div>
                )}
                {(selected.history?.length ?? 0) > 0 && (
                  <div>
                    <div className="text-muted-foreground text-xs font-medium uppercase">History (UTC)</div>
                    <ul className="mt-1 space-y-1 text-xs">
                      {selected.history!.map((h, i) => (
                        <li key={i} className="break-words">
                          {when(h.at)} {h.event}{h.note ? `: ${h.note.replace("_", " ")}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <SheetFooter className="flex-row flex-wrap">
                <Button variant="outline" size="sm" onClick={() => change(selected, { acknowledged: !selected.acknowledged }, selected.acknowledged ? "is no longer acknowledged" : "acknowledged")}>
                  {selected.acknowledged ? "Remove acknowledgement" : "Acknowledge"}
                </Button>
                {selected.status !== "resolved" && (
                  <Button variant="outline" size="sm" onClick={() => change(selected, { resolved: true }, "marked resolved")}>
                    Mark resolved
                  </Button>
                )}
                {(["triaged", "fixed", "false_positive"] as const).map((st) => (
                  <Button key={st} variant="outline" size="sm" onClick={() => setStatus(selected, st)}>
                    Mark {st.replace("_", " ")}
                  </Button>
                ))}
                {!selected.sample && <Button size="sm" onClick={() => exportPdf([selected])}>Export PDF</Button>}
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </Page>
  );
}
