// Slash commands in the chat box. ROUTE: each command runs as a separate
// `node main.ts <cmd> ...` process through execFile (an argument list, never a shell).
// Why: the commands call process.exit / console.log and may use a lot of memory (index), so a
// child process keeps the server alive and its output easy to capture. Only an allowlist runs.

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A command that runs longer than this is stopped. */
export const COMMAND_TIMEOUT_MS = 15 * 60_000;
/** Captured output cap, so a noisy command cannot fill memory. */
export const MAX_OUTPUT_BYTES = 1_000_000;
export const MAX_COMMAND_LINE = 400;
export const MAX_ARGS = 6;

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "main.ts");

/** Characters a command argument may contain. No shell metacharacters, quotes or spaces. */
const SAFE_ARG = /^[A-Za-z0-9_@.:/\\+=,#~-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface CommandSpec {
  name: string;
  usage: string;
  help: string;
  heavy: boolean;
  /** The command-table key that must exist, for commands another part of Guard adds. */
  requires?: string;
  /** For commands with a fixed first word: the allowed words. Anything else is refused. */
  subs?: string[];
  /** Those sub-commands that are light (do not take the heavy lock). Others are heavy. */
  light?: string[];
  /** Validates the arguments and returns the argv for main.ts, or an error message. */
  build: (args: string[], sub: string | undefined) => { argv: string[] } | { error: string };
}

const noArgs = (cmd: string[]): CommandSpec["build"] => (args) =>
  args.length ? { error: "This command takes no arguments." } : { argv: cmd };

const repoPath = (cmd: string[]): CommandSpec["build"] => (args) =>
  args.length !== 2 || args[0]!.startsWith("-") || args[1]!.startsWith("-")
    ? { error: "Use: <repo> <path>" }
    : { argv: [...cmd, args[0]!, args[1]!] };

/** Free arguments for commands owned by other parts of Guard: safe characters only, no --force. */
const passThrough = (cmd: string[]): CommandSpec["build"] => (args) =>
  args.some((a) => a === "--force" || a === "-f") ? { error: "--force is not allowed from the chat." } : { argv: [...cmd, ...args] };

/** Only these flags may appear (values after them are plain words). */
const noFlagsExcept = (args: string[], allowed: string[]): { error: string } | null => {
  const bad = args.find((a) => a.startsWith("-") && !allowed.includes(a));
  return bad ? { error: `Not allowed here: ${bad}` } : null;
};

export const COMMANDS: CommandSpec[] = [
  { name: "status", usage: "/status", help: "Index counts and last commits", heavy: false, build: noArgs(["status"]) },
  { name: "index", usage: "/index", help: "Re-index the vault and repos (waits if a build runs)", heavy: true, build: noArgs(["index"]) },
  { name: "check", usage: "/check", help: "Check the vault notes for problems", heavy: false, build: noArgs(["check"]) },
  { name: "stale", usage: "/stale", help: "Notes whose code changed", heavy: false, build: noArgs(["stale"]) },
  { name: "history", usage: "/history <repo> <path>", help: "Recent commits for a path", heavy: false, build: repoPath(["history"]) },
  { name: "cochange", usage: "/cochange <repo> <path>", help: "Files that change together", heavy: false, build: repoPath(["cochange"]) },
  { name: "blast", usage: "/blast <repo> <path>", help: "Code that depends on a file", heavy: false, build: repoPath(["graph", "blast"]) },
  { name: "brain", usage: "/brain", help: "Which model backend is used", heavy: false, build: noArgs(["brain", "status"]) },
  {
    name: "diary", usage: "/diary [YYYY-MM-DD]", help: "Draft the diary for a day", heavy: true,
    build: (args) => (args.length > 1 || (args[0] !== undefined && !DATE.test(args[0])) ? { error: "Use: [YYYY-MM-DD]" } : { argv: ["diary", ...args] }),
  },
  {
    name: "mine", usage: "/mine [repo]", help: "Find decisions in Claude sessions (writes proposed notes)", heavy: true,
    build: (args) => (args.length > 1 || args[0]?.startsWith("-") ? { error: "Use: [repo]" } : { argv: ["mine", ...args] }),
  },
  { name: "review", usage: "/review [args]", help: "Review a change", heavy: true, requires: "review", build: passThrough(["review"]) },
  { name: "refactor", usage: "/refactor [args]", help: "Refactor review", heavy: true, requires: "refactor", build: passThrough(["refactor"]) },
  { name: "replay", usage: "/replay [args]", help: "Replay past changes against the rules", heavy: true, requires: "replay", build: passThrough(["replay"]) },
  {
    name: "qa", usage: "/qa status|plan|generate|check|run [args]", help: "QA planning and runs", heavy: true, requires: "qa",
    subs: ["status", "plan", "generate", "check", "run"],
    // plan, check and status do not run tests.
    light: ["status", "plan", "check"],
    build: (args, sub) => (sub === undefined ? { error: "Use: status | plan | generate | check | run" } : { argv: ["qa", sub, ...args] }),
  },
  {
    name: "quiz", usage: "/quiz list | run --no-model", help: "Quiz questions, scored without a model", heavy: false, requires: "quiz",
    subs: ["list", "run"], light: ["list", "run"],
    build: (args, sub) => {
      if (sub === "run" && !args.includes("--no-model")) return { error: "From the chat, run needs --no-model" };
      return noFlagsExcept(args, ["--no-model", "--max"]) ?? { argv: ["quiz", sub ?? "list", ...args] };
    },
  },
  {
    name: "logcheck", usage: "/logcheck [repo] [--since YYYY-MM-DD]", help: "Are AI-log entries kept for each commit", heavy: false, requires: "logcheck",
    build: (args) => {
      const i = args.indexOf("--since");
      const rest = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
      if (i >= 0 && !(args[i + 1] && DATE.test(args[i + 1]!))) return { error: "Use: --since YYYY-MM-DD" };
      if (rest.length > 1 || rest[0]?.startsWith("-")) return { error: "Use: [repo] [--since YYYY-MM-DD]" };
      return { argv: ["logcheck", ...args] };
    },
  },
  {
    name: "rules", usage: "/rules list [--status S]", help: "List proposed and active checks (read only)", heavy: false, requires: "rules",
    subs: ["list"], light: ["list"],
    build: (args) => noFlagsExcept(args, ["--status"]) ?? { argv: ["rules", "list", ...args] },
  },
  {
    name: "prs", usage: "/prs status [repo]", help: "State of the pull-request data", heavy: false, requires: "prs",
    subs: ["status"], light: ["status"],
    build: (args) => (args.length > 1 || args[0]?.startsWith("-") ? { error: "Use: status [repo]" } : { argv: ["prs", "status", ...args] }),
  },
  { name: "daily", usage: "/daily [args]", help: "The daily routine (several steps; waits if a build runs)", heavy: true, requires: "daily", build: passThrough(["daily"]) },
];

