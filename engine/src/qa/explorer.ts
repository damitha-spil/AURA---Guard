// Bounded Exploratory QA Agent (/qa-explore <area>):
// Walks unvisited safe UI controls within a hard step cap (MAX_EXPLORE_STEPS = 15),
// runs all 5 deterministic oracles at target widths, and synthesizes a proposed JourneyDsl.

import type { CompleteFn } from "../brain/client.ts";
import type { AuraDriver, ObservedControl } from "./driver.ts";
import type { DslDefect, DslStep, JourneyDsl } from "./dsl.ts";
import { evaluateTrajectory, evaluateWithRubric } from "./judge.ts";
import type { JudgeEvaluation, TrajectoryEvaluation, TrajectoryStep } from "./judge.ts";
import { runAllOracles } from "./oracles.ts";
import type { OracleReport } from "./oracles.ts";

/** Safety cap: maximum exploratory actions per run to bound cost and side effects. */
export const MAX_EXPLORE_STEPS = 15;

export interface ExploreResult {
  area: string;
  telemetryMode: string;
  visitedControls: string[];
  skippedBlockedControls: string[];
  steps: TrajectoryStep[];
  oracleReports: { width: number; report: OracleReport }[];
  defects: DslDefect[];
  screenshots: { width: number; step: string; path: string }[];
  proposedJourney: JourneyDsl;
  trajectory: TrajectoryEvaluation;
  evaluation: JudgeEvaluation;
}

function isNavigableControl(c: ObservedControl, tier: 0 | 1): boolean {
  if (c.safeTier > tier) return false;
  const role = c.role.toLowerCase();
  return !role.includes("textbox") && !role.includes("edit") && !role.includes("input");
}

export async function exploreScreen(
  driver: AuraDriver,
  opts: {
    area: string;
    maxSteps?: number;
    tier?: 0 | 1;
    widths?: number[];
    screenContext?: string;
    complete?: CompleteFn;
  },
): Promise<ExploreResult> {
  const maxSteps = Math.max(1, Math.min(MAX_EXPLORE_STEPS, opts.maxSteps ?? MAX_EXPLORE_STEPS));
  const tier = opts.tier ?? 0;
  const widths = opts.widths?.length ? opts.widths : [800, 1100, 1440];

  const visited = new Set<string>();
  const skippedBlocked = new Set<string>();
  const steps: TrajectoryStep[] = [];
  const oracleReports: ExploreResult["oracleReports"] = [];
  const defects: DslDefect[] = [];
  const screenshots: { width: number; step: string; path: string }[] = [];
  const draftedSteps: DslStep[] = [];
  let lastVisible = "";
  let lastAria = "";
  let lastOracle: OracleReport | undefined;

  for (const w of widths) {
    await driver.resize(w);
    const col = await driver.collectOracles(w);
    lastVisible = col.visibleText || lastVisible;
    lastAria = col.ariaSnapshot || lastAria;
    const report = runAllOracles({
      width: w,
      layout: col.layout,
      consoleEvents: col.consoleEvents,
      networkEvents: col.networkEvents,
      formButtons: col.formButtons,
      visibleText: col.visibleText,
    });
    lastOracle = report;
    oracleReports.push({ width: w, report });
    if (!report.ok) {
      const fail = report.findings.find((f) => f.severity === "fail");
      defects.push({
        journey: `explore-${opts.area}`,
        step: `initial-layout-${w}px`,
        width: w,
        expected: "Zero layout, console, form, or protocol oracle failures",
        actual: fail?.message ?? "Oracle failed",
      });
    }
  }

  await driver.resize(widths[0] ?? 1100);
  for (let i = 0; i < maxSteps; i++) {
    const obs = await driver.observe();
    lastVisible = obs.visibleText || lastVisible;
    lastAria = obs.ariaSnapshot || lastAria;

    for (const c of obs.controls) {
      if (c.safeTier > tier && c.name) skippedBlocked.add(c.name);
    }
    const next = obs.controls.find((c) => c.name && !visited.has(c.name) && isNavigableControl(c, tier));
    if (!next) break;

    visited.add(next.name);
    const t0 = Date.now();
    let status: TrajectoryStep["status"] = "passed";
    try {
      await driver.click(next.name, tier, opts.screenContext);
      draftedSteps.push({ action: "click", target: next.name }, { action: "assert_oracles" });
      const col = await driver.collectOracles(obs.width);
      const report = runAllOracles({
        width: obs.width,
        layout: col.layout,
        consoleEvents: col.consoleEvents,
        networkEvents: col.networkEvents,
        formButtons: col.formButtons,
        visibleText: col.visibleText,
      });
      lastOracle = report;
      oracleReports.push({ width: obs.width, report });
      if (!report.ok) {
        const fail = report.findings.find((f) => f.severity === "fail");
        throw new Error(fail?.message ?? "Oracle failed after exploratory click");
      }
    } catch (e) {
      status = /Blocked before acting/i.test((e as Error).message) ? "blocked" : "failed";
      const cap = await driver.capture(`explore-fail-${i}`).catch(() => ({} as { path?: string }));
      if (cap.path) screenshots.push({ width: obs.width, step: next.name, path: cap.path });
      defects.push({
        journey: `explore-${opts.area}`,
        step: `click "${next.name}"`,
        width: obs.width,
        expected: "Control responds without errors or layout breaks",
        actual: (e as Error).message.split("\n")[0] ?? "failed",
        ...(cap.path ? { screenshot: cap.path } : {}),
      });
    }
    steps.push({ action: "click", target: next.name, status, ms: Date.now() - t0 });
  }

  const slugArea = opts.area.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "screen";
  const proposedJourney: JourneyDsl = {
    id: `journey-explore-${slugArea}`,
    title: `Exploratory coverage: ${opts.area}`,
    tier,
    widths,
    steps: draftedSteps.length ? draftedSteps : [{ action: "assert_oracles" }],
  };
  const trajectory = evaluateTrajectory(steps);
  const evaluation = await evaluateWithRubric(
    {
      journey: proposedJourney.id,
      summary: `Exploratory scan of ${opts.area} (${visited.size} controls visited)`,
      visibleText: lastVisible,
      ariaSnapshot: lastAria,
      oracleReport: lastOracle,
      safetyBlockedCount: trajectory.safetyBlocks,
    },
    opts.complete,
  );

  return {
    area: opts.area,
    telemetryMode: driver.telemetryMode,
    visitedControls: [...visited],
    skippedBlockedControls: [...skippedBlocked],
    steps,
    oracleReports,
    defects,
    screenshots,
    proposedJourney,
    trajectory,
    evaluation,
  };
}
