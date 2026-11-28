// Per-machine provider settings: on or off, a name for the screen and, for the CLIs, where the
// program and its settings folder are. There are on purpose no free launch arguments, environment
// variables or API addresses: they could undo the text-only lockdown or send keys elsewhere.

import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

export interface ProviderEntry { enabled?: boolean; displayName?: string; binaryPath?: string; homeDir?: string }

export const MAX_DISPLAY_NAME = 60;
export const MAX_PATH_CHARS = 500;
export const DEFAULT_HEALTH_SECONDS = 300;
export const MIN_HEALTH_SECONDS = 60;
export const MAX_HEALTH_SECONDS = 3600;

export const CLI_PROGRAMS: Record<string, string> = { "claude-cli": "claude", "antigravity-cli": "agy", "opencode-cli": "opencode" };

/**
 * Only where the CLI documents a variable for it: Claude Code documents CLAUDE_CONFIG_DIR
 * (code.claude.com/docs/en/env-vars). No such variable was verified for agy or OpenCode.
 */
export const HOME_DIR_ENV: Record<string, string> = { "claude-cli": "CLAUDE_CONFIG_DIR" };

export const programName = (id: string, platform: string = process.platform): string => `${CLI_PROGRAMS[id]}${platform === "win32" ? ".exe" : ""}`;

const isNetworkPath = (p: string): boolean => /^[\\/]{2}/.test(p);

function localPath(p: string, kind: "file" | "folder"): string | null {
  if (!p || p.length > MAX_PATH_CHARS || p.includes("\0") || !isAbsolute(p) || isNetworkPath(p)) return `Give the full path of a local ${kind}.`;
  try {
    const st = statSync(p);
    if (kind === "file" ? !st.isFile() : !st.isDirectory()) return `That is not a ${kind}.`;
    if (isNetworkPath(realpathSync.native(p))) return "Network locations are not allowed.";
  } catch {
    return `That ${kind} does not exist.`;
  }
  return null;
}

/** Null when the path may be started for this CLI, otherwise why not. */
export function binaryPathProblem(id: string, p: string, platform: string = process.platform): string | null {
  if (!CLI_PROGRAMS[id]) return "Only CLI providers have a program path.";
  const want = programName(id, platform);
  const name = basename(p);
  if (platform === "win32" ? name.toLowerCase() !== want : name !== want) return `The program file must be named ${want}.`;
  return localPath(p, "file");
}

export function homeDirProblem(id: string, p: string): string | null {
  if (!HOME_DIR_ENV[id]) return "This provider has no settings-folder option.";
  return localPath(p, "folder");
}
