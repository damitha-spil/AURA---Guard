// Small read-only git helpers. Every call is an argument array (paths may hold spaces).
import { execFileSync } from "node:child_process";

/** Largest git output we accept (bytes). A bigger answer is a sign of a wrong ref. */
export const GIT_MAX_BUFFER = 256 * 1024 * 1024;

export function git(repoPath: string, args: string[], input?: string): string {
  return execFileSync("git", ["-C", repoPath, "-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
    ...(input !== undefined ? { input } : {}),
  });
}

/** Runs git and returns null instead of throwing. */
export function gitTry(repoPath: string, args: string[]): string | null {
  try {
    return git(repoPath, args);
  } catch {
    return null;
  }
}

export function revParse(repoPath: string, ref: string): string | null {
  const out = gitTry(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return out ? out.trim() : null;
}

export function pathExistsAt(repoPath: string, ref: string, path: string): boolean {
  return gitTry(repoPath, ["cat-file", "-e", `${ref}:${path}`]) !== null;
}
