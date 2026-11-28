// Wave 2 DevSecOps SAST, Git Secret History, Dependency SCA Gate, and Localhost Nuclei Suite:
// 1. sec_semgrep_scan (Semgrep CLI / SARIF v2.1.0 ingestion / built-in OWASP static SAST -> SHA-256 Defects)
// 2. sec_gitleaks_history (gitleaks / read-only git log -p secret scanner with strict redaction)
// 3. sec_dependency_cves (osv-scanner / trivy / lockfile CVE & Dockerfile gate -> BLOCK_RELEASE on Critical/High)
// 4. sec_nuclei_local (nuclei / built-in security template probe locked strictly to 127.0.0.1 / localhost)

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { QualityVerdict } from "../automation/harness.ts";
import { PROJECT_NAME } from "../brand.ts";
import { upsertDefect } from "../defects/store.ts";
import { detectSecrets } from "../mask/detectors.ts";
import { gitTry } from "../review/git.ts";
import { isTestPath } from "../review/tier0.ts";
import type { GuardConfig } from "../types.ts";
import { resolveTargetRepo, runOptionalCli, walkRepoSourceFiles } from "../util/cli-runner.ts";
import { maskDeep } from "./safe-out.ts";
import { isLocalUrl, loadForbidden } from "./safety.ts";

/** Bound per-host Nuclei probe timeout. */
const NUCLEI_TIMEOUT_MS = 4_000;
const MAX_SEMGREP_FILES = 350;

export interface SastFinding {
  ruleId: string;
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  message: string;
  snippet: string;
}

export interface SemgrepScanReport {
  generatedAt: string;
  engine: "semgrep-sarif" | "sarif-ingest" | "builtin-owasp-sast";
  repo: string;
  totalFindings: number;
  defectsIngested: number;
  findings: SastFinding[];
}

export interface SecretLeakFinding {
  commitSha: string;
  file: string;
  line: number;
  secretKind: string;
  redactedPreview: string;
}

export interface GitleaksReport {
  generatedAt: string;
  engine: "gitleaks-cli" | "builtin-git-scanner";
  repo: string;
  commitsScanned: number;
  leaksFound: number;
  findings: SecretLeakFinding[];
}

export interface CveFinding {
  id: string;
  packageName: string;
  installedVersion: string;
  fixedIn: string;
  severity: "critical" | "high" | "medium" | "low";
  sourceFile: string;
  summary: string;
}

export interface DependencyCveReport {
  generatedAt: string;
  engine: "osv-scanner-cli" | "trivy-cli" | "builtin-sca";
  repo: string;
  lockfilesScanned: number;
  packagesChecked: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  releaseGate: QualityVerdict;
  vulnerabilities: CveFinding[];
}

export interface NucleiFinding {
  templateId: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  target: string;
  matchedAt: string;
  detail: string;
}

export interface NucleiLocalReport {
  generatedAt: string;
  engine: "nuclei-cli" | "builtin-nuclei-templates";
  baseUrl: string;
  templatesRun: number;
  matchedCount: number;
  findings: NucleiFinding[];
}

