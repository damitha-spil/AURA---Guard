// Unified dispatcher for executing SPIL REO's Wave 1-3 QA, QE, Security, Visual, A11y, and API tools.

import type { GuardConfig } from "../types.ts";
import { apiHurlRunner, apiSchemathesisFuzz, qaK6SmokeLoad } from "../qa/api_and_load.ts";
import { secDependencyCves, secGitleaksHistory, secNucleiLocal, secSemgrepScan } from "../qa/devsecops_suite.ts";
import { qaA11yTreeSnapshot, qaAxeAudit, qaLighthouseBudget, qaVisionGroundScreen, qaVisualDiff } from "../qa/visual_and_a11y.ts";
import { qeArchBoundaries, qeDeadCodeScan, qeMutationScore, reviewAstGrep } from "../qe/tier0_suite.ts";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

export async function executeReoTool(
  cfg: GuardConfig,
  toolId: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  switch (toolId) {
    case "qa_a11y_tree_snapshot":
      return qaA11yTreeSnapshot(cfg, {
        ...(str(args["url"]) ? { url: str(args["url"]) } : {}),
        ...(typeof args["html"] === "string" ? { html: args["html"] } : {}),
      });
    case "qa_vision_ground_screen":
      return qaVisionGroundScreen(cfg, {
        ...(str(args["imagePath"]) ? { imagePath: str(args["imagePath"]) } : {}),
        ...(typeof args["html"] === "string" ? { html: args["html"] } : {}),
        ...(str(args["windowTitle"]) ? { windowTitle: str(args["windowTitle"]) } : {}),
      });
    case "qa_visual_diff":
      return qaVisualDiff(cfg, {
        baselinePath: str(args["baselinePath"]) ?? "",
        currentPath: str(args["currentPath"]) ?? "",
        ...(num(args["thresholdPct"]) !== undefined ? { thresholdPct: num(args["thresholdPct"]) } : {}),
      });
    case "qa_axe_audit":
      return qaAxeAudit(cfg, {
        ...(str(args["url"]) ? { url: str(args["url"]) } : {}),
        ...(typeof args["html"] === "string" ? { html: args["html"] } : {}),
        ...(bool(args["recordDefects"]) !== undefined ? { recordDefects: bool(args["recordDefects"]) } : {}),
      });
    case "qa_lighthouse_budget":
      return qaLighthouseBudget(cfg, {
        url: str(args["url"]) ?? "",
        ...(num(args["maxTtfbMs"]) !== undefined ? { maxTtfbMs: num(args["maxTtfbMs"]) } : {}),
        ...(num(args["maxHtmlKb"]) !== undefined ? { maxHtmlKb: num(args["maxHtmlKb"]) } : {}),
      });
    case "review_ast_grep":
      return reviewAstGrep(cfg, {
        ...(str(args["repo"]) ? { repo: str(args["repo"]) } : {}),
        ...(str(args["targetDir"]) ? { targetDir: str(args["targetDir"]) } : {}),
        ...(str(args["pattern"]) ? { pattern: str(args["pattern"]) } : {}),
      });
    case "qe_dead_code_scan":
      return qeDeadCodeScan(cfg, {
        ...(str(args["repo"]) ? { repo: str(args["repo"]) } : {}),
        ...(str(args["targetDir"]) ? { targetDir: str(args["targetDir"]) } : {}),
      });
    case "qe_arch_boundaries":
      return qeArchBoundaries(cfg, {
        ...(str(args["repo"]) ? { repo: str(args["repo"]) } : {}),
        ...(str(args["targetDir"]) ? { targetDir: str(args["targetDir"]) } : {}),
      });
    case "qe_mutation_score":
      return qeMutationScore(cfg, {
        ...(str(args["repo"]) ? { repo: str(args["repo"]) } : {}),
        ...(str(args["targetDir"]) ? { targetDir: str(args["targetDir"]) } : {}),
        ...(Array.isArray(args["files"]) ? { files: args["files"].map(String) } : {}),
      });
    case "sec_semgrep_scan":
      return secSemgrepScan(cfg, {
        ...(str(args["repo"]) ? { repo: str(args["repo"]) } : {}),
        ...(str(args["targetDir"]) ? { targetDir: str(args["targetDir"]) } : {}),
        ...(typeof args["sarifJson"] === "string" ? { sarifJson: args["sarifJson"] } : {}),
        ...(bool(args["recordDefects"]) !== undefined ? { recordDefects: bool(args["recordDefects"]) } : {}),
      });
    case "sec_gitleaks_history":
      return secGitleaksHistory(cfg, {
        ...(str(args["repo"]) ? { repo: str(args["repo"]) } : {}),
        ...(str(args["targetDir"]) ? { targetDir: str(args["targetDir"]) } : {}),
        ...(num(args["maxCommits"]) !== undefined ? { maxCommits: num(args["maxCommits"]) } : {}),
      });
    case "sec_dependency_cves":
      return secDependencyCves(cfg, {
        ...(str(args["repo"]) ? { repo: str(args["repo"]) } : {}),
        ...(str(args["targetDir"]) ? { targetDir: str(args["targetDir"]) } : {}),
        ...(bool(args["recordDefects"]) !== undefined ? { recordDefects: bool(args["recordDefects"]) } : {}),
      });
    case "sec_nuclei_local":
      return secNucleiLocal(cfg, {
        baseUrl: str(args["baseUrl"]) ?? "",
      });
    case "api_schemathesis_fuzz":
      return apiSchemathesisFuzz(cfg, {
        baseUrl: str(args["baseUrl"]) ?? "",
        specText: typeof args["specText"] === "string" ? args["specText"] : "",
        ...(num(args["maxExamples"]) !== undefined ? { maxExamples: num(args["maxExamples"]) } : {}),
      });
    case "api_hurl_runner":
      return apiHurlRunner(cfg, {
        ...(str(args["baseUrl"]) ? { baseUrl: str(args["baseUrl"]) } : {}),
        hurlText: typeof args["hurlText"] === "string" ? args["hurlText"] : "",
      });
    case "qa_k6_smoke_load":
      return qaK6SmokeLoad(cfg, {
        url: str(args["url"]) ?? "",
        ...(num(args["vus"]) !== undefined ? { vus: num(args["vus"]) } : {}),
        ...(num(args["durationSeconds"]) !== undefined ? { durationSeconds: num(args["durationSeconds"]) } : {}),
        ...(num(args["p95BudgetMs"]) !== undefined ? { p95BudgetMs: num(args["p95BudgetMs"]) } : {}),
      });
    default:
      if (toolId.startsWith("reo_")) {
        const { runCompositeTool } = await import("../agents/creations.ts");
        return runCompositeTool(cfg, toolId, args);
      }
      throw new Error(`Unsupported or unknown Wave 1-3 tool: ${toolId}`);
  }
}
