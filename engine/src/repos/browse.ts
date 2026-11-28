// Folder names for the "Add repository" picker. Directories only: no file names are returned, no
// file is opened and git is never run, so browsing a hostile folder cannot start a program.

import { existsSync, lstatSync, opendirSync, readlinkSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { HttpError } from "../server/http.ts";
import type { GuardConfig } from "../types.ts";

/** Most folders returned for one listing, so a huge folder cannot flood the screen. */
export const MAX_BROWSE_ENTRIES = 500;
/** Most directory records read, because a folder full of files costs time even though none are returned. */
export const MAX_BROWSE_SCAN = 10_000;
/** Reading stops after this long; a slow disk must not hold the request open. */
export const MAX_BROWSE_MS = 2_000;
const MAX_PATH_CHARS = 1_000;
const MAX_LINK_HOPS = 16;

export interface BrowseEntry { name: string; path: string; isGit: boolean; added: boolean }
export interface Suggestion { name: string; path: string; kind: "home" | "projects" | "drive" }
export interface BrowseResult {
  path: string | null;
  parent: string | null;
  /** About the listed folder itself, so a pasted repository path can be added. */
  isGit: boolean;
  added: boolean;
  entries: BrowseEntry[];
  suggestions: Suggestion[];
  truncated: boolean;
}

const windows = process.platform === "win32";
const key = (p: string): string => (windows ? resolve(p).toLowerCase() : resolve(p));

/** UNC and device paths start with two separators. On Windows a local path also needs a drive. */
function checkShape(path: string): void {
  const bad = (message: string): never => { throw new HttpError(400, message); };
  if (path.length > MAX_PATH_CHARS || path.includes("\0")) bad("That path is not valid.");
  if (/^[\\/]{2}/.test(path)) bad("Network and device paths are not supported.");
  if (windows ? !/^[A-Za-z]:[\\/]/.test(path) : !path.startsWith("/")) bad("Type the full path of a folder on this computer.");
  if (windows) {
    const parts = path.slice(2).split(/[\\/]/);
    if (parts.some((p) => p.includes(":") || /^(con|prn|aux|nul|com\d|lpt\d)(\.[^\\/]*)?$/i.test(p))) bad("That path is not valid.");
  }
}

/**
 * Follows links one part at a time and checks each target before touching it, so a link that
 * points to a network share is refused without contacting that share.
 */
function localTarget(path: string): string {
  let current = resolve(path);
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
    const { root } = parse(current);
    const parts = current.slice(root.length).split(sep).filter(Boolean);
    let at = root;
    let followed = false;
    for (let i = 0; i < parts.length; i++) {
      const next = join(at, parts[i] as string);
      if (lstatSync(next).isSymbolicLink()) {
        // Junction targets may carry the \\?\C:\ long-path prefix, which is still a local drive.
        const target = readlinkSync(next).replace(/^\\\\\?\\(?=[A-Za-z]:)/, "");
        if (/^[\\/]{2}/.test(target)) throw new HttpError(400, "That folder links to a network or device location.");
        current = resolve(at, target, ...parts.slice(i + 1));
        checkShape(current);
        followed = true;
        break;
      }
      at = next;
    }
    if (!followed) return current;
  }
  throw new HttpError(400, "That folder has too many links.");
}

/** A .git folder, or the .git file of a worktree. Only its presence is checked. */
const hasGit = (dir: string): boolean => existsSync(join(dir, ".git"));

function suggest(cfg: GuardConfig, home: string): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (name: string, path: string, kind: Suggestion["kind"]): void => {
    if (/^[\\/]{2}/.test(path) || seen.has(key(path)) || !existsSync(path)) return;
    seen.add(key(path));
    out.push({ name, path: resolve(path), kind });
  };
  for (const r of cfg.repos) {
    const parent = dirname(resolve(r.path));
    add(basename(parent) || parent, parent, "projects");
  }
  add("Home", home, "home");
  if (windows) {
    const started = Date.now();
    // A and B are skipped: probing an empty floppy drive can stall.
    for (let code = 67; code <= 90 && Date.now() - started < MAX_BROWSE_MS; code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      add(drive, drive, "drive");
    }
  } else add("/", "/", "drive");
  return out;
}

export function browseFolders(cfg: GuardConfig, raw: string, home: string = homedir()): BrowseResult {
  const wanted = raw.trim();
  if (!wanted) return { path: null, parent: null, isGit: false, added: false, entries: [], suggestions: suggest(cfg, home), truncated: false };
  checkShape(wanted);
  const added = new Set(cfg.repos.map((r) => key(r.path)));
  const shown = resolve(wanted);
  const entries: BrowseEntry[] = [];
  let truncated = false;
  let real: string;
  try {
    real = localTarget(shown);
    const dir = opendirSync(real);
    try {
      const started = Date.now();
      let scanned = 0;
      for (let item: Dirent | null = dir.readSync(); item; item = dir.readSync()) {
        if (++scanned > MAX_BROWSE_SCAN || Date.now() - started > MAX_BROWSE_MS) { truncated = true; break; }
        // Links and junctions report false here, so they are never listed or followed.
        if (!item.isDirectory() || item.name.startsWith(".") || item.name.startsWith("$")) continue;
        if (entries.length >= MAX_BROWSE_ENTRIES) { truncated = true; break; }
        try {
          const path = join(shown, item.name);
          entries.push({ name: item.name, path, isGit: hasGit(join(real, item.name)), added: added.has(key(path)) });
        } catch { /* an entry that cannot be read is left out */ }
      }
    } finally {
      dir.closeSync();
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new HttpError(404, "That folder does not exist.");
    if (code === "ENOTDIR") throw new HttpError(400, "That is not a folder.");
    if (code === "EACCES" || code === "EPERM") throw new HttpError(403, "Windows does not allow REO to open that folder.");
    throw new HttpError(400, "That folder could not be opened.");
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const up = dirname(shown);
  return {
    path: shown, parent: up === shown ? null : up, isGit: hasGit(real), added: added.has(key(shown)) || added.has(key(real)),
    entries, suggestions: [], truncated,
  };
}
