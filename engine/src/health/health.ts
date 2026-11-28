// System health: a few local checks, run in parallel, each with its own time limit.
//
// RULES: no model call, no network request of Guard's own, nothing is written. A row says only what
// was checked. Rows hold fixed text, repo ids and counts: never paths, tool output or error messages,
// because those can carry secrets or private names.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createKeyStore } from "../brain/keystore.ts";
import { AUTO_BACKEND_IDS, buildBackends, wantedBackend } from "../brain/select.ts";
import type { SelectOptions } from "../brain/select.ts";
import { machineDataDir } from "../brain/settings.ts";
import { dbPath } from "../config.ts";
import { redactSecrets } from "../tools/native/common.ts";
import { probeCuaDriver } from "../qa/cua_client.ts";
import { repoInfo } from "../repos/repos.ts";
import { safeGitTry } from "../repos/safe-git.ts";
import type { GuardConfig } from "../types.ts";

/** One check may take this long. Longer than the slowest probe inside (a CLI --version, PowerShell start). */
export const HEALTH_TIMEOUT_MS = 12_000;
/** Most web source files looked at when deciding whether the build is older than the source. */
const MAX_SOURCE_FILES = 2_000;

export type HealthStatus = "ok" | "warn" | "fail" | "unknown";
export interface HealthResult { status: HealthStatus; detail: string; fix?: string }
export interface HealthRow { id: string; label: string; status: HealthStatus; detail: string; fix: string | null; ms: number }
export interface HealthReport { checkedAt: string; status: HealthStatus; rows: HealthRow[] }
export interface HealthCheck { id: string; label: string; run: () => Promise<HealthResult> }
export interface HealthOptions { brain?: SelectOptions; checks?: HealthCheck[]; timeoutMs?: number }

async function models(cfg: GuardConfig, o: SelectOptions): Promise<HealthResult> {
  // available() looks for a key or runs a CLI's --version. It never calls a model.
  const backends = buildBackends(cfg, o);
  const found = await Promise.all(backends.map(async (b) => ({ id: b.id, ok: (await b.available().catch(() => ({ ok: false }))).ok })));
  const ready = found.filter((f) => f.ok).map((f) => f.id);
  const wanted = wantedBackend(cfg, o.env ?? process.env);
  const usable = wanted === "auto" ? AUTO_BACKEND_IDS.find((id) => ready.includes(id)) : ready.find((id) => id === wanted);
  const count = `${ready.length} of ${found.length} providers have a key or program present.`;
  const untested = "Sign-in and keys were not tested and no model was called.";
  if (usable) return { status: "ok", detail: `${count} Calls would go to ${usable}. ${untested}` };
  return {
    status: "fail",
    detail: `${count} ${wanted === "auto" ? "None can be chosen automatically." : "The selected provider is not among them."} ${untested}`,
    fix: "Open Settings, then Providers. Turn on a provider, add its key or install and sign in to its program, or choose another one.",
  };
}

async function repos(cfg: GuardConfig): Promise<HealthResult> {
  if (cfg.repos.length === 0) return { status: "warn", detail: "No repository is added.", fix: "Open Repositories and choose Add repository." };
  const infos = await Promise.all(cfg.repos.map(repoInfo));
  const bad = infos.filter((r) => !r.exists || !r.isGit).map((r) => r.id);
  if (bad.length) {
    return { status: "fail", detail: `Git cannot read ${bad.length} of ${infos.length}: ${bad.join(", ")}.`, fix: "Open Repositories, remove the broken entry and add the folder again." };
  }
  return { status: "ok", detail: `Git can read all ${infos.length} added repositories. Remotes were not contacted.` };
}

async function index(cfg: GuardConfig): Promise<HealthResult> {
  const fix = "Run `npm run guard -- index`, or choose Rebuild index in Settings.";
  const file = dbPath(cfg);
  if (!existsSync(file)) return { status: "warn", detail: "The search index has not been built.", fix };
  let last: Map<string, string>;
  // Read-only on purpose: openDb would create or rebuild tables.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT repo, last_sha FROM repo_state").all() as { repo: string; last_sha: string }[];
    last = new Map(rows.map((r) => [r.repo, r.last_sha]));
  } finally {
    db.close();
  }
  const behind: string[] = [];
  let compared = 0;
  for (const r of cfg.repos) {
    if (!existsSync(r.path)) { behind.push(r.id); continue; }
    const head = (await safeGitTry(r.path, ["rev-parse", "HEAD"]))?.trim();
    if (!head) { behind.push(r.id); continue; }
    compared++;
    if (last.get(r.id) !== head) behind.push(r.id);
  }
  if (behind.length) return { status: "warn", detail: `The index does not match the current commit of: ${behind.join(", ")}.`, fix };
  if (compared === 0) return { status: "unknown", detail: "The index exists, but there is no repository to compare it with." };
  return { status: "ok", detail: `The index matches the checked-out commit of ${compared} repositories. Notes and uncommitted changes were not compared.` };
}

