// Declarative Step DSL & Live Session Controller for AURA QA:
// Replaces arbitrary TypeScript spec generation with a safe, Zod-validated step graph
// interpreted directly by AuraDriver with live pause/step/hint/abort controls.

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { CompleteFn } from "../brain/client.ts";
import type { AuraDriver } from "./driver.ts";
import { ForbiddenActionError } from "./harness.ts";
import { evaluateTrajectory, evaluateWithRubric } from "./judge.ts";
import type { JudgeEvaluation, TrajectoryEvaluation, TrajectoryStep } from "./judge.ts";
import { runAllOracles } from "./oracles.ts";
import type { OracleReport } from "./oracles.ts";

export const DSL_ACTIONS = [
  "resize",
  "click",
  "type",
  "press",
  "wait",
  "assert_text",
  "assert_oracles",
  "capture",
  "judge",
] as const;

export const dslStepSchema = z.object({
  action: z.enum(DSL_ACTIONS),
  target: z.string().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(240).max(2160).optional(),
  ms: z.number().int().min(10).max(15000).optional(),
  label: z.string().optional(),
  expected: z.string().optional(),
  note: z.string().optional(),
});

export const journeyDslSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  tier: z.union([z.literal(0), z.literal(1)]).default(0),
  widths: z.array(z.number().int().min(320).max(3840)).min(1).default([800, 1100, 1440]),
  screenContext: z.string().optional(),
  steps: z.array(dslStepSchema).min(1),
});

export type DslStep = z.infer<typeof dslStepSchema>;
export type JourneyDsl = z.infer<typeof journeyDslSchema>;

export type LiveSessionState = "idle" | "running" | "paused" | "stepping" | "aborted" | "completed";

export interface LiveSessionSnapshot {
  state: LiveSessionState;
  runId: string | null;
  journeyId: string | null;
  currentStepIndex: number;
  totalSteps: number;
  currentWidth: number | null;
  lastStepLabel: string | null;
  hints: string[];
  updatedAt: string;
}

/** Manages live Pause / Resume / Step Over / Inject Hint / Abort controls during a QA run. */
export class LiveSessionController {
  private state: LiveSessionState = "idle";
  private runId: string | null = null;
  private journeyId: string | null = null;
  private currentStepIndex = 0;
  private totalSteps = 0;
  private currentWidth: number | null = null;
  private lastStepLabel: string | null = null;
  private hints: string[] = [];
  private updatedAt = new Date().toISOString();
  private waiters: (() => void)[] = [];
  private stepBudget = 0;

  start(runId: string, journeyId: string, totalSteps: number): void {
    this.state = "running";
    this.runId = runId;
    this.journeyId = journeyId;
    this.currentStepIndex = 0;
    this.totalSteps = totalSteps;
    this.currentWidth = null;
    this.lastStepLabel = null;
    this.stepBudget = 0;
    this.touch();
  }

  pause(): LiveSessionSnapshot {
    if (this.state === "running" || this.state === "stepping") {
      this.state = "paused";
      this.touch();
    }
    return this.getSnapshot();
  }

  resume(): LiveSessionSnapshot {
    if (this.state === "paused" || this.state === "stepping") {
      this.state = "running";
      this.stepBudget = 0;
      this.touch();
      this.wake();
    }
    return this.getSnapshot();
  }

  stepOver(): LiveSessionSnapshot {
    if (this.state === "paused" || this.state === "idle") {
      this.state = "stepping";
      this.stepBudget = 1;
      this.touch();
      this.wake();
    }
    return this.getSnapshot();
  }

  injectHint(text: string): LiveSessionSnapshot {
    const clean = text.trim();
    if (clean) {
      this.hints = [...this.hints.slice(-19), clean];
      this.touch();
    }
    return this.getSnapshot();
  }

  abort(): LiveSessionSnapshot {
    if (this.state !== "completed" && this.state !== "idle") {
      this.state = "aborted";
      this.touch();
      this.wake();
    }
    return this.getSnapshot();
  }

  complete(): LiveSessionSnapshot {
    if (this.state !== "aborted") {
      this.state = "completed";
      this.touch();
    }
    return this.getSnapshot();
  }

