import * as React from "react";
import { Bug, FlaskConical, Inbox, MessageSquare, Activity as ActivityIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Stagger, StaggerItem } from "@/components/app/motion";
import { EmptyState, IconRow, Page, PageHeader } from "@/components/app/page";
import { apiGet } from "@/lib/api";

type Kind = "defect" | "run" | "chat" | "inbox";

interface Entry {
  key: string;
  kind: Kind;
  when: string;
  title: string;
  detail: string;
  tag: string;
  view: string;
}

const KIND_META: Record<Kind, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  defect: { label: "Defect", icon: Bug },
  run: { label: "QA run", icon: FlaskConical },
  chat: { label: "Chat", icon: MessageSquare },
  inbox: { label: "Inbox", icon: Inbox },
};

export function ActivityView({ onOpenView }: { onOpenView: (view: string) => void }) {
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [filter, setFilter] = React.useState("all");
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    Promise.all([
      apiGet<{ defects: { id: string; title: string; testedDate: string; severity: string; status: string; appName: string }[] }>("/api/defects"),
      apiGet<{ runs: { id: string; generatedAt: string; request: string; summary: string; scorecard: { defectsCount: number; runStatus: string } }[] }>("/api/qa/runs"),
      apiGet<{ chats: { id: string; title?: string; updated?: string }[] }>("/api/chats"),
      apiGet<{ items?: { id: string; title?: string; reason?: string; status?: string }[]; notes?: { id: string; title?: string; reason?: string; status?: string }[] }>("/api/inbox"),
    ]).then(([d, r, c, i]) => {
      const out: Entry[] = [];
      if (d.ok)
        for (const x of d.data.defects || [])
          out.push({ key: `d-${x.id}`, kind: "defect", when: x.testedDate, title: x.title, detail: `${x.id} · ${x.appName}`, tag: `${x.severity} · ${x.status.replace("_", " ")}`, view: "defects" });
      if (r.ok)
        for (const x of r.data.runs || [])
          out.push({ key: `r-${x.id}`, kind: "run", when: x.generatedAt, title: x.request || x.id, detail: x.summary, tag: `${x.scorecard.defectsCount} defects · ${x.scorecard.runStatus}`, view: "runs" });
      if (c.ok)
        for (const x of c.data.chats || [])
          out.push({ key: `c-${x.id}`, kind: "chat", when: x.updated || "", title: x.title || "Untitled chat", detail: "Conversation updated", tag: "chat", view: "workspace" });
      if (i.ok)
        for (const x of i.data.items || i.data.notes || [])
          out.push({ key: `i-${x.id}`, kind: "inbox", when: "", title: x.title || x.id, detail: x.reason || "Waiting for review", tag: x.status || "proposed", view: "knowledge" });
      out.sort((a, b) => b.when.localeCompare(a.when));
      setEntries(out);
      setLoaded(true);
    });
  }, []);

  const q = query.trim().toLowerCase();
  const shown = entries.filter(
    (e) => (filter === "all" || e.kind === filter) && (!q || `${e.title} ${e.detail} ${e.tag}`.toLowerCase().includes(q)),
  );

  return (
    <Page>
      <PageHeader title="Activity" description="Everything that happened, newest first: defects, QA runs, chats and inbox items." />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            {(Object.keys(KIND_META) as Kind[]).map((k) => (
              <TabsTrigger key={k} value={k}>{KIND_META[k].label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter activity..." className="w-full sm:w-64" aria-label="Filter activity" />
      </div>

      {!loaded ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState icon={ActivityIcon} title="Nothing here yet" description="Run an agent or log a defect and it will show up in this feed." />
      ) : (
        <Card className="p-4">
          <Stagger key={filter + q} className="flex flex-col gap-1">
            {shown.slice(0, 100).map((e) => (
              <StaggerItem key={e.key}>
                <IconRow
                  icon={KIND_META[e.kind].icon}
                  title={e.title}
                  subtitle={`${e.detail}${e.when ? " · " + e.when.replace("T", " ").slice(0, 16) : ""}`}
                  right={<Badge variant="secondary">{e.tag}</Badge>}
                  onClick={() => onOpenView(e.view)}
                />
              </StaggerItem>
            ))}
          </Stagger>
        </Card>
      )}
    </Page>
  );
}
