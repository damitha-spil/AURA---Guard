import * as React from "react";
import {
  Activity,
  CheckCircle2,
  FlaskConical,
  History,
  Play,
  Plus,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Workflow,
  XCircle,
} from "lucide-react";
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

interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "AGENT" | "TOOL" | "GATE";
  agent?: string;
  tool?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationMs: number;
  status: "OK" | "ERROR";
  attributes: Record<string, string | number | boolean>;
}

interface MissionTrace {
  traceId: string;
  missionId: string;
  prompt: string;
  agents: string[];
  startedAt: string;
  totalDurationMs: number;
  verdict: QualityVerdict;
  spanCount: number;
  spans: OtelSpan[];
}

interface BenchmarkCaseResult {
  providerId: string;
  model: string;
  mode: "live" | "heuristic_dry_run";
  latencyMs: number;
  estimatedCostUsd: number;
  citationScore: number;
  secretSafetyPass: boolean;
  completenessScore: number;
  overallScore: number;
  excerpt: string;
  error?: string;
}

interface ModelBenchmarkRun {
  id: string;
  createdAt: string;
  prompt: string;
  expectedKeywords: string[];
  winner: string;
  results: BenchmarkCaseResult[];
}

interface SkillProposal {
  id: string;
  patternKey: string;
  targetKind: "skill" | "vault_rule";
  targetName: string;
  title: string;
  rationale: string;
  occurrences: number;
  proposedPatchMarkdown: string;
  status: "proposed" | "approved" | "dismissed";
  sourceMissionId?: string;
  createdAt: string;
  reviewedAt?: string;
  vaultDraftPath?: string;
}

function verdictBadge(v?: QualityVerdict) {
  if (!v) return null;
  if (v === "PASS") return <Badge>PASS</Badge>;
  if (v === "BLOCK_RELEASE") return <Badge variant="destructive">BLOCK RELEASE</Badge>;
  return <Badge variant="secondary">NEEDS REVIEW</Badge>;
}

const BENCH_PROVIDERS = ["antigravity-cli", "claude-cli", "opencode-cli"] as const;

