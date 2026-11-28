// SPIL REO — Parallel Multi-Agent Swarm Runner & Self-Learning Loop.
// Executes specialist agents concurrently (pool=3) with live chat-in steering, per-agent timeouts,
// OpenTelemetry trace spans, and post-mission self-learning + autonomous asset creation.

import { randomBytes } from "node:crypto";
import { PROJECT_NAME } from "../brand.ts";
import { evaluateQualityGate, recordCheckpoint } from "../automation/harness.ts";
import type { QualityVerdict } from "../automation/harness.ts";
import {
  detectAndProposeFromDefects,
  msToUnixNanoString,
  recordMissionTrace,
} from "../automation/observatory_and_evals.ts";
import type { OtelSpan } from "../automation/observatory_and_evals.ts";
import { upsertDefect } from "../defects/store.ts";
import type { DefectRecord } from "../defects/store.ts";
import { listProductionDefects } from "../defects/store.ts";
import {
  getLearnedRouting,
  recallLessons,
  recordMissionOutcome,
  recordUserCorrection,
} from "../learning/self-learning.ts";
import { addMemory, recallMemory } from "../memory/qa-memory.ts";
import { getN8nStatus, n8nListWorkflows } from "../plugins/n8n.ts";
import { apiHurlRunner } from "../qa/api_and_load.ts";
import { qaK6SmokeLoad } from "../qa/api_and_load.ts";
import { runBackendQaSuite } from "../qa/backend_qa.ts";
import { probeDesktopCrawlers } from "../qa/desktop_crawler.ts";
import { secDependencyCves, secSemgrepScan } from "../qa/devsecops_suite.ts";
import { findFeatureEntry } from "../qa/feature_map.ts";
import { runSecurityProbes } from "../qa/security_probes.ts";
import { qaA11yTreeSnapshot, qaAxeAudit, qaLighthouseBudget } from "../qa/visual_and_a11y.ts";
import { analyzeRefinementAndKbDrift } from "../qe/refine.ts";
import { qeArchBoundaries, qeDeadCodeScan, qeMutationScore, reviewAstGrep } from "../qe/tier0_suite.ts";
import { analyzeCommitTrajectory } from "../qe/trajectory.ts";
import { listSkills } from "../roles/skills.ts";
import type { GuardConfig } from "../types.ts";
import { generatedSkillsDir, listCustomAgents, maybeSelfCreate } from "./creations.ts";
import type { CustomAgentSpec } from "./creations.ts";
import { drainInbox, finishMission, isAgentSkipped, registerMission } from "./mission-control.ts";
import { getEffectiveAgents } from "./profiles.ts";
import { PREBUILT_AGENTS, defectSourceFor, isPrebuiltAgentId, routeIntentToAgents } from "./registry.ts";
import type { AgentId } from "./registry.ts";

/** Hard cap on parallel running specialist agents in one swarm mission. */
export const MAX_PARALLEL_AGENTS = 3;

export interface MissionStep {
  id: string;
  agent: string;
  title: string;
  status: "pending" | "running" | "done" | "error" | "skipped";
}

export type MissionEvent =
  | { type: "mission"; id: string; prompt: string; agents: string[]; status: "started" | "done" }
  | {
      type: "agent";
      agent: string;
      name: string;
      status: "queued" | "running" | "done" | "error" | "skipped";
      detail?: string;
      createdBy?: "reo" | "user" | "system";
    }
  | { type: "chat"; from: "user" | "reo"; text: string; action?: string }
  | { type: "learned"; summary: string }
  | { type: "plan"; steps: MissionStep[] }
  | { type: "tool"; stepId: string; agent: string; tool: string; status: "running" | "done" | "error"; detail: string; output?: unknown }
  | { type: "defect"; defect: DefectRecord }
  | { type: "verdict"; verdict: QualityVerdict; recalledMemory: number; checkpointId: string };

