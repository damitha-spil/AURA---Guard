// QA commands: `qa plan | generate | check | run | status`. Merged into EXTRA_COMMANDS by the owner:
//   import { qaCommands } from "./commands-qa.ts";   Object.assign(EXTRA_COMMANDS, qaCommands);
// Also add "base", "head" and "widths" to VALUE_FLAGS in main.ts. (`--base=ref` works without that.)
//
// HARD RULES: Guard never writes into the Aura repo, never launches Aura, never runs cargo. Tests only read.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dbPath } from "../config.ts";
import { ApiError, BlockedError, MissingKeyError } from "../brain/client.ts";
import { CliError } from "../brain/backends.ts";
import { createBrain, describeBackends, NoBackendError } from "../brain/select.ts";
import { openDb } from "../index/db.ts";
import type { Db } from "../index/db.ts";
import { runBackendQaSuite } from "../qa/backend_qa.ts";
import { buildBugSheet } from "../qa/defects.ts";
import { crawlDesktopApp, probeDesktopCrawlers } from "../qa/desktop_crawler.ts";
import { buildPrEvidencePacket } from "../qa/evidence.ts";
import { findFeatureEntry } from "../qa/feature_map.ts";
import { runOpenApiChecks } from "../qa/openapi.ts";
import { runSecurityProbes } from "../qa/security_probes.ts";
import { buildPrReadinessReport } from "../prs/manager.ts";
import { CuaClient, createMcpCuaTransport, probeCuaDriver } from "../qa/cua_client.ts";
import { selectTargetWindow } from "../qa/cua_harness.ts";
import { createHybridDriver } from "../qa/driver.ts";
import { exploreScreen } from "../qa/explorer.ts";
import { attachAura } from "../qa/harness.ts";
import { runQaAgent } from "../qa/agent.ts";
import { generateSpec, isRejectedSpec } from "../qa/generate.ts";
import { CDP_ENV, cdpHowTo, probeCdp } from "../qa/harness.ts";
import { journeyProblems, loadJourneys } from "../qa/journeys.ts";
import { planTests, writePlan } from "../qa/planner.ts";
import { runSpec } from "../qa/runner.ts";
import { checkSpec, describeFindings, loadForbidden } from "../qa/safety.ts";
import type { CommandContext } from "./main.ts";

const copy = {
  usage: "qa <agent \"<request>\" [--no-model] [--json] | plan [repo] [--base ref] [--head ref] [--no-model] | generate <journey-id> | check <spec> | run <spec|journey-id> [--widths 800,1100,1440] [--video] [--note] | evidence <run-id> | backend | explore <area> | pr-readiness [repo] | status>",
  needArgs: (what: string) => `Missing argument. Usage: ${what}`,
  noRepo: (id: string, known: string) => `Unknown repo "${id}". Configured repos: ${known || "(none)"}.`,
  planWritten: (path: string, n: number, gaps: number, model: string) =>
    `QA plan written: ${path}\n${n} journey(s) to run, ${gaps} gap(s). ${model}`,
  planLine: (i: number, id: string, risk: string, why: string) => `  ${i}. [${risk}] ${id}: ${why}`,
  gapLine: (area: string, n: number) => `  gap: ${area} (${n} changed file(s) with no journey)`,
  noGraph: "Note: no code graph for this repo, so blast radius was skipped. Run `index` after a graph refresh.",
  specWritten: (path: string, tries: number) => `Spec written (status proposed, ${tries} attempt(s)): ${path}`,
  specRejected: (path: string) => `Spec REJECTED by the safety check and written with a REJECTED header (never run): ${path}`,
  safetyOk: (path: string) => `Safety check passed: ${path}`,
  safetyFail: (path: string, n: number) => `Safety check FAILED (${n} problem(s)): ${path}`,
  specMissing: (path: string) => `Spec not found: ${path}`,
  brainFail: (m: string) => `The model step failed: ${m}`,
  runResult: (status: string, journey: string, report: string) => `Run ${status}: ${journey}${report ? `\nReport: ${report}` : ""}`,
  statusCdp: (url: string, browser: string) => `Aura debugging port: reachable at ${url} (${browser})`,
  statusNoCdp: `Aura debugging port: ${CDP_ENV} is not set`,
  statusDown: (url: string, why: string) => `Aura debugging port: NOT reachable at ${url} (${why})`,
  journeyRow: (id: string, status: string, area: string, problems: string[]) =>
    `  ${id}  [${status}, ${area || "no area"}]${problems.length ? `  PROBLEMS: ${problems.join(", ")}` : ""}`,
  specRow: (name: string, rejected: boolean) => `  ${name}${rejected ? "  REJECTED (never run)" : ""}`,
};

