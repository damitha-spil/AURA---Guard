import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface RunOpts {
  cwd?: string;
  timeout: number;
  maxBuffer: number;
}
/** Runs a program with an argument array (never a shell string). */
export type Runner = (file: string, args: string[], opts: RunOpts) => Promise<{ stdout: string }>;

export const defaultRunner: Runner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
      // The Guard CLI prints a JSON error object and may also exit non-zero; keep the text.
      if (err && !stdout) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });

// Limits for every child process.
export const QUICK_MS = 30_000;
export const SUMMARIZE_MS = 180_000;
export const OUT_CAP = 8 * 1024 * 1024;
export const UI_MS = 12 * 60 * 60 * 1000; // the chat window stays up while the developer uses it

export class GuardError extends Error {}

export interface StatusResult {
  ok: true;
  spoolDir: string;
  consent: { accepted: boolean; developer?: string };
  repos: { repoKey: string; days: number; events: number; oldest?: string; newest?: string }[];
}
export interface SummarizeResult {
  ok: true;
  date: string;
  file: string;
  draft: string;
  entries: number;
  commits: number;
  ideas: string[];
  questions: string[];
  sources: Record<string, unknown>;
  backend: string;
}
export interface AnswerResult {
  ok: true;
  text: string;
  sources: { ref: string; kind?: string; title?: string; status?: string }[];
  backend: string;
}

/** The guard folder must be a real Guard clone. Returns an error message, or null when fine. */
export function validateGuardHome(home: string, exists: (p: string) => boolean = existsSync): string | null {
  if (!home.trim()) return "Set auraGuard.guardHome to the folder of your SPIL AURA QA Bot clone.";
  if (!exists(home)) return "The SPIL AURA QA Bot folder does not exist.";
  if (!exists(join(home, "engine", "src", "cli", "main.ts"))) return "That folder is not an SPIL AURA QA Bot clone (engine/src/cli/main.ts is missing).";
  if (!exists(join(home, "bin", "aura-guard.mjs"))) return "That folder is missing bin/aura-guard.mjs.";
  return null;
}

export class GuardCli {
  private guardHome: string;
  private nodePath: string;
  private run: Runner;
  constructor(guardHome: string, nodePath: string, run: Runner = defaultRunner) {
    this.guardHome = guardHome;
    this.nodePath = nodePath;
    this.run = run;
  }

  /** Argument array for one Guard command. */
  argv(args: string[]): string[] {
    return [join(this.guardHome, "bin", "aura-guard.mjs"), ...args, "--json"];
  }

  async call<T>(args: string[], timeout = QUICK_MS): Promise<T> {
    let stdout: string;
    try {
      ({ stdout } = await this.run(this.nodePath || "node", this.argv(args), { cwd: this.guardHome, timeout, maxBuffer: OUT_CAP }));
    } catch (e) {
      throw new GuardError(`Could not run SPIL AURA QA Bot: ${(e as Error).message.split("\n")[0]}`);
    }
    let j: unknown;
    try {
      j = JSON.parse(stdout.trim());
    } catch {
      throw new GuardError("SPIL AURA QA Bot did not return JSON.");
    }
    const o = j as { ok?: boolean; error?: string };
    if (!o || o.ok !== true) throw new GuardError(o?.error ? String(o.error) : "SPIL AURA QA Bot reported a failure.");
    return j as T;
  }

  status() {
    return this.call<StatusResult>(["capture", "status"]);
  }
  show(repoPath: string, date?: string) {
    return this.call<{ ok: true; date: string; events: unknown[] }>(["capture", "show", "--repo", repoPath, ...(date ? ["--date", date] : [])]);
  }
  summarize(repoPath: string, date?: string, noModel = false) {
    return this.call<SummarizeResult>(
      ["capture", "summarize", "--repo", repoPath, ...(date ? ["--date", date] : []), ...(noModel ? ["--no-model"] : [])],
      SUMMARIZE_MS,
    );
  }
  purge(repoPath: string, opt: { before?: string; all?: boolean }) {
    return this.call<{ ok: true; removed: number }>(["capture", "purge", "--repo", repoPath, ...(opt.all ? ["--all"] : opt.before ? ["--before", opt.before] : ["--all"])]);
  }
  answer(question: string, notesOnly = false) {
    // A question that starts with a dash must not be read as an option.
    const q = question.startsWith("-") ? `Q: ${question}` : question;
    return this.call<AnswerResult>(["answer", q, ...(notesOnly ? ["--notes-only"] : [])], SUMMARIZE_MS);
  }
  /** Starts the chat window. Not awaited by callers; the process lives until the window is closed. */
  openUi(): Promise<{ stdout: string }> {
    return this.run(this.nodePath || "node", [join(this.guardHome, "bin", "aura-guard.mjs"), "ui"], { cwd: this.guardHome, timeout: UI_MS, maxBuffer: OUT_CAP });
  }
}
