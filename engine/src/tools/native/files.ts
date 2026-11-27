// list_dir, read_file and search_files: read-only, only inside the configured repos and the vault.
// Paths are written <repoId>/relative/path or vault/relative/path.

import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { GuardConfig } from "../../types.ts";
import { redactSecrets, ToolError, truncate } from "./common.ts";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ENTRIES = 500;
export const MAX_MATCHES = 100;
/** Search stops after this many files or this long, so a huge tree cannot stall the server. */
export const MAX_SEARCH_FILES = 20_000;
export const SEARCH_TIMEOUT_MS = 15_000;
const MAX_DEPTH = 25;
const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "bin", "obj", ".venv", "__pycache__", ".artifacts"]);

/** Folders that hold keys or credentials (.git: its config can carry tokens). */
const SECRET_DIRS = new Set([".git", ".ssh", ".aws", ".azure", ".gnupg", "secrets", ".secrets"]);
const SECRET_NAMES = [
  /^\.env/i, /\.env$/i,
  /\.(?:pem|key|pfx|p12|pk8|jks|keystore|kdbx|ppk|publishsettings|pubxml(?:\.user)?)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i,
  /^\.(?:npmrc|netrc|pypirc|git-credentials|htpasswd)$/i,
  /^guard\.config.*\.json$/i,
  // Application settings files usually carry connection strings.
  /^(?:appsettings.*\.json|local\.settings\.json|secrets?\.json|launch-token|connectionstrings\.config)$/i,
];
/** "secret" or "credential" in a data file's name. Source code with such a name is readable (values are redacted). */
const SECRET_WORD = /(?:secret|credential)/i;
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|rs|cs|py|java|go|md|sql|html|css)$/i;

/** True when any part of a relative path is a place Guard will not read. */
export function isSecretPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts.some((p, i) => {
    const name = p.toLowerCase();
    if (SECRET_DIRS.has(name)) return true;
    if (SECRET_NAMES.some((re) => re.test(name))) return true;
    return i === parts.length - 1 && SECRET_WORD.test(name) && !SOURCE_FILE.test(name);
  });
}

export function fileRoots(cfg: GuardConfig): { id: string; path: string }[] {
  return [...cfg.repos.filter((r) => r.id !== "vault").map((r) => ({ id: r.id, path: r.path })), { id: "vault", path: cfg.vaultDir }];
}

const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
};

function realOrNull(path: string): string | null {
  try { return realpathSync.native(path); } catch { return null; }
}

const refused = (): ToolError => new ToolError("Refused: that file may hold keys or credentials.", true);

/** The real path behind <rootId>/rel, after traversal, link-escape and secret-file checks. */
export function resolveToolPath(cfg: GuardConfig, input: string): { root: string; full: string; shown: string } {
  const parts = input.trim().replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const [id, ...rest] = parts;
  const roots = fileRoots(cfg);
  const root = roots.find((r) => r.id === id);
  if (!root) throw new ToolError(`Write paths as <name>/relative/path. Names: ${roots.map((r) => r.id).join(", ")}.`);
  // ":" blocks drive letters and NTFS streams; Windows ignores trailing dots and spaces, which would dodge name checks.
  if (rest.some((p) => p === "" || p === "." || p === ".." || p.includes(":") || p.includes("\0") || /[. ]$/.test(p))) {
    throw new ToolError("Refused: the path must be plain and relative, without \"..\".", true);
  }
  if (isSecretPath(rest.join("/"))) throw refused();
  const realRoot = realOrNull(root.path);
  if (!realRoot) throw new ToolError(`The folder for "${root.id}" does not exist on this computer.`);
  const full = realOrNull(join(realRoot, ...rest));
  if (!full) throw new ToolError("No such file or folder.");
  if (!inside(realRoot, full)) throw new ToolError("Refused: that path leads outside the allowed folder.", true);
  // Checked again on the real path: a link or a short 8.3 name must not hide a secret file.
  if (isSecretPath(relative(realRoot, full)) || insideSecretData(cfg, full)) throw refused();
  return { root: realRoot, full, shown: [root.id, ...rest].join("/") };
}

