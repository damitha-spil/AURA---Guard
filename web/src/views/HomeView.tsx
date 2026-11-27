import * as React from "react";
import { Bug, FileText, Library, MessageSquare, Plug, ShieldCheck, Sparkles, Terminal, TriangleAlert } from "lucide-react";
import { BrandAvatar } from "@/components/app/brand";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { DefectsByStatus, DefectsOverTime, NotesByStatus, RunsOverTime, type DefectLite, type NoteLite, type RunLite } from "@/components/app/charts";
import { Stagger, StaggerItem } from "@/components/app/motion";
import { Page, PageHeader, StatCard } from "@/components/app/page";
import { apiGet, apiPost } from "@/lib/api";

export interface SystemTelemetry {
  repos: { id: string; label: string; path: string }[];
  vaultNotes: number;
  vaultProblems: number;
  skillsCount: number;
  defectsCount: number;
  guardrails: {
    readOnlyRepos: boolean;
    maskingGate: string;
    localOnlyProbes: boolean;
    erpWritesBlocked: boolean;
  };
}

type Source = { ref: string; title?: string; kind?: string };

export function HomeView({
  onOpenWorkspace,
  onOpenView,
}: {
  onOpenWorkspace: (initialPrompt?: string, routeNotice?: string) => void;
  onOpenView: (view: string) => void;
}) {
  const [prompt, setPrompt] = React.useState("");
  const [notesOnly, setNotesOnly] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [answerText, setAnswerText] = React.useState<string | null>(null);
  const [asked, setAsked] = React.useState("");
  const [sources, setSources] = React.useState<Source[]>([]);
  const [sys, setSys] = React.useState<SystemTelemetry | null>(null);
  const [sysLoaded, setSysLoaded] = React.useState(false);
  const [defects, setDefects] = React.useState<DefectLite[]>([]);
  const [runs, setRuns] = React.useState<RunLite[]>([]);
  const [notes, setNotes] = React.useState<NoteLite[]>([]);
  const [chartsLoaded, setChartsLoaded] = React.useState(false);

  React.useEffect(() => {
    Promise.all([
      apiGet<{ defects: DefectLite[] }>("/api/defects"),
      apiGet<{ runs: RunLite[] }>("/api/qa/runs"),
      apiGet<{ notes: NoteLite[] }>("/api/reo/notes"),
    ]).then(([d, r, n]) => {
      if (d.ok) setDefects(d.data.defects || []);
      if (r.ok) setRuns(r.data.runs || []);
      if (n.ok) setNotes(n.data.notes || []);
      setChartsLoaded(true);
    });
  }, []);

  React.useEffect(() => {
    apiGet<SystemTelemetry>("/api/reo/system").then((r) => {
      if (r.ok) setSys(r.data);
      setSysLoaded(true);
    });
  }, []);

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    const q = prompt.trim();
    if (!q || loading) return;
    setLoading(true);
    const route = await apiPost<{ destination: "landing" | "workspace"; agents: string[]; reason: string }>(
      "/api/reo/route",
      { prompt: q },
    );
    if (route.ok && route.data.destination === "workspace") {
      setLoading(false);
      setPrompt("");
      onOpenWorkspace(q, `Routed to ${route.data.agents.join(", ")} agent(s) — ${route.data.reason}`);
      return;
    }

    const created = await apiPost<{ id: string }>("/api/chats", {});
    if (!created.ok || !created.data.id) {
      setLoading(false);
      setAnswerText("Could not create a session with the local engine.");
      toast.error("Could not create a session with the local engine.");
      return;
    }
    const res = await apiPost<{ ok?: boolean; text?: string; sources?: Source[] }>(
      `/api/chats/${created.data.id}/ask`,
      { question: q, notesOnly },
    );
    setLoading(false);
    setAsked(q);
    setAnswerText(res.data?.text || res.error || "No answer returned.");
    setSources(Array.isArray(res.data?.sources) ? res.data.sources : []);
  }

  const guardrails: [string, boolean][] = sys
    ? [
        ["Read-only target repositories", sys.guardrails.readOnlyRepos],
        ["Local-only security probes", sys.guardrails.localOnlyProbes],
        ["ERP write tools blocked", sys.guardrails.erpWritesBlocked],
      ]
    : [];

  const presets = [
    { label: "Run QA & Review", prompt: "@qa @review inspect the latest branch changes", icon: Terminal },
    { label: "Cyber Security Audit", prompt: "@security audit localhost backend safety", icon: ShieldCheck },
    { label: "QE Trajectory & Drift", prompt: "@qe analyze 7-day commit trajectory & KB drift", icon: Sparkles },
  ];

  const card = "mb-4 break-inside-avoid min-w-0";
  return (
    <Page>
      <PageHeader
        title="Overview"
        description="Ask your vault, launch specialist agents, and keep an eye on defects."
        actions={
          <Button variant="outline" onClick={() => onOpenView("agents")}>
            View Agents &amp; Skills
          </Button>
        }
      />

      <Stagger className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StaggerItem><StatCard label="Vault notes" value={sys?.vaultNotes ?? 0} icon={<FileText className="size-4" />} loading={!sysLoaded} /></StaggerItem>
        <StaggerItem><StatCard label="Skills" value={sys?.skillsCount ?? 0} icon={<Library className="size-4" />} loading={!sysLoaded} /></StaggerItem>
        <StaggerItem><StatCard label="Tracked defects" value={sys?.defectsCount ?? 0} icon={<Bug className="size-4" />} loading={!sysLoaded} /></StaggerItem>
        <StaggerItem><StatCard label="Vault problems" value={sys?.vaultProblems ?? 0} icon={<TriangleAlert className="size-4" />} loading={!sysLoaded} /></StaggerItem>
      </Stagger>

      <div className="columns-1 gap-4 lg:columns-2 2xl:columns-3">
        <Card className={card}>
          <CardHeader>
            <CardTitle>Ask REO</CardTitle>
            <CardDescription>
              Knowledge questions are answered here. Operational requests (@qa, @security, @review) open the Workspace.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <form onSubmit={handleAsk} className="flex flex-col gap-3">
              <Input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Ask a knowledge question, or type @qa / @security..."
                aria-label="Ask SPIL REO"
              />
              <div className="flex items-center gap-2">
                <Switch id="home-notes-only" checked={notesOnly} onCheckedChange={setNotesOnly} />
                <Label htmlFor="home-notes-only" className="text-muted-foreground text-xs">
                  Notes only (strict vault citations)
                </Label>
              </div>
              <Button type="submit" className="w-full" disabled={!prompt.trim() || loading}>
                {loading ? "Thinking..." : "Ask REO"}
              </Button>
            </form>

            {loading && (
              <div className="flex gap-3">
                <BrandAvatar />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              </div>
            )}

            {answerText !== null && !loading && (
              <div className="bg-muted space-y-3 rounded-2xl p-4">
                <div className="flex items-center gap-2">
                  <BrandAvatar className="size-6" />
                  <div className="text-muted-foreground min-w-0 truncate text-xs">Q: {asked}</div>
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{answerText}</p>
                {sources.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {sources.map((s) => (
                      <Badge key={s.ref} variant="outline" className="max-w-full">
                        <span className="truncate">{s.title || s.ref}</span>
                      </Badge>
                    ))}
                  </div>
                )}
                <Button variant="outline" size="sm" onClick={() => onOpenWorkspace(prompt || undefined)}>
                  Continue in Workspace
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={card}>
          <CardHeader>
            <CardTitle>Quick actions</CardTitle>
            <CardDescription>Launch a multi-agent mission</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onOpenWorkspace(p.prompt)}
                className="hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-2xl p-2 text-left transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
              >
                <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-xl">
                  <p.icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{p.label}</span>
                  <span className="text-muted-foreground block truncate text-xs">{p.prompt}</span>
                </span>
              </button>
            ))}
          </CardContent>
          <CardFooter>
            <Button className="w-full" onClick={() => onOpenWorkspace()}>
              <MessageSquare />
              Open Workspace
            </Button>
          </CardFooter>
        </Card>

        <div className="mb-4 break-inside-avoid"><DefectsOverTime defects={defects} loading={!chartsLoaded} /></div>
        <div className="mb-4 break-inside-avoid"><NotesByStatus notes={notes} loading={!chartsLoaded} /></div>
        <div className="mb-4 break-inside-avoid"><RunsOverTime runs={runs} loading={!chartsLoaded} /></div>
        <div className="mb-4 break-inside-avoid"><DefectsByStatus defects={defects} loading={!chartsLoaded} /></div>

        <Card className={card}>
          <CardHeader>
            <CardTitle>Guardrails</CardTitle>
            <CardDescription>Reported by the local engine</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {!sysLoaded && <Skeleton className="h-16 w-full" />}
            {[...guardrails, ...(sys ? ([["Secret masking gate", sys.guardrails.maskingGate]] as [string, string][]) : [])].map(([label, v]) => (
              <div key={label} className="flex items-center gap-3 p-2">
                <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-xl">
                  <ShieldCheck className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
                {typeof v === "boolean" ? (
                  <Badge variant={v ? "secondary" : "destructive"}>{v ? "On" : "Off"}</Badge>
                ) : (
                  <Badge variant="outline">{v}</Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className={card}>
          <CardHeader>
            <CardTitle>Defects &amp; reports</CardTitle>
            <CardDescription>Deduplicated bugs, PDF exports and Teams notifications</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="bg-muted rounded-2xl p-5">
              <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Tracked</div>
              <div className="mt-1 text-3xl font-bold tabular-nums">{sys?.defectsCount ?? 0}</div>
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button className="w-full" onClick={() => onOpenView("defects")}>Open Defect Tracker</Button>
            <Button variant="outline" className="w-full" onClick={() => onOpenView("plugins")}>
              <Plug />
              MS Teams &amp; Composio
            </Button>
          </CardFooter>
        </Card>
      </div>
    </Page>
  );
}
