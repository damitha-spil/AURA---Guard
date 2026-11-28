// Wave 2 Deterministic Tier 0 Quality Engineering Suite (Zero Token Cost):
// 1. review_ast_grep (ast-grep / structural Vault AST rule checks)
// 2. qe_dead_code_scan (knip / unused exports, orphan files & unused npm deps)
// 3. qe_arch_boundaries (dependency-cruiser / layer boundary & cycle detection)
// 4. qe_mutation_score (stryker / scoped mutation site & test adequacy scorer)
// All operations are strictly read-only on configured repos and masked via maskDeep.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { maskDeep } from "../qa/safe-out.ts";
import { isTestPath } from "../review/tier0.ts";
import type { GuardConfig } from "../types.ts";
import { resolveTargetRepo, runOptionalCli, walkRepoSourceFiles } from "../util/cli-runner.ts";
import { analyzeCommitTrajectory } from "./trajectory.ts";

/** Maximum source files read in Tier 0 repo scans to bound memory and runtime. */
export const TIER0_MAX_SCAN_FILES = 350;
/** Maximum findings returned per Tier 0 check. */
export const TIER0_MAX_FINDINGS = 80;

export interface AstGrepFinding {
  ruleId: string;
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  snippet: string;
  message: string;
}

export interface AstGrepReport {
  generatedAt: string;
  engine: "ast-grep-cli" | "builtin-structural";
  repo: string;
  filesScanned: number;
  findings: AstGrepFinding[];
}

export interface DeadCodeReport {
  generatedAt: string;
  engine: "knip-cli" | "builtin-graph";
  repo: string;
  filesScanned: number;
  unusedDependencies: string[];
  unusedExports: { file: string; symbol: string; line: number }[];
  unusedFiles: string[];
}

export interface ArchBoundariesReport {
  generatedAt: string;
  engine: "dependency-cruiser-cli" | "builtin-boundaries";
  repo: string;
  modulesAnalyzed: number;
  ok: boolean;
  boundaryViolations: { from: string; to: string; rule: string }[];
  circularDependencies: string[][];
}

export interface MutationScoreReport {
  generatedAt: string;
  engine: "stryker-cli" | "builtin-mutator";
  repo: string;
  filesAnalyzed: number;
  totalMutantSites: number;
  coveredSites: number;
  mutationScorePct: number;
  survivingRiskSites: { file: string; line: number; operator: string; snippet: string }[];
}

