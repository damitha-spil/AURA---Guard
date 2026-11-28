import * as React from "react";
import { ArrowLeft, Bot, Play, Plus, Sparkles, Trash2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, IconRow, Page, PageHeader } from "@/components/app/page";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

interface SubAgent {
  id: string;
  name: string;
  role: string;
  description: string;
  defaultSkills: string[];
  allowedTools: string[];
  riskTier: string;
  createdBy?: "reo" | "user" | "system";
  origin?: string;
  status?: "active" | "disabled";
}

interface ToolEntry {
  id: string;
  name: string;
  category: string;
  riskTier: string;
  requiresConfirmation: boolean;
  description: string;
  createdBy?: "reo" | "user" | "system";
  origin?: string;
  status?: "active" | "disabled";
}

interface SkillEntry {
  id?: string;
  name: string;
  category?: string;
  description?: string;
  createdBy?: "reo" | "system";
  origin?: string;
}

function GridSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-44 w-full" />
      ))}
    </div>
  );
}

function CreatedByBadge({ createdBy, origin }: { createdBy?: string; origin?: string }) {
  if (createdBy !== "reo") return null;
  return (
    <Badge variant="secondary" className="gap-1 text-[10px]" title={origin ? `Origin: ${origin}` : undefined}>
      <Sparkles className="size-3" />
      Created by REO{origin ? ` · ${origin}` : ""}
    </Badge>
  );
}

