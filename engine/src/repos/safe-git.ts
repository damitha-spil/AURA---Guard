// Git for repositories Guard did not create. Only commands that cannot write are allowed, and the
// repo's own config cannot make git run a program: hooks, fsmonitor, external diff, textconv and
// clean/smudge/process filters are switched off, submodules are not entered and nothing is fetched.

import { execFile, execFileSync } from "node:child_process";
import { devNull } from "node:os";

export const GIT_TIMEOUT_MS = 20_000;
/** Most output kept from one git command. A larger diff is reported as too large. */
export const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** The same list as in AGENTS.md. `config` is allowed only in its two reading forms below. */
export const READ_ONLY_COMMANDS: readonly string[] = ["log", "show", "ls-files", "rev-parse", "rev-list", "cat-file", "diff", "status", "for-each-ref", "config"];

export class GitError extends Error {
  tooLarge: boolean;
  constructor(message: string, tooLarge = false) {
    super(message);
    this.name = "GitError";
    this.tooLarge = tooLarge;
  }
}

function checkCommand(args: string[]): void {
  const [cmd, first] = args;
  if (!cmd || !READ_ONLY_COMMANDS.includes(cmd)) throw new GitError(`git ${cmd ?? ""} is not allowed.`);
  if (cmd === "config" && !(first === "--get" || first === "--null")) throw new GitError("Only reading git config is allowed.");
  if (args.some((a) => a === "--output" || a.startsWith("--output=") || a === "--ext-diff" || a === "--textconv")) {
    throw new GitError("That git option is not allowed.");
  }
}

/** Extra flags every diff-producing command gets. */
function hardened(args: string[]): string[] {
  const [cmd, ...rest] = args as [string, ...string[]];
  if (cmd === "diff") return [cmd, "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-color", ...rest];
  if (cmd === "status") return [cmd, "--ignore-submodules=all", ...rest];
  if (cmd === "log" || cmd === "show") return [cmd, "--no-ext-diff", "--no-textconv", "--no-show-signature", ...rest];
  return args;
}

function environment(overrides: [string, string][]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Inherited GIT_* variables could point git elsewhere or name a program to run.
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith("GIT_")) env[k] = v;
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_COUNT: String(overrides.length) });
  overrides.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

const BASE: [string, string][] = [
  ["core.fsmonitor", "false"], ["core.hooksPath", devNull], ["core.quotepath", "false"], ["core.pager", "cat"],
  ["protocol.allow", "never"], ["log.showSignature", "false"],
];

const argv = (args: string[]): string[] => ["--no-optional-locks", "--literal-pathspecs", ...hardened(args)];
const options = (cwd: string, overrides: [string, string][]) => ({
  cwd, env: environment(overrides), encoding: "utf8" as const, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT_BYTES, windowsHide: true,
});

/** Overrides that empty every filter the config names. Reading config runs nothing. */
function filterOverrides(names: string): [string, string][] {
  const drivers = new Set(names.split("\0").filter(Boolean).map((k) => k.slice("filter.".length, k.lastIndexOf("."))));
  return [...drivers].flatMap((d): [string, string][] => [
    [`filter.${d}.clean`, ""], [`filter.${d}.smudge`, ""], [`filter.${d}.process`, ""], [`filter.${d}.required`, "false"],
  ]);
}

const LIST_FILTERS = ["config", "--null", "--name-only", "--get-regexp", "^filter\\."];

function overridesFor(cwd: string): [string, string][] {
  try {
    return [...BASE, ...filterOverrides(execFileSync("git", argv(LIST_FILTERS), { ...options(cwd, BASE), stdio: ["ignore", "pipe", "ignore"] }))];
  } catch (e) {
    // Status 1 means no filter is configured. Anything else means they could not be listed.
    if ((e as { status?: number }).status === 1) return BASE;
    throw new GitError("Git could not read this folder's settings.");
  }
}

export function safeGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      checkCommand(args);
      const o = options(cwd, overridesFor(cwd));
      execFile("git", argv(args), o, (e, stdout) => {
        if (!e) return resolve(stdout);
        const tooLarge = (e as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        reject(new GitError(tooLarge ? "Git's answer was too large." : "Git could not run that on this folder.", tooLarge));
      });
    } catch (e) {
      reject(e);
    }
  });
}

/** Like safeGit but null on any failure. */
export const safeGitTry = (cwd: string, args: string[]): Promise<string | null> => safeGit(cwd, args).catch(() => null);

export function safeGitSync(cwd: string, args: string[]): string | null {
  try {
    checkCommand(args);
    return execFileSync("git", argv(args), { ...options(cwd, overridesFor(cwd)), stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