const BUILTIN_AST_RULES: readonly {
  id: string;
  severity: AstGrepFinding["severity"];
  exts?: string[];
  re: RegExp;
  message: string;
}[] = [
  {
    id: "no-eval-or-new-function",
    severity: "high",
    re: /\b(?:eval\s*\(|new\s+Function\s*\()/,
    message: "Dynamic code evaluation (eval / new Function) breaks static analysis and invites injection.",
  },
  {
    id: "no-shell-exec-string",
    severity: "critical",
    re: /\bexec(?:Sync)?\s*\(\s*`[^`]*\$\{|shell\s*:\s*true\b/,
    message: "Shell execution with interpolation or shell:true; use execFile/spawn with an argument array.",
  },
  {
    id: "no-dangerously-set-html",
    severity: "high",
    exts: [".tsx", ".jsx", ".ts", ".js"],
    re: /\bdangerouslySetInnerHTML\b/,
    message: "dangerouslySetInnerHTML bypasses React XSS escaping; sanitize or render structured nodes.",
  },
  {
    id: "button-explicit-type",
    severity: "low",
    exts: [".tsx", ".jsx"],
    re: /<button\b(?![^>]*\btype\s*=)[^>]*>/,
    message: "<button> should declare type=\"button\" or type=\"submit\" to avoid unintended form submissions.",
  },
  {
    id: "no-console-secret-log",
    severity: "medium",
    re: /\bconsole\.(?:log|info|debug)\s*\([^)]*\b(?:apiKey|api_key|secret|password|passwd|authToken|token)\b/i,
    message: "Potential credential identifier passed to console logging; mask or omit sensitive fields.",
  },
];

/** 1. ast-grep structural rule scanner with Vault safety patterns. */
export async function reviewAstGrep(
  cfg: GuardConfig,
  opts: { repo?: string; targetDir?: string; pattern?: string } = {},
): Promise<AstGrepReport> {
  const target = resolveTargetRepo(cfg, opts.repo, opts.targetDir);
  if (!target) {
    return maskDeep({ generatedAt: new Date().toISOString(), engine: "builtin-structural", repo: "none", filesScanned: 0, findings: [] });
  }

  let engine: AstGrepReport["engine"] = "builtin-structural";
  const findings: AstGrepFinding[] = [];

  if (opts.pattern?.trim()) {
    const cli = await runOptionalCli("sg", ["run", "--pattern", opts.pattern.trim(), "--json", target.path], { timeoutMs: 12_000 });
    if (cli.available && cli.stdout.trim()) {
      try {
        const parsed = JSON.parse(cli.stdout) as Array<{ file?: string; text?: string; range?: { start?: { line?: number } } }>;
        if (Array.isArray(parsed)) {
          engine = "ast-grep-cli";
          for (const hit of parsed.slice(0, TIER0_MAX_FINDINGS)) {
            findings.push({
              ruleId: "custom-ast-grep",
              severity: "medium",
              file: relative(target.path, hit.file ?? "").replace(/\\/g, "/") || String(hit.file ?? ""),
              line: (hit.range?.start?.line ?? 0) + 1,
              snippet: String(hit.text ?? "").slice(0, 120),
              message: `Matched custom ast-grep pattern: ${opts.pattern.trim()}`,
            });
          }
        }
      } catch {
        /* fallback cleanly to built-in scanner */
      }
    }
  }

  const files = walkRepoSourceFiles(target.path, {
    maxFiles: TIER0_MAX_SCAN_FILES,
    exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".rs", ".py"],
  });

  if (engine === "builtin-structural") {
    const customPattern = opts.pattern?.trim() || "";
    for (const rel of files) {
      if (findings.length >= TIER0_MAX_FINDINGS || isTestPath(rel)) continue;
      let raw = "";
      try {
        raw = readFileSync(join(target.path, rel), "utf8");
      } catch {
        continue;
      }
      const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
      const lines = raw.split(/\r?\n/);
      for (let i = 0; i < lines.length && findings.length < TIER0_MAX_FINDINGS; i++) {
        const line = lines[i] ?? "";
        if (customPattern && line.includes(customPattern)) {
          findings.push({
            ruleId: "custom-pattern",
            severity: "medium",
            file: rel,
            line: i + 1,
            snippet: line.trim().slice(0, 120),
            message: `Matched structural pattern "${customPattern}".`,
          });
        }
        for (const rule of BUILTIN_AST_RULES) {
          if (rule.exts && !rule.exts.includes(ext)) continue;
          if (rule.re.test(line)) {
            findings.push({
              ruleId: rule.id,
              severity: rule.severity,
              file: rel,
              line: i + 1,
              snippet: line.trim().slice(0, 120),
              message: rule.message,
            });
          }
        }
      }
    }
  }

  return maskDeep({
    generatedAt: new Date().toISOString(),
    engine,
    repo: target.id,
    filesScanned: files.length,
    findings,
  });
}

function readPackageDeps(dir: string): string[] {
  const deps = new Set<string>();
  for (const relPkg of ["package.json", "engine/package.json", "web/package.json"]) {
    const full = join(dir, relPkg);
    if (!existsSync(full)) continue;
    try {
      const parsed = JSON.parse(readFileSync(full, "utf8")) as { dependencies?: Record<string, unknown> };
      for (const k of Object.keys(parsed.dependencies ?? {})) {
        if (!k.startsWith("@types/")) deps.add(k);
      }
    } catch {
      /* ignore malformed package.json */
    }
  }
  return [...deps];
}

function resolveImportPath(fromRel: string, spec: string, knownSet: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const baseDir = dirname(fromRel);
  const rawJoined = join(baseDir, spec).replace(/\\/g, "/");
  const candidates = [
    rawJoined,
    `${rawJoined}.ts`,
    `${rawJoined}.tsx`,
    `${rawJoined}.js`,
    `${rawJoined}/index.ts`,
    `${rawJoined}/index.tsx`,
  ];
  for (const c of candidates) {
    if (knownSet.has(c)) return c;
  }
  return null;
}

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|require\(["']([^"']+)["']\)/g;

/** 2. knip-style dead code, orphan module, and unused dependency scanner. */
export async function qeDeadCodeScan(
  cfg: GuardConfig,
  opts: { repo?: string; targetDir?: string } = {},
): Promise<DeadCodeReport> {
  const target = resolveTargetRepo(cfg, opts.repo, opts.targetDir);
  if (!target) {
    return maskDeep({
      generatedAt: new Date().toISOString(),
      engine: "builtin-graph",
      repo: "none",
      filesScanned: 0,
      unusedDependencies: [],
      unusedExports: [],
      unusedFiles: [],
    });
  }

  const cli = await runOptionalCli("knip", ["--reporter", "json"], { cwd: target.path, timeoutMs: 12_000 });
  if (cli.available && cli.stdout.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(cli.stdout) as { files?: string[]; dependencies?: string[]; exports?: unknown[] };
      return maskDeep({
        generatedAt: new Date().toISOString(),
        engine: "knip-cli",
        repo: target.id,
        filesScanned: 0,
        unusedDependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies.slice(0, 50) : [],
        unusedExports: [],
        unusedFiles: Array.isArray(parsed.files) ? parsed.files.slice(0, 50) : [],
      });
    } catch {
      /* fallback cleanly */
    }
  }

  const files = walkRepoSourceFiles(target.path, {
    maxFiles: TIER0_MAX_SCAN_FILES,
    exts: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
  });
  const fileSet = new Set(files);
  const contents = new Map<string, string>();
  const importedFiles = new Set<string>();
  const externalPackagesUsed = new Set<string>();

  for (const rel of files) {
    let raw = "";
    try {
      raw = readFileSync(join(target.path, rel), "utf8");
    } catch {
      continue;
    }
    contents.set(rel, raw);
    for (const m of raw.matchAll(IMPORT_RE)) {
      const spec = (m[1] || m[2] || "").trim();
      if (!spec) continue;
      if (spec.startsWith(".")) {
        const hit = resolveImportPath(rel, spec, fileSet);
        if (hit) importedFiles.add(hit);
      } else {
        const parts = spec.split("/");
        const pkg = spec.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : (parts[0] ?? "");
        if (pkg) externalPackagesUsed.add(pkg);
      }
    }
  }

  const declaredDeps = readPackageDeps(target.path);
  const unusedDependencies = declaredDeps.filter((dep) => {
    if (externalPackagesUsed.has(dep)) return false;
    // Check config files or tailwind plugins referenced by string
    for (const text of contents.values()) {
      if (text.includes(dep)) return false;
    }
    return true;
  }).slice(0, 30);

  const exportDeclRe = /^export\s+(?:async\s+)?(?:function|const|class|type|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const unusedExports: DeadCodeReport["unusedExports"] = [];
  const unusedFiles: string[] = [];

  for (const rel of files) {
    if (isTestPath(rel) || /(?:^|\/)(?:index|main|cli|server|App|vite\.config)\.[tj]sx?$/i.test(rel)) continue;
    if (!importedFiles.has(rel)) {
      unusedFiles.push(rel);
    }
    const raw = contents.get(rel) ?? "";
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length && unusedExports.length < 40; i++) {
      const m = exportDeclRe.exec(lines[i] ?? "");
      const sym = m?.[1];
      if (!sym) continue;
      let referencedElsewhere = false;
      const symRe = new RegExp(`\\b${sym}\\b`);
      for (const [otherRel, otherText] of contents.entries()) {
        if (otherRel === rel) continue;
        if (symRe.test(otherText)) {
          referencedElsewhere = true;
          break;
        }
      }
      if (!referencedElsewhere) {
        unusedExports.push({ file: rel, symbol: sym, line: i + 1 });
      }
    }
  }

  return maskDeep({
    generatedAt: new Date().toISOString(),
    engine: "builtin-graph",
    repo: target.id,
    filesScanned: files.length,
    unusedDependencies,
    unusedExports,
    unusedFiles: unusedFiles.slice(0, 40),
  });
}

/** 3. dependency-cruiser style architectural boundary & circular import checker. */
export async function qeArchBoundaries(
  cfg: GuardConfig,
  opts: { repo?: string; targetDir?: string } = {},
): Promise<ArchBoundariesReport> {
  const target = resolveTargetRepo(cfg, opts.repo, opts.targetDir);
  if (!target) {
    return maskDeep({
      generatedAt: new Date().toISOString(),
      engine: "builtin-boundaries",
      repo: "none",
      modulesAnalyzed: 0,
      ok: true,
      boundaryViolations: [],
      circularDependencies: [],
    });
  }

  const files = walkRepoSourceFiles(target.path, {
    maxFiles: TIER0_MAX_SCAN_FILES,
    exts: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
  });
  const fileSet = new Set(files);
  const graph = new Map<string, string[]>();
  const boundaryViolations: ArchBoundariesReport["boundaryViolations"] = [];

  for (const rel of files) {
    let raw = "";
    try {
      raw = readFileSync(join(target.path, rel), "utf8");
    } catch {
      continue;
    }
    const edges: string[] = [];
    for (const m of raw.matchAll(IMPORT_RE)) {
      const spec = (m[1] || m[2] || "").trim();
      if (!spec) continue;
      if (rel.startsWith("web/src/") && /^(?:node:|better-sqlite3|playwright|@modelcontextprotocol\/sdk)/.test(spec)) {
        boundaryViolations.push({ from: rel, to: spec, rule: "ui-must-not-import-node-or-db-internals" });
      }
      if (rel.includes("/ui/") && spec.includes("/server/")) {
        boundaryViolations.push({ from: rel, to: spec, rule: "ui-must-not-import-server-module" });
      }
      if (spec.startsWith(".")) {
        const resolvedEdge = resolveImportPath(rel, spec, fileSet);
        if (resolvedEdge) {
          edges.push(resolvedEdge);
          if (rel.startsWith("web/") && resolvedEdge.startsWith("engine/src/")) {
            boundaryViolations.push({ from: rel, to: resolvedEdge, rule: "web-must-not-import-engine-source" });
          }
        }
      }
    }
    graph.set(rel, edges);
  }

  // Deterministic DFS cycle detection
  const circularDependencies: string[][] = [];
  const state = new Map<string, 1 | 2>(); // 1=visiting, 2=done
  const stack: string[] = [];
  const seenCycleKeys = new Set<string>();

  const dfs = (node: string): void => {
    if (circularDependencies.length >= 20) return;
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const st = state.get(next);
      if (st === 1) {
        const start = stack.indexOf(next);
        if (start >= 0) {
          const cycle = [...stack.slice(start), next];
          const key = [...cycle.slice(0, -1)].sort().join("->");
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key);
            circularDependencies.push(cycle);
          }
        }
      } else if (!st) {
        dfs(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of graph.keys()) {
    if (!state.get(node)) dfs(node);
  }

  return maskDeep({
    generatedAt: new Date().toISOString(),
    engine: "builtin-boundaries",
    repo: target.id,
    modulesAnalyzed: files.length,
    ok: boundaryViolations.length === 0 && circularDependencies.length === 0,
    boundaryViolations: boundaryViolations.slice(0, 40),
    circularDependencies,
  });
}

/** 4. stryker style scoped mutation site & test-adequacy auditor. */
export async function qeMutationScore(
  cfg: GuardConfig,
  opts: { repo?: string; targetDir?: string; files?: string[] } = {},
): Promise<MutationScoreReport> {
  const target = resolveTargetRepo(cfg, opts.repo, opts.targetDir);
  if (!target) {
    return maskDeep({
      generatedAt: new Date().toISOString(),
      engine: "builtin-mutator",
      repo: "none",
      filesAnalyzed: 0,
      totalMutantSites: 0,
      coveredSites: 0,
      mutationScorePct: 100,
      survivingRiskSites: [],
    });
  }

  const allFiles = walkRepoSourceFiles(target.path, { maxFiles: TIER0_MAX_SCAN_FILES, exts: [".ts", ".tsx", ".js", ".mjs"] });
  const testFiles = allFiles.filter((f) => isTestPath(f));
  const testBodies = testFiles.map((f) => {
    try {
      const txt = readFileSync(join(target.path, f), "utf8");
      const assertions = (txt.match(/\b(?:assert\.|expect\s*\()/g) ?? []).length;
      return { path: f, text: txt, assertions };
    } catch {
      return { path: f, text: "", assertions: 0 };
    }
  });

  let candidates = (opts.files ?? []).filter((f) => existsSync(join(target.path, f)));
  if (candidates.length === 0 && !opts.targetDir) {
    const traj = analyzeCommitTrajectory(cfg, null, { repo: target.id, lookbackDays: 14 });
    candidates = traj.churnHotspots.map((h) => h.path).filter((p) => existsSync(join(target.path, p)) && !isTestPath(p));
  }
  if (candidates.length === 0) {
    candidates = allFiles.filter((f) => !isTestPath(f)).slice(0, 12);
  }

  let totalMutantSites = 0;
  let coveredSites = 0;
  const survivingRiskSites: MutationScoreReport["survivingRiskSites"] = [];

  for (const rel of candidates.slice(0, 15)) {
    let raw = "";
    try {
      raw = readFileSync(join(target.path, rel), "utf8");
    } catch {
      continue;
    }
    const baseName = rel.split("/").pop()?.replace(/\.[^.]+$/, "") ?? rel;
    const matchingTests = testBodies.filter((t) => t.text.includes(baseName) || t.text.includes(rel.replace(/\.[^.]+$/, "")));
    const totalAssertionsForModule = matchingTests.reduce((s, t) => s + t.assertions, 0);

    const lines = raw.split(/\r?\n/);
    let fileSites = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      let operator = "";
      if (/(?:<=|>=|<|>|===|!==)/.test(line) && /\bif\b/.test(line)) operator = "RelationalBoundary";
      else if (/(?:&&|\|\|)/.test(line) && /\bif\b/.test(line)) operator = "LogicalOperator";
      else if (/^\s*if\s*\([^)]+\)\s*return\b/.test(line)) operator = "EarlyReturnGuard";
      if (!operator) continue;

      fileSites++;
      totalMutantSites++;
      if (totalAssertionsForModule >= Math.max(1, fileSites)) {
        coveredSites++;
      } else if (survivingRiskSites.length < 30) {
        survivingRiskSites.push({
          file: rel,
          line: i + 1,
          operator,
          snippet: line.trim().slice(0, 120),
        });
      }
    }
  }

  const mutationScorePct = totalMutantSites === 0 ? 100 : Number(((coveredSites / totalMutantSites) * 100).toFixed(1));

  return maskDeep({
    generatedAt: new Date().toISOString(),
    engine: "builtin-mutator",
    repo: target.id,
    filesAnalyzed: Math.min(15, candidates.length),
    totalMutantSites,
    coveredSites,
    mutationScorePct,
    survivingRiskSites,
  });
}
