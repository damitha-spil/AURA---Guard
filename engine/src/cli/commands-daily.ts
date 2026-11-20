// `aura-guard daily`: the end-of-day routine. Runs each step from
// roles/daily.json as its own child process (so one failure never stops the
// rest and a step that calls process.exit is harmless), then writes a short
// report to data/daily/<date>.md. Nothing here writes to other repos; the steps
// only add proposed notes to the vault and refresh the local index.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CommandContext } from "./main.ts";
import { runChild } from "./commands-dept.ts";
import { listDepartments, loadRegistry } from "../departments/registry.ts";

const StepSchema = z.object({
  id: z.string(),
  argv: z.array(z.string()).min(1),
  timeoutMin: z.number().positive().default(10),
  optional: z.boolean().default(false),
  needsModel: z.boolean().default(false),
  /** Department helper that must be switched on for this step (see departments/model.ts). */
  role: z.string().optional(),
  /** Skipped when the department has no git source. */
  needsRepo: z.boolean().default(false),
});
const FileSchema = z.object({ steps: z.array(StepSchema).min(1) });
type Step = z.infer<typeof StepSchema>;

// Cap what one step may print into memory and into the report.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const REPORT_LINES_PER_STEP = 30;

type Status = "ok" | "failed" | "skipped";
interface StepResult {
  id: string;
  status: Status;
  seconds: number;
  note: string;
  lines: string[];
}

const copy = {
  start: (date: string, n: number) => `Daily routine for ${date}: ${n} steps.`,
  line: (id: string, status: Status, secs: number, note: string) =>
    `  ${status.padEnd(7)} ${id} (${secs} s)${note ? ` - ${note}` : ""}`,
  reportAt: (path: string) => `Report: ${path}`,
  off: (name: string) => `The daily routine is switched off for ${name}.`,
  badFile: (why: string) => `roles/daily.json is not valid: ${why}`,
};

function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function runStep(mainTs: string, cwd: string, step: Step): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    // Always a child process with an argument list; never a shell string.
    execFile(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", mainTs, ...step.argv],
      { cwd, timeout: step.timeoutMin * 60_000, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (err, stdout, stderr) => {
        const text = `${stdout}${stderr}`.trim();
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, text });
      },
    );
  });
}

export const dailyCommands: Record<string, (ctx: CommandContext) => Promise<number> | number> = {
  daily: async ({ flags, out, cfg, base }) => {
    // `daily --all`: each department runs its own routine in its own process.
    if (flags["all"] === true) {
      const reg = loadRegistry(base ?? cfg);
      const pass = [...(flags["no-model"] === true ? ["--no-model"] : []), ...(typeof flags.skip === "string" ? ["--skip", flags.skip] : [])];
      let failed = 0;
      for (const d of listDepartments(reg)) {
        if (!d.roles.daily) {
          out(`== ${d.name} (${d.id}): daily routine is off, skipped ==`);
          continue;
        }
        out(`== ${d.name} (${d.id}) ==`);
        const r = await runChild(cfg.root, ["daily", "--dept", d.id, ...pass], 120);
        if (r.text) out(r.text);
        if (r.code !== 0) failed++;
      }
      return failed ? 1 : 0;
    }
    if (cfg.roles && cfg.roles["daily"] === false) {
      out(copy.off(cfg.departmentName ?? "this department"));
      return 0;
    }
    const file = join(cfg.root, "roles", "daily.json");
    let steps: Step[];
    try {
      steps = FileSchema.parse(JSON.parse(readFileSync(file, "utf8"))).steps;
    } catch (e) {
      out(copy.badFile(e instanceof Error ? e.message : String(e)));
      return 2;
    }
    const skip = new Set(typeof flags.skip === "string" ? flags.skip.split(",").map((s) => s.trim()) : []);
    const noModel = flags["no-model"] === true;
    const date = localToday();
    const mainTs = join(cfg.root, "engine", "src", "cli", "main.ts");

    out(copy.start(date, steps.length));
    const results: StepResult[] = [];
    for (const step of steps) {
      const t0 = Date.now();
      let r: StepResult;
      if (skip.has(step.id)) r = { id: step.id, status: "skipped", seconds: 0, note: "skipped by --skip", lines: [] };
      else if (step.role && cfg.roles && cfg.roles[step.role] === false) r = { id: step.id, status: "skipped", seconds: 0, note: `helper "${step.role}" is off for this department`, lines: [] };
      else if (step.needsRepo && cfg.departmentId !== undefined && cfg.repos.length === 0) r = { id: step.id, status: "skipped", seconds: 0, note: "needs a git source", lines: [] };
      else if (step.needsModel && noModel) r = { id: step.id, status: "skipped", seconds: 0, note: "needs the model (--no-model)", lines: [] };
      else {
        const { code, text } = await runStep(mainTs, cfg.root, cfg.departmentId !== undefined ? { ...step, argv: [...step.argv, "--dept", cfg.departmentId] } : step);
        const secs = Math.round((Date.now() - t0) / 1000);
        const unknown = /Unknown command/i.test(text);
        const lines = text.split(/\r?\n/).filter(Boolean);
        if (unknown) r = { id: step.id, status: "skipped", seconds: secs, note: "command not available", lines: [] };
        else if (code !== 0 && step.optional) r = { id: step.id, status: "skipped", seconds: secs, note: lines[0]?.slice(0, 120) ?? "optional step could not run", lines: lines.slice(0, REPORT_LINES_PER_STEP) };
        else if (code !== 0) r = { id: step.id, status: "failed", seconds: secs, note: lines[0]?.slice(0, 120) ?? `exit ${code}`, lines: lines.slice(0, REPORT_LINES_PER_STEP) };
        else r = { id: step.id, status: "ok", seconds: secs, note: lines[lines.length - 1]?.slice(0, 120) ?? "", lines: lines.slice(0, REPORT_LINES_PER_STEP) };
      }
      results.push(r);
      out(copy.line(r.id, r.status, r.seconds, r.note));
    }

    const dir = join(cfg.dataDir, "daily");
    mkdirSync(dir, { recursive: true });
    const reportPath = join(dir, `${date}.md`);
    const body =
      `# Daily routine ${date}\n\n` +
      results
        .map((r) => `## ${r.id}: ${r.status} (${r.seconds} s)\n\n${r.lines.length ? "```\n" + r.lines.join("\n") + "\n```\n" : r.note + "\n"}`)
        .join("\n");
    writeFileSync(reportPath, body);
    out(copy.reportAt(reportPath));
    return results.some((r) => r.status === "failed") ? 1 : 0;
  },
};

export { existsSync as _existsForTests };