function AgentDetail({
  agent,
  tools,
  skills,
  onBack,
  onRun,
}: {
  agent: SubAgent;
  tools: ToolEntry[];
  skills: SkillEntry[];
  onBack: () => void;
  onRun: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = React.useState(`@${agent.id} run automated inspection and report findings`);
  const mention = `@${agent.id}`;
  const send = () => onRun(prompt.trim().startsWith(mention) ? prompt.trim() : `${mention} ${prompt.trim()}`);
  return (
    <Page>
      <PageHeader
        title={agent.name}
        description={`${mention} · ${agent.role}`}
        actions={
          <>
            <CreatedByBadge createdBy={agent.createdBy} origin={agent.origin} />
            <Badge variant={agent.riskTier === "read_only" ? "secondary" : "outline"}>{agent.riskTier}</Badge>
            <Button type="button" variant="outline" size="sm" onClick={onBack}>
              <ArrowLeft />
              All agents
            </Button>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader>
            <CardTitle>Run {mention}</CardTitle>
            <CardDescription>{agent.description}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Label htmlFor="agent-prompt">Mission prompt</Label>
            <Textarea id="agent-prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <div className="flex flex-col gap-2">
              <Button type="button" className="w-full" disabled={!prompt.trim()} onClick={send}>
                <Play />
                Run in Workspace
              </Button>
              <Button type="button" className="w-full" variant="outline" onClick={() => setPrompt(`${mention} run automated inspection and report findings`)}>
                Reset prompt
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Skills</CardTitle>
            <CardDescription>{agent.defaultSkills.length} default</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {agent.defaultSkills.length === 0 && <p className="text-muted-foreground text-xs">No default skills.</p>}
            {agent.defaultSkills.map((name) => {
              const hit = skills.find((s) => s.name === name || s.id === name);
              return (
                <div key={name} className="rounded-2xl border p-2">
                  <div className="truncate font-medium">{name}</div>
                  {hit?.description && <div className="text-muted-foreground line-clamp-2 text-xs">{hit.description}</div>}
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Tools</CardTitle>
          <CardDescription>Permission-tiered tools this agent may call</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-1 md:grid-cols-2">
          {agent.allowedTools.map((id) => {
            const t = tools.find((x) => x.id === id || x.name === id);
            return (
              <IconRow
                key={id}
                icon={Wrench}
                title={t?.name || id}
                subtitle={t?.description || "No description available."}
                right={t && <Badge variant={t.riskTier === "read_only" ? "secondary" : "outline"}>{t.riskTier}</Badge>}
              />
            );
          })}
        </CardContent>
      </Card>
    </Page>
  );
}

export function AgentsView({ onRunMission }: { onRunMission: (prompt: string) => void }) {
  const [query, setQuery] = React.useState("");
  const [agents, setAgents] = React.useState<SubAgent[]>([]);
  const [tools, setTools] = React.useState<ToolEntry[]>([]);
  const [skills, setSkills] = React.useState<SkillEntry[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  // Create with REO form toggle
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createKind, setCreateKind] = React.useState<"agent" | "tool" | "skill">("agent");
  const [createName, setCreateName] = React.useState("");
  const [createDesc, setCreateDesc] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const loadAll = React.useCallback(() => {
    Promise.all([
      apiGet<{ agents: SubAgent[]; tools: ToolEntry[] }>("/api/reo/agents"),
      apiGet<{ skills: SkillEntry[] }>("/api/skills"),
    ]).then(([a, s]) => {
      if (a.ok) {
        setAgents(a.data.agents || []);
        setTools(a.data.tools || []);
      }
      if (s.ok) setSkills(s.data.skills || []);
      setLoaded(true);
    });
  }, []);

  React.useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!createDesc.trim()) return;
    setCreating(true);
    const res = await apiPost<{ ok: boolean }>("/api/reo/create", {
      kind: createKind,
      description: createDesc.trim(),
      ...(createName.trim() ? { name: createName.trim() } : {}),
    });
    setCreating(false);
    if (res.ok) {
      toast.success(`REO created new ${createKind}`);
      setCreateDesc("");
      setCreateName("");
      setCreateOpen(false);
      loadAll();
    } else toast.error(res.error || "Could not create item");
  }

  async function toggleCustomStatus(kind: "custom-agents" | "custom-tools", id: string, current?: "active" | "disabled") {
    const next = current === "disabled" ? "active" : "disabled";
    const r = await apiPatch(`/api/reo/${kind}/${id}`, { status: next });
    if (r.ok) {
      toast.success(`Set ${id} to ${next}`);
      loadAll();
    }
  }

  async function removeCustom(kind: "custom-agents" | "custom-tools" | "generated-skills", id: string) {
    const r = await apiDelete(`/api/reo/${kind}/${id}`);
    if (r.ok) {
      toast.success(`Deleted ${id}`);
      loadAll();
    }
  }

  const selectedAgent = agents.find((a) => a.id === selectedId);
  if (selectedAgent) {
    return (
      <AgentDetail
        agent={selectedAgent}
        tools={tools.filter((t) => selectedAgent.allowedTools.includes(t.id) || selectedAgent.allowedTools.includes(t.name))}
        skills={skills.filter((s) => selectedAgent.defaultSkills.includes(s.name) || selectedAgent.defaultSkills.includes(s.id || ""))}
        onBack={() => setSelectedId(null)}
        onRun={onRunMission}
      />
    );
  }

  const q = query.trim().toLowerCase();
  const fa = agents.filter((a) => !q || `${a.name} ${a.role} ${a.description}`.toLowerCase().includes(q));
  const ft = tools.filter((t) => !q || `${t.name} ${t.id} ${t.category} ${t.description}`.toLowerCase().includes(q));
  const fs = skills.filter((s) => !q || `${s.name || s.id} ${s.category || ""} ${s.description || ""}`.toLowerCase().includes(q));

  return (
    <Page>
      <PageHeader
        title="Agents"
        description="Specialist sub-agents, permission-tiered tools and reusable engineering playbooks."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={() => setCreateOpen((v) => !v)}>
              <Plus />
              Create with REO
            </Button>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter agents, tools, or skills..."
              className="w-full sm:w-64"
              aria-label="Filter"
            />
          </div>
        }
      />

      {createOpen && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Sparkles className="size-4" />
              Create Agent, Tool, or Skill with REO
            </CardTitle>
            <CardDescription className="text-xs">
              Describe what you need in plain English. REO composes safe read-only or localhost tools without generating unsafe code.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="grid gap-3">
              <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <Select value={createKind} onValueChange={(v) => setCreateKind(v as "agent" | "tool" | "skill")}>
                  <SelectTrigger aria-label="Asset kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">Custom Agent</SelectItem>
                    <SelectItem value="tool">Composite Tool</SelectItem>
                    <SelectItem value="skill">Skill Playbook</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="Optional short name (e.g. a11y-audit-guardian)"
                />
              </div>
              <Textarea
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder="Describe what it should check (e.g. Audit local UI for WCAG accessibility issues, dead exports, and Semgrep SAST)"
                className="min-h-16"
              />
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={creating || !createDesc.trim()}>
                  <Sparkles />
                  {creating ? "Creating..." : "Create"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="agents">
        <TabsList>
          <TabsTrigger value="agents">Agents <Badge variant="secondary">{agents.length}</Badge></TabsTrigger>
          <TabsTrigger value="tools">Tools <Badge variant="secondary">{tools.length}</Badge></TabsTrigger>
          <TabsTrigger value="skills">Skills <Badge variant="secondary">{skills.length}</Badge></TabsTrigger>
        </TabsList>

        <TabsContent value="agents">
          {!loaded ? (
            <GridSkeleton />
          ) : fa.length === 0 ? (
            <EmptyState title="No agents found" />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {fa.map((a) => {
                const isCustom = a.id.startsWith("custom-");
                return (
                  <Card key={a.id} className="min-w-0">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-xl">
                            <Bot className="size-4" />
                          </span>
                          <div className="min-w-0">
                            <CardTitle className="truncate">{a.name}</CardTitle>
                            <CardDescription className="truncate">@{a.id} · {a.role}</CardDescription>
                          </div>
                        </div>
                        <Badge variant={a.riskTier === "read_only" ? "secondary" : "outline"}>{a.riskTier}</Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <CreatedByBadge createdBy={a.createdBy} origin={a.origin} />
                        {a.status === "disabled" && <Badge variant="outline">disabled</Badge>}
                      </div>
                    </CardHeader>
                    <CardContent className="flex-1 space-y-3 text-sm">
                      <p>{a.description}</p>
                      <div className="flex flex-wrap gap-1">
                        {a.allowedTools.map((t) => (
                          <Badge key={t} variant="outline" className="max-w-full"><span className="truncate">{t}</span></Badge>
                        ))}
                      </div>
                      {a.defaultSkills.length > 0 && (
                        <p className="text-muted-foreground text-xs">Skills: {a.defaultSkills.join(", ")}</p>
                      )}
                    </CardContent>
                    <CardFooter className="flex flex-col gap-2">
                      <Button
                        type="button"
                        className="w-full"
                        disabled={a.status === "disabled"}
                        onClick={() => onRunMission(`@${a.id} run automated inspection and report findings`)}
                      >
                        <Play />
                        Run @{a.id}
                      </Button>
                      <div className="flex w-full gap-2">
                        <Button type="button" className="flex-1" variant="outline" onClick={() => setSelectedId(a.id)}>
                          Details
                        </Button>
                        {isCustom && (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => toggleCustomStatus("custom-agents", a.id, a.status)}
                            >
                              {a.status === "disabled" ? "Enable" : "Disable"}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Delete ${a.id}`}
                              onClick={() => removeCustom("custom-agents", a.id)}
                            >
                              <Trash2 />
                            </Button>
                          </>
                        )}
                      </div>
                    </CardFooter>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="tools">
          {!loaded ? (
            <GridSkeleton />
          ) : ft.length === 0 ? (
            <EmptyState title="No tools found" />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {ft.map((t) => {
                const isCustom = t.id.startsWith("reo_");
                return (
                  <Card key={t.id} className="min-w-0">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="min-w-0 truncate">{t.name}</CardTitle>
                        <Badge variant={t.riskTier === "read_only" ? "secondary" : t.riskTier === "external_notify" ? "destructive" : "outline"}>
                          {t.riskTier}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <CreatedByBadge createdBy={t.createdBy} origin={t.origin} />
                        {t.status === "disabled" && <Badge variant="outline">disabled</Badge>}
                      </div>
                      <CardDescription>{t.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                      <span>
                        <code>{t.id}</code> · {t.category}
                      </span>
                      {isCustom && (
                        <div className="flex items-center gap-1">
                          <Button type="button" size="sm" variant="outline" onClick={() => toggleCustomStatus("custom-tools", t.id, t.status)}>
                            {t.status === "disabled" ? "Enable" : "Disable"}
                          </Button>
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Delete ${t.id}`} onClick={() => removeCustom("custom-tools", t.id)}>
                            <Trash2 />
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="skills">
          {!loaded ? (
            <GridSkeleton />
          ) : fs.length === 0 ? (
            <EmptyState title="No skills found" />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {fs.map((s) => (
                <Card key={s.name || s.id} className="min-w-0">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="min-w-0 truncate">{s.name || s.id}</CardTitle>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline">{s.category || "skill"}</Badge>
                        {s.createdBy === "reo" && (
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => removeCustom("generated-skills", s.name)}>
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    </div>
                    <CreatedByBadge createdBy={s.createdBy} origin={s.origin} />
                    <CardDescription>{s.description || ""}</CardDescription>
                  </CardHeader>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </Page>
  );
}