export type Parsed =
  | { ok: true; spec: CommandSpec; argv: string[]; heavy: boolean; display: string }
  | { ok: false; error: string };

/** Splits "/name a b" and checks it against the allowlist. Never builds a shell string. */
export function parseSlash(line: string, available: ReadonlySet<string>): Parsed {
  const text = line.trim();
  if (!text.startsWith("/")) return { ok: false, error: "Commands start with /." };
  if (text.length > MAX_COMMAND_LINE) return { ok: false, error: "That command is too long." };
  const tokens = text.slice(1).split(/\s+/).filter(Boolean);
  const name = tokens.shift()?.toLowerCase();
  const spec = COMMANDS.find((c) => c.name === name);
  if (!name || !spec) return { ok: false, error: `Unknown command /${name ?? ""}. Type / to see the list.` };
  if (tokens.length > MAX_ARGS) return { ok: false, error: "Too many arguments." };
  if (tokens.some((t) => t === "--force" || t === "-f")) return { ok: false, error: "--force is not allowed from the chat." };
  for (const t of tokens) {
    if (!SAFE_ARG.test(t) && !/^--[a-z][a-z-]*$/.test(t)) return { ok: false, error: `Not allowed in a command: ${t.replace(/[^\x20-\x7e]/g, "?").slice(0, 20)}` };
  }
  if (spec.requires && !available.has(spec.requires)) return { ok: false, error: `/${spec.name} is not installed in this version of Guard.` };
  let sub: string | undefined;
  let args = tokens;
  if (spec.subs) {
    sub = tokens[0]?.toLowerCase();
    if (sub === undefined || !spec.subs.includes(sub)) return { ok: false, error: `Use: ${spec.usage}` };
    args = tokens.slice(1);
  }
  const b = spec.build(args, sub);
  if ("error" in b) return { ok: false, error: `${b.error} (${spec.usage})` };
  const heavy = spec.light && sub !== undefined ? !spec.light.includes(sub) : spec.heavy;
  return { ok: true, spec, argv: b.argv, heavy, display: "/" + [name, ...tokens].join(" ") };
}

export interface ProcessResult { code: number; stdout: string; stderr: string; timedOut?: boolean }
/** `onChunk` (optional) receives output text as the child writes it; the final result still holds everything. */
export type RunProcess = (argv: string[], cwd: string, onChunk?: (chunk: string) => void) => Promise<ProcessResult>;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export const runMainProcess: RunProcess = (argv, cwd, onChunk) =>
  new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", MAIN, ...argv],
      { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({
          code,
          stdout: String(stdout).replace(ANSI, ""),
          stderr: String(stderr).replace(ANSI, ""),
          ...(err && (err as { killed?: boolean }).killed ? { timedOut: true } : {}),
        });
      },
    );
    if (onChunk) {
      for (const s of [child.stdout, child.stderr]) s?.on("data", (d: string | Buffer) => onChunk(String(d).replace(ANSI, "")));
    }
  });

/** One heavy command at a time. Light commands never wait. */
export class HeavyLock {
  running: string | null = null;
  tryAcquire(name: string): boolean {
    if (this.running) return false;
    this.running = name;
    return true;
  }
  release(): void {
    this.running = null;
  }
}

/** The command names Guard has at runtime (the extra command table). */
export async function loadCommandTable(): Promise<Set<string>> {
  try {
    const m = (await import("../cli/main.ts")) as { EXTRA_COMMANDS?: Record<string, unknown> };
    return new Set(Object.keys(m.EXTRA_COMMANDS ?? {}));
  } catch {
    return new Set();
  }
}