/** `--name value` (when main.ts lists it in VALUE_FLAGS) or `--name=value`. */
function flagValue(flags: CommandContext["flags"], name: string): string | undefined {
  const v = flags[name];
  if (typeof v === "string") return v;
  for (const [k] of Object.entries(flags)) if (k.startsWith(`${name}=`)) return k.slice(name.length + 1);
  return undefined;
}

function openDbIfAny(cfg: CommandContext["cfg"]): Db | null {
  const f = dbPath(cfg);
  return existsSync(f) ? openDb(f) : null;
}

const isModelError = (e: unknown): boolean =>
  e instanceof MissingKeyError || e instanceof BlockedError || e instanceof ApiError || e instanceof NoBackendError || e instanceof CliError;

export const qaCommands: Record<string, (ctx: CommandContext) => Promise<number> | number> = {
  qa: async (ctx) => {
    const { rest, flags, out, cfg } = ctx;
    const sub = rest[0];
    const arg = rest[1];

    if (sub === "agent") {
      const request = rest.slice(1).join(" ").trim();
      if (!request) { out(copy.needArgs('qa agent "<request>" [--no-model] [--json]')); return 2; }
      const json = flags["json"] === true;
      const noModel = flags["no-model"] === true;
      const db = openDbIfAny(cfg);
      try {
        let complete;
        let backend: string | null = null;
        if (!noModel) {
          try {
            complete = createBrain(cfg).complete;
            const d = await describeBackends(cfg);
            backend = d.picked === "claude-cli" ? "Claude plan" : d.picked === "anthropic-api" ? "API key" : null;
          } catch { complete = undefined; }
        }
        const o = await runQaAgent({ cfg, db, complete, backend }, { message: request, history: [], noModel });
        if (o.kind === "result") {
          out(json ? JSON.stringify({ kind: "result", result: o.result }) : o.markdown.trimEnd());
          return 0;
        }
        if (o.kind === "needs-input") {
          out(json ? JSON.stringify({ kind: "needs-input", question: o.question, options: o.options }) : o.text);
          return 2;
        }
        out(json ? JSON.stringify({ kind: o.kind, text: o.text }) : o.text);
        return 1;
      } catch (e) {
        out(json ? JSON.stringify({ kind: "error", text: (e as Error).message }) : (e as Error).message);
        return 1;
      } finally {
        db?.close();
      }
    }

    if (sub === "plan") {
      const repoId = arg ?? cfg.repos.find((r) => r.id === "spil-aura")?.id ?? cfg.repos[0]?.id ?? "";
      if (!cfg.repos.some((r) => r.id === repoId)) {
        out(copy.noRepo(repoId, cfg.repos.map((r) => r.id).join(", ")));
        return 2;
      }
      const noModel = flags["no-model"] === true;
      const db = openDbIfAny(cfg);
      try {
        const base = flagValue(flags, "base");
        const head = flagValue(flags, "head");
        const plan = await planTests(cfg, db, { repo: repoId, ...(base ? { base } : {}), ...(head ? { head } : {}) }, noModel ? {} : { complete: createBrain(cfg).complete });
        const path = writePlan(cfg, plan);
        out(copy.planWritten(path, plan.items.length, plan.gaps.length, plan.modelNote));
        plan.items.forEach((i, n) => out(copy.planLine(n + 1, i.journey, i.risk, i.why)));
        for (const g of plan.gaps) out(copy.gapLine(g.area, g.files.length));
        if (!db) out(copy.noGraph);
        return 0;
      } catch (e) {
        out((e as Error).message);
        return 1;
      }
    }

    if (sub === "generate") {
      if (!arg) { out(copy.needArgs("qa generate <journey-id>")); return 2; }
      try {
        const brain = createBrain(cfg);
        const r = await generateSpec(cfg, arg, { complete: brain.complete });
        out(r.rejected ? copy.specRejected(r.file) : copy.specWritten(r.file, r.attempts));
        for (const f of describeFindings(r.findings)) out(`  - ${f}`);
        const used = brain.backendUsed();
        if (used) out(`Model backend used: ${used}`);
        return r.rejected ? 1 : 0;
      } catch (e) {
        if (isModelError(e)) { out(copy.brainFail((e as Error).message)); return 1; }
        out((e as Error).message);
        return 1;
      }
    }

    if (sub === "check") {
      if (!arg) { out(copy.needArgs("qa check <spec>")); return 2; }
      const path = existsSync(arg) ? arg : join(cfg.root, "qa", "generated", arg.endsWith(".ts") ? arg : `${arg}.spec.ts`);
      if (!existsSync(path)) { out(copy.specMissing(path)); return 2; }
      const src = readFileSync(path, "utf8");
      if (isRejectedSpec(src)) { out(copy.safetyFail(path, 1)); out("  - the file carries a REJECTED header from generation"); return 1; }
      const r = checkSpec(src, loadForbidden(cfg.root));
      if (r.ok) { out(copy.safetyOk(path)); return 0; }
      out(copy.safetyFail(path, r.findings.length));
      for (const f of describeFindings(r.findings)) out(`  - ${f}`);
      return 1;
    }

    if (sub === "run") {
      if (!arg) { out(copy.needArgs("qa run <spec|journey-id>")); return 2; }
      const w = flagValue(flags, "widths");
      const widths = w ? w.split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 400) : undefined;
      const r = await runSpec(cfg, arg, {
        ...(widths?.length ? { widths } : {}), video: flags["video"] === true, note: flags["note"] === true,
      });
      out(copy.runResult(r.status, r.journey, r.reportPath ?? ""));
      if (r.blocker) out(`Blocker: ${r.blocker}`);
      if (r.safety) for (const f of describeFindings(r.safety)) out(`  - ${f}`);
      if (r.howTo) for (const h of r.howTo) out(h);
      for (const d of r.defects) out(`  defect: ${d.step} at ${d.width ?? "window"} px: ${d.actual}`);
      out(r.videoNote);
      return r.status === "passed" ? 0 : r.status === "failed" ? 1 : 3;
    }

    if (sub === "status") {
      const url = process.env[CDP_ENV];
      let code = 0;
      if (!url) { out(copy.statusNoCdp); out(cdpHowTo().join("\n")); code = 1; }
      else {
        try { out(copy.statusCdp(url, await probeCdp(url))); }
        catch (e) { out(copy.statusDown(url, (e as Error).message)); out(cdpHowTo(url).join("\n")); code = 1; }
      }
      out("Journeys:");
      for (const j of loadJourneys(cfg)) out(copy.journeyRow(j.id, j.status, j.area, journeyProblems(j)));
      const dir = join(cfg.root, "qa", "generated");
      out("Generated specs:");
      const specs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".spec.ts")).sort() : [];
      if (specs.length === 0) out("  (none yet)");
      for (const s of specs) out(copy.specRow(s, isRejectedSpec(readFileSync(join(dir, s), "utf8"))));
      return code;
    }

    if (sub === "evidence") {
      if (!arg) { out(copy.needArgs("qa evidence <run-id>")); return 2; }
      const built = await buildPrEvidencePacket(cfg, arg);
      if (!built) { out(`No QA run found for ID: ${arg}`); return 1; }
      out(built.markdown.trimEnd());
      out(`\nSaved: ${built.markdownPath}`);
      return 0;
    }

    if (sub === "backend") {
      const report = await runBackendQaSuite(cfg);
      for (const c of report.checks) {
        out(`[${c.status.toUpperCase()}] ${c.label} (${c.ms} ms) — ${c.detail}`);
      }
      out(`Summary: ${report.passed} pass, ${report.warned} warn, ${report.failed} fail`);
      return report.ok ? 0 : 1;
    }

    if (sub === "pr-readiness") {
      const db = openDbIfAny(cfg);
      try {
        const rep = buildPrReadinessReport(cfg, db, { ...(arg ? { repo: arg } : {}) });
        out(rep.prSummaryMarkdown.trimEnd());
        return rep.releaseGate === "block" ? 1 : 0;
      } finally {
        db?.close();
      }
    }

    if (sub === "explore") {
      const area = rest.slice(1).join(" ").trim() || "home";
      const cdpUrl = process.env[CDP_ENV];
      const cuaProbe = await probeCuaDriver(cfg);
      if (!cdpUrl && !cuaProbe.available) {
        out(`Explore requires either ${CDP_ENV} or an installed cua-driver in background mode.`);
        out(cdpHowTo().join("\n"));
        return 1;
      }
      let attached: Awaited<ReturnType<typeof attachAura>> | undefined;
      let cuaClient: CuaClient | undefined;
      try {
        if (cdpUrl) attached = await attachAura(cdpUrl);
        if (cuaProbe.available) cuaClient = new CuaClient(await createMcpCuaTransport(cfg));
        const win = cuaClient ? selectTargetWindow(await cuaClient.listWindows(), cfg) : undefined;
        const driver = createHybridDriver({
          cfg,
          ...(cuaClient && win ? { cuaClient, window: win } : {}),
          ...(attached ? { page: attached.page } : {}),
          forbidden: loadForbidden(cfg.root),
          shotDir: join(cfg.root, ".artifacts", "qa", `explore-${Date.now().toString(36)}`),
        });
        const res = await exploreScreen(driver, { area });
        await driver.close();
        out(`Explored "${area}" (${res.telemetryMode}): ${res.visitedControls.length} controls, ${res.defects.length} defect(s).`);
        out(res.evaluation.summary);
        return res.defects.length > 0 ? 1 : 0;
      } finally {
        await attached?.browser.close().catch(() => {});
      }
    }

    if (sub === "bugs") {
      if (!arg) { out(copy.needArgs("qa bugs <run-id>")); return 2; }
      const sheet = buildBugSheet(cfg, arg);
      if (!sheet) { out(`No QA run found for ID: ${arg}`); return 1; }
      out(sheet.markdown.trimEnd());
      out(`\nSaved JSON/MD/CSV under: ${sheet.paths.markdownPath}`);
      return 0;
    }

    if (sub === "openapi") {
      const specPath = rest[1];
      const baseUrl = rest[2];
      if (!specPath || !baseUrl) { out(copy.needArgs("qa openapi <spec-path> <local-base-url>")); return 2; }
      const rep = await runOpenApiChecks(cfg, { specPath, baseUrl });
      out(`OpenAPI checks on ${rep.baseUrl}: ${rep.passed} pass, ${rep.failed} fail, ${rep.skipped} skipped (${rep.endpointsFound} endpoints).`);
      return rep.failed > 0 ? 1 : 0;
    }

    if (sub === "security") {
      if (!arg) { out(copy.needArgs("qa security <local-base-url>")); return 2; }
      const rep = await runSecurityProbes(cfg, { baseUrl: arg });
      for (const p of rep.probes) out(`[${p.status.toUpperCase()}] ${p.category} ${p.target} — ${p.detail}`);
      return rep.ok ? 0 : 1;
    }

    if (sub === "crawl") {
      const avail = await probeDesktopCrawlers(cfg);
      out(`Crawlers: WindowsUIA=${avail.windowsUia.available}, Cua=${avail.cuaDriver.available}, Python=${avail.python.available}`);
      const dryRun = flags["dry-run"] === true;
      const maxActions = typeof flags["max"] === "string" ? Number(flags["max"]) : 5;
      const rep = await crawlDesktopApp(cfg, { ...(arg ? { matchTitle: arg } : {}), dryRun, maxActions });
      out(`Crawled "${rep.window.title}" (${rep.window.processName}): ${rep.nodesCount} UIA nodes, ${rep.controls.length} controls, ${rep.clicked.length} clicked, ${rep.blockedControls.length} Tier-2 blocked.`);
      return 0;
    }

    if (sub === "features") {
      const list = findFeatureEntry(cfg, arg ?? "");
      for (const f of list) out(`- [${f.id}] ${f.title} (${f.entryPoint}) -> ${f.journeyId ?? "no journey"}`);
      return 0;
    }

    out(copy.usage);
    return 2;
  },
};
