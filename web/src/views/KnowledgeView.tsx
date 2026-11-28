import * as React from "react";
import { Check, FileText, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortHeader } from "@/components/app/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, IconRow, Page, PageHeader } from "@/components/app/page";
import { NoteChecks } from "@/components/app/note-checks";
import { apiGet, apiPost } from "@/lib/api";
import { inboxItems, type InboxItem, type InboxReply } from "@/lib/inbox";

interface VaultNote {
  id: string;
  title: string;
  type: string;
  status: string;
  audience: string[];
  ref: string;
  anchors: number;
}

interface ReportItem {
  path: string;
  rel?: string;
  name?: string;
  kind?: string;
}

export function KnowledgeView() {
  const [notes, setNotes] = React.useState<VaultNote[]>([]);
  const [inbox, setInbox] = React.useState<InboxItem[]>([]);
  const [reports, setReports] = React.useState<ReportItem[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [decided, setDecided] = React.useState<{ item: InboxItem; to: string }[]>([]);
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [sheetData, setSheetData] = React.useState<{ title: string; content: string } | null>(null);

  async function loadAll() {
    const [n, i, r] = await Promise.all([
      apiGet<{ notes: VaultNote[] }>("/api/reo/notes"),
      apiGet<InboxReply>("/api/inbox"),
      apiGet<{ reports: ReportItem[] }>("/api/reports"),
    ]);
    if (n.ok) setNotes(n.data.notes || []);
    if (i.ok) setInbox(inboxItems(i.data));
    if (r.ok) setReports(r.data.reports || []);
    setLoaded(true);
  }

  React.useEffect(() => {
    loadAll();
  }, []);

  async function openNote(ref: string, title: string) {
    const r = await apiGet<{ content?: string; text?: string }>(`/api/doc?ref=${encodeURIComponent(ref)}`);
    setSheetData({ title, content: r.data?.content || r.data?.text || r.error || "Unable to read note." });
  }

  async function openReport(path: string, name?: string) {
    const r = await apiGet<{ content?: string; text?: string }>(`/api/report?path=${encodeURIComponent(path)}`);
    setSheetData({ title: name || path, content: r.data?.content || r.data?.text || r.error || "Unable to read report." });
  }

  async function decide(item: InboxItem, to: "active" | "deprecated") {
    const r = await apiPost(`/api/notes/${encodeURIComponent(item.id)}/status`, { to });
    if (r.ok) setDecided((prev) => [...prev, { item, to }]);
    if (r.ok) toast.success(to === "active" ? "Rule approved" : "Item dismissed");
    else toast.error(r.error || "Update failed");
    loadAll();
  }

  const [suggesting, setSuggesting] = React.useState(false);
  async function suggestLessons() {
    setSuggesting(true);
    const r = await apiPost<{ written: number; skippedDuplicate: number; blocked: number }>("/api/notes/lessons");
    setSuggesting(false);
    if (!r.ok) return void toast.error(r.error || "Could not suggest lessons.");
    const { written, skippedDuplicate, blocked } = r.data;
    toast.success(`New proposed notes: ${written}. Already saved: ${skippedDuplicate}. Left out as possible secrets: ${blocked}.`);
    loadAll();
  }

  const filteredNotes = notes.filter(
    (n) =>
      (statusFilter === "all" || n.status === statusFilter) &&
      (!query.trim() || `${n.title} ${n.id} ${n.type}`.toLowerCase().includes(query.trim().toLowerCase())),
  );

  const noteColumns = React.useMemo<ColumnDef<VaultNote>[]>(
    () => [
      { accessorKey: "title", header: ({ column }) => <SortHeader column={column}>Title</SortHeader>, cell: ({ row }) => <span className="font-medium">{row.original.title}</span> },
      { accessorKey: "type", header: ({ column }) => <SortHeader column={column}>Type</SortHeader> },
      { accessorKey: "status", header: ({ column }) => <SortHeader column={column}>Status</SortHeader>, cell: ({ row }) => <Badge variant={row.original.status === "active" ? "default" : row.original.status === "stale" ? "destructive" : "secondary"}>{row.original.status}</Badge> },
      { id: "audience", header: "Audience", accessorFn: (n) => (n.audience || []).join(", ") },
      { accessorKey: "anchors", header: ({ column }) => <SortHeader column={column}>Anchors</SortHeader> },
    ],
    [],
  );

  return (
    <Page>
      <PageHeader title="Knowledge" description="Browse vault rules, review proposed items and read saved reports." />

      <Tabs defaultValue="vault">
        <TabsList>
          <TabsTrigger value="vault">Vault <Badge variant="secondary">{notes.length}</Badge></TabsTrigger>
          <TabsTrigger value="inbox">Inbox board <Badge variant={inbox.length ? "default" : "secondary"}>{inbox.length}</Badge></TabsTrigger>
          <TabsTrigger value="checks">Note checks</TabsTrigger>
          <TabsTrigger value="reports">Reports <Badge variant="secondary">{reports.length}</Badge></TabsTrigger>
        </TabsList>

        <TabsContent value="vault" className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search vault notes..." className="w-full sm:max-w-xs" aria-label="Search notes" />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40" aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="proposed">Proposed</SelectItem>
                <SelectItem value="stale">Stale</SelectItem>
                <SelectItem value="shadow">Shadow</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Card className="p-4"><DataTable columns={noteColumns} data={filteredNotes} loading={!loaded} hideFilter onRowClick={(n) => openNote(n.ref, n.title)} empty="No notes found." /></Card>
        </TabsContent>

        <TabsContent value="inbox" className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" onClick={suggestLessons} disabled={suggesting}>
              {suggesting ? "Looking..." : "Suggest lessons"}
            </Button>
            <p className="text-muted-foreground min-w-0 flex-1 text-xs">
              Reads recent Claude session records for your repositories on this computer. No model is used. New notes are only proposed until you approve them.
            </p>
          </div>
          {loaded && inbox.length === 0 && decided.length === 0 ? (
            <EmptyState icon={Check} title="Inbox is clear" description="No proposed items are waiting for review." />
          ) : (
            <div className="grid gap-4 md:grid-cols-3">
              {(
                [
                  ["Proposed", null],
                  ["Approved", "active"],
                  ["Dismissed", "deprecated"],
                ] as const
              ).map(([label, to]) => {
                const col = to === null ? inbox : decided.filter((d) => d.to === to).map((d) => d.item);
                return (
                  <div
                    key={label}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const it = inbox.find((x) => x.id === e.dataTransfer.getData("text/plain"));
                      if (it && to) decide(it, to);
                    }}
                    className="bg-muted/40 flex min-h-24 min-w-0 flex-col gap-2 rounded-2xl border p-2"
                  >
                    <div className="flex items-center justify-between px-1 text-sm font-medium">
                      {label}
                      <Badge variant="secondary">{col.length}</Badge>
                    </div>
                    {col.map((item) => (
                      <Card
                        key={item.id}
                        draggable={to === null}
                        onDragStart={(e) => e.dataTransfer.setData("text/plain", item.id)}
                        className="min-w-0 gap-2 py-3"
                      >
                        <CardHeader className="px-3">
                          <CardTitle className="text-sm break-words">{item.title || item.id}</CardTitle>
                          <CardDescription className="line-clamp-2 text-xs">{item.preview || item.type}</CardDescription>
                        </CardHeader>
                        {to === null && (
                          <CardFooter className="gap-2 px-3">
                            <Button size="sm" className="h-7" onClick={() => decide(item, "active")}>
                              <Check />
                              Approve
                            </Button>
                            <Button variant="outline" size="sm" className="h-7" onClick={() => decide(item, "deprecated")}>
                              <X />
                              Dismiss
                            </Button>
                          </CardFooter>
                        )}
                      </Card>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="checks">
          <NoteChecks titleOf={(id) => notes.find((n) => n.id === id)?.title || id} onOpen={openNote} />
        </TabsContent>

        <TabsContent value="reports">
          <Card className="p-4">
            {reports.length === 0 ? (
              <EmptyState icon={FileText} title="No saved reports" description="Reports from QA runs and exports appear here." />
            ) : (
              <div className="flex flex-col gap-1">
                {reports.map((r) => (
                  <IconRow
                    key={r.path}
                    icon={FileText}
                    title={r.name || r.path}
                    subtitle={r.rel || r.path}
                    right={<Badge variant="outline">{r.kind || "report"}</Badge>}
                    onClick={() => openReport(r.path, r.name)}
                  />
                ))}
              </div>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      <Sheet open={sheetData !== null} onOpenChange={(o) => !o && setSheetData(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle className="break-words">{sheetData?.title || "Document"}</SheetTitle>
            <SheetDescription>Read-only view</SheetDescription>
          </SheetHeader>
          <pre className="px-4 pb-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{sheetData?.content}</pre>
        </SheetContent>
      </Sheet>
    </Page>
  );
}
