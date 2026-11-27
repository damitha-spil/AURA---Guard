import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

export function PluginsView() {
  const [plugins, setPlugins] = React.useState<PluginConfig[]>([]);
  const [team, setTeam] = React.useState<TeamMember[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [endpoints, setEndpoints] = React.useState<Record<string, string>>({});

  const [mName, setMName] = React.useState("");
  const [mRole, setMRole] = React.useState("Engineer");
  const [mAlias, setMAlias] = React.useState("");
  const [mWebhook, setMWebhook] = React.useState("");

  async function load() {
    const r = await apiGet<{ plugins: PluginConfig[]; team: TeamMember[] }>("/api/plugins");
    if (r.ok) {
      const list = r.data.plugins || [];
      setPlugins(list);
      setTeam(r.data.team || []);
      const map: Record<string, string> = {};
      for (const p of list) map[p.id] = p.endpoint || "";
      setEndpoints(map);
    }
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
        description="Connect Composio, Microsoft Teams, Azure DevOps, GitHub and MCP servers, and map your team."
      />

      <Tabs defaultValue="plugins">
        <TabsList>
          <TabsTrigger value="plugins">Integrations</TabsTrigger>
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