  progress(stepIndex: number, width: number | null, label: string): void {
    this.currentStepIndex = stepIndex;
    this.currentWidth = width;
    this.lastStepLabel = label;
    this.touch();
  }

  async waitForGate(): Promise<"continue" | "abort"> {
    while (this.state === "paused" || (this.state === "stepping" && this.stepBudget <= 0)) {
      await new Promise<void>((res) => this.waiters.push(res));
    }
    if (this.state === "aborted") return "abort";
    if (this.state === "stepping" && this.stepBudget > 0) {
      this.stepBudget -= 1;
      if (this.stepBudget === 0) this.state = "paused";
      this.touch();
    }
    return "continue";
  }

  getSnapshot(): LiveSessionSnapshot {
    return {
      state: this.state,
      runId: this.runId,
      journeyId: this.journeyId,
      currentStepIndex: this.currentStepIndex,
      totalSteps: this.totalSteps,
      currentWidth: this.currentWidth,
      lastStepLabel: this.lastStepLabel,
      hints: [...this.hints],
      updatedAt: this.updatedAt,
    };
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }

  private wake(): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const fn of pending) fn();
  }
}

/** Parses raw JSON or a ```qa-steps fenced JSON/YAML block inside a journey markdown note. */
export function parseJourneyDsl(markdownOrJson: string): JourneyDsl {
  const trimmed = markdownOrJson.trim();
  let raw: unknown;
  if (trimmed.startsWith("{")) {
    raw = JSON.parse(trimmed);
  } else {
    const match = /```qa-steps[ \t]*\r?\n([\s\S]*?)\r?\n```/i.exec(markdownOrJson);
    if (!match) {
      throw new Error("No JSON object or ```qa-steps fenced block found in journey specification.");
    }
    const block = match[1]!.trim();
    raw = block.startsWith("{") ? JSON.parse(block) : parseYaml(block);
  }
  return journeyDslSchema.parse(raw);
}

export interface DslDefect {
  journey: string;
  step: string;
  width: number;
  expected: string;
  actual: string;
  screenshot?: string;
}

export interface DslRunEvent {
  type: "step" | "oracle" | "defect" | "hint";
  width: number;
  stepIndex: number;
  message: string;
}

export interface DslRunResult {
  status: "passed" | "failed" | "aborted";
  journeyId: string;
  telemetryMode: string;
  steps: TrajectoryStep[];
  oracleReports: { width: number; stepIndex: number; report: OracleReport }[];
  defects: DslDefect[];
  screenshots: { width: number; step: string; path: string }[];
  trajectory: TrajectoryEvaluation;
  evaluation: JudgeEvaluation;
}

