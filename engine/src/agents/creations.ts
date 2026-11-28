// SPIL REO — Dynamic Creation of Custom Agents, Composite Tools & Generated Skills.
// All REO-authored assets live strictly inside cfg.dataDir (never mutating external repos or plugin files),
// carry `createdBy: "reo" | "user"`, and are composed deterministically without writing arbitrary code.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { maskOutgoing } from "../mask/mask.ts";
import { maskDeep } from "../qa/safe-out.ts";
import { listSkills } from "../roles/skills.ts";
import { BUILTIN_TOOLS } from "../tools/registry.ts";
import type { ToolRiskTier } from "../tools/registry.ts";
import { executeReoTool } from "../tools/execute.ts";
import type { GuardConfig } from "../types.ts";
import { PREBUILT_AGENTS, isPrebuiltAgentId } from "./registry.ts";
import type { AgentId } from "./registry.ts";
import { loadLearningStore } from "../learning/self-learning.ts";
import { listSkillProposals } from "../automation/observatory_and_evals.ts";

/** Hard cap on total self-created assets per workspace to prevent unbounded growth. */
export const MAX_SELF_CREATED = 20;
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type AssetCreator = "reo" | "user";
export type AssetOrigin = "chat" | "self-learning";
export type AssetStatus = "active" | "disabled";

export interface CustomAgentSpec {
  id: string; // `custom-<slug>`
  name: string;
  role: string;
  description: string;
  baseAgent: AgentId;
  allowedTools: string[];
  defaultSkills: string[];
  riskTier: ToolRiskTier;
  createdBy: AssetCreator;
  origin: AssetOrigin;
  status: AssetStatus;
  enabled: boolean;
  createdAt: string;
  uses: number;
}

export interface CompositeToolStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface CompositeTool {
  id: string; // `reo_<slug>`
  name: string;
  category: "composite";
  description: string;
  steps: CompositeToolStep[];
  riskTier: ToolRiskTier;
  requiresConfirmation: boolean;
  source: "reo-composite";
  createdBy: AssetCreator;
  origin: AssetOrigin;
  status: AssetStatus;
  createdAt: string;
  runs: number;
  failures: number;
}

const EXECUTABLE_TOOL_IDS = new Set([
  "qa_a11y_tree_snapshot",
  "qa_vision_ground_screen",
  "qa_visual_diff",
  "qa_axe_audit",
  "qa_lighthouse_budget",
  "review_ast_grep",
  "qe_dead_code_scan",
  "qe_arch_boundaries",
  "qe_mutation_score",
  "sec_semgrep_scan",
  "sec_gitleaks_history",
  "sec_dependency_cves",
  "sec_nuclei_local",
  "api_schemathesis_fuzz",
  "api_hurl_runner",
  "qa_k6_smoke_load",
]);

function agentsFile(dataDir: string): string {
  return join(dataDir, "custom-agents.json");
}

function toolsFile(dataDir: string): string {
  return join(dataDir, "custom-tools.json");
}

export function generatedSkillsDir(dataDir: string): string {
  return join(dataDir, "generated-skills");
}

function readJsonList<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as T[]) : [];
  } catch {
    return [];
  }
}

function writeJsonList<T>(dataDir: string, file: string, items: T[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(maskDeep(items), null, 2), "utf8");
}

function slugifyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "custom";
}