interface StepRunContext {
  cfg: GuardConfig;
  missionId: string;
  step: MissionStep;
  prompt: string;
  localUrl: string | null;
  allowedTools: Set<string> | null; // non-null for custom agents
  signal: AbortSignal;
  onEvent: (ev: MissionEvent) => void;
  recordDefect: (input: Parameters<typeof upsertDefect>[1]) => DefectRecord;
  recordToolRun: (agent: string, tool: string, ms: number, ok: boolean) => void;
}

const agentTitle = (agentId: string, customMap: Map<string, CustomAgentSpec>): string => {
  const pre = PREBUILT_AGENTS.find((a) => a.id === agentId);
  if (pre) return pre.role;
  const cust = customMap.get(agentId);
  return cust?.role || "Specialist Task";
};

const agentDisplayName = (agentId: string, customMap: Map<string, CustomAgentSpec>): string => {
  const pre = PREBUILT_AGENTS.find((a) => a.id === agentId);
  if (pre) return pre.name;
  return customMap.get(agentId)?.name || agentId;
};

async function runToolTracked(
  ctx: StepRunContext,
  toolId: string,
  startDetail: string,
  fn: () => Promise<{ detail: string; output?: unknown }>,
): Promise<boolean> {
  if (ctx.signal.aborted) return false;
  if (ctx.allowedTools && !ctx.allowedTools.has(toolId)) return false;

  ctx.onEvent({ type: "tool", stepId: ctx.step.id, agent: ctx.step.agent, tool: toolId, status: "running", detail: startDetail });
  const t0 = Date.now();
  try {
    const res = await fn();
    ctx.recordToolRun(ctx.step.agent, toolId, Math.max(1, Date.now() - t0), true);
    ctx.onEvent({
      type: "tool",
      stepId: ctx.step.id,
      agent: ctx.step.agent,
      tool: toolId,
      status: "done",
      detail: res.detail,
      ...(res.output !== undefined ? { output: res.output } : {}),
    });
    return true;
  } catch (err) {
    ctx.recordToolRun(ctx.step.agent, toolId, Math.max(1, Date.now() - t0), false);
    ctx.onEvent({
      type: "tool",
      stepId: ctx.step.id,
      agent: ctx.step.agent,
      tool: toolId,
      status: "error",
      detail: (err as Error).message,
    });
    return false;
  }
}

