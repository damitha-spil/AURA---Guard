// Safe CLI probe runner & read-only repo file walker.
// Every external binary runs via execFile with shell=false and an explicit argument array.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { GuardConfig } from "../types.ts";

/** Default bounded timeout for optional external scanners. */
export const CLI_DEFAULT_TIMEOUT_MS = 15_000;
/** Maximum captured stdout/stderr buffer for optional scanners (4 MB). */
export const CLI_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Default cap on walked files per static scan so large monorepos stay fast. */
export const DEFAULT_MAX_WALK_FILES = 400;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  "coverage",
  ".artifacts",
  ".cache",
  "__pycache__",
]);

export interface OptionalCliResult {
  available: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function execCandidate(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; input?: string },
): Promise<{ missing: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: CLI_MAX_BUFFER_BYTES,
        windowsHide: true,
        shell: false,
      },
      (err, stdout, stderr) => {
        if (!err) {
          done({ missing: false, exitCode: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
          return;
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EINVAL") {
          done({ missing: true, exitCode: null, stdout: "", stderr: "" });
          return;
        }
        const status = typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1;
        done({ missing: false, exitCode: status, stdout: String(stdout ?? ""), stderr: String(stderr ?? err.message) });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

/**
 * Invoke an optional CLI binary if installed on PATH without ever using a shell.
 * Returns `{ available: false }` cleanly when the binary is absent.
 */
export async function runOptionalCli(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; input?: string } = {},
): Promise<OptionalCliResult> {
  const timeoutMs = opts.timeoutMs ?? CLI_DEFAULT_TIMEOUT_MS;
  const candidates = process.platform === "win32" && !bin.includes(".") ? [bin, `${bin}.exe`] : [bin];
  for (const candidate of candidates) {
    const res = await execCandidate(candidate, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      timeoutMs,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
    if (!res.missing) {
      return { available: true, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
    }
  }
  return { available: false, exitCode: null, stdout: "", stderr: "" };
}

/** Pick the target configured repo cleanly without ever modifying it. */
export function resolveTargetRepo(
  cfg: GuardConfig,
  repoId?: string,
  targetDir?: string,
): { id: string; path: string } | null {
  if (targetDir && targetDir.trim()) {
    const resolved = resolve(targetDir.trim());
    if (existsSync(resolved)) {
      return { id: repoId?.trim() || "custom-dir", path: resolved };
    }
  }
  const match =
    (repoId ? cfg.repos.find((r) => r.id === repoId) : undefined) ??
    cfg.repos.find((r) => r.id === "spil-aura") ??
    cfg.repos[0];
  if (match && existsSync(match.path)) {
    return { id: match.id, path: resolve(match.path) };
  }
  if (existsSync(cfg.root)) {
    return { id: repoId?.trim() || "reo-root", path: resolve(cfg.root) };
  }
  return null;
}

/** Recursively list source files (read-only) with forward-slash paths. */
export function walkRepoSourceFiles(
  repoPath: string,
  opts: { maxFiles?: number; exts?: string[] } = {},
): string[] {
  const root = resolve(repoPath);
  if (!existsSync(root)) return [];
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_WALK_FILES;
  const extSet = opts.exts ? new Set(opts.exts.map((e) => e.toLowerCase())) : null;
  const out: string[] = [];

  const visit = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        visit(join(dir, entry.name));
      } else if (entry.isFile()) {
        const full = join(dir, entry.name);
        if (!full.startsWith(root + sep)) continue;
        if (extSet) {
          const dot = entry.name.lastIndexOf(".");
          const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : "";
          if (!extSet.has(ext)) continue;
        }
        out.push(relative(root, full).replace(/\\/g, "/"));
      }
    }
  };

  visit(root);
  return out.sort();
}