function titleFromWords(description: string, fallback: string): string {
  const words = description
    .replace(/[^a-z0-9\s-]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 4);
  if (words.length === 0) return fallback;
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

function maxRiskTier(tiers: ToolRiskTier[]): ToolRiskTier {
  if (tiers.includes("external_notify")) return "external_notify";
  if (tiers.includes("local_action")) return "local_action";
  return "read_only";
}

/** Deterministic tool/agent/skill matcher from a plain-English description (no LLM required). */
export function designFromDescription(
  root: string,
  kind: "agent" | "tool" | "skill",
  description: string,
  explicitName?: string,
  extraSkillsDir?: string,
): {
  name: string;
  slug: string;
  baseAgent: AgentId;
  allowedTools: string[];
  defaultSkills: string[];
  steps: CompositeToolStep[];
  riskTier: ToolRiskTier;
} {
  const cleanDesc = description.trim();
  const tokens = cleanDesc.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  const safeTools = BUILTIN_TOOLS.filter((t) => t.riskTier !== "external_notify");

  const scoredTools = safeTools
    .map((t) => {
      const hay = `${t.id} ${t.name} ${t.description} ${t.category}`.toLowerCase();
      let score = tokens.reduce((acc, tok) => acc + (hay.includes(tok) ? 2 : 0), 0);
      if (kind === "tool" && !EXECUTABLE_TOOL_IDS.has(t.id)) score -= 5;
      return { t, score };
    })
    .filter((x) => x.score > 0 && (kind !== "tool" || EXECUTABLE_TOOL_IDS.has(x.t.id)))
    .sort((a, b) => b.score - a.score);

  const pickedTools =
    scoredTools.length > 0
      ? scoredTools.slice(0, kind === "tool" ? 4 : 6).map((x) => x.t)
      : safeTools.filter((t) => ["review_ast_grep", "qe_arch_boundaries", "sec_semgrep_scan"].includes(t.id));

  const pickedIds = pickedTools.map((t) => t.id);

  // Pick best matching prebuilt baseAgent
  let baseAgent: AgentId = "qe";
  let bestOverlap = -1;
  for (const ag of PREBUILT_AGENTS) {
    const overlap = pickedIds.filter((id) => ag.allowedTools.includes(id)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      baseAgent = ag.id;
    }
  }

  const allSkills = listSkills(root, undefined, extraSkillsDir);
  const pickedSkills = allSkills
    .map((s) => {
      const hay = `${s.name} ${s.description}`.toLowerCase();
      return { name: s.name, score: tokens.reduce((acc, tok) => acc + (hay.includes(tok) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.name);

  const name = explicitName?.trim() || titleFromWords(cleanDesc, `REO ${kind}`);
  const slug = slugifyName(name);
  const riskTier = maxRiskTier(pickedTools.map((t) => t.riskTier));
  const steps = pickedIds
    .filter((id) => EXECUTABLE_TOOL_IDS.has(id))
    .slice(0, 4)
    .map((tool) => ({ tool, args: {} as Record<string, unknown> }));

  return {
    name,
    slug,
    baseAgent,
    allowedTools: pickedIds,
    defaultSkills: pickedSkills,
    steps: steps.length ? steps : [{ tool: "review_ast_grep", args: {} }],
    riskTier,
  };
}

export function listCustomAgents(dataDir: string): CustomAgentSpec[] {
  return readJsonList<CustomAgentSpec>(agentsFile(dataDir));
}

export function createCustomAgent(
  dataDir: string,
  root: string,
  input: {
    description: string;
    name?: string;
    role?: string;
    baseAgent?: AgentId;
    allowedTools?: string[];
    defaultSkills?: string[];
    createdBy?: AssetCreator;
    origin?: AssetOrigin;
  },
): CustomAgentSpec {
  const masked = maskOutgoing(input.description.trim());
  if (!masked.ok) throw new Error("Agent description blocked by secret masking gate.");
  const extraDir = generatedSkillsDir(dataDir);
  const design = designFromDescription(root, "agent", masked.text, input.name, extraDir);
  const baseAgent: AgentId = input.baseAgent && isPrebuiltAgentId(input.baseAgent) ? input.baseAgent : design.baseAgent;

  const allowedSet = new Set(BUILTIN_TOOLS.filter((t) => t.riskTier !== "external_notify").map((t) => t.id));
  const allowedTools = (input.allowedTools?.length ? input.allowedTools : design.allowedTools).filter((id) => allowedSet.has(id));
  const tiers = allowedTools
    .map((id) => BUILTIN_TOOLS.find((t) => t.id === id)?.riskTier)
    .filter((t): t is ToolRiskTier => Boolean(t));

  const existing = listCustomAgents(dataDir);
  let id = `custom-${design.slug}`;
  if (existing.some((a) => a.id === id)) {
    id = `custom-${design.slug.slice(0, 32)}-${Date.now().toString(36).slice(-4)}`;
  }

  const spec: CustomAgentSpec = maskDeep({
    id,
    name: design.name,
    role: input.role?.trim() || "REO Specialist Agent",
    description: masked.text.slice(0, 400),
    baseAgent,
    allowedTools: allowedTools.length ? allowedTools : design.allowedTools,
    defaultSkills: input.defaultSkills?.length ? input.defaultSkills : design.defaultSkills,
    riskTier: tiers.length ? maxRiskTier(tiers) : design.riskTier,
    createdBy: input.createdBy ?? "reo",
    origin: input.origin ?? "chat",
    status: "active",
    enabled: true,
    createdAt: new Date().toISOString(),
    uses: 0,
  });

  writeJsonList(dataDir, agentsFile(dataDir), [spec, ...existing]);
  return spec;
}

export function updateCustomAgentStatus(dataDir: string, id: string, status: AssetStatus): CustomAgentSpec | null {
  const all = listCustomAgents(dataDir);
  const idx = all.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  all[idx] = { ...all[idx]!, status, enabled: status === "active" };
  writeJsonList(dataDir, agentsFile(dataDir), all);
  return all[idx]!;
}

export function deleteCustomAgent(dataDir: string, id: string): boolean {
  const all = listCustomAgents(dataDir);
  const next = all.filter((a) => a.id !== id);
  if (next.length === all.length) return false;
  writeJsonList(dataDir, agentsFile(dataDir), next);
  return true;
}

export function listCompositeTools(dataDir: string): CompositeTool[] {
  return readJsonList<CompositeTool>(toolsFile(dataDir));
}

export function createCompositeTool(
  dataDir: string,
  root: string,
  input: {
    description: string;
    name?: string;
    steps?: CompositeToolStep[];
    createdBy?: AssetCreator;
    origin?: AssetOrigin;
  },
): CompositeTool {
  const masked = maskOutgoing(input.description.trim());
  if (!masked.ok) throw new Error("Tool description blocked by secret masking gate.");
  const design = designFromDescription(root, "tool", masked.text, input.name);

  const steps = (input.steps?.length ? input.steps : design.steps).filter((s) => EXECUTABLE_TOOL_IDS.has(s.tool));
  if (steps.length === 0) throw new Error("Composite tool requires at least one safe executable built-in tool.");

  const tiers = steps
    .map((s) => BUILTIN_TOOLS.find((t) => t.id === s.tool)?.riskTier)
    .filter((t): t is ToolRiskTier => Boolean(t));
  if (tiers.includes("external_notify")) {
    throw new Error("External notification tools cannot be included in composite tools.");
  }

  const existing = listCompositeTools(dataDir);
  const baseSlug = design.slug.replace(/-/g, "_");
  let id = `reo_${baseSlug}`;
  if (existing.some((t) => t.id === id)) {
    id = `reo_${baseSlug.slice(0, 28)}_${Date.now().toString(36).slice(-4)}`;
  }

  const tool: CompositeTool = maskDeep({
    id,
    name: design.name,
    category: "composite",
    description: masked.text.slice(0, 400),
    steps,
    riskTier: tiers.length ? maxRiskTier(tiers) : "read_only",
    requiresConfirmation: false,
    source: "reo-composite",
    createdBy: input.createdBy ?? "reo",
    origin: input.origin ?? "chat",
    status: "active",
    createdAt: new Date().toISOString(),
    runs: 0,
    failures: 0,
  });

  writeJsonList(dataDir, toolsFile(dataDir), [tool, ...existing]);
  return tool;
}

export function updateCompositeToolStatus(dataDir: string, id: string, status: AssetStatus): CompositeTool | null {
  const all = listCompositeTools(dataDir);
  const idx = all.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  all[idx] = { ...all[idx]!, status };
  writeJsonList(dataDir, toolsFile(dataDir), all);
  return all[idx]!;
}

export function deleteCompositeTool(dataDir: string, id: string): boolean {
  const all = listCompositeTools(dataDir);
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) return false;
  writeJsonList(dataDir, toolsFile(dataDir), next);
  return true;
}

function resolveTemplateArgs(template: Record<string, unknown>, runtimeArgs: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...template };
  for (const [k, v] of Object.entries(template)) {
    if (typeof v === "string") {
      merged[k] = v.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) =>
        runtimeArgs[key] !== undefined ? String(runtimeArgs[key]) : "",
      );
    }
  }
  for (const [k, v] of Object.entries(runtimeArgs)) {
    if (!(k in merged) && v !== undefined) merged[k] = v;
  }
  return merged;
}

/** Run an active REO-created composite tool pipeline step-by-step and record telemetry. */
export async function runCompositeTool(
  cfg: GuardConfig,
  id: string,
  args: Record<string, unknown> = {},
): Promise<{ id: string; status: "ok" | "error"; steps: Array<{ tool: string; result: unknown }> }> {
  const all = listCompositeTools(cfg.dataDir);
  const tool = all.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown composite tool: ${id}`);
  if (tool.status === "disabled") throw new Error(`Composite tool "${id}" is disabled.`);

  const outputs: Array<{ tool: string; result: unknown }> = [];
  let failed = false;
  try {
    for (const step of tool.steps) {
      if (!EXECUTABLE_TOOL_IDS.has(step.tool)) {
        throw new Error(`Disallowed step tool in composite: ${step.tool}`);
      }
      const stepArgs = resolveTemplateArgs(step.args, args);
      const res = await executeReoTool(cfg, step.tool, stepArgs);
      outputs.push({ tool: step.tool, result: res });
    }
    return maskDeep({ id: tool.id, status: "ok", steps: outputs });
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    const fresh = listCompositeTools(cfg.dataDir);
    const idx = fresh.findIndex((t) => t.id === id);
    if (idx >= 0) {
      fresh[idx]!.runs += 1;
      if (failed) fresh[idx]!.failures += 1;
      writeJsonList(cfg.dataDir, toolsFile(cfg.dataDir), fresh);
    }
  }
}

/** Create a REO-generated skill playbook in cfg.dataDir/generated-skills/<name>/SKILL.md. */
export function createGeneratedSkill(
  dataDir: string,
  root: string,
  input: { name: string; description: string; body: string; origin?: AssetOrigin },
): { name: string; file: string; createdBy: "reo"; origin: AssetOrigin } {
  const cleanName = input.name.trim().toLowerCase();
  if (!SAFE_SKILL_NAME.test(cleanName)) {
    throw new Error(`Invalid skill name "${input.name}". Must match /^[a-z0-9][a-z0-9-]{0,63}$/.`);
  }
  const existingPlugin = listSkills(root).find((s) => s.name === cleanName);
  if (existingPlugin) {
    throw new Error(`Skill "${cleanName}" already exists in plugin skills.`);
  }
  const maskedDesc = maskOutgoing(input.description.trim());
  const maskedBody = maskOutgoing(input.body.trim());
  if (!maskedDesc.ok || !maskedBody.ok) {
    throw new Error("Generated skill blocked by secret masking gate.");
  }

  const base = resolve(generatedSkillsDir(dataDir));
  const folder = resolve(join(base, cleanName));
  if (!folder.startsWith(base + sep)) {
    throw new Error("Invalid skill directory path.");
  }
  mkdirSync(folder, { recursive: true });
  const origin: AssetOrigin = input.origin ?? "chat";
  const fm = stringifyYaml({
    name: cleanName,
    description: maskedDesc.text.slice(0, 300),
    created_by: "reo",
    origin,
  }).trimEnd();
  const content = `---\n${fm}\n---\n\n${maskedBody.text}\n`;
  const file = join(folder, "SKILL.md");
  writeFileSync(file, content, "utf8");
  return { name: cleanName, file, createdBy: "reo", origin };
}

export function deleteGeneratedSkill(dataDir: string, name: string): boolean {
  if (!SAFE_SKILL_NAME.test(name)) return false;
  const base = resolve(generatedSkillsDir(dataDir));
  const folder = resolve(join(base, name));
  if (!folder.startsWith(base + sep) || !existsSync(folder)) return false;
  rmSync(folder, { recursive: true, force: true });
  return true;
}

/**
 * Autonomous self-creation loop (called at end of mission):
 * Creates at most 1 composite tool, custom agent, or generated skill per mission, capped at MAX_SELF_CREATED.
 */
export function maybeSelfCreate(
  cfg: GuardConfig,
  missionSummary: { agents: string[]; tools: string[] },
): { kind: "tool" | "agent" | "skill"; id: string; name: string } | null {
  const totalCreated =
    listCustomAgents(cfg.dataDir).filter((a) => a.origin === "self-learning").length +
    listCompositeTools(cfg.dataDir).filter((t) => t.origin === "self-learning").length +
    listSkills(cfg.root, undefined, generatedSkillsDir(cfg.dataDir)).filter((s) => s.origin === "self-learning").length;

  if (totalCreated >= MAX_SELF_CREATED) return null;

  const learning = loadLearningStore(cfg.dataDir);
  const existingTools = listCompositeTools(cfg.dataDir);
  const existingAgents = listCustomAgents(cfg.dataDir);
  const extraSkills = generatedSkillsDir(cfg.dataDir);

  // 1. Repeated multi-tool pattern (>=3 successful runs) -> auto composite tool
  for (const pat of learning.patterns) {
    if (pat.count < 3 || pat.lastVerdict === "BLOCK_RELEASE") continue;
    const validSteps = pat.tools.filter((id) => EXECUTABLE_TOOL_IDS.has(id)).sort();
    if (validSteps.length < 2) continue;
    const sig = validSteps.join(",");
    const dup = existingTools.some((t) => t.steps.map((s) => s.tool).sort().join(",") === sig);
    if (dup) continue;
    const label = pat.key.split("::")[0]?.replace(/\+/g, " ") || "workflow";
    const tool = createCompositeTool(cfg.dataDir, cfg.root, {
      name: `REO ${titleFromWords(label, "Pipeline")} Suite`,
      description: `Auto-composed pipeline for "${label}" (${validSteps.join(" -> ")}).`,
      steps: validSteps.map((toolId) => ({ tool: toolId, args: {} })),
      createdBy: "reo",
      origin: "self-learning",
    });
    return { kind: "tool", id: tool.id, name: tool.name };
  }

  // 2. Repeated co-occurring multi-agent cluster (>=3 times) -> combined custom agent
  for (const pat of learning.patterns) {
    if (pat.count < 3 || pat.agents.length < 2) continue;
    const sortedAgents = [...new Set(pat.agents)].filter((a) => isPrebuiltAgentId(a)).sort();
    if (sortedAgents.length < 2) continue;
    const unionTools = [
      ...new Set(
        sortedAgents.flatMap((id) => PREBUILT_AGENTS.find((a) => a.id === id)?.allowedTools ?? []),
      ),
    ]
      .filter((tid) => BUILTIN_TOOLS.find((t) => t.id === tid)?.riskTier !== "external_notify")
      .slice(0, 8);
    const sig = [...unionTools].sort().join(",");
    const dup = existingAgents.some((a) => [...a.allowedTools].sort().join(",") === sig);
    if (dup) continue;
    const label = pat.key.split("::")[0]?.replace(/\+/g, " ") || sortedAgents.join(" ");
    const ag = createCustomAgent(cfg.dataDir, cfg.root, {
      name: `${titleFromWords(label, "Swarm")} Specialist`,
      role: `Auto-merged ${sortedAgents.join(" + ")}`,
      description: `Self-created specialist combining ${sortedAgents.join(" and ")} for recurring "${label}" workflows.`,
      baseAgent: sortedAgents[0]!,
      allowedTools: unionTools,
      createdBy: "reo",
      origin: "self-learning",
    });
    return { kind: "agent", id: ag.id, name: ag.name };
  }

  // 3. Approved SkillProposal without generated skill -> create generated skill
  const allSkills = new Set(listSkills(cfg.root, undefined, extraSkills).map((s) => s.name));
  const approved = listSkillProposals(cfg.dataDir, "approved");
  for (const p of approved) {
    const candidateName = `qe-${slugifyName(p.targetName || p.title)}`.slice(0, 50);
    if (allSkills.has(candidateName)) continue;
    const sk = createGeneratedSkill(cfg.dataDir, cfg.root, {
      name: candidateName,
      description: p.title,
      body: `# ${p.title}\n\n${p.rationale}\n\n## Playbook Steps\n\n${p.proposedPatchMarkdown}`,
      origin: "self-learning",
    });
    return { kind: "skill", id: sk.name, name: sk.name };
  }

  void missionSummary;
  return null;
}
