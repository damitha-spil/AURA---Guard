// SPIL REO — Autonomous Multi-Agent Mission Runner.
// Plans and executes real local tools across specialist sub-agents and streams structured events
// while recording OpenTelemetry-compatible spans and proposing skill/rule improvements on recurrences.

import { randomBytes } from "node:crypto";
import { PROJECT_NAME } from "../brand.ts";
import type { GuardConfig } from "../types.ts";
import { upsertDefect } from "../defects/store.ts";
import type { DefectRecord } from "../defects/store.ts";
import { runBackendQaSuite } from "../qa/backend_qa.ts";
import { probeDesktopCrawlers } from "../qa/desktop_crawler.ts";
import { secDependencyCves, secSemgrepScan } from "../qa/devsecops_suite.ts";
import { findFeatureEntry } from "../qa/feature_map.ts";
import { runSecurityProbes } from "../qa/security_probes.ts";
import { analyzeRefinementAndKbDrift } from "../qe/refine.ts";
import { qeArchBoundaries, reviewAstGrep } from "../qe/tier0_suite.ts";
import { analyzeCommitTrajectory } from "../qe/trajectory.ts";
import { listSkills } from "../roles/skills.ts";
import { getN8nStatus, n8nListWorkflows } from "../plugins/n8n.ts";
import { getEffectiveAgents } from "./profiles.ts";
import { addMemory, recallMemory } from "../memory/qa-memory.ts";
import { evaluateQualityGate, recordCheckpoint } from "../automation/harness.ts";
import type { QualityVerdict } from "../automation/harness.ts";
import {
  detectAndProposeFromDefects,
  msToUnixNanoString,
  recordMissionTrace,
} from "../automation/observatory_and_evals.ts";
import type { OtelSpan } from "../automation/observatory_and_evals.ts";
import { routeIntentToAgents } from "./registry.ts";
import type { AgentId } from "./registry.ts";

export interface MissionStep {
  id: string;
  agent: AgentId;
  title: string;
  status: "pending" | "running" | "done" | "error";
}

export type MissionEvent =
  | { type: "mission"; id: string; prompt: string; agents: AgentId[]; status: "started" | "done" }
  | { type: "plan"; steps: MissionStep[] }
  | { type: "tool"; stepId: string; agent: AgentId; tool: string; status: "running" | "done" | "error"; detail: string; output?: unknown }
  | { type: "defect"; defect: DefectRecord }
  | { type: "verdict"; verdict: QualityVerdict; recalledMemory: number; checkpointId: string };

