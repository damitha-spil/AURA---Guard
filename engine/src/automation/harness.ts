// Hermes-inspired QA Harness: automation triggers, execution checkpoints, and Quality Gate.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../agents/registry.ts";
import type { DefectRecord } from "../defects/store.ts";

export type TriggerKind =
  | "schedule"
  | "on_commit"
  | "on_pull_request"
  | "on_test_failure"
  | "on_security_alert"
  | "on_release_candidate";

export type QualityVerdict = "PASS" | "NEEDS_REVIEW" | "BLOCK_RELEASE";

export interface AutomationRule {
  id: string;
  name: string;
  trigger: TriggerKind;
  schedule?: string;
  prompt: string;
  agents: AgentId[];
  enabled: boolean;
  lastRunAt?: string;
  lastVerdict?: QualityVerdict;
}

export interface ExecutionCheckpoint {
  id: string;
  missionId: string;
  stage: "baseline" | "completed";
  summary: string;
  agents: AgentId[];
  defectCount: number;
  verdict?: QualityVerdict;
  createdAt: string;
}

/** Cap stored checkpoints to bound local disk growth. */
export const MAX_CHECKPOINTS = 100;

const DEFAULT_RULES: AutomationRule[] = [
  {
    id: "rule-nightly-regression",
    name: "Nightly Regression QA",
    trigger: "schedule",
    schedule: "0 2 * * *",
    prompt: "@qa @qe run regression check, UIA probe, and 7-day churn hotspot review",
    agents: ["qa", "qe"],
    enabled: true,
  },
  {
    id: "rule-commit-intelligence",
    name: "Commit Risk & Drift Check",
    trigger: "on_commit",
    prompt: "@qe @review analyze latest commit blast radius and vault rule alignment",
    agents: ["qe", "review"],
    enabled: true,
  },
  {
    id: "rule-security-gate",
    name: "Security Release Gate",
    trigger: "on_release_candidate",
    prompt: "@security run local backend safety and adversarial probes",
    agents: ["security"],
    enabled: true,
  },
];

function rulesPath(dataDir: string): string {
  return join(dataDir, "automation-rules.json");
}

function checkpointsPath(dataDir: string): string {
  return join(dataDir, "checkpoints.json");
}

function writeRules(dataDir: string, rules: AutomationRule[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(rulesPath(dataDir), JSON.stringify(rules, null, 2), "utf8");
}

export function listAutomationRules(dataDir: string): AutomationRule[] {
  const file = rulesPath(dataDir);
  if (!existsSync(file)) {
    const seed = DEFAULT_RULES.map((r) => ({ ...r, agents: [...r.agents] }));
    writeRules(dataDir, seed);
    return seed;
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as AutomationRule[]) : [];
  } catch {
    return [];
  }
}

export function upsertAutomationRule(
  dataDir: string,
  input: Partial<AutomationRule> & { name?: string; trigger?: TriggerKind; prompt?: string },
): AutomationRule {
  const rules = listAutomationRules(dataDir);
  const idx = input.id ? rules.findIndex((r) => r.id === input.id) : -1;
  if (idx >= 0) {
    const existing = rules[idx]!;
    const updated: AutomationRule = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule.trim() || undefined } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt.trim() } : {}),
      ...(Array.isArray(input.agents) ? { agents: input.agents } : {}),
      ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
      ...(input.lastRunAt !== undefined ? { lastRunAt: input.lastRunAt } : {}),
      ...(input.lastVerdict !== undefined ? { lastVerdict: input.lastVerdict } : {}),
    };
    rules[idx] = updated;
    writeRules(dataDir, rules);
    return updated;
  }
  const created: AutomationRule = {
    id: input.id || `rule-${randomUUID().slice(0, 8)}`,
    name: (input.name || "Custom QA Trigger").trim().slice(0, 120),
    trigger: input.trigger || "on_commit",
    ...(input.schedule?.trim() ? { schedule: input.schedule.trim() } : {}),
    prompt: (input.prompt || "@qa @review run checks").trim().slice(0, 1000),
    agents: Array.isArray(input.agents) && input.agents.length > 0 ? input.agents : ["qa", "review"],
    enabled: input.enabled ?? true,
  };
  writeRules(dataDir, [created, ...rules]);
  return created;
}

export function deleteAutomationRule(dataDir: string, id: string): boolean {
  const rules = listAutomationRules(dataDir);
  const next = rules.filter((r) => r.id !== id);
  if (next.length === rules.length) return false;
  writeRules(dataDir, next);
  return true;
}

/** Deterministic REO Quality Gate verdict based on defect severities. */
export function evaluateQualityGate(defects: readonly Pick<DefectRecord, "severity">[]): QualityVerdict {
  if (defects.some((d) => d.severity === "critical" || d.severity === "high")) {
    return "BLOCK_RELEASE";
  }
  if (defects.length > 0) {
    return "NEEDS_REVIEW";
  }
  return "PASS";
}

export function listCheckpoints(dataDir: string, limit = 30): ExecutionCheckpoint[] {
  const file = checkpointsPath(dataDir);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as ExecutionCheckpoint[]).slice(0, limit) : [];
  } catch {
    return [];
  }
}

export function recordCheckpoint(
  dataDir: string,
  input: Omit<ExecutionCheckpoint, "id" | "createdAt">,
): ExecutionCheckpoint {
  const cp: ExecutionCheckpoint = {
    ...input,
    id: `cp-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
  };
  const next = [cp, ...listCheckpoints(dataDir, MAX_CHECKPOINTS - 1)];
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(checkpointsPath(dataDir), JSON.stringify(next, null, 2), "utf8");
  return cp;
}
