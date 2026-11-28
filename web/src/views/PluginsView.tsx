import * as React from "react";
import {
  ArrowRight,
  CheckCircle2,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { AppBrandIcon, ComposioLogo, McpHubLogo, N8nLogo } from "@/components/app/connector-icons";
import { Page, PageHeader } from "@/components/app/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
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

interface ComposioStatus {
  enabled: boolean;
  endpoint: string;
  keySource: "env" | "stored" | null;
  canStore: boolean;
}

interface ComposioConnection {
  id: string;
  appName: string;
  status: string;
}

interface ComposioAction {
  name: string;
  appName: string;
  displayName: string;
  description: string;
}

interface ExternalMcpServer {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  discoveredTools: Array<{ name: string; description: string }>;
  lastConnectedAt?: string;
  lastError?: string;
}

const COMPOSIO_APPS = [
  { id: "jira", label: "Jira" },
  { id: "linear", label: "Linear" },
  { id: "slack", label: "Slack" },
  { id: "github", label: "GitHub" },
  { id: "notion", label: "Notion" },
] as const;

const MCP_PRESETS = [
  {
    id: "github",
    label: "GitHub MCP",
    transport: "stdio" as const,
    commandOrUrl: "npx.cmd",
    args: "-y @modelcontextprotocol/server-github",
  },
  {
    id: "playwright",
    label: "Playwright MCP",
    transport: "stdio" as const,
    commandOrUrl: "npx.cmd",
    args: "-y @playwright/mcp@latest",
  },
  {
    id: "filesystem",
    label: "Filesystem MCP",
    transport: "stdio" as const,
    commandOrUrl: "npx.cmd",
    args: "-y @modelcontextprotocol/server-filesystem .",
  },
  {
    id: "postgres",
    label: "Postgres MCP",
    transport: "stdio" as const,
    commandOrUrl: "npx.cmd",
    args: "-y @modelcontextprotocol/server-postgres",
  },
];

export function PluginsView() {
  const [activeTab, setActiveTab] = React.useState("plugins");
  const [plugins, setPlugins] = React.useState<PluginConfig[]>([]);
  const [team, setTeam] = React.useState<TeamMember[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [endpoints, setEndpoints] = React.useState<Record<string, string>>({});

  // n8n state
  const [n8nStatus, setN8nStatus] = React.useState<N8nStatus | null>(null);
  const [n8nKey, setN8nKey] = React.useState("");
  const [n8nWorkflows, setN8nWorkflows] = React.useState<N8nWorkflow[]>([]);
  const [n8nExecutions, setN8nExecutions] = React.useState<N8nExecution[]>([]);
  const [n8nBusy, setN8nBusy] = React.useState(false);
  const [webhookPath, setWebhookPath] = React.useState("");
  const [webhookJson, setWebhookJson] = React.useState('{\n  "event": "qa_check",\n  "summary": "Triggered from SPIL REO"\n}');

  // Composio state
  const [composioStatus, setComposioStatus] = React.useState<ComposioStatus | null>(null);
  const [composioKey, setComposioKey] = React.useState("");
  const [composioConnections, setComposioConnections] = React.useState<ComposioConnection[]>([]);
  const [composioActions, setComposioActions] = React.useState<ComposioAction[]>([]);
  const [composioAppFilter, setComposioAppFilter] = React.useState("");
  const [selectedAction, setSelectedAction] = React.useState("");
  const [actionParamsJson, setActionParamsJson] = React.useState("{}");
  const [composioOutput, setComposioOutput] = React.useState<unknown>(null);
  const [composioBusy, setComposioBusy] = React.useState(false);

  // External MCP Hub state
  const [mcpServers, setMcpServers] = React.useState<ExternalMcpServer[]>([]);
  const [mcpName, setMcpName] = React.useState("");
  const [mcpTransport, setMcpTransport] = React.useState<"stdio" | "http" | "sse">("stdio");
  const [mcpCmdOrUrl, setMcpCmdOrUrl] = React.useState("");
  const [mcpArgs, setMcpArgs] = React.useState("");
  const [mcpBusyId, setMcpBusyId] = React.useState<string | null>(null);
  const [mcpCallTarget, setMcpCallTarget] = React.useState<{ serverId: string; toolName: string } | null>(null);
  const [mcpCallArgsJson, setMcpCallArgsJson] = React.useState("{}");
  const [mcpCallResult, setMcpCallResult] = React.useState<unknown>(null);

  // Team form
  const [mName, setMName] = React.useState("");
  const [mRole, setMRole] = React.useState("Engineer");
  const [mAlias, setMAlias] = React.useState("");
  const [mWebhook, setMWebhook] = React.useState("");

  async function load() {
    const [r, n8, comp, mcp] = await Promise.all([
      apiGet<{ plugins: PluginConfig[]; team: TeamMember[] }>("/api/plugins"),
      apiGet<N8nStatus>("/api/n8n/status"),
      apiGet<ComposioStatus>("/api/composio/status"),
      apiGet<{ servers: ExternalMcpServer[] }>("/api/mcp-hub/servers"),
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
    if (comp.ok) setComposioStatus(comp.data);
    if (mcp.ok && Array.isArray(mcp.data.servers)) setMcpServers(mcp.data.servers);
    setLoaded(true);
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

  async function saveComposioConfig(e: React.FormEvent) {
    e.preventDefault();
    const res = await apiPut<{ plugin: PluginConfig }>("/api/plugins/composio", {
      enabled: true,
      endpoint: (endpoints["composio"] || "").trim(),
      ...(composioStatus?.keySource ? { hasCredential: true } : {}),
    });
    if (!res.ok) {
      toast.error(res.error || "Could not save Composio config.");
      return;
    }
    if (composioKey.trim()) {
      const kRes = await apiPut("/api/composio/key", { key: composioKey.trim() });
      if (!kRes.ok) {
        toast.error(kRes.error || "Saved plugin, but failed to store COMPOSIO_API_KEY.");
        await load();
        return;
      }
      setComposioKey("");
    }
    toast.success("Composio configuration saved.");
    await load();
  }

  async function refreshComposioData(appFilter?: string) {
    setComposioBusy(true);
    const qs = appFilter?.trim() ? `?apps=${encodeURIComponent(appFilter.trim())}` : "";
    const [c, a] = await Promise.all([
      apiGet<{ connections: ComposioConnection[] }>("/api/composio/connections"),
      apiGet<{ actions: ComposioAction[] }>(`/api/composio/actions${qs}`),
    ]);
    setComposioBusy(false);
    if (c.ok) setComposioConnections(c.data.connections || []);
    else toast.error(c.error || "Could not load Composio connections.");
    if (a.ok) setComposioActions(a.data.actions || []);
  }

  async function executeComposioAction(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedAction.trim()) return;
    let params: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(actionParamsJson || "{}") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed as Record<string, unknown>;
    } catch {
      toast.error("Invalid JSON parameters.");
      return;
    }
    setComposioBusy(true);
    const r = await apiPost("/api/composio/execute", { actionName: selectedAction.trim(), params });
    setComposioBusy(false);
    if (r.ok) {
      setComposioOutput(r.data);
      toast.success(`Executed ${selectedAction}`);
    } else {
      toast.error(r.error || "Action execution failed.");
    }
  }

  async function addMcpServer(e: React.FormEvent) {
    e.preventDefault();
    if (!mcpName.trim() || !mcpCmdOrUrl.trim()) return;
    const payload =
      mcpTransport === "stdio"
        ? {
            name: mcpName.trim(),
            transport: "stdio",
            command: mcpCmdOrUrl.trim(),
            args: mcpArgs.split(/\s+/).map((x) => x.trim()).filter(Boolean),
          }
        : { name: mcpName.trim(), transport: mcpTransport, url: mcpCmdOrUrl.trim() };
    const r = await apiPost<{ ok: boolean; server: ExternalMcpServer }>("/api/mcp-hub/servers", payload);
    if (r.ok) {
      setMcpName("");
      setMcpCmdOrUrl("");
      setMcpArgs("");
      toast.success(`Added MCP server "${r.data.server.name}"`);
      await load();
    } else toast.error(r.error || "Could not add MCP server");
  }

  async function probeMcp(id: string) {
    setMcpBusyId(id);
    const r = await apiPost<{ ok: boolean; server?: ExternalMcpServer }>(`/api/mcp-hub/servers/${id}/probe`, {});
    setMcpBusyId(null);
    if (r.ok) {
      toast.success(`Discovered ${r.data.server?.discoveredTools.length ?? 0} tool(s)`);
      await load();
    } else {
      toast.error(r.error || "Probe failed");
      await load();
    }
  }

  async function runMcpToolCall(e: React.FormEvent) {
    e.preventDefault();
    if (!mcpCallTarget) return;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(mcpCallArgsJson || "{}") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      toast.error("Invalid JSON arguments.");
      return;
    }
    setMcpBusyId(mcpCallTarget.serverId);
    const r = await apiPost<{ ok: boolean; result?: unknown }>("/api/mcp-hub/call", {
      serverId: mcpCallTarget.serverId,
      toolName: mcpCallTarget.toolName,
      args,
    });
    setMcpBusyId(null);
    if (r.ok) {
      setMcpCallResult(r.data.result);
      toast.success(`Executed ${mcpCallTarget.toolName}`);
    } else {
      toast.error(r.error || "MCP tool call failed.");
    }
  }

  async function removeMcp(id: string) {
    const r = await apiDelete(`/api/mcp-hub/servers/${id}`);
    if (r.ok) {
      toast.success("Removed external MCP server");
      await load();
    }
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
    const r = await apiPost<{ ok: boolean; status: number }>("/api/n8n/trigger", {
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

  const totalDiscoveredMcpTools = mcpServers.reduce((sum, s) => sum + s.discoveredTools.length, 0);
  const filteredActions = composioActions.filter(
    (a) =>
      !composioAppFilter.trim() ||
      `${a.name} ${a.appName} ${a.description}`.toLowerCase().includes(composioAppFilter.trim().toLowerCase()),
  );

  return (
    <Page>
      <PageHeader
        title="Plugins & Connectors"
        description="Connect 100+ OAuth apps via Composio, bridge any external MCP server, automate with n8n, and manage your team."
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="max-w-full overflow-x-auto">
          <TabsList>
            <TabsTrigger value="plugins">Integrations</TabsTrigger>
            <TabsTrigger value="composio" className="gap-1.5">
              <ComposioLogo className="size-4" />
              Composio (100+ Apps)
            </TabsTrigger>
            <TabsTrigger value="mcp-hub" className="gap-1.5">
              <McpHubLogo className="size-4" />
              MCP Server Hub
              <Badge variant="secondary">{mcpServers.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="n8n" className="gap-1.5">
              <N8nLogo className="size-4" />
              n8n Automation
            </TabsTrigger>
            <TabsTrigger value="team" className="gap-1.5">
              <Users className="size-3.5" />
              Team directory
              <Badge variant="secondary">{team.length}</Badge>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="plugins" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="border-violet-500/20 bg-violet-500/5 py-3">
              <CardContent className="flex items-center justify-between gap-3 px-4">
                <div className="flex items-center gap-2.5">
                  <ComposioLogo className="size-8 shrink-0" />
                  <div>
                    <div className="text-sm font-medium">Composio Toolkits</div>
                    <div className="text-muted-foreground text-xs">
                      {composioStatus?.keySource ? `${composioConnections.length} connected` : "100+ OAuth apps"}
                    </div>
                  </div>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => setActiveTab("composio")}>
                  Open
                  <ArrowRight className="size-3.5" />
                </Button>
              </CardContent>
            </Card>
            <Card className="border-emerald-500/20 bg-emerald-500/5 py-3">
              <CardContent className="flex items-center justify-between gap-3 px-4">
                <div className="flex items-center gap-2.5">
                  <McpHubLogo className="size-8 shrink-0" />
                  <div>
                    <div className="text-sm font-medium">External MCP Hub</div>
                    <div className="text-muted-foreground text-xs">
                      {mcpServers.length} server(s) · {totalDiscoveredMcpTools} tools
                    </div>
                  </div>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => setActiveTab("mcp-hub")}>
                  Open
                  <ArrowRight className="size-3.5" />
                </Button>
              </CardContent>
            </Card>
            <Card className="border-rose-500/20 bg-rose-500/5 py-3">
              <CardContent className="flex items-center justify-between gap-3 px-4">
                <div className="flex items-center gap-2.5">
                  <N8nLogo className="size-8 shrink-0" />
                  <div>
                    <div className="text-sm font-medium">n8n Workflows</div>
                    <div className="text-muted-foreground text-xs">
                      {n8nStatus?.enabled && n8nStatus?.keySource ? "Connected" : "400+ workflow nodes"}
                    </div>
                  </div>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => setActiveTab("n8n")}>
                  Open
                  <ArrowRight className="size-3.5" />
                </Button>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {!loaded && [0, 1, 2].map((i) => <Skeleton key={i} className="h-48 w-full" />)}
            {plugins.map((p) => {
              const dedicatedTab = p.id === "composio" || p.id === "n8n" || p.id === "mcp-hub" ? p.id : null;
              return (
                <Card key={p.id} className="min-w-0">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <AppBrandIcon id={p.id} className="size-8 shrink-0" />
                        <div className="min-w-0">
                          <CardTitle className="truncate">{p.name}</CardTitle>
                          <CardDescription className="truncate">{p.category}</CardDescription>
                        </div>
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
                            ? "https://backend.composio.dev/api/v2"
                            : p.id === "n8n"
                              ? "http://localhost:5678"
                              : "Server / API endpoint"
                      }
                    />
                  </CardContent>
                  <CardFooter className="flex flex-col gap-2">
                    <div className="flex w-full gap-2">
                      <Button type="button" variant="outline" className="flex-1" onClick={() => savePlugin(p, !p.enabled)}>
                        {p.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button type="button" className="flex-1" onClick={() => savePlugin(p, p.enabled)}>Save</Button>
                    </div>
                    {dedicatedTab && (
                      <Button type="button" variant="ghost" size="sm" className="w-full text-xs" onClick={() => setActiveTab(dedicatedTab)}>
                        Configure in {p.name} Studio
                        <ArrowRight className="size-3.5" />
                      </Button>
                    )}
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="composio" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <ComposioLogo className="size-9 shrink-0" />
                  <div>
                    <CardTitle className="text-base">Composio OAuth Toolkits (100+ Apps)</CardTitle>
                    <CardDescription>
                      Connect Jira, Linear, Slack, GitHub, Notion, and Google Workspace with one encrypted API key.
                    </CardDescription>
                  </div>
                </div>
                <Badge variant={composioStatus?.enabled && composioStatus?.keySource ? "default" : "secondary"} className="gap-1">
                  {composioStatus?.enabled && composioStatus?.keySource && <CheckCircle2 className="size-3" />}
                  {composioStatus?.enabled && composioStatus?.keySource ? "Connected" : "Setup needed"}
                </Badge>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {COMPOSIO_APPS.map((app) => (
                  <Button
                    key={app.id}
                    type="button"
                    size="sm"
                    variant={composioAppFilter === app.id ? "default" : "outline"}
                    className="h-7 gap-1.5 rounded-full px-2.5 text-xs"
                    onClick={() => {
                      const next = composioAppFilter === app.id ? "" : app.id;
                      setComposioAppFilter(next);
                      if (composioStatus?.enabled && composioStatus?.keySource) refreshComposioData(next);
                    }}
                  >
                    <AppBrandIcon id={app.id} className="size-3.5" />
                    {app.label}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={saveComposioConfig} className="grid gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="comp-ep" className="text-xs">Composio API Endpoint</Label>
                    <Input
                      id="comp-ep"
                      value={endpoints["composio"] ?? ""}
                      onChange={(e) => setEndpoints({ ...endpoints, composio: e.target.value })}
                      placeholder="https://backend.composio.dev/api/v2"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="comp-key" className="text-xs">
                      Composio API Key ({composioStatus?.keySource === "env" ? "from env" : composioStatus?.keySource === "stored" ? "saved encrypted" : "not set"})
                    </Label>
                    <Input
                      id="comp-key"
                      type="password"
                      value={composioKey}
                      onChange={(e) => setComposioKey(e.target.value)}
                      placeholder={composioStatus?.keySource ? "Paste new key to replace..." : "Paste COMPOSIO_API_KEY..."}
                      autoComplete="off"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" size="sm">
                    <KeyRound />
                    Save &amp; Enable Composio
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={composioBusy} onClick={() => refreshComposioData(composioAppFilter)}>
                    <RefreshCw className={composioBusy ? "animate-spin" : undefined} />
                    Load Connected Apps &amp; Actions
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Connected Accounts ({composioConnections.length})</CardTitle>
                <CardDescription className="text-xs">OAuth-authenticated toolkits ready for REO agents.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                {composioConnections.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-center">Save your key and click &quot;Load Connected Apps &amp; Actions&quot;.</p>
                ) : (
                  composioConnections.map((c) => (
                    <div key={c.id} className="flex items-center justify-between rounded-xl border px-3 py-2">
                      <span className="flex items-center gap-2 font-medium">
                        <AppBrandIcon id={c.appName} className="size-4" />
                        {c.appName}
                      </span>
                      <Badge variant={c.status === "ACTIVE" ? "default" : "outline"}>{c.status}</Badge>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Run Composio Action</CardTitle>
                <CardDescription className="text-xs">Pick a loaded action or enter an action name (parameters pass masking gate).</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <form onSubmit={executeComposioAction} className="grid gap-2.5">
                  <Input
                    value={selectedAction}
                    onChange={(e) => setSelectedAction(e.target.value)}
                    placeholder="Action name (e.g. SLACK_SEND_MESSAGE, JIRA_CREATE_ISSUE)"
                    className="font-mono text-xs"
                  />
                  <Textarea
                    value={actionParamsJson}
                    onChange={(e) => setActionParamsJson(e.target.value)}
                    rows={3}
                    className="font-mono text-xs"
                    aria-label="Action parameters JSON"
                  />
                  <Button type="submit" size="sm" disabled={composioBusy || !selectedAction.trim()}>
                    <Play />
                    Run Action
                  </Button>
                </form>
                {composioOutput !== null && (
                  <pre className="bg-muted max-h-36 overflow-auto rounded-lg p-2 font-mono text-[11px]">
                    {JSON.stringify(composioOutput, null, 2)}
                  </pre>
                )}
              </CardContent>
            </Card>
          </div>

          {filteredActions.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-sm">Available Actions ({filteredActions.length})</CardTitle>
                  <div className="relative w-56">
                    <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-3.5" />
                    <Input
                      value={composioAppFilter}
                      onChange={(e) => setComposioAppFilter(e.target.value)}
                      placeholder="Filter actions..."
                      className="h-8 pl-8 text-xs"
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {filteredActions.slice(0, 15).map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    onClick={() => setSelectedAction(a.name)}
                    className="hover:bg-muted/60 flex flex-col gap-1 rounded-xl border p-2.5 text-left text-xs transition-colors"
                  >
                    <div className="flex items-center gap-1.5 font-mono font-medium">
                      <AppBrandIcon id={a.appName} className="size-3.5 shrink-0" />
                      <span className="truncate">{a.name}</span>
                    </div>
                    <span className="text-muted-foreground line-clamp-2 text-[11px]">{a.description}</span>
                  </button>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="mcp-hub" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <McpHubLogo className="size-9 shrink-0" />
                  <div>
                    <CardTitle className="text-base">External MCP Server Hub</CardTitle>
                    <CardDescription>
                      Plug any external stdio, HTTP, or SSE MCP server into REO. Discovered tools auto-register in Agents &rarr; Tools.
                    </CardDescription>
                  </div>
                </div>
                <Badge variant="outline" className="gap-1">
                  <Sparkles className="size-3" />
                  {totalDiscoveredMcpTools} tools bridged
                </Badge>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground mr-1 text-xs">1-Click Presets:</span>
                {MCP_PRESETS.map((preset) => (
                  <Button
                    key={preset.id}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 rounded-full px-2.5 text-xs"
                    onClick={() => {
                      setMcpName(preset.label);
                      setMcpTransport(preset.transport);
                      setMcpCmdOrUrl(preset.commandOrUrl);
                      setMcpArgs(preset.args);
                    }}
                  >
                    <AppBrandIcon id={preset.id} className="size-3.5" />
                    {preset.label}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={addMcpServer} className="grid gap-3">
                <div className="grid gap-2 sm:grid-cols-3">
                  <Input value={mcpName} onChange={(e) => setMcpName(e.target.value)} placeholder="Server name (e.g. GitHub MCP)" />
                  <Select value={mcpTransport} onValueChange={(v) => setMcpTransport(v as "stdio" | "http" | "sse")}>
                    <SelectTrigger aria-label="MCP transport">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stdio">stdio (local executable)</SelectItem>
                      <SelectItem value="http">Streamable HTTP</SelectItem>
                      <SelectItem value="sse">SSE</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={mcpCmdOrUrl}
                    onChange={(e) => setMcpCmdOrUrl(e.target.value)}
                    placeholder={mcpTransport === "stdio" ? "npx.cmd or executable" : "https://mcp.example.com/mcp"}
                  />
                </div>
                {mcpTransport === "stdio" && (
                  <Input
                    value={mcpArgs}
                    onChange={(e) => setMcpArgs(e.target.value)}
                    placeholder="Arguments (space-separated, e.g. -y @modelcontextprotocol/server-github)"
                  />
                )}
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={!mcpName.trim() || !mcpCmdOrUrl.trim()}>
                    <Plus />
                    Add MCP Server
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="grid gap-3">
            {mcpServers.map((s) => (
              <Card key={s.id}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <McpHubLogo className="size-7 shrink-0" />
                      <div>
                        <div className="flex items-center gap-2">
                          <CardTitle className="text-sm">{s.name}</CardTitle>
                          <Badge variant="outline" className="font-mono text-[10px]">{s.transport}</Badge>
                          <Badge variant="secondary">{s.discoveredTools.length} tools</Badge>
                        </div>
                        <CardDescription className="font-mono text-xs">
                          {s.transport === "stdio" ? `${s.command} ${(s.args || []).join(" ")}` : s.url}
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button type="button" size="sm" variant="outline" disabled={mcpBusyId === s.id} onClick={() => probeMcp(s.id)}>
                        <RefreshCw className={mcpBusyId === s.id ? "animate-spin" : undefined} />
                        Discover Tools
                      </Button>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${s.name}`} onClick={() => removeMcp(s.id)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  {s.lastError && <p className="text-destructive mt-1 text-xs">{s.lastError}</p>}
                </CardHeader>
                {s.discoveredTools.length > 0 && (
                  <CardContent className="flex flex-wrap gap-1.5">
                    {s.discoveredTools.map((t) => (
                      <Button
                        key={t.name}
                        type="button"
                        size="sm"
                        variant={mcpCallTarget?.serverId === s.id && mcpCallTarget?.toolName === t.name ? "default" : "outline"}
                        className="h-7 font-mono text-[11px]"
                        title={t.description || t.name}
                        onClick={() => setMcpCallTarget({ serverId: s.id, toolName: t.name })}
                      >
                        <Play className="size-3" />
                        {t.name}
                      </Button>
                    ))}
                  </CardContent>
                )}
              </Card>
            ))}

            {mcpCallTarget && (
              <Card className="border-primary/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-mono">Test Tool: {mcpCallTarget.toolName}</CardTitle>
                  <CardDescription className="text-xs">Arguments pass REO&apos;s secret masking gate before reaching the external MCP server.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2.5">
                  <form onSubmit={runMcpToolCall} className="grid gap-2">
                    <Textarea
                      value={mcpCallArgsJson}
                      onChange={(e) => setMcpCallArgsJson(e.target.value)}
                      rows={3}
                      className="font-mono text-xs"
                      aria-label="MCP tool arguments JSON"
                    />
                    <div className="flex justify-end gap-2">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setMcpCallTarget(null)}>
                        Close
                      </Button>
                      <Button type="submit" size="sm" disabled={mcpBusyId === mcpCallTarget.serverId}>
                        <Play />
                        Invoke Tool
                      </Button>
                    </div>
                  </form>
                  {mcpCallResult !== null && (
                    <pre className="bg-muted max-h-48 overflow-auto rounded-lg p-2.5 font-mono text-[11px]">
                      {JSON.stringify(mcpCallResult, null, 2)}
                    </pre>
                  )}
                </CardContent>
              </Card>
            )}

            {mcpServers.length === 0 && (
              <Card>
                <CardContent className="text-muted-foreground py-8 text-center text-xs">
                  No external MCP servers configured yet. Click a 1-click preset above or add a custom server.
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="n8n" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <N8nLogo className="size-9 shrink-0" />
                  <div>
                    <CardTitle className="text-base">n8n Workflow Automation</CardTitle>
                    <CardDescription>
                      Connect SPIL REO to your n8n instance so QA agents, /n8n commands, and MCP tools can discover and trigger workflows.
                    </CardDescription>
                  </div>
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
                  <p className="text-muted-foreground text-xs">No workflows loaded yet. Click &quot;Load Workflows &amp; Executions&quot;.</p>
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
                <CardDescription className="text-xs">Payloads pass REO&apos;s masking gate; secrets are blocked before sending.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={triggerWebhook} className="grid gap-3">
                  <Input
                    value={webhookPath}
                    onChange={(e) => setWebhookPath(e.target.value)}
                    placeholder="Webhook path (e.g. reo-qa-gate)"
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
                      <span className="text-muted-foreground">{ex.mode}</span>
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
              <CardTitle>Add engineer</CardTitle>
              <CardDescription>Map engineers to git aliases and Microsoft Teams channels.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={addMember} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Input placeholder="Full name" value={mName} onChange={(e) => setMName(e.target.value)} />
                <Input placeholder="Role" value={mRole} onChange={(e) => setMRole(e.target.value)} />
                <Input placeholder="Git alias" value={mAlias} onChange={(e) => setMAlias(e.target.value)} />
                <Input placeholder="Teams webhook / channel" value={mWebhook} onChange={(e) => setMWebhook(e.target.value)} />
                <Button type="submit" disabled={!mName.trim()}>
                  <Plus />
                  Add
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Team directory</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Git alias</TableHead>
                    <TableHead>Teams target</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {team.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground h-24 text-center">
                        No team members mapped yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    team.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-medium">{m.name}</TableCell>
                        <TableCell>{m.role}</TableCell>
                        <TableCell><code>{m.gitAlias || "—"}</code></TableCell>
                        <TableCell className="max-w-48 truncate">{m.teamsWebhookOrId || "—"}</TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove ${m.name}`}
                            onClick={async () => {
                              await apiDelete(`/api/team/${encodeURIComponent(m.id)}`);
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
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
