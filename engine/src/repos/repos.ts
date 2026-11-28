// The repos the user loaded: their state, branches, commits and diffs. Read-only toward the repos.
// Adding or removing one changes only guard.config.local.json.

import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HttpError } from "../server/http.ts";
import { isSecretPath } from "../tools/native/files.ts";
import { detectSecrets } from "../mask/detectors.ts";
import type { GuardConfig, RepoConfig } from "../types.ts";
import { GitError, safeGit, safeGitTry } from "./safe-git.ts";
import { classifyRemote } from "./hosts.ts";
import type { HostKind, Remote } from "./hosts.ts";

export const MAX_DIFF_FILES = 300;
/** One file's patch text, and all patch text together, as returned to the screen. */
export const MAX_PATCH_CHARS = 100_000;
export const MAX_TOTAL_CHARS = 600_000;
export const MAX_UNTRACKED_BYTES = 256 * 1024;
export const MAX_COMMITS = 200;
export const MAX_REPOS = 40;
export const WORKTREE = "WORKTREE";

export const remoteOf = async (path: string): Promise<Remote> => classifyRemote((await safeGitTry(path, ["config", "--get", "remote.origin.url"])) ?? "");

export function findRepo(cfg: GuardConfig, id: string): RepoConfig {
  const r = cfg.repos.find((x) => x.id === id);
  if (!r) throw new HttpError(404, "No such repo.");
  return r;
}

/** The repo, checked to be an existing folder, for routes that run git in it. */
export function openRepo(cfg: GuardConfig, id: string): RepoConfig {
  const r = findRepo(cfg, id);
  if (!existsSync(r.path)) throw new HttpError(409, "This repo's folder does not exist on this computer.");
  return r;
}

export interface RepoInfo {
  id: string; path: string; exists: boolean; isGit: boolean; branch: string | null; dirtyFiles: number | null;
  ahead: number | null; behind: number | null; host: HostKind;
  lastCommit: { sha: string; subject: string; date: string } | null; error: string | null;
}

export async function repoInfo(r: RepoConfig): Promise<RepoInfo> {
  const info: RepoInfo = {
    id: r.id, path: r.path, exists: false, isGit: false, branch: null, dirtyFiles: null, ahead: null, behind: null,
    host: "unknown", lastCommit: null, error: null,
  };
  try {
    info.exists = statSync(r.path).isDirectory();
  } catch { /* missing */ }
  if (!info.exists) return { ...info, error: "The folder does not exist on this computer." };
  if ((await safeGitTry(r.path, ["rev-parse", "--is-inside-work-tree"]))?.trim() !== "true") {
    return { ...info, error: "Git cannot read this folder as a repository." };
  }
  info.isGit = true;
  const branch = (await safeGitTry(r.path, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  info.branch = branch && branch !== "HEAD" ? branch : null;
  const status = await safeGitTry(r.path, ["status", "--porcelain=v1", "--no-renames", "-z"]);
  info.dirtyFiles = status === null ? null : status.split("\0").filter(Boolean).length;
  // Against the tracking ref already on disk; nothing is fetched.
  const counts = /^(\d+)\s+(\d+)/.exec((await safeGitTry(r.path, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])) ?? "");
  if (counts) {
    info.behind = Number(counts[1]);
    info.ahead = Number(counts[2]);
  }
  info.host = (await remoteOf(r.path)).host;
  const last = (await safeGitTry(r.path, ["log", "-1", "--format=%H%x00%s%x00%aI"]))?.trim().split("\0");
  if (last && last.length === 3) info.lastCommit = { sha: last[0] as string, subject: last[1] as string, date: last[2] as string };
  return info;
}

/* ---------------- adding and removing ---------------- */

const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

/** Rewrites only the repos list; every other key stays. A missing file starts from the settings in use. */
function saveRepos(cfg: GuardConfig, repos: RepoConfig[]): void {
  const file = join(cfg.root, "guard.config.local.json");
  let raw: Record<string, unknown>;
  if (existsSync(file)) {
    try { raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch {
      throw new HttpError(409, "guard.config.local.json is not valid JSON, so it was not changed. Fix it first.");
    }
  } else {
    const { root: _root, repos: _repos, ...rest } = cfg;
    raw = rest;
  }
  raw.repos = repos;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
    throw new HttpError(500, "Could not write guard.config.local.json.");
  }
  // The running server and its tools see the change at once.
  cfg.repos = repos;
}

const samePath = (a: string, b: string): boolean => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

export async function addRepo(cfg: GuardConfig, rawPath: unknown, rawId: unknown): Promise<RepoConfig> {
  const path = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!path || !isAbsolute(path) || /^[\\/]{2}/.test(path)) throw new HttpError(400, "Give the full path of a folder on this computer.");
  let real: string;
  try {
    real = realpathSync.native(path);
    if (!statSync(real).isDirectory()) throw new Error("not a folder");
  } catch { throw new HttpError(400, "That folder does not exist."); }
  if (/^[\\/]{2}/.test(real)) throw new HttpError(400, "Network folders are not supported.");
  const top = (await safeGitTry(real, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) throw new HttpError(400, "That folder is not a git repository.");
  const root = realpathSync.native(top);
  if (cfg.repos.some((r) => samePath(r.path, root))) throw new HttpError(409, "That repo is already loaded.");
  if (cfg.repos.length >= MAX_REPOS) throw new HttpError(409, "Too many repos are loaded.");
  const taken = new Set([...cfg.repos.map((r) => r.id), "vault"]);
  let id: string;
  if (rawId !== undefined && rawId !== "") {
    if (typeof rawId !== "string" || !REPO_ID.test(rawId)) throw new HttpError(400, "A repo id may use letters, digits, dot, underscore and dash.");
    if (taken.has(rawId)) throw new HttpError(409, "That id is already used.");
    id = rawId;
  } else {
    const base = basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "").slice(0, 50) || "repo";
    id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  }
  const entry: RepoConfig = { id, path: root.replace(/\\/g, "/") };
  saveRepos(cfg, [...cfg.repos, entry]);
  return entry;
}

