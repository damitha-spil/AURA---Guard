import * as React from "react";
import { CheckCircle2, History, Play, Plus, Search, ShieldAlert, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { Page, PageHeader } from "@/components/app/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";

type MemoryLayer = "project" | "execution" | "procedural";
type MemoryConfidence = "verified" | "hypothesis";
type QualityVerdict = "PASS" | "NEEDS_REVIEW" | "BLOCK_RELEASE";
type TriggerKind = "schedule" | "on_commit" | "on_pull_request" | "on_test_failure" | "on_security_alert" | "on_release_candidate";

interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  confidence: MemoryConfidence;
  title: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: string;
  verifiedAt?: string;
}

interface AutomationRule {
  id: string;
  name: string;
  trigger: TriggerKind;
  schedule?: string;
  prompt: string;
  agents: string[];
  enabled: boolean;
  lastRunAt?: string;
  lastVerdict?: QualityVerdict;
}

interface Checkpoint {
  id: string;
  missionId: string;
  stage: "baseline" | "completed";
  summary: string;
  agents: string[];
  defectCount: number;
  verdict?: QualityVerdict;
  createdAt: string;
}

function verdictBadge(v?: QualityVerdict) {
  if (!v) return null;
  if (v === "PASS") return <Badge>PASS</Badge>;
  if (v === "BLOCK_RELEASE") return <Badge variant="destructive">BLOCK RELEASE</Badge>;
  return <Badge variant="secondary">NEEDS REVIEW</Badge>;
}