async function desktopDriver(cfg: GuardConfig): Promise<HealthResult> {
  const cua = await probeCuaDriver(cfg);
  const builtIn = process.platform === "win32" && existsSync(join(cfg.root, "bin", "win-uia-crawler.ps1"));
  const found = [
    cua.available ? "cua-driver answered --version." : "cua-driver did not answer.",
    builtIn ? "The built-in Windows crawler script is present but was not run." : "The built-in Windows crawler is not available.",
  ].join(" ");
  const claim = "No window was read or controlled.";
  if (!cfg.cuaDriver?.allowedApps?.some((a) => a.trim())) {
    return { status: "warn", detail: `${found} Desktop tests are off because no app is allowed. ${claim}`, fix: "Add the program name of the app under test to cuaDriver.allowedApps in guard.config.local.json." };
  }
  if (cua.available) return { status: "ok", detail: `${found} ${claim}` };
  return { status: builtIn ? "warn" : "fail", detail: `${found} ${claim}`, fix: "Install cua-driver, or set cuaDriver.command in guard.config.local.json." };
}

async function keyStore(cfg: GuardConfig, o: SelectOptions): Promise<HealthResult> {
  const store = createKeyStore({ dataDir: machineDataDir(cfg), ...(o.env ? { env: o.env } : {}), ...(o.secrets ? { backend: o.secrets } : {}) });
  if (await store.storage()) return { status: "ok", detail: "This computer's secure key store helper starts. No key was read, saved or decrypted." };
  return { status: "warn", detail: "No secure key store is available, so keys cannot be saved here.", fix: "Set provider keys as environment variables before starting REO." };
}

function newestMtime(path: string, budget: { left: number }): number {
  if (budget.left-- <= 0) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  for (const name of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, name), budget));
  return newest;
}

async function webBuild(cfg: GuardConfig): Promise<HealthResult> {
  const fix = "Run `npm run web:build`.";
  const built = join(cfg.root, "web", "dist", "index.html");
  if (!existsSync(built)) return { status: "fail", detail: "The web app has not been built.", fix };
  const at = statSync(built).mtimeMs;
  const budget = { left: MAX_SOURCE_FILES };
  const sources = ["src", "public", "index.html"].map((p) => join(cfg.root, "web", p)).filter((p) => existsSync(p));
  if (sources.some((p) => newestMtime(p, budget) > at)) return { status: "warn", detail: "Web source files are newer than the build.", fix };
  return { status: "ok", detail: "A build is present and no checked source file is newer. The pages were not opened." };
}

export function defaultChecks(cfg: GuardConfig, brain: SelectOptions = {}): HealthCheck[] {
  return [
    { id: "models", label: "Model providers", run: () => models(cfg, brain) },
    { id: "repos", label: "Repositories", run: () => repos(cfg) },
    { id: "index", label: "Search index", run: () => index(cfg) },
    { id: "desktop-driver", label: "Desktop test driver", run: () => desktopDriver(cfg) },
    { id: "key-store", label: "Secure key store", run: () => keyStore(cfg, brain) },
    { id: "web-build", label: "Web app build", run: () => webBuild(cfg) },
  ];
}

async function runOne(check: HealthCheck, timeoutMs: number): Promise<HealthRow> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<HealthResult>((done) => {
    timer = setTimeout(() => done({ status: "unknown", detail: `The check did not finish within ${timeoutMs / 1000} s.`, fix: "Run health again when the computer is less busy." }), timeoutMs);
  });
  let r: HealthResult;
  try {
    r = await Promise.race([check.run(), late]);
  } catch {
    // The error text is left out on purpose: it can name paths or carry secrets.
    r = { status: "unknown", detail: "The check stopped with an error, so nothing is known.", fix: "Check the engine's settings files, then run health again." };
  } finally {
    clearTimeout(timer);
  }
  return {
    id: check.id, label: check.label, status: r.status, detail: redactSecrets(r.detail),
    fix: r.fix ? redactSecrets(r.fix) : null, ms: Date.now() - started,
  };
}

/** The worst row decides; "unknown" ranks above "warn" because nothing was shown to work. */
const RANK: Record<HealthStatus, number> = { ok: 0, warn: 1, unknown: 2, fail: 3 };

export async function runHealth(cfg: GuardConfig, opts: HealthOptions = {}): Promise<HealthReport> {
  const checks = opts.checks ?? defaultChecks(cfg, opts.brain ?? {});
  const rows = await Promise.all(checks.map((c) => runOne(c, opts.timeoutMs ?? HEALTH_TIMEOUT_MS)));
  const status = rows.reduce<HealthStatus>((worst, r) => (RANK[r.status] > RANK[worst] ? r.status : worst), "ok");
  return { checkedAt: new Date().toISOString(), status, rows };
}