export async function executeJourneyDsl(
  driver: AuraDriver,
  dsl: JourneyDsl,
  opts: {
    runId?: string;
    controller?: LiveSessionController;
    onEvent?: (ev: DslRunEvent) => void;
    complete?: CompleteFn;
    hints?: string[];
  } = {},
): Promise<DslRunResult> {
  const controller = opts.controller;
  const runId = opts.runId ?? `dsl-${Date.now().toString(36)}`;
  const totalCalls = dsl.widths.length * dsl.steps.length;
  controller?.start(runId, dsl.id, totalCalls);
  for (const h of opts.hints ?? []) controller?.injectHint(h);

  const steps: TrajectoryStep[] = [];
  const oracleReports: DslRunResult["oracleReports"] = [];
  const defects: DslDefect[] = [];
  const screenshots: { width: number; step: string; path: string }[] = [];
  let aborted = false;
  let lastVisibleText = "";
  let lastAria = "";
  let lastOracle: OracleReport | undefined;

  let globalIdx = 0;
  for (const width of dsl.widths) {
    await driver.resize(width);
    for (let i = 0; i < dsl.steps.length; i++) {
      const step = dsl.steps[i]!;
      const label = step.label ?? `${step.action}${step.target ? `(${step.target})` : ""}`;
      controller?.progress(++globalIdx, width, label);

      if (controller) {
        const gate = await controller.waitForGate();
        if (gate === "abort") {
          aborted = true;
          break;
        }
      }

      const t0 = Date.now();
      let status: TrajectoryStep["status"] = "passed";
      try {
        if (step.action === "resize") {
          await driver.resize(step.width ?? width, step.height);
        } else if (step.action === "click") {
          await driver.click(step.target ?? "", dsl.tier, dsl.screenContext);
        } else if (step.action === "type") {
          await driver.type(step.target ?? "", step.text ?? "", dsl.tier, dsl.screenContext);
        } else if (step.action === "press") {
          await driver.press(step.key ?? "", step.target, dsl.tier, dsl.screenContext);
        } else if (step.action === "wait") {
          await new Promise((res) => setTimeout(res, step.ms ?? 100));
        } else if (step.action === "assert_text") {
          const obs = await driver.observe();
          lastVisibleText = obs.visibleText;
          lastAria = obs.ariaSnapshot;
          const expected = step.expected ?? step.text ?? "";
          if (expected && !obs.visibleText.toLowerCase().includes(expected.toLowerCase())) {
            throw new Error(`Expected visible text to contain "${expected}".`);
          }
        } else if (step.action === "capture") {
          const cap = await driver.capture(`${dsl.id}-${width}-${step.label ?? i}`);
          if (cap.path) screenshots.push({ width, step: label, path: cap.path });
        } else if (step.action === "judge") {
          const obs = await driver.observe();
          lastVisibleText = obs.visibleText;
          lastAria = obs.ariaSnapshot;
        }

        // Always collect deterministic oracles on assert_oracles or after mutating actions.
        if (step.action === "assert_oracles" || step.action === "click" || step.action === "type" || step.action === "resize") {
          const col = await driver.collectOracles(width);
          lastVisibleText = col.visibleText || lastVisibleText;
          lastAria = col.ariaSnapshot || lastAria;
          const report = runAllOracles({
            width,
            layout: col.layout,
            consoleEvents: col.consoleEvents,
            networkEvents: col.networkEvents,
            formButtons: col.formButtons,
            visibleText: col.visibleText,
          });
          lastOracle = report;
          oracleReports.push({ width, stepIndex: i, report });
          opts.onEvent?.({ type: "oracle", width, stepIndex: i, message: `Oracles: ${report.passed} pass / ${report.failed} fail` });
          if (!report.ok) {
            const firstFail = report.findings.find((f) => f.severity === "fail");
            throw new Error(firstFail?.message ?? "Deterministic oracle check failed.");
          }
        }

        opts.onEvent?.({ type: "step", width, stepIndex: i, message: `${label} passed` });
      } catch (e) {
        const isBlocked = e instanceof ForbiddenActionError;
        status = isBlocked ? "blocked" : "failed";
        const cap = await driver.capture(`fail-${dsl.id}-${width}-${i}`).catch(() => ({} as { path?: string }));
        if (cap.path) screenshots.push({ width, step: label, path: cap.path });
        const actual = (e as Error).message.split("\n")[0] ?? "step failed";
        defects.push({
          journey: dsl.id,
          step: label,
          width,
          expected: step.expected ?? "Step completes without error or oracle failure",
          actual,
          ...(cap.path ? { screenshot: cap.path } : {}),
        });
        opts.onEvent?.({ type: "defect", width, stepIndex: i, message: actual });
      }

      steps.push({
        action: step.action,
        target: step.target ?? label,
        status,
        ms: Date.now() - t0,
      });
    }
    if (aborted) break;
  }

  controller?.complete();
  const trajectory = evaluateTrajectory(steps);
  const evaluation = await evaluateWithRubric(
    {
      journey: dsl.id,
      summary: `${dsl.title} (${driver.telemetryMode})`,
      visibleText: lastVisibleText,
      ariaSnapshot: lastAria,
      oracleReport: lastOracle,
      safetyBlockedCount: trajectory.safetyBlocks,
    },
    opts.complete,
  );

  const status: DslRunResult["status"] = aborted ? "aborted" : defects.length > 0 ? "failed" : "passed";
  return {
    status,
    journeyId: dsl.id,
    telemetryMode: driver.telemetryMode,
    steps,
    oracleReports,
    defects,
    screenshots,
    trajectory,
    evaluation,
  };
}