/** Removes the entry only. No file in the repo is touched. */
export function removeRepo(cfg: GuardConfig, id: string): void {
  findRepo(cfg, id);
  saveRepos(cfg, cfg.repos.filter((r) => r.id !== id));
}

/* ---------------- refs, branches, commits ---------------- */

export interface Branch { name: string; remote: boolean; sha: string; date: string; subject: string; ref: string }

export async function listBranches(path: string): Promise<{ current: string | null; branches: Branch[] }> {
  const out = await safeGit(path, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(subject)", "refs/heads", "refs/remotes"]);
  const branches = out.split("\n").flatMap((line): Branch[] => {
    const [ref, sha, date, subject] = line.split("\0");
    if (!ref || !sha || /^refs\/remotes\/.+\/HEAD$/.test(ref)) return [];
    const remote = ref.startsWith("refs/remotes/");
    return [{ name: ref.replace(/^refs\/(?:heads|remotes)\//, ""), remote, sha, date: date ?? "", subject: subject ?? "", ref }];
  });
  const current = (await safeGitTry(path, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  return { current: current && current !== "HEAD" ? current : null, branches };
}

/** The commit a user-given name stands for. Only listed branches, HEAD or a commit hash are accepted. */
export async function resolveRef(path: string, name: string, branches?: Branch[]): Promise<string> {
  const bad = (): never => { throw new HttpError(400, "Use a branch from the list, HEAD or a commit hash."); };
  if (!name || name.startsWith("-")) bad();
  let spec: string;
  if (name === "HEAD" || /^[0-9a-f]{7,64}$/i.test(name)) spec = name;
  else {
    const hit = (branches ?? (await listBranches(path)).branches).find((b) => b.name === name);
    spec = hit ? hit.ref : bad();
  }
  const sha = (await safeGitTry(path, ["rev-parse", "--verify", "--quiet", `${spec}^{commit}`]))?.trim();
  return sha || bad();
}

export async function listCommits(path: string, ref: string, limit: number): Promise<{ sha: string; subject: string; author: string; date: string }[]> {
  const sha = await resolveRef(path, ref);
  const n = Math.min(MAX_COMMITS, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50));
  const out = await safeGit(path, ["log", `--max-count=${n}`, "--format=%H%x00%s%x00%an%x00%aI", sha, "--"]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [h, subject, author, date] = line.split("\0") as [string, string, string, string];
    return { sha: h, subject, author, date };
  });
}

/* ---------------- diffs ---------------- */

export interface RawDiff { baseSha: string; headSha: string | null; text: string }

/** A new file git does not track yet, as a patch. Null when it must not or cannot be read. */
function untrackedChunk(root: string, rel: string): { chunk: string; note: string | null } {
  const head = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n`;
  const skip = (note: string) => ({ chunk: head, note });
  const full = join(root, rel);
  try {
    const st = lstatSync(full);
    if (!st.isFile()) return skip("link or special file");
    // A linked folder inside the repo must not lead the read outside it.
    const inside = relative(realpathSync.native(root), realpathSync.native(full));
    if (isAbsolute(inside) || inside === ".." || inside.startsWith(".." + sep)) return skip("outside the repo");
    if (isSecretPath(rel)) return skip("secret-like file");
    if (st.size > MAX_UNTRACKED_BYTES) return skip("too large");
    const buf = Buffer.alloc(st.size);
    const fd = openSync(full, "r");
    let n = 0;
    try { n = readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
    const data = buf.subarray(0, n);
    if (data.includes(0)) return skip("binary file");
    const lines = data.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (!lines.length) return { chunk: head, note: null };
    return { chunk: `${head}--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => "+" + l).join("\n")}\n`, note: null };
  } catch {
    return skip("could not be read");
  }
}

/** The patch text between a commit and another commit or the working tree. */
export async function rawDiff(path: string, base: string, head: string, ignoreWhitespace = false): Promise<RawDiff & { notes: Map<string, string> }> {
  const { branches } = await listBranches(path);
  const baseSha = await resolveRef(path, base, branches);
  const headSha = head === WORKTREE ? null : await resolveRef(path, head, branches);
  let text = await safeGit(path, [
    "diff", "-M", "-U3", "--src-prefix=a/", "--dst-prefix=b/", ...(ignoreWhitespace ? ["-w"] : []), baseSha, ...(headSha ? [headSha] : []), "--",
  ]);
  const notes = new Map<string, string>();
  if (!headSha) {
    const untracked = (await safeGit(path, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const rel of untracked.slice(0, MAX_DIFF_FILES)) {
      const u = untrackedChunk(path, rel);
      if (u.note) notes.set(rel, u.note);
      if (text && !text.endsWith("\n")) text += "\n";
      text += u.chunk;
    }
  }
  return { baseSha, headSha, text, notes };
}

export interface DiffFileView {
  path: string; status: "added" | "modified" | "deleted" | "renamed"; additions: number; deletions: number; patch: string | null; withheld: string | null;
}

const unquote = (p: string): string => (p.startsWith("\"") && p.endsWith("\"") ? p.slice(1, -1).replace(/\\(["\\])/g, "$1") : p);

function readChunk(chunk: string) {
  const lines = chunk.replace(/\n$/, "").split("\n");
  let status: DiffFileView["status"] = "modified";
  let oldPath = "";
  let newPath = "";
  let binary = false;
  let modeChange = false;
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  const side = (l: string, prefix: string): string => {
    const p = unquote(l.slice(4).replace(/\t.*$/, ""));
    return p === "/dev/null" ? "" : p.startsWith(prefix) ? p.slice(2) : p;
  };
  for (const l of lines.slice(1)) {
    if (l.startsWith("@@")) { inHunk = true; continue; }
    if (inHunk) {
      if (l.startsWith("+")) additions++;
      else if (l.startsWith("-")) deletions++;
    } else if (l.startsWith("new file mode")) status = "added";
    else if (l.startsWith("deleted file mode")) status = "deleted";
    else if (l.startsWith("rename from ")) { status = "renamed"; oldPath = unquote(l.slice(12)); }
    else if (l.startsWith("rename to ")) newPath = unquote(l.slice(10));
    else if (l.startsWith("old mode")) modeChange = true;
    else if (l.startsWith("Binary files") || l.startsWith("GIT binary patch")) binary = true;
    else if (l.startsWith("--- ")) oldPath ||= side(l, "a/");
    else if (l.startsWith("+++ ")) newPath ||= side(l, "b/");
  }
  if (!oldPath && !newPath) {
    // No ---/+++ lines (binary, mode only, empty file): "diff --git a/P b/P".
    const rest = (lines[0] as string).slice("diff --git ".length);
    const half = (rest.length - 5) / 2;
    newPath = Number.isInteger(half) && half > 0 ? rest.slice(2, 2 + half) : rest.split(" b/").pop() ?? rest;
  }
  const path = (status === "deleted" ? oldPath : newPath) || oldPath || newPath;
  return { path, oldPath, status, additions, deletions, binary, modeChange, hunks: inHunk, patch: lines.join("\n") };
}

export const splitDiff = (text: string): string[] => text.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));

/** True when a file's patch must not be shown or sent to a model. */
export function withheldReason(path: string, oldPath: string, patch: string): string | null {
  if (isSecretPath(path) || (oldPath && isSecretPath(oldPath))) return "secret-like file";
  return detectSecrets(patch).length ? "the change looks like it contains a secret" : null;
}

export async function diffView(path: string, base: string, head: string, ignoreWhitespace = false) {
  let raw;
  try {
    raw = await rawDiff(path, base, head, ignoreWhitespace);
  } catch (e) {
    if (e instanceof GitError && e.tooLarge) throw new HttpError(413, "That diff is too large to show. Compare closer commits.");
    throw e;
  }
  const files: DiffFileView[] = [];
  let truncated = false;
  let total = 0;
  for (const chunk of splitDiff(raw.text)) {
    const c = readChunk(chunk);
    // With whitespace ignored, a file whose only changes were whitespace is not a changed file.
    if (ignoreWhitespace && c.status === "modified" && !c.hunks && !c.binary && !c.modeChange) continue;
    if (files.length >= MAX_DIFF_FILES) { truncated = true; break; }
    let withheld = raw.notes.get(c.path) ?? (c.binary ? "binary file" : null) ?? withheldReason(c.path, c.oldPath, c.patch.slice(0, MAX_UNTRACKED_BYTES * 4));
    let patch: string | null = withheld ? null : c.patch;
    if (patch !== null) {
      if (total >= MAX_TOTAL_CHARS) { patch = null; withheld = "left out: the diff is too large"; truncated = true; }
      else {
        if (patch.length > MAX_PATCH_CHARS) { patch = patch.slice(0, MAX_PATCH_CHARS) + "\n... (patch cut: file is large)"; truncated = true; }
        total += patch.length;
      }
    }
    files.push({ path: c.path, status: c.status, additions: c.additions, deletions: c.deletions, patch, withheld });
  }
  return {
    base, head,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    truncated, files,
  };
}
