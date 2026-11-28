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

const StepSchema = z.object({
  id: z.string(),
  argv: z.array(z.string()).min(1),
  timeoutMin: z.number().positive().default(10),
  optional: z.boolean().default(false),
  needsModel: z.boolean().default(false),
  /** Skipped when the project has no git source. */
  needsRepo: z.boolean().default(false),
});
const FileSchema = z.object({ steps: z.array(StepSchema).min(1) });
type Step = z.infer<typeof StepSchema>;

/**
 * What may run with nobody watching. Fixed in code, because roles/daily.json is a file anyone can
 * edit: a step not listed here needs a person to confirm it. Each entry is the command words and the
 * flags it may carry. These read repositories and write only REO's own data and proposed notes.
 */
const UNATTENDED: { words: string[]; args?: number; flags?: string[] }[] = [
  { words: ["index"] },
  { words: ["check"] },
  { words: ["health"] },
  { words: ["stale"] },
  { words: ["logcheck"] },
  { words: ["prs", "sync"] },
  { words: ["prs", "mine"], flags: ["--min-score", "--max"] },
  { words: ["mine"], flags: ["--min-score", "--max"] },
  { words: ["rules", "propose"] },
  { words: ["qa", "backend"] },
  { words: ["qa", "pr-readiness"], args: 1 },
  { words: ["qa", "status"] },
];

/** Why a step may not run unattended, or null when it may. */
export function unattendedRefusal(argv: string[], needsModel: boolean): string | null {
  if (needsModel) return "needs confirmation: it calls a model";
  const rule = UNATTENDED.find((r) => r.words.every((w, i) => argv[i] === w));
  if (!rule) return `needs confirmation: "${argv.slice(0, 2).join(" ")}" is not on the read-only list`;
  let args = 0;
  for (let i = rule.words.length; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("-")) {
      if (!rule.flags?.includes(a) || !/^\d+(\.\d+)?$/.test(argv[i + 1] ?? "")) return `needs confirmation: option ${a} is not on the read-only list`;
      i++;
    } else if (++args > (rule.args ?? 0)) return "needs confirmation: extra arguments are not on the read-only list";
  }
  return null;
}

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
    const child = execFile(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", mainTs, ...step.argv],
      { cwd, timeout: step.timeoutMin * 60_000, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (err, stdout, stderr) => {
        const text = `${stdout}${stderr}`.trim();
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, text });
      },
    );
    // No input is ever given, so a step that asks a question ends instead of waiting.
    child.stdin?.end();
  });
}

export const dailyCommands: Record<string, (ctx: CommandContext) => Promise<number> | number> = {
  daily: async ({ flags, out, cfg }) => {
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
    // No terminal means nobody can answer, so it counts as unattended.
    const unattended = flags["unattended"] === true || !process.stdin.isTTY;
    const date = localToday();
    const mainTs = join(cfg.root, "engine", "src", "cli", "main.ts");

    out(copy.start(date, steps.length));
    const results: StepResult[] = [];
    for (const step of steps) {
      const t0 = Date.now();
      let r: StepResult;
      const refused = unattended ? unattendedRefusal(step.argv, step.needsModel) : null;
      if (skip.has(step.id)) r = { id: step.id, status: "skipped", seconds: 0, note: "skipped by --skip", lines: [] };
      else if (step.needsRepo && cfg.repos.length === 0) r = { id: step.id, status: "skipped", seconds: 0, note: "needs a git source", lines: [] };
      else if (refused) r = { id: step.id, status: "skipped", seconds: 0, note: `unattended run, ${refused}`, lines: [] };
      else if (step.needsModel && noModel) r = { id: step.id, status: "skipped", seconds: 0, note: "needs the model (--no-model)", lines: [] };
      else {
        const { code, text } = await runStep(mainTs, cfg.root, step);
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