const STEP_RUNNERS: Record<AgentId, (ctx: StepRunContext) => Promise<void>> = {
  async qa(ctx) {
    await runToolTracked(ctx, "qa_crawl_desktop_app", "Probing Windows UIA & CUA drivers", async () => {
      const crawlers = await probeDesktopCrawlers(ctx.cfg);
      const features = findFeatureEntry(ctx.cfg, ctx.prompt);
      const readyCount = [crawlers.windowsUia.available, crawlers.cuaDriver.available, crawlers.python.available].filter(Boolean).length;
      return {
        detail: `${readyCount} crawler backend(s) ready, ${features.length} feature match(es)`,
        output: { crawlers, features },
      };
    });
    if (ctx.localUrl && !ctx.signal.aborted) {
      await runToolTracked(ctx, "qa_a11y_tree_snapshot", `Snapshotting semantic ARIA tree for ${ctx.localUrl}`, async () => {
        const snap = await qaA11yTreeSnapshot(ctx.cfg, { url: ctx.localUrl! });
        return { detail: `${snap.nodeCount} ARIA nodes (${snap.unlabeledCount} unlabeled)`, output: snap };
      });
    }
  },

  async qe(ctx) {
    await runToolTracked(ctx, "qe_commit_trajectory", "Inspecting 7-day commit churn, AST rules & boundaries", async () => {
      const traj = analyzeCommitTrajectory(ctx.cfg, null, { lookbackDays: 7 });
      const refine = analyzeRefinementAndKbDrift(ctx.cfg, null, {});
      const astRes = await reviewAstGrep(ctx.cfg, {}).catch(() => null);
      const boundRes = await qeArchBoundaries(ctx.cfg, {}).catch(() => null);
      for (const f of refine.refinements.slice(0, 3)) {
        if (f.kind === "deep-nesting" || f.kind === "large-change") {
          ctx.recordDefect({
            appName: PROJECT_NAME,
            branch: "current",
            commitSha: "",
            testedBy: "SPIL REO QE Agent",
            assignedTo: "",
            agentSource: "qe",
            severity: f.kind === "deep-nesting" ? "high" : "medium",
            title: `${f.kind}: ${f.file}`,
            expected: "Clean maintainable change aligned with Vault rules",
            actual: f.message,
            reproSteps: ["Run qe_code_refine_drift on repository"],
            codeSuggestion: f.message,
            fileRef: `${f.file}:${f.line}`,
            evidencePaths: [],
          });
        }
      }
      return {
        detail: `${traj.churnHotspots.length} hotspot(s), ${refine.refinements.length} refinement(s), ${astRes?.findings.length ?? 0} AST hit(s), ${boundRes?.circularDependencies.length ?? 0} cycle(s)`,
        output: {
          hotspots: traj.churnHotspots.slice(0, 5),
          refinements: refine.refinements.length,
          staleAnchors: refine.staleAnchors.length,
          astFindings: astRes?.findings.length ?? 0,
          cycles: boundRes?.circularDependencies.length ?? 0,
        },
      };
    });
    if (!ctx.signal.aborted && (!ctx.allowedTools || ctx.allowedTools.has("qe_mutation_score"))) {
      await runToolTracked(ctx, "qe_mutation_score", "Measuring mutation site coverage", async () => {
        const mut = await qeMutationScore(ctx.cfg, {});
        return { detail: `Mutation adequacy: ${mut.mutationScorePct}% across ${mut.filesAnalyzed} file(s)`, output: mut };
      });
    }
  },

  async review(ctx) {
    await runToolTracked(ctx, "review_ast_grep", "Running Tier 0 AST & architecture boundary review", async () => {
      const ast = await reviewAstGrep(ctx.cfg, {});
      const bounds = await qeArchBoundaries(ctx.cfg, {});
      return {
        detail: `${ast.findings.length} AST finding(s) across ${ast.filesScanned} file(s); ${bounds.circularDependencies.length} circular dep(s)`,
        output: { astFindings: ast.findings.slice(0, 10), cycles: bounds.circularDependencies.length },
      };
    });
  },

  async security(ctx) {
    await runToolTracked(ctx, "qa_security_probes", "Running DevSecOps SAST, CVE gate & local probes", async () => {
      const backendQa = await runBackendQaSuite(ctx.cfg);
      const semgrepRes = await secSemgrepScan(ctx.cfg, { recordDefects: false }).catch(() => null);
      const cveRes = await secDependencyCves(ctx.cfg, { recordDefects: false }).catch(() => null);
      const probeRes = ctx.localUrl ? await runSecurityProbes(ctx.cfg, { baseUrl: ctx.localUrl }) : null;
      if (cveRes && (cveRes.criticalCount > 0 || cveRes.highCount > 0)) {
        for (const v of cveRes.vulnerabilities.filter((x) => x.severity === "critical" || x.severity === "high").slice(0, 3)) {
          ctx.recordDefect({
            appName: PROJECT_NAME,
            branch: "current",
            commitSha: "",
            testedBy: "SPIL REO Security Agent",
            assignedTo: "",
            agentSource: "security",
            severity: v.severity,
            title: `${v.id}: ${v.packageName}@${v.installedVersion}`,
            expected: `Upgrade to >= ${v.fixedIn}`,
            actual: v.summary,
            reproSteps: ["Run sec_dependency_cves"],
            codeSuggestion: `npm install ${v.packageName}@^${v.fixedIn}`,
            fileRef: v.sourceFile,
            evidencePaths: [],
          });
        }
      }
      for (const c of backendQa.checks.filter((x) => x.status === "fail")) {
        ctx.recordDefect({
          appName: PROJECT_NAME,
          branch: "current",
          commitSha: "",
          testedBy: "SPIL REO Security Agent",
          assignedTo: "",
          agentSource: "security",
          severity: "high",
          title: `Backend QA Failed: ${c.label}`,
          expected: "Check passes safety & isolation policy",
          actual: c.detail || "Backend check failed",
          reproSteps: ["Run backend_qa suite"],
          codeSuggestion: c.detail || "",
          evidencePaths: [],
        });
      }
      return {
        detail: `Backend QA: ${backendQa.passed}/${backendQa.checks.length} passed · SAST: ${semgrepRes?.totalFindings ?? 0} · CVEs: ${cveRes?.vulnerabilities.length ?? 0} (${cveRes?.releaseGate ?? "PASS"})${probeRes ? ` · HTTP probes: ${probeRes.failed} failed` : ""}`,
        output: { backendQa, semgrep: semgrepRes?.totalFindings ?? 0, cves: cveRes?.releaseGate ?? "PASS", probeRes },
      };
    });
  },

  async api(ctx) {
    if (!ctx.localUrl) {
      await runToolTracked(ctx, "qa_openapi_checks", "Checking local API target configuration", async () => ({
        detail: "Provide a localhost URL in the prompt to run live API Hurl/contract checks.",
        output: { skipped: true },
      }));
      return;
    }
    await runToolTracked(ctx, "api_hurl_runner", `Running localhost Hurl health contract on ${ctx.localUrl}`, async () => {
      const hurl = await apiHurlRunner(ctx.cfg, {
        baseUrl: ctx.localUrl!,
        hurlText: `GET /\nHTTP 200\n[Asserts]\nstatus == 200`,
      });
      return { detail: `${hurl.passedEntries}/${hurl.totalEntries} Hurl contract(s) passed`, output: hurl };
    });
  },

  async a11y(ctx) {
    if (!ctx.localUrl) {
      await runToolTracked(ctx, "qa_axe_audit", "Inspecting accessibility audit prerequisites", async () => ({
        detail: "Provide a localhost URL (e.g. http://127.0.0.1:4310) to run live WCAG Axe & CWV checks.",
        output: { skipped: true },
      }));
      return;
    }
    await runToolTracked(ctx, "qa_axe_audit", `Running WCAG Axe & Lighthouse audit on ${ctx.localUrl}`, async () => {
      const axe = await qaAxeAudit(ctx.cfg, { url: ctx.localUrl!, recordDefects: true });
      const cwv = await qaLighthouseBudget(ctx.cfg, { url: ctx.localUrl! }).catch(() => null);
      return {
        detail: `WCAG score ${axe.score}/100 (${axe.violations.length} violation(s))${cwv ? ` · Perf ${cwv.scores.performance}/100` : ""}`,
        output: { axe, cwv },
      };
    });
  },

  async perf(ctx) {
    if (!ctx.localUrl) {
      await runToolTracked(ctx, "qa_k6_smoke_load", "Checking localhost load budget target", async () => ({
        detail: "Provide a localhost URL (e.g. http://127.0.0.1:4310) to run k6 smoke load.",
        output: { skipped: true },
      }));
      return;
    }
    await runToolTracked(ctx, "qa_k6_smoke_load", `Running bounded k6 smoke load (3 VUs, 3s) on ${ctx.localUrl}`, async () => {
      const k6 = await qaK6SmokeLoad(ctx.cfg, { url: ctx.localUrl!, vus: 3, durationSeconds: 3 });
      const cwv = await qaLighthouseBudget(ctx.cfg, { url: ctx.localUrl! }).catch(() => null);
      return {
        detail: `${k6.totalRequests} reqs · p95=${k6.latency.p95Ms}ms · err=${k6.errorRatePct}% · budget=${k6.budgetPassed ? "PASS" : "FAIL"}`,
        output: { k6, cwv },
      };
    });
  },

  async release(ctx) {
    await runToolTracked(ctx, "sec_dependency_cves", "Evaluating CVE lockfiles & churn trajectory for release gate", async () => {
      const cves = await secDependencyCves(ctx.cfg, { recordDefects: false });
      const traj = analyzeCommitTrajectory(ctx.cfg, null, { lookbackDays: 7 });
      if (cves.releaseGate === "BLOCK_RELEASE") {
        for (const v of cves.vulnerabilities.filter((x) => x.severity === "critical" || x.severity === "high").slice(0, 3)) {
          ctx.recordDefect({
            appName: PROJECT_NAME,
            branch: "current",
            commitSha: "",
            testedBy: "SPIL REO Release Manager",
            assignedTo: "",
            agentSource: defectSourceFor("release"),
            severity: v.severity,
            title: `Release Blocker ${v.id}: ${v.packageName}@${v.installedVersion}`,
            expected: `Upgrade to >= ${v.fixedIn}`,
            actual: v.summary,
            reproSteps: ["Run sec_dependency_cves"],
            codeSuggestion: `npm install ${v.packageName}@^${v.fixedIn}`,
            fileRef: v.sourceFile,
            evidencePaths: [],
          });
        }
      }
      return {
        detail: `Release gate hint: ${cves.releaseGate} (${cves.vulnerabilities.length} CVE(s), risk=${traj.riskLevel})`,
        output: { releaseGate: cves.releaseGate, cves: cves.vulnerabilities.length, trajectoryRisk: traj.riskLevel },
      };
    });
  },

  async architect(ctx) {
    await runToolTracked(ctx, "qe_arch_boundaries", "Checking module boundaries, circular imports & dead code", async () => {
      const bounds = await qeArchBoundaries(ctx.cfg, {});
      const dead = await qeDeadCodeScan(ctx.cfg, {});
      return {
        detail: `${bounds.boundaryViolations.length} boundary violation(s), ${bounds.circularDependencies.length} cycle(s), ${dead.unusedExports.length} unused export(s)`,
        output: { bounds, unusedExports: dead.unusedExports.length, unusedDeps: dead.unusedDependencies },
      };
    });
  },

  async triage(ctx) {
    await runToolTracked(ctx, "qa_bug_sheet", "Clustering recurring defects & commit churn suspects", async () => {
      const recurring = listProductionDefects(ctx.cfg.dataDir).filter((d) => (d.recurrenceCount ?? 1) >= 2);
      const traj = analyzeCommitTrajectory(ctx.cfg, null, { lookbackDays: 7 });
      return {
        detail: `${recurring.length} recurring defect cluster(s), ${traj.churnHotspots.length} churn hotspot(s)`,
        output: {
          recurring: recurring.slice(0, 5).map((d) => ({ id: d.id, title: d.title, count: d.recurrenceCount })),
          hotspots: traj.churnHotspots.slice(0, 5),
        },
      };
    });
  },

  async knowledge(ctx) {
    await runToolTracked(ctx, "list_skills", "Recalling QA memory & loaded skill playbooks", async () => {
      const skills = listSkills(ctx.cfg.root, undefined, generatedSkillsDir(ctx.cfg.dataDir));
      const mem = recallMemory(ctx.cfg.dataDir, ctx.prompt, 3);
      return {
        detail: `Loaded ${skills.length} skill(s) and recalled ${mem.length} memory note(s)`,
        output: { skillCount: skills.length, recalled: mem.map((m) => m.title) },
      };
    });
  },

  async report(ctx) {
    await runToolTracked(ctx, "n8n_list_workflows", "Inspecting configured n8n instance & report readiness", async () => {
      const st = await getN8nStatus(ctx.cfg.dataDir);
      if (!st.enabled || !st.endpoint || !st.keySource) {
        return {
          detail: st.enabled ? "n8n enabled; configure endpoint and N8N_API_KEY in Plugins -> n8n Automation" : "n8n plugin disabled",
          output: st,
        };
      }
      const workflows = await n8nListWorkflows(ctx.cfg.dataDir);
      return {
        detail: `${workflows.length} n8n workflow(s) discovered (${workflows.filter((w) => w.active).length} active)`,
        output: { count: workflows.length, workflows: workflows.slice(0, 8) },
      };
    });
  },
};

