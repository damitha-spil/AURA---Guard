import * as React from "react";
import { KeyRound, Play, Plus, RefreshCw, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Page, PageHeader } from "@/components/app/page";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";

interface PluginConfig {
  id: string;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  status: string;
  endpoint?: string;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
  gitAlias: string;
  teamsWebhookOrId: string;
}

interface N8nStatus {
  enabled: boolean;
  endpoint: string;
  keySource: "env" | "stored" | null;
  canStore: boolean;
}

interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string;
  tags: string[];
  webhookPaths: string[];
}

interface N8nExecution {
  id: string;
  workflowId: string;
  status: string;
  startedAt: string;
  stoppedAt: string;
  mode: string;
}

export function PluginsView() {
  const [plugins, setPlugins] = React.useState<PluginConfig[]>([]);
  const [team, setTeam] = React.useState<TeamMember[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [endpoints, setEndpoints] = React.useState<Record<string, string>>({});
  const [n8nStatus, setN8nStatus] = React.useState<N8nStatus | null>(null);
  const [n8nKey, setN8nKey] = React.useState("");
  const [n8nWorkflows, setN8nWorkflows] = React.useState<N8nWorkflow[]>([]);
  const [n8nExecutions, setN8nExecutions] = React.useState<N8nExecution[]>([]);
  const [n8nBusy, setN8nBusy] = React.useState(false);
  const [webhookPath, setWebhookPath] = React.useState("");
  const [webhookJson, setWebhookJson] = React.useState('{\n  "event": "qa_check",\n  "summary": "Triggered from SPIL REO"\n}');

  const [mName, setMName] = React.useState("");
  const [mRole, setMRole] = React.useState("Engineer");
  const [mAlias, setMAlias] = React.useState("");
  const [mWebhook, setMWebhook] = React.useState("");

  async function load() {
    const [r, n8] = await Promise.all([
      apiGet<{ plugins: PluginConfig[]; team: TeamMember[] }>("/api/plugins"),
      apiGet<N8nStatus>("/api/n8n/status"),
    ]);
    if (r.ok) {
      const list = r.data.plugins || [];
      setPlugins(list);
      setTeam(r.data.team || []);
      const map: Record<string, string> = {};
      for (const p of list) map[p.id] = p.endpoint || "";
      setEndpoints(map);
    }
    if (n8.ok) setN8nStatus(n8.data);
    setLoaded(true);
  }

  async function refreshN8nData() {
    setN8nBusy(true);
    const [w, e] = await Promise.all([
      apiGet<{ workflows: N8nWorkflow[] }>("/api/n8n/workflows"),
      apiGet<{ executions: N8nExecution[] }>("/api/n8n/executions"),
    ]);
    setN8nBusy(false);
    if (w.ok) setN8nWorkflows(w.data.workflows || []);
    else toast.error(w.error || "Could not load n8n workflows.");
    if (e.ok) setN8nExecutions(e.data.executions || []);
  }

  async function saveN8nConfig(e: React.FormEvent) {
    e.preventDefault();
    const ep = (endpoints["n8n"] || "").trim();
    const res = await apiPut<{ plugin: PluginConfig }>("/api/plugins/n8n", {
      enabled: true,
      endpoint: ep,
      ...(n8nStatus?.keySource ? { hasCredential: true } : {}),
    });
    if (!res.ok) {
      toast.error(res.error || "Could not save n8n endpoint.");
      return;
    }
    if (n8nKey.trim()) {
      const kRes = await apiPut("/api/n8n/key", { key: n8nKey.trim() });
      if (!kRes.ok) {
        toast.error(kRes.error || "Saved endpoint, but failed to store N8N_API_KEY.");
        await load();
        return;
      }
      setN8nKey("");
    }
    toast.success("n8n configuration saved.");
    await load();
  }

  async function removeN8nKey() {
    const r = await apiDelete("/api/n8n/key");
    if (r.ok) toast.success("Removed saved N8N_API_KEY.");
    else toast.error(r.error || "Could not remove n8n key.");
    await load();
  }

  async function triggerWebhook(e: React.FormEvent) {
    e.preventDefault();
    if (!webhookPath.trim()) return;
    let payload: Record<string, unknown> = {};
    if (webhookJson.trim()) {
      try {
        const parsed = JSON.parse(webhookJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          toast.error("Payload must be a JSON object.");
          return;
        }
        payload = parsed as Record<string, unknown>;
      } catch {
        toast.error("Invalid JSON payload.");
        return;
      }
    }
    setN8nBusy(true);
    const r = await apiPost<{ ok: boolean; status: number; url: string; body: string }>("/api/n8n/trigger", {
      pathOrUrl: webhookPath.trim(),
      payload,
    });
    setN8nBusy(false);
    if (r.ok && r.data.ok) {
      toast.success(`Webhook triggered (HTTP ${r.data.status})`);
      refreshN8nData();
    } else {
      toast.error(r.error || `Webhook returned HTTP ${r.data?.status ?? "error"}`);
    }
  }

  React.useEffect(() => {
    load();
  }, []);

  async function savePlugin(p: PluginConfig, nextEnabled: boolean) {
    const r = await apiPut<{ plugin: PluginConfig }>(`/api/plugins/${encodeURIComponent(p.id)}`, {
      enabled: nextEnabled,
      endpoint: (endpoints[p.id] || "").trim(),
    });
    if (r.ok) {
      toast.success(`Updated ${p.name}`);
      load();
    } else toast.error(r.error || `Could not update ${p.name}`);
  }

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    if (!mName.trim()) return;
    const r = await apiPost("/api/team", {
      name: mName.trim(),
      role: mRole.trim() || "Engineer",
      gitAlias: mAlias.trim(),
      teamsWebhookOrId: mWebhook.trim(),
    });
    if (r.ok) {
      setMName("");
      setMAlias("");
      setMWebhook("");
      toast.success("Added team member.");
      load();
    } else toast.error(r.error || "Could not add team member");
  }

  return (
    <Page>
      <PageHeader
        title="Plugins"
        description="Connect n8n Automation, Composio, Microsoft Teams, Azure DevOps, GitHub and MCP servers, and map your team."
      />

      <Tabs defaultValue="plugins">
        <TabsList>
          <TabsTrigger value="plugins">Integrations</TabsTrigger>
          <TabsTrigger value="n8n">n8n Automation</TabsTrigger>
          <TabsTrigger value="team">Team directory <Badge variant="secondary">{team.length}</Badge></TabsTrigger>
        </TabsList>

        <TabsContent value="plugins">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {!loaded && [0, 1, 2].map((i) => <Skeleton key={i} className="h-48 w-full" />)}
            {plugins.map((p) => (
              <Card key={p.id} className="min-w-0">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="truncate">{p.name}</CardTitle>
                      <CardDescription className="truncate">{p.category}</CardDescription>
                    </div>
                    <Badge variant={p.enabled ? "default" : "secondary"}>{p.enabled ? p.status : "disabled"}</Badge>
                  </div>
                  <CardDescription>{p.description}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2">
                  <Label htmlFor={`ep-${p.id}`} className="text-xs">Endpoint</Label>
                  <Input
                    id={`ep-${p.id}`}
                    value={endpoints[p.id] ?? ""}
                    onChange={(e) => setEndpoints({ ...endpoints, [p.id]: e.target.value })}
                    placeholder={
                      p.id === "ms-teams"
                        ? "HTTPS Teams webhook URL"
                        : p.id === "composio"
                          ? "Composio workspace URL"
                          : p.id === "n8n"
                            ? "http://localhost:5678 or https://n8n.example.com"
                            : "Server / API endpoint"
                    }
                  />
                </CardContent>
                <CardFooter className="flex flex-col gap-2">
                  <Button variant="outline" className="w-full" onClick={() => savePlugin(p, !p.enabled)}>
                    {p.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button className="w-full" onClick={() => savePlugin(p, p.enabled)}>Save</Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="n8n" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Workflow className="size-4" />
                    n8n Connection
                  </CardTitle>
                  <CardDescription>
                    Connect SPIL REO to your n8n instance so QA agents, /n8n commands, and MCP tools can discover and trigger workflows.
                  </CardDescription>
                </div>
                <Badge variant={n8nStatus?.enabled && n8nStatus?.keySource ? "default" : "secondary"}>
                  {n8nStatus?.enabled && n8nStatus?.keySource ? "Connected" : "Setup needed"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={saveN8nConfig} className="grid gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="n8n-url" className="text-xs">n8n Instance URL</Label>
                    <Input
                      id="n8n-url"
                      value={endpoints["n8n"] ?? ""}
                      onChange={(e) => setEndpoints({ ...endpoints, n8n: e.target.value })}
                      placeholder="http://localhost:5678"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="n8n-key" className="text-xs">
                      n8n API Key ({n8nStatus?.keySource === "env" ? "from N8N_API_KEY env" : n8nStatus?.keySource === "stored" ? "saved encrypted" : "not set"})
                    </Label>
                    <Input
                      id="n8n-key"
                      type="password"
                      value={n8nKey}
                      onChange={(e) => setN8nKey(e.target.value)}
                      disabled={n8nStatus ? !n8nStatus.canStore : false}
                      placeholder={n8nStatus?.keySource ? "Paste new key to replace..." : "Paste N8N_API_KEY..."}
                      autoComplete="off"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" size="sm">
                    <KeyRound />
                    Save &amp; Enable n8n
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={n8nBusy} onClick={refreshN8nData}>
                    <RefreshCw className={n8nBusy ? "animate-spin" : undefined} />
                    Load Workflows &amp; Executions
                  </Button>
                  {n8nStatus?.keySource === "stored" && (
                    <Button type="button" size="sm" variant="destructive" onClick={removeN8nKey}>
                      Remove saved key
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Workflows ({n8nWorkflows.length})</CardTitle>
                <CardDescription className="text-xs">Click a webhook path to prefill the trigger form.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {n8nWorkflows.length === 0 ? (
                  <p className="text-muted-foreground text-xs">No workflows loaded yet. Click "Load Workflows &amp; Executions".</p>
                ) : (
                  n8nWorkflows.map((w) => (
                    <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{w.name}</span>
                          <Badge variant={w.active ? "default" : "secondary"}>{w.active ? "active" : "inactive"}</Badge>
                        </div>
                        <div className="text-muted-foreground mt-1 flex flex-wrap gap-1.5 text-xs">
                          <span className="font-mono">id:{w.id}</span>
                          {w.webhookPaths.map((wp) => (
                            <button
                              key={wp}
                              type="button"
                              onClick={() => setWebhookPath(wp)}
                              className="bg-muted hover:bg-accent rounded px-1.5 py-0.5 font-mono text-[11px]"
                            >
                              /webhook/{wp}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Trigger n8n Webhook</CardTitle>
                <CardDescription className="text-xs">Payloads pass REO's masking gate; secrets are blocked before sending.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={triggerWebhook} className="grid gap-3">
                  <Input
                    value={webhookPath}
                    onChange={(e) => setWebhookPath(e.target.value)}
                    placeholder="Webhook path (e.g. reo-qa-gate or webhook/reo-qa-gate)"
                    aria-label="Webhook path"
                  />
                  <Textarea
                    value={webhookJson}
                    onChange={(e) => setWebhookJson(e.target.value)}
                    className="min-h-24 font-mono text-xs"
                    aria-label="Webhook JSON payload"
                  />
                  <Button type="submit" size="sm" disabled={n8nBusy || !webhookPath.trim()}>
                    <Play />
                    Trigger Webhook
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>

          {n8nExecutions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Recent Executions ({n8nExecutions.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {n8nExecutions.map((ex) => (
                  <div key={ex.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
                    <span className="font-mono">#{ex.id} · workflow {ex.workflowId}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant={ex.status === "error" ? "destructive" : ex.status === "success" ? "default" : "secondary"}>
                        {ex.status}
                      </Badge>
                      <span className="text-muted-foreground">{ex.startedAt ? new Date(ex.startedAt).toLocaleString() : ex.mode}</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="team" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Add team member</CardTitle>
              <CardDescription>Map engineers so Defects can dispatch reports to their Teams target.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={addMember} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <Input value={mName} onChange={(e) => setMName(e.target.value)} placeholder="Name *" aria-label="Name" />
                <Input value={mRole} onChange={(e) => setMRole(e.target.value)} placeholder="Role / module" aria-label="Role" />
                <Input value={mAlias} onChange={(e) => setMAlias(e.target.value)} placeholder="Git alias / email" aria-label="Git alias" />
                <Input value={mWebhook} onChange={(e) => setMWebhook(e.target.value)} placeholder="Teams webhook URL" aria-label="Webhook" />
                <Button type="submit" disabled={!mName.trim()}>
                  <Plus />
                  Add member
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card className="p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="hidden md:table-cell">Git alias</TableHead>
                  <TableHead>Teams target</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {team.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground text-center">
                      No engineers mapped yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  team.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="font-medium">{m.name}</TableCell>
                      <TableCell>{m.role}</TableCell>
                      <TableCell className="text-muted-foreground hidden md:table-cell">{m.gitAlias || "—"}</TableCell>
                      <TableCell className="text-muted-foreground max-w-40 truncate">{m.teamsWebhookOrId || "—"}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${m.name}`}
                          onClick={async () => {
                            const r = await apiDelete(`/api/team/${encodeURIComponent(m.id)}`);
                            toast(r.ok ? `Removed ${m.name}` : "Could not remove member");
                            load();
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
