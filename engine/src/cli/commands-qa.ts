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
import { createBrain, NoBackendError } from "../brain/select.ts";
import { openDb } from "../index/db.ts";
import type { Db } from "../index/db.ts";
import { generateSpec, isRejectedSpec } from "../qa/generate.ts";
import { CDP_ENV, cdpHowTo, probeCdp } from "../qa/harness.ts";
import { journeyProblems, loadJourneys } from "../qa/journeys.ts";
import { planTests, writePlan } from "../qa/planner.ts";
import { runSpec } from "../qa/runner.ts";
import { checkSpec, describeFindings, loadForbidden } from "../qa/safety.ts";
import type { CommandContext } from "./main.ts";

const copy = {
  usage: "qa <plan [repo] [--base ref] [--head ref] [--no-model] | generate <journey-id> | check <spec> | run <spec|journey-id> [--widths 800,1100,1440] [--video] [--note] | status>",
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

    out(copy.usage);
    return 2;
  },
};