export async function runAgenticMission(
  cfg: GuardConfig,
  prompt: string,
  onEvent: (ev: MissionEvent) => void,
): Promise<{
  id: string;
  traceId: string;
  agents: AgentId[];
  steps: MissionStep[];
  defects: DefectRecord[];
  verdict: QualityVerdict;
  recalledMemory: number;
  checkpointId: string;
}> {
  const id = `mission-${Date.now().toString(36)}`;
  const traceId = randomBytes(16).toString("hex");
  const rootSpanId = randomBytes(8).toString("hex");
  const missionStartMs = Date.now();
  const spans: OtelSpan[] = [];
  const route = routeIntentToAgents(prompt);
  const profiles = getEffectiveAgents(cfg.dataDir);
  const enabledSet = new Set(profiles.filter((p) => p.enabled).map((p) => p.id));
  const routed = route.agents.filter((a) => enabledSet.has(a));
  const agents: AgentId[] = routed.length ? routed : ["qa", "review"];
  const recalled = recallMemory(cfg.dataDir, prompt, 5);
  recordCheckpoint(cfg.dataDir, {
    missionId: id,
    stage: "baseline",
    summary: `Started: ${prompt.slice(0, 140)}`,
    agents,
    defectCount: 0,
  });
  onEvent({ type: "mission", id, prompt, agents, status: "started" });

  const steps: MissionStep[] = [];
  if (agents.includes("qe") || agents.includes("review")) {
    steps.push({ id: "step-qe", agent: "qe", title: "Analyze commit trajectory, AST rules & boundaries", status: "pending" });
  }
  if (agents.includes("qa")) {
    steps.push({ id: "step-qa", agent: "qa", title: "Inspect desktop UIA crawlers & feature map", status: "pending" });
  }
  if (agents.includes("security") || agents.includes("api")) {
    steps.push({ id: "step-sec", agent: "security", title: "Run DevSecOps SAST/CVE scan & local probes", status: "pending" });
  }
  const n8nSt = await getN8nStatus(cfg.dataDir).catch(() => ({ enabled: false, endpoint: "", keySource: null, canStore: false }));
  if (/\b(n8n|webhook|workflow[- ]?automation)\b/i.test(prompt) || (agents.includes("report") && n8nSt.enabled && Boolean(n8nSt.endpoint))) {
    steps.push({ id: "step-n8n", agent: "report", title: "Inspect n8n automation workflows & webhook readiness", status: "pending" });
  }
  if (!steps.length) {
    steps.push({ id: "step-review", agent: "review", title: "Audit active rules & skill playbooks", status: "pending" });
  }
  onEvent({ type: "plan", steps: steps.map((s) => ({ ...s })) });

  const defects: DefectRecord[] = [];
  const updateStep = (step: MissionStep, status: MissionStep["status"]) => {
    step.status = status;
    onEvent({ type: "plan", steps: steps.map((s) => ({ ...s })) });
  };

  for (const step of steps) {
    updateStep(step, "running");
    const stepSpanId = randomBytes(8).toString("hex");
    const stepStartMs = Date.now();
    let stepStatus: "OK" | "ERROR" = "OK";
    try {
      if (step.id === "step-qe") {
        onEvent({ type: "tool", stepId: step.id, agent: "qe", tool: "qe_commit_trajectory", status: "running", detail: "Inspecting 7-day commit churn, AST rules & boundaries" });
        const traj = analyzeCommitTrajectory(cfg, null, { lookbackDays: 7 });
        const refine = analyzeRefinementAndKbDrift(cfg, null, {});
        const astRes = await reviewAstGrep(cfg, {}).catch(() => null);
        const boundRes = await qeArchBoundaries(cfg, {}).catch(() => null);
        onEvent({
          type: "tool",
          stepId: step.id,
          agent: "qe",
          tool: "qe_commit_trajectory",
          status: "done",
          detail: `${traj.churnHotspots.length} hotspot(s), ${refine.refinements.length} refinement(s), ${astRes?.findings.length ?? 0} AST hit(s), ${boundRes?.circularDependencies.length ?? 0} cycle(s)`,
          output: {
            hotspots: traj.churnHotspots.slice(0, 5),
            refinements: refine.refinements.length,
            staleAnchors: refine.staleAnchors.length,
            astFindings: astRes?.findings.length ?? 0,
            cycles: boundRes?.circularDependencies.length ?? 0,
          },
        });
        for (const f of refine.refinements.slice(0, 3)) {
          if (f.kind === "deep-nesting" || f.kind === "large-change") {
            const d = upsertDefect(cfg.dataDir, {
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
            defects.push(d);
            onEvent({ type: "defect", defect: d });
          }
        }
      } else if (step.id === "step-qa") {
        onEvent({ type: "tool", stepId: step.id, agent: "qa", tool: "qa_crawl_desktop_app", status: "running", detail: "Probing Windows UIA & CUA drivers" });
        const crawlers = await probeDesktopCrawlers(cfg);
        const features = findFeatureEntry(cfg, prompt);
        const readyCount = [crawlers.windowsUia.available, crawlers.cuaDriver.available, crawlers.python.available].filter(Boolean).length;
        onEvent({
          type: "tool",
          stepId: step.id,
          agent: "qa",
          tool: "qa_crawl_desktop_app",
          status: "done",
          detail: `${readyCount} crawler backend(s) ready, ${features.length} feature match(es)`,
          output: { crawlers, features },
        });
      } else if (step.id === "step-sec") {
        onEvent({ type: "tool", stepId: step.id, agent: "security", tool: "qa_security_probes", status: "running", detail: "Running DevSecOps SAST, CVE gate & local probes" });
        const backendQa = await runBackendQaSuite(cfg);
        const semgrepRes = await secSemgrepScan(cfg, { recordDefects: false }).catch(() => null);
        const cveRes = await secDependencyCves(cfg, { recordDefects: false }).catch(() => null);
        const urlMatch = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?[^\s]*/i.exec(prompt);
        const probeRes = urlMatch ? await runSecurityProbes(cfg, { baseUrl: urlMatch[0] }) : null;
        onEvent({
          type: "tool",
          stepId: step.id,
          agent: "security",
          tool: "qa_security_probes",
          status: "done",
          detail: `Backend QA: ${backendQa.passed}/${backendQa.checks.length} passed · SAST: ${semgrepRes?.totalFindings ?? 0} · CVEs: ${cveRes?.vulnerabilities.length ?? 0} (${cveRes?.releaseGate ?? "PASS"})${probeRes ? ` · HTTP probes: ${probeRes.failed} failed` : ""}`,
          output: { backendQa, semgrep: semgrepRes?.totalFindings ?? 0, cves: cveRes?.releaseGate ?? "PASS", probeRes },
        });
        if (cveRes && (cveRes.criticalCount > 0 || cveRes.highCount > 0)) {
          for (const v of cveRes.vulnerabilities.filter((x) => x.severity === "critical" || x.severity === "high").slice(0, 3)) {
            const d = upsertDefect(cfg.dataDir, {
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
            defects.push(d);
            onEvent({ type: "defect", defect: d });
          }
        }
        for (const c of backendQa.checks.filter((x) => x.status === "fail")) {
          const d = upsertDefect(cfg.dataDir, {
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
          defects.push(d);
          onEvent({ type: "defect", defect: d });
        }
      } else if (step.id === "step-n8n") {
        onEvent({ type: "tool", stepId: step.id, agent: "report", tool: "n8n_list_workflows", status: "running", detail: "Inspecting configured n8n instance & workflows" });
        const st = await getN8nStatus(cfg.dataDir);
        if (!st.enabled || !st.endpoint || !st.keySource) {
          onEvent({
            type: "tool",
            stepId: step.id,
            agent: "report",
            tool: "n8n_list_workflows",
            status: "done",
            detail: st.enabled ? "n8n enabled; configure endpoint and N8N_API_KEY in Plugins -> n8n Automation" : "n8n plugin disabled",
            output: st,
          });
        } else {
          const workflows = await n8nListWorkflows(cfg.dataDir);
          onEvent({
            type: "tool",
            stepId: step.id,
            agent: "report",
            tool: "n8n_list_workflows",
            status: "done",
            detail: `${workflows.length} n8n workflow(s) discovered (${workflows.filter((w) => w.active).length} active)`,
            output: { count: workflows.length, workflows: workflows.slice(0, 8) },
          });
        }
      } else {
        onEvent({ type: "tool", stepId: step.id, agent: "review", tool: "list_skills", status: "running", detail: "Loading REO skills & playbooks" });
        const skills = listSkills(cfg.root);
        onEvent({
          type: "tool",
          stepId: step.id,
          agent: "review",
          tool: "list_skills",
          status: "done",
          detail: `Loaded ${skills.length} skill playbooks`,
          output: { count: skills.length },
        });
      }
      updateStep(step, "done");
    } catch (err) {
      stepStatus = "ERROR";
      updateStep(step, "error");
      onEvent({
        type: "tool",
        stepId: step.id,
        agent: step.agent,
        tool: "mission_step",
        status: "error",
        detail: (err as Error).message,
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
  }

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
    attributes: { "reo.mission_id": id, "reo.verdict": verdict, "reo.defects": defects.length },
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
    agents,
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
  onEvent({ type: "verdict", verdict, recalledMemory: recalled.length, checkpointId: cp.id });
  onEvent({ type: "mission", id, prompt, agents, status: "done" });
  return { id, traceId, agents, steps, defects, verdict, recalledMemory: recalled.length, checkpointId: cp.id };
}