export async function runAgenticMission(
  cfg: GuardConfig,
  prompt: string,
  onEvent: (ev: MissionEvent) => void,
  opts: { missionId?: string; signal?: AbortSignal } = {},
): Promise<{
  id: string;
  traceId: string;
  agents: string[];
  steps: MissionStep[];
  defects: DefectRecord[];
  verdict: QualityVerdict;
  recalledMemory: number;
  checkpointId: string;
}> {
  const id = opts.missionId || `mission-${Date.now().toString(36)}`;
  const traceId = randomBytes(16).toString("hex");
  const rootSpanId = randomBytes(8).toString("hex");
  const missionStartMs = Date.now();
  const missionAbort = registerMission(id, opts.signal);
  const spans: OtelSpan[] = [];

  try {
    const learnedRouting = getLearnedRouting(cfg.dataDir);
    const route = routeIntentToAgents(prompt, learnedRouting);
    const profiles = getEffectiveAgents(cfg.dataDir);
    const profileMap = new Map(profiles.map((p) => [p.id, p]));
    const customList = listCustomAgents(cfg.dataDir).filter((a) => a.enabled && a.status === "active");
    const customMap = new Map(customList.map((a) => [a.id, a]));

    const routedPrebuilt = route.agents.filter((a) => profileMap.get(a)?.enabled !== false);
    const routedCustom = (route.customAgents ?? []).filter((cid) => customMap.has(cid));
    const agents: string[] = [...routedPrebuilt, ...routedCustom];
    if (agents.length === 0) agents.push("qa", "review");

    const recalled = recallMemory(cfg.dataDir, prompt, 5);
    const appliedLessons = recallLessons(cfg.dataDir, prompt, 3);
    const localUrlMatch = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?[^\s]*/i.exec(prompt);
    const localUrl = localUrlMatch?.[0] ?? null;

    recordCheckpoint(cfg.dataDir, {
      missionId: id,
      stage: "baseline",
      summary: `Started swarm: ${prompt.slice(0, 140)}`,
      agents: agents.filter(isPrebuiltAgentId),
      defectCount: 0,
    });
    onEvent({ type: "mission", id, prompt, agents, status: "started" });

    if (appliedLessons.length > 0) {
      const summaryText = `Applying what I learned: ${appliedLessons.map((l) => l.text).join(" · ")}`;
      onEvent({ type: "chat", from: "reo", text: summaryText, action: "learned_recall" });
    }

    const steps: MissionStep[] = agents.map((ag) => ({
      id: `step-${ag}`,
      agent: ag,
      title: agentTitle(ag, customMap),
      status: "pending",
    }));

    const n8nSt = await getN8nStatus(cfg.dataDir).catch(() => ({ enabled: false, endpoint: "", keySource: null, canStore: false }));
    if (
      /\b(n8n|webhook|workflow[- ]?automation)\b/i.test(prompt) &&
      !agents.includes("report") &&
      n8nSt.enabled &&
      Boolean(n8nSt.endpoint)
    ) {
      steps.push({ id: "step-report", agent: "report", title: "Inspect n8n automation workflows", status: "pending" });
    }

    for (const s of steps) {
      const cust = customMap.get(s.agent);
      onEvent({
        type: "agent",
        agent: s.agent,
        name: agentDisplayName(s.agent, customMap),
        status: "queued",
        detail: s.title,
        createdBy: cust ? cust.createdBy : "system",
      });
    }
    onEvent({ type: "plan", steps: steps.map((s) => ({ ...s })) });

    const defects: DefectRecord[] = [];
    const toolRuns: Array<{ id: string; ms: number; ok: boolean }> = [];
    const successfulAgents = new Set<string>();

    const updateStep = (step: MissionStep, status: MissionStep["status"]) => {
      step.status = status;
      onEvent({ type: "plan", steps: steps.map((s) => ({ ...s })) });
    };

    const recordDefect = (input: Parameters<typeof upsertDefect>[1]): DefectRecord => {
      const d = upsertDefect(cfg.dataDir, input);
      defects.push(d);
      onEvent({ type: "defect", defect: d });
      return d;
    };

    const processInbox = () => {
      const msgs = drainInbox(id);
      for (const msg of msgs) {
        onEvent({ type: "chat", from: "user", text: msg.text, action: msg.action });
        if (msg.action === "note") {
          const lesson = recordUserCorrection(cfg.dataDir, msg.text, id);
          if (lesson) {
            onEvent({ type: "learned", summary: `Saved lesson: ${lesson.text}` });
          }
          onEvent({ type: "chat", from: "reo", text: `Noted: "${msg.text.slice(0, 80)}"`, action: "note" });
        } else if (msg.action === "stop") {
          onEvent({ type: "chat", from: "reo", text: "Stopping remaining swarm steps as requested.", action: "stop" });
        } else if (msg.action === "skip" && msg.target) {
          onEvent({ type: "chat", from: "reo", text: `Skipping @${msg.target}.`, action: "skip" });
        } else if (msg.action === "add_agent" && msg.target) {
          const target = msg.target;
          if (!steps.some((s) => s.agent === target)) {
            const newStep: MissionStep = {
              id: `step-${target}`,
              agent: target,
              title: agentTitle(target, customMap),
              status: "pending",
            };
            steps.push(newStep);
            const cust = customMap.get(target);
            onEvent({
              type: "agent",
              agent: target,
              name: agentDisplayName(target, customMap),
              status: "queued",
              detail: newStep.title,
              createdBy: cust ? cust.createdBy : "system",
            });
            onEvent({ type: "plan", steps: steps.map((s) => ({ ...s })) });
            onEvent({ type: "chat", from: "reo", text: `Added @${target} to the live swarm.`, action: "add_agent" });
          }
        }
      }
    };

    const executeOneStep = async (step: MissionStep): Promise<void> => {
      processInbox();
      const cust = customMap.get(step.agent);
      const displayName = agentDisplayName(step.agent, customMap);
      const createdBy = cust ? cust.createdBy : "system";

      if (missionAbort.signal.aborted || isAgentSkipped(id, step.agent) || isAgentSkipped(id, step.id)) {
        updateStep(step, "skipped");
        onEvent({ type: "agent", agent: step.agent, name: displayName, status: "skipped", detail: "Skipped", createdBy });
        return;
      }

      updateStep(step, "running");
      onEvent({ type: "agent", agent: step.agent, name: displayName, status: "running", detail: step.title, createdBy });

      const stepSpanId = randomBytes(8).toString("hex");
      const stepStartMs = Date.now();
      let stepStatus: "OK" | "ERROR" = "OK";

      try {
        const baseId: AgentId = cust ? cust.baseAgent : isPrebuiltAgentId(step.agent) ? step.agent : "review";
        const runnerFn = STEP_RUNNERS[baseId];
        const profile = profileMap.get(baseId);
        const timeoutMs = (profile?.maxTimeSeconds ?? 120) * 1000;

        const ctx: StepRunContext = {
          cfg,
          missionId: id,
          step,
          prompt,
          localUrl,
          allowedTools: cust ? new Set(cust.allowedTools) : null,
          signal: missionAbort.signal,
          onEvent,
          recordDefect,
          recordToolRun: (_ag, tool, ms, ok) => toolRuns.push({ id: tool, ms, ok }),
        };

        let timer: NodeJS.Timeout | null = null;
        await Promise.race([
          runnerFn(ctx),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Time budget reached")), timeoutMs);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });

        if (missionAbort.signal.aborted) {
          updateStep(step, "skipped");
          onEvent({ type: "agent", agent: step.agent, name: displayName, status: "skipped", detail: "Stopped by user", createdBy });
        } else {
          successfulAgents.add(step.agent);
          updateStep(step, "done");
          onEvent({ type: "agent", agent: step.agent, name: displayName, status: "done", detail: "Completed", createdBy });
        }
      } catch (err) {
        stepStatus = "ERROR";
        const msg = (err as Error).message;
        updateStep(step, "error");
        onEvent({ type: "agent", agent: step.agent, name: displayName, status: "error", detail: msg, createdBy });
        onEvent({
          type: "tool",
          stepId: step.id,
          agent: step.agent,
          tool: "mission_step",
          status: "error",
          detail: msg,
        });
      } finally {
        const stepEndMs = Date.now();
        spans.push({
          traceId,
          spanId: stepSpanId,
          parentSpanId: rootSpanId,
          name: step.title,
          kind: "TOOL",
          agent: step.agent,
          tool: step.id,
          startTimeUnixNano: msToUnixNanoString(stepStartMs),
          endTimeUnixNano: msToUnixNanoString(stepEndMs),
          durationMs: Math.max(1, stepEndMs - stepStartMs),
          status: stepStatus,
          attributes: { "reo.step_id": step.id, "reo.agent": step.agent },
        });
      }
    };

    // Bounded concurrent swarm pool (processes dynamically added steps too)
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < steps.length) {
        const idx = cursor++;
        const step = steps[idx];
        if (!step) break;
        await executeOneStep(step);
      }
    };
    const poolSize = Math.min(MAX_PARALLEL_AGENTS, Math.max(1, steps.length));
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
    processInbox();

    const verdict = evaluateQualityGate(defects);
    const gateEndMs = Date.now();
    spans.unshift({
      traceId,
      spanId: rootSpanId,
      name: `mission:${agents.join("+")}`,
      kind: "AGENT",
      startTimeUnixNano: msToUnixNanoString(missionStartMs),
      endTimeUnixNano: msToUnixNanoString(gateEndMs),
      durationMs: Math.max(1, gateEndMs - missionStartMs),
      status: verdict === "BLOCK_RELEASE" ? "ERROR" : "OK",
      attributes: {
        "reo.mission_id": id,
        "reo.verdict": verdict,
        "reo.defects": defects.length,
        "reo.applied_lessons": appliedLessons.length,
      },
    });
    spans.push({
      traceId,
      spanId: randomBytes(8).toString("hex"),
      parentSpanId: rootSpanId,
      name: `quality-gate:${verdict}`,
      kind: "GATE",
      startTimeUnixNano: msToUnixNanoString(gateEndMs),
      endTimeUnixNano: msToUnixNanoString(gateEndMs + 1),
      durationMs: 1,
      status: verdict === "BLOCK_RELEASE" ? "ERROR" : "OK",
      attributes: { "reo.verdict": verdict, "reo.recalled_memory": recalled.length },
    });

    recordMissionTrace(cfg.dataDir, {
      traceId,
      missionId: id,
      prompt: prompt.slice(0, 200),
      agents,
      startedAt: new Date(missionStartMs).toISOString(),
      totalDurationMs: Math.max(1, gateEndMs - missionStartMs),
      verdict,
      spanCount: spans.length,
      spans,
    });

    const cp = recordCheckpoint(cfg.dataDir, {
      missionId: id,
      stage: "completed",
      summary: `${steps.length} step(s), ${defects.length} defect(s), ${recalled.length} recalled memory item(s)`,
      agents: agents.filter(isPrebuiltAgentId),
      defectCount: defects.length,
      verdict,
    });

    if (defects.length > 0) {
      addMemory(cfg.dataDir, {
        layer: "execution",
        confidence: "hypothesis",
        title: `Mission ${id}: ${defects[0]!.title}`,
        content: defects.map((d) => `[${d.severity}] ${d.title}`).join("\n"),
        tags: ["mission", verdict.toLowerCase()],
        source: id,
      });
      detectAndProposeFromDefects(cfg.dataDir, id);
    }

    // Record self-learning telemetry + autonomous tool/agent/skill creation
    recordMissionOutcome(cfg.dataDir, {
      missionId: id,
      prompt,
      agents: [...new Set(steps.map((s) => s.agent))],
      tools: toolRuns,
      verdict,
      successfulAgents: [...successfulAgents],
      appliedLessonIds: appliedLessons.map((l) => l.id),
    });

    const created = maybeSelfCreate(cfg, {
      agents: [...successfulAgents],
      tools: toolRuns.filter((t) => t.ok).map((t) => t.id),
    });
    if (created) {
      onEvent({ type: "learned", summary: `REO created ${created.kind}: ${created.name} (${created.id})` });
    }

    onEvent({ type: "verdict", verdict, recalledMemory: recalled.length, checkpointId: cp.id });
    onEvent({ type: "mission", id, prompt, agents, status: "done" });
    return { id, traceId, agents, steps, defects, verdict, recalledMemory: recalled.length, checkpointId: cp.id };
  } finally {
    finishMission(id);
  }
}