export function HarnessView() {
  const [memories, setMemories] = React.useState<MemoryEntry[]>([]);
  const [rules, setRules] = React.useState<AutomationRule[]>([]);
  const [checkpoints, setCheckpoints] = React.useState<Checkpoint[]>([]);
  const [layerFilter, setLayerFilter] = React.useState<string>("all");
  const [memQuery, setMemQuery] = React.useState("");

  // Add Memory form
  const [memLayer, setMemLayer] = React.useState<MemoryLayer>("project");
  const [memTitle, setMemTitle] = React.useState("");
  const [memContent, setMemContent] = React.useState("");
  const [memTags, setMemTags] = React.useState("");

  // Add Trigger form
  const [ruleName, setRuleName] = React.useState("");
  const [ruleTrigger, setRuleTrigger] = React.useState<TriggerKind>("on_commit");
  const [ruleSchedule, setRuleSchedule] = React.useState("");
  const [rulePrompt, setRulePrompt] = React.useState("");
  const [runningId, setRunningId] = React.useState<string | null>(null);

  const loadAll = React.useCallback(async () => {
    const [m, r, c] = await Promise.all([
      apiGet<{ entries: MemoryEntry[] }>("/api/reo/memory"),
      apiGet<{ rules: AutomationRule[] }>("/api/reo/automation"),
      apiGet<{ checkpoints: Checkpoint[] }>("/api/reo/checkpoints"),
    ]);
    if (m.ok && Array.isArray(m.data.entries)) setMemories(m.data.entries);
    if (r.ok && Array.isArray(r.data.rules)) setRules(r.data.rules);
    if (c.ok && Array.isArray(c.data.checkpoints)) setCheckpoints(c.data.checkpoints);
  }, []);

  React.useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function createMemory(e: React.FormEvent) {
    e.preventDefault();
    if (!memTitle.trim() || !memContent.trim()) return;
    const res = await apiPost<{ entry: MemoryEntry }>("/api/reo/memory", {
      layer: memLayer,
      confidence: "verified",
      title: memTitle.trim(),
      content: memContent.trim(),
      tags: memTags.split(",").map((s) => s.trim()).filter(Boolean),
    });
    if (res.ok) {
      setMemTitle("");
      setMemContent("");
      setMemTags("");
      toast.success("Saved to QA memory");
      loadAll();
    } else toast.error(res.error || "Could not save memory");
  }

  async function verifyMem(id: string) {
    const res = await apiPut(`/api/reo/memory/${id}/verify`, {});
    if (res.ok) {
      toast.success("Promoted hypothesis to verified memory");
      loadAll();
    }
  }

  async function removeMem(id: string) {
    const res = await apiDelete(`/api/reo/memory/${id}`);
    if (res.ok) loadAll();
  }

  async function createRule(e: React.FormEvent) {
    e.preventDefault();
    if (!ruleName.trim() || !rulePrompt.trim()) return;
    const res = await apiPost<{ rule: AutomationRule }>("/api/reo/automation", {
      name: ruleName.trim(),
      trigger: ruleTrigger,
      schedule: ruleTrigger === "schedule" ? ruleSchedule.trim() || "0 2 * * *" : undefined,
      prompt: rulePrompt.trim(),
      enabled: true,
    });
    if (res.ok) {
      setRuleName("");
      setRulePrompt("");
      setRuleSchedule("");
      toast.success("Automation trigger added");
      loadAll();
    } else toast.error(res.error || "Could not create trigger");
  }

  async function toggleRule(rule: AutomationRule, enabled: boolean) {
    const res = await apiPut(`/api/reo/automation/${rule.id}`, { enabled });
    if (res.ok) loadAll();
  }

  async function runRuleNow(id: string) {
    setRunningId(id);
    const res = await apiPost<{ ok: boolean; verdict?: QualityVerdict; defectsCount?: number; error?: string }>(
      `/api/reo/automation/${id}/run`,
      {},
    );
    setRunningId(null);
    if (res.ok) {
      toast.success(`Harness run finished · Gate: ${res.data.verdict || "PASS"} (${res.data.defectsCount ?? 0} defects)`);
      loadAll();
    } else toast.error(res.error || res.data?.error || "Failed to run trigger");
  }

  async function removeRule(id: string) {
    const res = await apiDelete(`/api/reo/automation/${id}`);
    if (res.ok) loadAll();
  }

  const visibleMemories = memories.filter((m) => {
    if (layerFilter !== "all" && m.layer !== layerFilter) return false;
    if (!memQuery.trim()) return true;
    return `${m.title} ${m.content} ${m.tags.join(" ")}`.toLowerCase().includes(memQuery.trim().toLowerCase());
  });

  return (
    <Page>
      <PageHeader
        title="QA Harness"
        description="Persistent 3-layer QA memory, autonomous event triggers, execution checkpoints, and release quality gates."
      />
      <Tabs defaultValue="memory" className="grid gap-4">
        <TabsList>
          <TabsTrigger value="memory">Memory Explorer</TabsTrigger>
          <TabsTrigger value="automation">Automation &amp; Triggers</TabsTrigger>
          <TabsTrigger value="checkpoints">Checkpoints</TabsTrigger>
        </TabsList>

        <TabsContent value="memory" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Record Project or Procedural Memory</CardTitle>
              <CardDescription className="text-xs">
                Store verified architecture conventions, known regressions, or reusable QA playbooks.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={createMemory} className="grid gap-3">
                <div className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
                  <Select value={memLayer} onValueChange={(v) => setMemLayer(v as MemoryLayer)}>
                    <SelectTrigger aria-label="Memory layer">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="project">Project Memory</SelectItem>
                      <SelectItem value="execution">Execution Memory</SelectItem>
                      <SelectItem value="procedural">Procedural Memory</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={memTitle}
                    onChange={(e) => setMemTitle(e.target.value)}
                    placeholder="Title (e.g., Auth token refresh race in checkout)"
                  />
                </div>
                <Textarea
                  value={memContent}
                  onChange={(e) => setMemContent(e.target.value)}
                  placeholder="Verified fact, root cause, or testing procedure..."
                  className="min-h-20"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Input
                    value={memTags}
                    onChange={(e) => setMemTags(e.target.value)}
                    placeholder="Tags (comma-separated: auth, regression, api)"
                    className="max-w-sm"
                  />
                  <Button type="submit" size="sm" disabled={!memTitle.trim() || !memContent.trim()}>
                    <Plus />
                    Add memory
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4" />
              <Input
                value={memQuery}
                onChange={(e) => setMemQuery(e.target.value)}
                placeholder="Search memory entries..."
                className="pl-9"
              />
            </div>
            {(["all", "project", "execution", "procedural"] as const).map((l) => (
              <Button
                key={l}
                type="button"
                size="sm"
                variant={layerFilter === l ? "secondary" : "outline"}
                onClick={() => setLayerFilter(l)}
              >
                {l === "all" ? "All layers" : l}
              </Button>
            ))}
          </div>

          <div className="grid gap-3">
            {visibleMemories.map((m) => (
              <Card key={m.id}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge variant="outline">{m.layer}</Badge>
                      <Badge variant={m.confidence === "verified" ? "default" : "secondary"}>
                        {m.confidence}
                      </Badge>
                      <CardTitle className="text-sm">{m.title}</CardTitle>
                    </div>
                    <div className="flex items-center gap-1">
                      {m.confidence === "hypothesis" && (
                        <Button size="sm" variant="outline" onClick={() => verifyMem(m.id)}>
                          <CheckCircle2 />
                          Verify
                        </Button>
                      )}
                      <Button size="icon-sm" variant="ghost" aria-label="Delete memory" onClick={() => removeMem(m.id)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-2 text-xs">
                  <p className="text-muted-foreground whitespace-pre-wrap">{m.content}</p>
                  {m.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {m.tags.map((t) => (
                        <Badge key={t} variant="secondary" className="text-[10px]">
                          #{t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
            {visibleMemories.length === 0 && (
              <Card>
                <CardContent className="text-muted-foreground py-8 text-center text-xs">
                  No memory entries yet. Missions and manual entries appear here.
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="automation" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Add Autonomous Trigger</CardTitle>
              <CardDescription className="text-xs">
                Schedule recurring QA or bind quality checks to commit, PR, and release-candidate hooks.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={createRule} className="grid gap-3">
                <div className="grid gap-2 sm:grid-cols-3">
                  <Input value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder="Trigger name" />
                  <Select value={ruleTrigger} onValueChange={(v) => setRuleTrigger(v as TriggerKind)}>
                    <SelectTrigger aria-label="Trigger event">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="schedule">Scheduled cron</SelectItem>
                      <SelectItem value="on_commit">on_commit</SelectItem>
                      <SelectItem value="on_pull_request">on_pull_request</SelectItem>
                      <SelectItem value="on_test_failure">on_test_failure</SelectItem>
                      <SelectItem value="on_security_alert">on_security_alert</SelectItem>
                      <SelectItem value="on_release_candidate">on_release_candidate</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={ruleSchedule}
                    onChange={(e) => setRuleSchedule(e.target.value)}
                    disabled={ruleTrigger !== "schedule"}
                    placeholder="Cron (e.g. 0 2 * * *)"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={rulePrompt}
                    onChange={(e) => setRulePrompt(e.target.value)}
                    placeholder="Mission prompt (e.g., @qa @security run regression & probes)"
                    className="min-w-60 flex-1"
                  />
                  <Button type="submit" size="sm" disabled={!ruleName.trim() || !rulePrompt.trim()}>
                    <Plus />
                    Add trigger
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="grid gap-3">
            {rules.map((r) => (
              <Card key={r.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div className="min-w-48 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Workflow className="text-muted-foreground size-4" />
                      <span className="text-sm font-medium">{r.name}</span>
                      <Badge variant="outline" className="font-mono text-[11px]">
                        {r.trigger}
                        {r.schedule ? ` · ${r.schedule}` : ""}
                      </Badge>
                      {verdictBadge(r.lastVerdict)}
                    </div>
                    <p className="text-muted-foreground text-xs break-words">{r.prompt}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={r.enabled} aria-label={`Enable ${r.name}`} onCheckedChange={(v) => toggleRule(r, v)} />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={runningId === r.id}
                      onClick={() => runRuleNow(r.id)}
                    >
                      <Play />
                      {runningId === r.id ? "Running..." : "Run now"}
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label="Delete trigger" onClick={() => removeRule(r.id)}>
                      <Trash2 />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="checkpoints" className="grid gap-3">
          {checkpoints.map((cp) => (
            <Card key={cp.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div className="min-w-48 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {cp.verdict === "BLOCK_RELEASE" ? (
                      <ShieldAlert className="text-destructive size-4" />
                    ) : (
                      <History className="text-muted-foreground size-4" />
                    )}
                    <span className="font-mono text-xs">{cp.missionId}</span>
                    <Badge variant="outline">{cp.stage}</Badge>
                    {verdictBadge(cp.verdict)}
                  </div>
                  <p className="text-muted-foreground text-xs break-words">{cp.summary}</p>
                </div>
                <div className="text-muted-foreground text-right text-xs">
                  <div>{cp.defectCount} defect{cp.defectCount === 1 ? "" : "s"}</div>
                  <div>{new Date(cp.createdAt).toLocaleString()}</div>
                </div>
              </CardContent>
            </Card>
          ))}
          {checkpoints.length === 0 && (
            <Card>
              <CardContent className="text-muted-foreground py-8 text-center text-xs">
                No execution checkpoints recorded yet. Run an agent mission or automation trigger to capture checkpoints.
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </Page>
  );
}