const OWASP_SAST_RULES: readonly {
  id: string;
  severity: SastFinding["severity"];
  re: RegExp;
  message: string;
}[] = [
  {
    id: "owasp.sql-injection.string-interpolation",
    severity: "critical",
    re: /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^`"']*(?:\$\{|['"]\s*\+\s*[A-Za-z_])/i,
    message: "SQL query uses string concatenation or interpolation; use parameterized queries.",
  },
  {
    id: "owasp.command-injection.shell-true",
    severity: "high",
    re: /\b(?:spawn|execFile|exec)\s*\([^)]*shell\s*:\s*true\b/,
    message: "Subprocess spawned with shell:true; pass an explicit binary & argument array.",
  },
  {
    id: "owasp.xss.unsafe-dom-sink",
    severity: "high",
    re: /\.innerHTML\s*=|\bdocument\.write\s*\(|\bdangerouslySetInnerHTML\b/,
    message: "Direct DOM HTML sink without sanitization risks Cross-Site Scripting (XSS).",
  },
  {
    id: "owasp.crypto.weak-digest",
    severity: "medium",
    re: /\bcreateHash\s*\(\s*["'](?:md5|sha1)["']\s*\)/i,
    message: "Weak hash algorithm (MD5/SHA1) detected; use SHA-256/512 or scrypt/argon2 for credentials.",
  },
  {
    id: "owasp.ssrf.unvalidated-request-url",
    severity: "high",
    re: /\bfetch\s*\(\s*(?:req\.query|req\.body|params|urlInput)\b/,
    message: "Server-side fetch directly uses request-supplied URL without allowlist/loopback validation.",
  },
];

function parseSarifText(rawSarif: string, repoRoot: string): SastFinding[] {
  const parsed = JSON.parse(rawSarif) as {
    runs?: Array<{
      results?: Array<{
        ruleId?: string;
        level?: string;
        message?: { text?: string };
        locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number; snippet?: { text?: string } } } }>;
      }>;
    }>;
  };
  const out: SastFinding[] = [];
  for (const run of parsed.runs ?? []) {
    for (const r of run.results ?? []) {
      const loc = r.locations?.[0]?.physicalLocation;
      const uri = loc?.artifactLocation?.uri ?? "unknown";
      const file = uri.startsWith("file://") ? uri : relative(repoRoot, uri).startsWith("..") ? uri : relative(repoRoot, uri).replace(/\\/g, "/");
      const level = (r.level ?? "warning").toLowerCase();
      const severity: SastFinding["severity"] = level === "error" ? "high" : level === "note" ? "low" : "medium";
      out.push({
        ruleId: r.ruleId || "semgrep.finding",
        severity,
        file,
        line: loc?.region?.startLine ?? 1,
        message: r.message?.text || "SARIF static security finding",
        snippet: (loc?.region?.snippet?.text ?? "").slice(0, 120),
      });
    }
  }
  return out;
}

/** 1. Semgrep SAST & SARIF v2.1.0 Defect Ingestion Engine. */
export async function secSemgrepScan(
  cfg: GuardConfig,
  opts: { repo?: string; targetDir?: string; sarifJson?: string; recordDefects?: boolean } = {},
): Promise<SemgrepScanReport> {
  const target = resolveTargetRepo(cfg, opts.repo, opts.targetDir);
  const repoId = target?.id ?? "custom";
  const repoRoot = target?.path ?? cfg.root;

  let engine: SemgrepScanReport["engine"] = "builtin-owasp-sast";
  let findings: SastFinding[] = [];

  if (opts.sarifJson?.trim()) {
    engine = "sarif-ingest";
    findings = parseSarifText(opts.sarifJson, repoRoot);
  } else if (target) {
    const cli = await runOptionalCli("semgrep", ["--config", "auto", "--sarif", "--quiet", target.path], { timeoutMs: 15_000 });
    if (cli.available && cli.stdout.trim().startsWith("{")) {
      try {
        engine = "semgrep-sarif";
        findings = parseSarifText(cli.stdout, target.path);
      } catch {
        /* fallback cleanly */
      }
    }
  }

  if (engine === "builtin-owasp-sast" && target) {
    const files = walkRepoSourceFiles(target.path, {
      maxFiles: MAX_SEMGREP_FILES,
      exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".cs", ".rs"],
    });
    for (const rel of files) {
      if (isTestPath(rel) || findings.length >= 60) continue;
      let raw = "";
      try {
        raw = readFileSync(join(target.path, rel), "utf8");
      } catch {
        continue;
      }
      const lines = raw.split(/\r?\n/);
      for (let i = 0; i < lines.length && findings.length < 60; i++) {
        const line = lines[i] ?? "";
        for (const rule of OWASP_SAST_RULES) {
          if (rule.re.test(line)) {
            findings.push({
              ruleId: rule.id,
              severity: rule.severity,
              file: rel,
              line: i + 1,
              message: rule.message,
              snippet: line.trim().slice(0, 120),
            });
          }
        }
      }
    }
  }

  let defectsIngested = 0;
  if (opts.recordDefects !== false) {
    for (const f of findings.filter((x) => x.severity === "critical" || x.severity === "high").slice(0, 15)) {
      upsertDefect(cfg.dataDir, {
        appName: PROJECT_NAME,
        branch: "current",
        commitSha: "",
        testedBy: "SPIL REO DevSecOps Agent",
        assignedTo: "",
        agentSource: "security",
        severity: f.severity,
        title: `${f.ruleId}: ${f.file}:${f.line}`,
        expected: "Code passes OWASP SAST security checks without high/critical vulnerabilities.",
        actual: f.message,
        reproSteps: ["Run sec_semgrep_scan on repository"],
        codeSuggestion: f.snippet,
        fileRef: `${f.file}:${f.line}`,
        evidencePaths: [],
      });
      defectsIngested++;
    }
  }

  return maskDeep({
    generatedAt: new Date().toISOString(),
    engine,
    repo: repoId,
    totalFindings: findings.length,
    defectsIngested,
    findings,
  });
}

function redactSecretValue(raw: string): string {
  const prefix = raw.slice(0, Math.min(4, raw.length));
  return `${prefix}***REDACTED***`;
}

/** 2. Gitleaks-style read-only git commit history secret scanner (never leaks raw secrets). */
export async function secGitleaksHistory(
  cfg: GuardConfig,
  opts: { repo?: string; targetDir?: string; maxCommits?: number } = {},
): Promise<GitleaksReport> {
  const target = resolveTargetRepo(cfg, opts.repo, opts.targetDir);
  if (!target) {
    return maskDeep({ generatedAt: new Date().toISOString(), engine: "builtin-git-scanner", repo: "none", commitsScanned: 0, leaksFound: 0, findings: [] });
  }

  const maxCommits = Math.max(1, Math.min(100, opts.maxCommits ?? 25));
  const findings: SecretLeakFinding[] = [];
  let commitsScanned = 0;
  let engine: GitleaksReport["engine"] = "builtin-git-scanner";

  const cli = await runOptionalCli("gitleaks", ["detect", "--source", target.path, "--report-format", "json", "--report-path", "-", "--no-banner"], { timeoutMs: 15_000 });
  if (cli.available && cli.stdout.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(cli.stdout) as Array<{ Commit?: string; File?: string; StartLine?: number; RuleID?: string; Secret?: string }>;
      engine = "gitleaks-cli";
      for (const hit of parsed.slice(0, 50)) {
        findings.push({
          commitSha: hit.Commit || "HEAD",
          file: hit.File || "unknown",
          line: hit.StartLine ?? 1,
          secretKind: hit.RuleID || "SECRET",
          redactedPreview: redactSecretValue(hit.Secret || "****"),
        });
      }
    } catch {
      /* fallback cleanly */
    }
  }

  if (engine === "builtin-git-scanner") {
    const rawLog = gitTry(target.path, [
      "log",
      `-n`,
      String(maxCommits),
      "-p",
      "--no-color",
      "--unified=0",
      "--format=__COMMIT__%H",
    ]);
    if (rawLog) {
      let currentCommit = "HEAD";
      let currentFile = "unknown";
      let lineNo = 0;
      for (const line of rawLog.split(/\r?\n/)) {
        if (line.startsWith("__COMMIT__")) {
          currentCommit = line.slice("__COMMIT__".length).trim().slice(0, 12) || "HEAD";
          commitsScanned++;
          continue;
        }
        if (line.startsWith("+++ b/")) {
          currentFile = line.slice(6).trim();
          continue;
        }
        const hunk = /^@@ [^ ]+ \+(\d+)/.exec(line);
        if (hunk) {
          lineNo = Number(hunk[1]) - 1;
          continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
          lineNo++;
          if (isTestPath(currentFile)) continue;
          const content = line.slice(1);
          const spans = detectSecrets(content).filter((s) => s.severity === "secret");
          for (const s of spans) {
            findings.push({
              commitSha: currentCommit,
              file: currentFile,
              line: lineNo,
              secretKind: s.kind,
              redactedPreview: redactSecretValue(content.slice(s.start, s.end)),
            });
            if (findings.length >= 50) break;
          }
        }
        if (findings.length >= 50) break;
      }
    }
  }

  return maskDeep({
    generatedAt: new Date().toISOString(),
    engine,
    repo: target.id,
    commitsScanned,
    leaksFound: findings.length,
    findings,
  });
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^[^0-9]*/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^[^0-9]*/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const KNOWN_CVES: readonly { pkg: string; fixedIn: string; id: string; severity: CveFinding["severity"]; summary: string }[] = [
  { pkg: "lodash", fixedIn: "4.17.21", id: "CVE-2021-23337", severity: "high", summary: "Command injection / prototype pollution in lodash < 4.17.21." },
  { pkg: "axios", fixedIn: "1.6.0", id: "CVE-2023-45857", severity: "critical", summary: "CSRF / XSRF-TOKEN exposure in axios < 1.6.0." },
  { pkg: "semver", fixedIn: "7.5.2", id: "CVE-2022-3517", severity: "high", summary: "ReDoS vulnerability in semver < 7.5.2." },
  { pkg: "ws", fixedIn: "8.17.1", id: "CVE-2024-37890", severity: "high", summary: "DoS crash on many headers in ws < 8.17.1." },
  { pkg: "tar", fixedIn: "6.2.1", id: "CVE-2024-28863", severity: "high", summary: "Path traversal / unbounded extraction DoS in node-tar < 6.2.1." },
  { pkg: "jsonwebtoken", fixedIn: "9.0.0", id: "CVE-2022-23529", severity: "critical", summary: "Unsafe secretOrPublicKey coercion in jsonwebtoken < 9.0.0." },
  { pkg: "express", fixedIn: "4.19.2", id: "CVE-2024-29041", severity: "medium", summary: "Open redirect in express < 4.19.2." },
  { pkg: "vite", fixedIn: "5.2.6", id: "CVE-2024-31207", severity: "medium", summary: "Dev server fs.deny bypass in vite < 5.2.6." },
];

/** 3. OSV-Scanner / Trivy style SCA lockfile vulnerability & release gate checker. */
export async function secDependencyCves(
  cfg: GuardConfig,
  opts: { repo?: string; targetDir?: string; recordDefects?: boolean } = {},
): Promise<DependencyCveReport> {
  const target = resolveTargetRepo(cfg, opts.repo, opts.targetDir);
  if (!target) {
    return maskDeep({
      generatedAt: new Date().toISOString(),
      engine: "builtin-sca",
      repo: "none",
      lockfilesScanned: 0,
      packagesChecked: 0,
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      releaseGate: "PASS",
      vulnerabilities: [],
    });
  }

  let engine: DependencyCveReport["engine"] = "builtin-sca";
  let lockfilesScanned = 0;
  let packagesChecked = 0;
  const vulnerabilities: CveFinding[] = [];

  const osv = await runOptionalCli("osv-scanner", ["--format", "json", "-r", target.path], { timeoutMs: 15_000 });
  if (osv.available && osv.stdout.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(osv.stdout) as { results?: Array<{ source?: { path?: string }; packages?: Array<{ package?: { name?: string; version?: string }; vulnerabilities?: Array<{ id?: string; summary?: string }> }> }> };
      engine = "osv-scanner-cli";
      for (const res of parsed.results ?? []) {
        lockfilesScanned++;
        for (const p of res.packages ?? []) {
          packagesChecked++;
          for (const v of p.vulnerabilities ?? []) {
            vulnerabilities.push({
              id: v.id || "OSV-VULN",
              packageName: p.package?.name || "unknown",
              installedVersion: p.package?.version || "0.0.0",
              fixedIn: "latest",
              severity: "high",
              sourceFile: res.source?.path || "lockfile",
              summary: (v.summary || "OSV vulnerability").slice(0, 160),
            });
          }
        }
      }
    } catch {
      /* fallback cleanly */
    }
  }

  if (engine === "builtin-sca") {
    for (const relLock of ["package-lock.json", "engine/package-lock.json", "web/package-lock.json"]) {
      const full = join(target.path, relLock);
      if (!existsSync(full)) continue;
      lockfilesScanned++;
      try {
        const parsed = JSON.parse(readFileSync(full, "utf8")) as {
          packages?: Record<string, { version?: string }>;
          dependencies?: Record<string, { version?: string }>;
        };
        const pkgs = parsed.packages ?? parsed.dependencies ?? {};
        for (const [rawKey, meta] of Object.entries(pkgs)) {
          const name = rawKey.includes("node_modules/") ? rawKey.split("node_modules/").pop() ?? rawKey : rawKey;
          if (!name || !meta?.version) continue;
          packagesChecked++;
          for (const adv of KNOWN_CVES) {
            if (name === adv.pkg && compareSemver(meta.version, adv.fixedIn) < 0) {
              vulnerabilities.push({
                id: adv.id,
                packageName: name,
                installedVersion: meta.version,
                fixedIn: adv.fixedIn,
                severity: adv.severity,
                sourceFile: relLock,
                summary: adv.summary,
              });
            }
          }
        }
      } catch {
        /* ignore malformed lockfile */
      }
    }
  }

  const criticalCount = vulnerabilities.filter((v) => v.severity === "critical").length;
  const highCount = vulnerabilities.filter((v) => v.severity === "high").length;
  const mediumCount = vulnerabilities.filter((v) => v.severity === "medium").length;
  const releaseGate: QualityVerdict =
    criticalCount > 0 || highCount > 0 ? "BLOCK_RELEASE" : mediumCount > 0 ? "NEEDS_REVIEW" : "PASS";

  if (opts.recordDefects !== false && (criticalCount > 0 || highCount > 0)) {
    for (const v of vulnerabilities.filter((x) => x.severity === "critical" || x.severity === "high").slice(0, 10)) {
      upsertDefect(cfg.dataDir, {
        appName: PROJECT_NAME,
        branch: "current",
        commitSha: "",
        testedBy: "SPIL REO SCA Gate",
        assignedTo: "",
        agentSource: "security",
        severity: v.severity,
        title: `${v.id}: ${v.packageName}@${v.installedVersion}`,
        expected: `Upgrade ${v.packageName} to >= ${v.fixedIn}`,
        actual: v.summary,
        reproSteps: ["Run sec_dependency_cves against lockfiles"],
        codeSuggestion: `npm install ${v.packageName}@^${v.fixedIn}`,
        fileRef: v.sourceFile,
        evidencePaths: [],
      });
    }
  }

  return maskDeep({
    generatedAt: new Date().toISOString(),
    engine,
    repo: target.id,
    lockfilesScanned,
    packagesChecked,
    criticalCount,
    highCount,
    mediumCount,
    releaseGate,
    vulnerabilities: vulnerabilities.slice(0, 50),
  });
}

/** 4. Nuclei localhost-only dynamic vulnerability & exposure scanner. */
export async function secNucleiLocal(
  cfg: GuardConfig,
  opts: { baseUrl: string; fetchFn?: typeof fetch },
): Promise<NucleiLocalReport> {
  const forbidden = loadForbidden(cfg.root);
  if (!isLocalUrl(opts.baseUrl, forbidden)) {
    throw new Error(`Blocked sec_nuclei_local against non-local host: ${opts.baseUrl}. Only localhost/127.0.0.1 permitted.`);
  }
  const base = opts.baseUrl.replace(/\/+$/, "");

  if (!opts.fetchFn) {
    const cli = await runOptionalCli("nuclei", ["-u", base, "-jsonl", "-silent"], { timeoutMs: 15_000 });
    if (cli.available && cli.stdout.trim()) {
      const findings: NucleiFinding[] = [];
      for (const line of cli.stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const item = JSON.parse(line) as { "template-id"?: string; "matched-at"?: string; info?: { severity?: string; name?: string } };
          const sev = (item.info?.severity ?? "info").toLowerCase();
          findings.push({
            templateId: item["template-id"] || "nuclei-template",
            severity: sev === "critical" || sev === "high" || sev === "medium" || sev === "low" ? sev : "info",
            target: base,
            matchedAt: item["matched-at"] || base,
            detail: item.info?.name || "Matched Nuclei template",
          });
        } catch {
          /* skip invalid jsonl line */
        }
      }
      return maskDeep({
        generatedAt: new Date().toISOString(),
        engine: "nuclei-cli",
        baseUrl: base,
        templatesRun: findings.length,
        matchedCount: findings.length,
        findings,
      });
    }
  }

  const doFetch = opts.fetchFn ?? fetch;
  const templates: readonly { id: string; path: string; severity: NucleiFinding["severity"]; check: (res: Response, body: string) => string | null }[] = [
    {
      id: "exposed-dotenv-file",
      path: "/.env",
      severity: "critical",
      check: (res, body) => (res.status === 200 && /^[A-Z0-9_]{3,}=/m.test(body) ? "Exposed .env environment variables over HTTP." : null),
    },
    {
      id: "exposed-git-head",
      path: "/.git/HEAD",
      severity: "high",
      check: (res, body) => (res.status === 200 && /ref:\s*refs\//.test(body) ? "Exposed .git/HEAD repository metadata." : null),
    },
    {
      id: "exposed-actuator-env",
      path: "/actuator/env",
      severity: "high",
      check: (res, body) => (res.status === 200 && body.includes("propertySources") ? "Unauthenticated Spring Actuator /actuator/env exposure." : null),
    },
    {
      id: "missing-security-headers",
      path: "/",
      severity: "medium",
      check: (res) => {
        const missing: string[] = [];
        if (!res.headers.get("content-security-policy")) missing.push("Content-Security-Policy");
        if (!res.headers.get("x-content-type-options")) missing.push("X-Content-Type-Options");
        return missing.length ? `Missing HTTP hardening header(s): ${missing.join(", ")}` : null;
      },
    },
    {
      id: "permissive-cors-wildcard",
      path: "/",
      severity: "medium",
      check: (res) =>
        res.headers.get("access-control-allow-origin") === "*" && res.headers.get("access-control-allow-credentials") === "true"
          ? "Dangerous CORS combination: Access-Control-Allow-Origin: * with Allow-Credentials: true."
          : null,
    },
  ];

  const findings: NucleiFinding[] = [];
  for (const tpl of templates) {
    try {
      const r = await doFetch(`${base}${tpl.path}`, { signal: AbortSignal.timeout(NUCLEI_TIMEOUT_MS) });
      const body = await r.text();
      const detail = tpl.check(r, body);
      if (detail) {
        findings.push({
          templateId: tpl.id,
          severity: tpl.severity,
          target: base,
          matchedAt: `${base}${tpl.path}`,
          detail,
        });
      }
    } catch {
      /* target unreachable for this path */
    }
  }

  return maskDeep({
    generatedAt: new Date().toISOString(),
    engine: "builtin-nuclei-templates",
    baseUrl: base,
    templatesRun: templates.length,
    matchedCount: findings.length,
    findings,
  });
}
