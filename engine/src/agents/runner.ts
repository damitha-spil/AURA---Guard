// SPIL REO — Autonomous Multi-Agent Mission Runner.
// Plans and executes real local tools across specialist sub-agents and streams structured events.

import { PROJECT_NAME } from "../brand.ts";
import type { GuardConfig } from "../types.ts";
import { upsertDefect } from "../defects/store.ts";
import type { DefectRecord } from "../defects/store.ts";
import { runBackendQaSuite } from "../qa/backend_qa.ts";
import { probeDesktopCrawlers } from "../qa/desktop_crawler.ts";
import { findFeatureEntry } from "../qa/feature_map.ts";
import { runSecurityProbes } from "../qa/security_probes.ts";
import { analyzeRefinementAndKbDrift } from "../qe/refine.ts";
import { analyzeCommitTrajectory } from "../qe/trajectory.ts";
import { listSkills } from "../roles/skills.ts";
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
  | { type: "defect"; defect: DefectRecord };

export async function runAgenticMission(
  cfg: GuardConfig,
  prompt: string,
  onEvent: (ev: MissionEvent) => void,
): Promise<{ id: string; agents: AgentId[]; steps: MissionStep[]; defects: DefectRecord[] }> {
  const id = `mission-${Date.now().toString(36)}`;
  const route = routeIntentToAgents(prompt);
  const agents: AgentId[] = route.agents.length ? route.agents : ["qa", "review"];
  onEvent({ type: "mission", id, prompt, agents, status: "started" });

  const steps: MissionStep[] = [];
  if (agents.includes("qe") || agents.includes("review")) {
    steps.push({ id: "step-qe", agent: "qe", title: "Analyze commit trajectory & KB drift", status: "pending" });
  }
  if (agents.includes("qa")) {
    steps.push({ id: "step-qa", agent: "qa", title: "Inspect desktop UIA crawlers & feature map", status: "pending" });
  }
  if (agents.includes("security") || agents.includes("api")) {
    steps.push({ id: "step-sec", agent: "security", title: "Run backend QA & local security probes", status: "pending" });
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
    try {
      if (step.id === "step-qe") {
        onEvent({ type: "tool", stepId: step.id, agent: "qe", tool: "qe_commit_trajectory", status: "running", detail: "Inspecting 7-day commit churn & hotspots" });
        const traj = analyzeCommitTrajectory(cfg, null, { lookbackDays: 7 });
        const refine = analyzeRefinementAndKbDrift(cfg, null, {});
        onEvent({
          type: "tool",
          stepId: step.id,
          agent: "qe",
          tool: "qe_commit_trajectory",
          status: "done",
          detail: `${traj.churnHotspots.length} hotspot(s), ${refine.refinements.length} refinement(s), ${refine.staleAnchors.length} stale anchor(s)`,
          output: { hotspots: traj.churnHotspots.slice(0, 5), refinements: refine.refinements.length, staleAnchors: refine.staleAnchors.length },
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
        onEvent({ type: "tool", stepId: step.id, agent: "security", tool: "qa_security_probes", status: "running", detail: "Running local-only backend & safety probes" });
        const backendQa = await runBackendQaSuite(cfg);
        const urlMatch = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?[^\s]*/i.exec(prompt);
        const probeRes = urlMatch ? await runSecurityProbes(cfg, { baseUrl: urlMatch[0] }) : null;
        onEvent({
          type: "tool",
          stepId: step.id,
          agent: "security",
          tool: "qa_security_probes",
          status: "done",
          detail: `Backend QA: ${backendQa.passed}/${backendQa.checks.length} passed${probeRes ? ` · HTTP probes: ${probeRes.failed} failed / ${probeRes.passed} passed` : ""}`,
          output: { backendQa, probeRes },
        });
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
      updateStep(step, "error");
      onEvent({
        type: "tool",
        stepId: step.id,
        agent: step.agent,
        tool: "mission_step",
        status: "error",
        detail: (err as Error).message,
      });
    }
  }

  onEvent({ type: "mission", id, prompt, agents, status: "done" });
  return { id, agents, steps, defects };
}
