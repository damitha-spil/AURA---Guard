// Reads a git diff into files, hunks and line numbers. Read-only.
import { git, gitTry, revParse } from "./git.ts";

/** Prompt budget for all patch text in one model call (characters, about 12k tokens). */
export const MAX_TOTAL_PATCH_CHARS = 48_000;
/** One file's patch text is cut here, so one big file cannot use the whole budget. */
export const MAX_PATCH_CHARS_PER_FILE = 12_000;
/** More changed files than this are not reviewed; the rest are listed as skipped. */
export const MAX_FILES = 80;
/** Added lines kept per file for the fixed checks (a generated file can have millions). */
export const MAX_ADDED_LINES_PER_FILE = 5_000;

/** Files that are noise for a review: lockfiles, generated output, vendored, binary-ish assets. */
export const SKIP_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock|poetry\.lock|Gemfile\.lock)$/,
  /\.lock$/,
  /(^|\/)(node_modules|dist|target|build|\.next|coverage)\//,
  /(^|\/)gen\/schemas\//,
  /\.min\.(js|css)$/,
  /\.(snap|map)$/,
  /\.d\.ts$/,
  /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|woff2?|ttf|otf|mp4|mov|exe|dll|bin|wasm)$/i,
  /(^|\/)(\.artifacts|ai-log)\//,
];

export function skipReason(path: string): string | null {
  return SKIP_PATH_PATTERNS.some((re) => re.test(path)) ? "lockfile, generated or binary file" : null;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  /** Line numbers (new side) of added lines. */
  added: number[];
  /** Line numbers (old side) of removed lines. */
  removed: number[];
  addedLines: { line: number; text: string }[];
  hunks: Hunk[];
  patch: string;
  patchTruncated: boolean;
}

export interface SkippedFile { path: string; reason: string }

export interface DiffResult {
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  files: DiffFile[];
  skipped: SkippedFile[];
}

/** Default base: merge-base with origin/development when that ref exists, else HEAD~1. */
export function defaultBase(repoPath: string, head = "HEAD"): string {
  if (revParse(repoPath, "origin/development")) {
    const mb = gitTry(repoPath, ["merge-base", "origin/development", head]);
    if (mb && mb.trim()) return mb.trim();
  }
  return `${head}~1`;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function stripTab(p: string): string {
  const t = p.indexOf("\t");
  return t >= 0 ? p.slice(0, t) : p;
}

/** Parses `git diff` output. Exported for tests. */
export function parseDiff(text: string): { files: DiffFile[]; skipped: SkippedFile[] } {
  const files: DiffFile[] = [];
  const skipped: SkippedFile[] = [];
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let status: FileStatus = "modified";
    let binary = false;
    let i = 1;
    for (; i < lines.length; i++) {
      const l = lines[i] as string;
      if (l.startsWith("@@")) break;
      if (l.startsWith("new file mode")) status = "added";
      else if (l.startsWith("deleted file mode")) status = "deleted";
      else if (l.startsWith("rename from ")) { oldPath = l.slice(12); status = "renamed"; }
      else if (l.startsWith("rename to ")) newPath = l.slice(10);
      else if (l.startsWith("Binary files") || l.startsWith("GIT binary patch")) binary = true;
      else if (l.startsWith("--- ")) {
        const p = stripTab(l.slice(4));
        if (p !== "/dev/null") oldPath = oldPath ?? p.replace(/^a\//, "");
      } else if (l.startsWith("+++ ")) {
        const p = stripTab(l.slice(4));
        if (p !== "/dev/null") newPath = p.replace(/^b\//, "");
      }
    }
    if (!newPath && !oldPath) {
      // No ---/+++ (binary, mode change): "diff --git a/P b/P" with equal paths.
      const rest = (lines[0] as string).slice("diff --git ".length);
      const half = (rest.length - 5) / 2;
      newPath = Number.isInteger(half) ? rest.slice(2, 2 + half) : (rest.split(" b/")[1] ?? rest);
    }
    const path = (status === "deleted" ? oldPath : newPath) ?? oldPath ?? "";
    const why = binary ? "binary file" : skipReason(path);
    if (why) { skipped.push({ path, reason: why }); continue; }

    const f: DiffFile = {
      path, oldPath: status === "renamed" ? oldPath : null, status,
      added: [], removed: [], addedLines: [], hunks: [], patch: "", patchTruncated: false,
    };
    let newLine = 0;
    let oldLine = 0;
    let inHunk = false;
    for (; i < lines.length; i++) {
      const l = lines[i] as string;
      const h = HUNK_RE.exec(l);
      if (h) {
        oldLine = Number(h[1]);
        newLine = Number(h[3]);
        f.hunks.push({
          oldStart: oldLine, oldLines: h[2] === undefined ? 1 : Number(h[2]),
          newStart: newLine, newLines: h[4] === undefined ? 1 : Number(h[4]), header: h[5] ?? "",
        });
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      const c = l[0];
      if (c === "+") {
        f.added.push(newLine);
        if (f.addedLines.length < MAX_ADDED_LINES_PER_FILE) f.addedLines.push({ line: newLine, text: l.slice(1) });
        newLine++;
      } else if (c === "-") {
        f.removed.push(oldLine);
        oldLine++;
      } else if (c === " ") {
        newLine++;
        oldLine++;
      }
    }
    const patch = chunk.replace(/\n$/, "");
    if (patch.length > MAX_PATCH_CHARS_PER_FILE) {
      f.patch = patch.slice(0, MAX_PATCH_CHARS_PER_FILE) + "\n... (patch cut: file is large)";
      f.patchTruncated = true;
    } else f.patch = patch;
    files.push(f);
  }
  return { files, skipped };
}

export function readDiff(repoPath: string, opts: { base?: string; head?: string } = {}): DiffResult {
  const head = opts.head ?? "HEAD";
  const base = opts.base ?? defaultBase(repoPath, head);
  const baseSha = revParse(repoPath, base);
  const headSha = revParse(repoPath, head);
  if (!baseSha) throw new Error(`Unknown base ref "${base}".`);
  if (!headSha) throw new Error(`Unknown head ref "${head}".`);
  const text = git(repoPath, ["diff", "--no-color", "--no-ext-diff", "-M", "-U3", baseSha, headSha]);
  const parsed = parseDiff(text);
  let files = parsed.files;
  const skipped = [...parsed.skipped];
  if (files.length > MAX_FILES) {
    for (const f of files.slice(MAX_FILES)) skipped.push({ path: f.path, reason: `more than ${MAX_FILES} files changed` });
    files = files.slice(0, MAX_FILES);
  }
  return { base, head, baseSha, headSha, files, skipped };
}