export function HarnessView() {
  const [memories, setMemories] = React.useState<MemoryEntry[]>([]);
  const [rules, setRules] = React.useState<AutomationRule[]>([]);
  const [checkpoints, setCheckpoints] = React.useState<Checkpoint[]>([]);
  const [traces, setTraces] = React.useState<MissionTrace[]>([]);
  const [benchmarks, setBenchmarks] = React.useState<ModelBenchmarkRun[]>([]);
  const [proposals, setProposals] = React.useState<SkillProposal[]>([]);
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

  // Evaluation Lab state
  const [evalPrompt, setEvalPrompt] = React.useState("Run Tier 0 AST check and DevSecOps CVE gate on recent PR changes");
  const [evalKeywords, setEvalKeywords] = React.useState("ast, cve, vault, gate");
  const [evalProviders, setEvalProviders] = React.useState<string[]>(["antigravity-cli", "claude-cli", "opencode-cli"]);
  const [evalBusy, setEvalBusy] = React.useState(false);

  // Manual Skill Proposal draft state
  const [propTitle, setPropTitle] = React.useState("");
  const [propTarget, setPropTarget] = React.useState("qe-ast-rules");
  const [propRationale, setPropRationale] = React.useState("");
  const [propPatch, setPropPatch] = React.useState("");

  const loadAll = React.useCallback(async () => {
    const [m, r, c, t, b, p] = await Promise.all([
      apiGet<{ entries: MemoryEntry[] }>("/api/reo/memory"),
      apiGet<{ rules: AutomationRule[] }>("/api/reo/automation"),
      apiGet<{ checkpoints: Checkpoint[] }>("/api/reo/checkpoints"),
      apiGet<{ traces: MissionTrace[] }>("/api/reo/traces"),
      apiGet<{ benchmarks: ModelBenchmarkRun[] }>("/api/reo/benchmarks"),
      apiGet<{ proposals: SkillProposal[] }>("/api/reo/skill-proposals"),
    ]);
    if (m.ok && Array.isArray(m.data.entries)) setMemories(m.data.entries);
    if (r.ok && Array.isArray(r.data.rules)) setRules(r.data.rules);
    if (c.ok && Array.isArray(c.data.checkpoints)) setCheckpoints(c.data.checkpoints);
    if (t.ok && Array.isArray(t.data.traces)) setTraces(t.data.traces);
    if (b.ok && Array.isArray(b.data.benchmarks)) setBenchmarks(b.data.benchmarks);
    if (p.ok && Array.isArray(p.data.proposals)) setProposals(p.data.proposals);
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

  function toggleProvider(pid: string) {
    setEvalProviders((prev) => (prev.includes(pid) ? (prev.length > 1 ? prev.filter((x) => x !== pid) : prev) : [...prev, pid]));
  }

  async function executeBenchmark(e: React.FormEvent) {
    e.preventDefault();
    if (!evalPrompt.trim()) return;
    setEvalBusy(true);
    const res = await apiPost<{ ok: boolean; benchmark?: ModelBenchmarkRun; error?: string }>("/api/reo/benchmarks/run", {
      prompt: evalPrompt.trim(),
      providers: evalProviders,
      expectedKeywords: evalKeywords.split(",").map((s) => s.trim()).filter(Boolean),
    });
    setEvalBusy(false);
    if (res.ok) {
      toast.success(`Benchmark finished · Winner: ${res.data.benchmark?.winner || "complete"}`);
      loadAll();
    } else {
      toast.error(res.error || res.data?.error || "Benchmark failed");
    }
  }

  async function createProposal(e: React.FormEvent) {
    e.preventDefault();
    if (!propTitle.trim() || !propRationale.trim() || !propPatch.trim()) return;
    const res = await apiPost<{ ok: boolean; proposal?: SkillProposal }>("/api/reo/skill-proposals", {
      title: propTitle.trim(),
      targetName: propTarget.trim() || "qe-ast-rules",
      targetKind: "skill",
      rationale: propRationale.trim(),
      proposedPatchMarkdown: propPatch.trim(),
    });
    if (res.ok) {
      setPropTitle("");
      setPropRationale("");
      setPropPatch("");
      toast.success("Added skill improvement proposal (status: proposed)");
      loadAll();
    } else toast.error(res.error || "Could not create proposal");
  }

  async function reviewProposal(id: string, decision: "approved" | "dismissed") {
    const res = await apiPut<{ ok: boolean; proposal?: SkillProposal }>(`/api/reo/skill-proposals/${id}`, { decision });
    if (res.ok) {
      toast.success(decision === "approved" ? "Approved proposal & saved draft to Vault inbox" : "Dismissed proposal");
      loadAll();
    } else toast.error(res.error || "Failed to update proposal");
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
        description="3-layer QA memory, autonomous triggers, OpenTelemetry trace observatory, Evaluation Lab benchmarks, and skill proposals."
      />
      <Tabs defaultValue="memory" className="grid gap-4">
        <div className="max-w-full overflow-x-auto">
          <TabsList>
            <TabsTrigger value="memory">Memory Explorer</TabsTrigger>
            <TabsTrigger value="automation">Automation &amp; Triggers</TabsTrigger>
            <TabsTrigger value="checkpoints">Checkpoints</TabsTrigger>
            <TabsTrigger value="observatory">Observatory</TabsTrigger>
            <TabsTrigger value="evals">Evaluation Lab</TabsTrigger>
            <TabsTrigger value="proposals">Skill Proposals</TabsTrigger>
          </TabsList>
        </div>

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
                        <Button type="button" size="sm" variant="outline" onClick={() => verifyMem(m.id)}>
                          <CheckCircle2 />
                          Verify
                        </Button>
                      )}
                      <Button type="button" size="icon-sm" variant="ghost" aria-label="Delete memory" onClick={() => removeMem(m.id)}>
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
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={runningId === r.id}
                      onClick={() => runRuleNow(r.id)}
                    >
                      <Play />
                      {runningId === r.id ? "Running..." : "Run now"}
                    </Button>
                    <Button type="button" size="icon-sm" variant="ghost" aria-label="Delete trigger" onClick={() => removeRule(r.id)}>
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

        <TabsContent value="observatory" className="grid gap-3">
          {traces.map((tr) => {
            const totalMs = Math.max(1, tr.totalDurationMs);
            return (
              <Card key={tr.traceId}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Activity className="text-muted-foreground size-4" />
                      <CardTitle className="font-mono text-xs">{tr.missionId}</CardTitle>
                      {verdictBadge(tr.verdict)}
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {tr.spanCount} spans · {tr.totalDurationMs} ms
                      </Badge>
                    </div>
                    <span className="text-muted-foreground font-mono text-[10px]">trace:{tr.traceId.slice(0, 12)}</span>
                  </div>
                  <CardDescription className="text-xs break-words">{tr.prompt}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-1.5">
                  {tr.spans.map((sp) => {
                    const barWidth = Math.max(8, Math.min(260, Math.round((sp.durationMs / totalMs) * 260)));
                    return (
                      <div key={sp.spanId} className="grid grid-cols-[minmax(0,1fr)_16rem_4rem] items-center gap-2 text-xs">
                        <div className="flex min-w-0 items-center gap-1.5 truncate">
                          <Badge variant="secondary" className="text-[10px]">
                            {sp.kind}
                          </Badge>
                          <span className="truncate">{sp.name}</span>
                        </div>
                        <svg viewBox="0 0 260 12" className="h-3 w-full" aria-hidden="true">
                          <rect x="0" y="2" width="260" height="8" rx="3" className="fill-muted" />
                          <rect
                            x="0"
                            y="2"
                            width={barWidth}
                            height="8"
                            rx="3"
                            className={sp.status === "ERROR" ? "fill-destructive" : "fill-primary"}
                          />
                        </svg>
                        <span className="text-muted-foreground text-right font-mono text-[11px]">{sp.durationMs}ms</span>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            );
          })}
          {traces.length === 0 && (
            <Card>
              <CardContent className="text-muted-foreground py-8 text-center text-xs">
                No OpenTelemetry mission traces yet. Run an autonomous mission or Automation Trigger to inspect execution waterfalls.
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="evals" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <FlaskConical className="size-4" />
                Evaluation Lab (Model A/B Benchmark)
              </CardTitle>
              <CardDescription className="text-xs">
                Promptfoo-style side-by-side comparison across providers for grounding, secret safety, latency, and cost.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={executeBenchmark} className="grid gap-3">
                <Textarea
                  value={evalPrompt}
                  onChange={(e) => setEvalPrompt(e.target.value)}
                  placeholder="QA benchmark prompt..."
                  className="min-h-16"
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    value={evalKeywords}
                    onChange={(e) => setEvalKeywords(e.target.value)}
                    placeholder="Expected keywords (comma-separated)"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {BENCH_PROVIDERS.map((pid) => {
                      const active = evalProviders.includes(pid);
                      return (
                        <Button
                          key={pid}
                          type="button"
                          size="sm"
                          variant={active ? "default" : "outline"}
                          onClick={() => toggleProvider(pid)}
                        >
                          {pid}
                        </Button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={evalBusy || !evalPrompt.trim()}>
                    <Play />
                    {evalBusy ? "Benchmarking..." : "Run benchmark"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="grid gap-3">
            {benchmarks.map((run) => (
              <Card key={run.id}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>Winner: {run.winner}</Badge>
                      <span className="font-mono text-xs">{run.id}</span>
                    </div>
                    <span className="text-muted-foreground text-xs">{new Date(run.createdAt).toLocaleString()}</span>
                  </div>
                  <CardDescription className="text-xs break-words">{run.prompt}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {run.results.map((r) => (
                    <div key={r.providerId} className="bg-muted/40 grid gap-1 rounded-md border p-2.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 font-medium">
                          <span>{r.providerId}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {r.mode}
                          </Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                          <span>Score: {r.overallScore}/100</span>
                          <span>Ground: {r.citationScore}%</span>
                          <span>{r.latencyMs}ms</span>
                          <span>${r.estimatedCostUsd.toFixed(4)}</span>
                          <Badge variant={r.secretSafetyPass ? "secondary" : "destructive"} className="text-[10px]">
                            {r.secretSafetyPass ? "Secret Safe" : "Leaked"}
                          </Badge>
                        </div>
                      </div>
                      <p className="text-muted-foreground line-clamp-2 whitespace-pre-wrap">{r.excerpt}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="proposals" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="size-4" />
                Propose Skill or Rule Patch
              </CardTitle>
              <CardDescription className="text-xs">
                Proposals remain in review (never auto-active). Approving sends a status: proposed draft into the Vault inbox.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={createProposal} className="grid gap-2.5">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input value={propTitle} onChange={(e) => setPropTitle(e.target.value)} placeholder="Proposal title" />
                  <Input value={propTarget} onChange={(e) => setPropTarget(e.target.value)} placeholder="Target skill (e.g. qe-ast-rules)" />
                </div>
                <Input value={propRationale} onChange={(e) => setPropRationale(e.target.value)} placeholder="Why this keeps recurring..." />
                <Textarea
                  value={propPatch}
                  onChange={(e) => setPropPatch(e.target.value)}
                  placeholder="Proposed rule step or checklist markdown..."
                  className="min-h-16 font-mono text-xs"
                />
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={!propTitle.trim() || !propRationale.trim() || !propPatch.trim()}>
                    <Plus />
                    Create proposal
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="grid gap-3">
            {proposals.map((p) => (
              <Card key={p.id}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={p.status === "approved" ? "default" : p.status === "dismissed" ? "outline" : "secondary"}>
                        {p.status}
                      </Badge>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {p.targetName} · {p.occurrences}x
                      </Badge>
                      <CardTitle className="text-sm">{p.title}</CardTitle>
                    </div>
                    {p.status === "proposed" && (
                      <div className="flex items-center gap-1.5">
                        <Button type="button" size="sm" variant="outline" onClick={() => reviewProposal(p.id, "approved")}>
                          <CheckCircle2 />
                          Approve to Vault
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => reviewProposal(p.id, "dismissed")}>
                          <XCircle />
                          Dismiss
                        </Button>
                      </div>
                    )}
                  </div>
                  <CardDescription className="text-xs">{p.rationale}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-1.5">
                  <pre className="bg-muted/50 overflow-x-auto rounded border p-2 font-mono text-[11px] whitespace-pre-wrap">
                    {p.proposedPatchMarkdown}
                  </pre>
                  {p.vaultDraftPath && <p className="text-muted-foreground font-mono text-[11px]">Vault draft: {p.vaultDraftPath}</p>}
                </CardContent>
              </Card>
            ))}
            {proposals.length === 0 && (
              <Card>
                <CardContent className="text-muted-foreground py-8 text-center text-xs">
                  No skill or rule improvement proposals yet. Recurring defect patterns auto-propose patches here.
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
