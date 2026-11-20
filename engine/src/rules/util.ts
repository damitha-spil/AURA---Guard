// Small helpers shared by the learn commands (quiz, rules, logcheck, support).

import { execFile } from "node:child_process";

export function localToday(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// A git call may not run longer than this; a stuck repo must not hang a command.
const GIT_TIMEOUT_MS = 60_000;
// Output cap for one git call (long histories); larger output fails loudly instead of truncating.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Runs a READ-ONLY git command with an argument list (never a shell string). */
export function gitRead(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Reads `--name value` from a command context, falling back to argv when main.ts does not know the flag. */
export function flagString(
  flags: Record<string, string | true>,
  rest: string[],
  name: string,
): { value: string | undefined; rest: string[] } {
  const f = flags[name];
  if (typeof f === "string") return { value: f, rest };
  if (f !== true) return { value: undefined, rest };
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (v !== undefined && !v.startsWith("--")) {
    const j = rest.indexOf(v);
    return { value: v, rest: j >= 0 ? [...rest.slice(0, j), ...rest.slice(j + 1)] : rest };
  }
  return { value: undefined, rest };
}