/** Guard's own data folder holds saved keys, tokens and chats. */
function insideSecretData(cfg: GuardConfig, full: string): boolean {
  const data = realOrNull(cfg.dataDir);
  return !!data && inside(data, full);
}

export function listDir(cfg: GuardConfig, input: string): string {
  if (!input.trim()) return fileRoots(cfg).map((r) => `${r.id}/`).join("\n");
  const { full } = resolveToolPath(cfg, input);
  if (!statSync(full).isDirectory()) throw new ToolError("That is a file. Use /read for it.");
  const names = readdirSync(full, { withFileTypes: true })
    .filter((e) => !isSecretPath(e.name))
    .map((e) => e.name + (e.isDirectory() ? "/" : e.isSymbolicLink() ? " (link)" : ""))
    .sort();
  if (!names.length) return "(empty)";
  const more = names.length > MAX_ENTRIES ? `\n... and ${names.length - MAX_ENTRIES} more` : "";
  return truncate(names.slice(0, MAX_ENTRIES).join("\n") + more);
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export function readTextFile(cfg: GuardConfig, input: string): string {
  const { full } = resolveToolPath(cfg, input);
  const st = statSync(full);
  if (!st.isFile()) throw new ToolError("That is not a file. Use /ls for a folder.");
  // Only the start of a large file is read.
  const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
  const fd = openSync(full, "r");
  let n = 0;
  try { n = readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
  const data = buf.subarray(0, n);
  if (looksBinary(data)) throw new ToolError("This is a binary file; only text files can be read.");
  return truncate(redactSecrets(data.toString("utf8")));
}

/** Plain text search (not a pattern), ignoring case, across every allowed folder. */
export async function searchFiles(cfg: GuardConfig, text: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const needle = text.trim().toLowerCase();
  if (needle.length < 2) throw new ToolError("Type at least two characters to find.");
  const deadline = Date.now() + (opts.timeoutMs ?? SEARCH_TIMEOUT_MS);
  const out: string[] = [];
  let seen = 0;
  let stopped = "";
  for (const root of fileRoots(cfg)) {
    const real = realOrNull(root.path);
    if (!real) continue;
    const stack: { dir: string; rel: string; depth: number }[] = [{ dir: real, rel: "", depth: 0 }];
    while (stack.length && !stopped) {
      const { dir, rel, depth } = stack.pop()!;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        // Links are never followed, so the walk cannot leave the folder.
        if (e.isSymbolicLink() || isSecretPath(r)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && depth < MAX_DEPTH && !insideSecretData(cfg, full)) stack.push({ dir: full, rel: r, depth: depth + 1 });
          continue;
        }
        if (!e.isFile()) continue;
        if (++seen > MAX_SEARCH_FILES) stopped = "file limit";
        else if (Date.now() > deadline) stopped = "time limit";
        if (stopped) break;
        // Lets the server answer other requests during a long search.
        if (seen % 50 === 0) await new Promise<void>((res) => setImmediate(res));
        let body: string;
        try {
          if (statSync(full).size > MAX_FILE_BYTES) continue;
          const buf = readFileSync(full);
          if (looksBinary(buf)) continue;
          body = buf.toString("utf8");
        } catch { continue; }
        if (!body.toLowerCase().includes(needle)) continue;
        // Matched again after redaction, so a search cannot be used to probe a secret value.
        const lines = redactSecrets(body).split("\n");
        for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
          const line = lines[i] as string;
          if (line.toLowerCase().includes(needle)) out.push(`${root.id}/${r}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
        if (out.length >= MAX_MATCHES) { stopped = "match limit"; break; }
      }
    }
    if (stopped) break;
  }
  const note = stopped ? `\n(stopped at the ${stopped}; the results may be incomplete)` : "";
  return truncate(out.length ? out.join("\n") : "No matches.") + note;
}
