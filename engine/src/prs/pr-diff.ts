// The changes in one pull request, in the same shape as the repo diff API (`diffView`).
//
// Read-only. First choice is the local clone: both commits of the pull request must already be in it
// (nothing is fetched) and the diff is computed with the hardened git runner. If they are not, the
// official host API is read instead, with size caps. The answer says which source was used.

import { existsSync } from "node:fs";
import type { GuardConfig } from "../types.ts";
import { HttpError } from "../server/http.ts";
import { remoteOf, diffView, findRepo, withheldReason, MAX_DIFF_FILES, MAX_PATCH_CHARS, MAX_TOTAL_CHARS } from "../repos/repos.ts";
import type { DiffFileView } from "../repos/repos.ts";
import { safeGitTry, GitError } from "../repos/safe-git.ts";
import type { Remote } from "../repos/hosts.ts";
import { AuthBlockedError, AzureError, createClient } from "./azure.ts";
import type { AzureClient } from "./azure.ts";
import { AZURE_HELP, HostFix, azureCredentials, githubGet, HOST_TIMEOUT_MS } from "./host-access.ts";
import type { PullDeps } from "./pulls.ts";
import { unifiedPatch } from "./text-diff.ts";

/** Azure gives no patch text, so file contents are read for this many files; the rest are listed only. */
export const AZURE_PATCH_FILES = 40;
/** A file larger than this (characters) is not compared. */
export const MAX_COMPARE_CHARS = 200_000;
/** GitHub files are read 100 per page, this many pages (300 files, the same cap as the repo diff). */
const GITHUB_PAGES = Math.ceil(MAX_DIFF_FILES / 100);
const AZURE_CONCURRENCY = 4;

export interface PrDiffFile extends Omit<DiffFileView, "additions" | "deletions"> { additions: number | null; deletions: number | null }
export interface PrDiff {
  base: string; head: string; additions: number; deletions: number; truncated: boolean; files: PrDiffFile[];
  /** Where the changes came from. */
  source: "local" | "github-api" | "azure-api";
  /** A plain sentence saying which source was used and any limit that applies. */
  sourceNote: string;
}

interface Meta { source: string; target: string; headSha: string | null; baseSha: string | null }

const text = (v: unknown, max = 300): string => String(v ?? "").slice(0, max);
const branch = (ref: unknown): string => text(ref).replace(/^refs\/heads\//, "");
const sha = (v: unknown): string | null => (typeof v === "string" && /^[0-9a-f]{7,64}$/i.test(v) ? v : null);

async function hasCommit(path: string, id: string | null): Promise<boolean> {
  return id !== null && (await safeGitTry(path, ["cat-file", "-e", `${id}^{commit}`])) !== null;
}

/** Applies the same limits as the repo diff: secrets withheld, patches and totals capped. */
export function finishFiles(raw: { path: string; oldPath: string; status: DiffFileView["status"]; additions: number | null; deletions: number | null; patch: string | null; withheld: string | null }[]): { files: PrDiffFile[]; truncated: boolean } {
  const files: PrDiffFile[] = [];
  let truncated = false;
  let total = 0;
  for (const r of raw) {
    if (files.length >= MAX_DIFF_FILES) { truncated = true; break; }
    let withheld = r.withheld;
    let patch = r.patch;
    if (patch !== null) {
      withheld = withheld ?? withheldReason(r.path, r.oldPath, patch);
      if (withheld) patch = null;
    } else if (!withheld) withheld = withheldReason(r.path, r.oldPath, "");
    if (patch !== null) {
      if (total >= MAX_TOTAL_CHARS) { patch = null; withheld = "left out: the diff is too large"; truncated = true; }
      else {
        if (patch.length > MAX_PATCH_CHARS) { patch = patch.slice(0, MAX_PATCH_CHARS) + "\n... (patch cut: file is large)"; truncated = true; }
        total += patch.length;
      }
    }
    files.push({ path: r.path, status: r.status, additions: r.additions, deletions: r.deletions, patch, withheld });
  }
  return { files, truncated };
}

const totals = (files: PrDiffFile[]) => ({
  additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
  deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
});

/* ---------------- GitHub ---------------- */

async function githubMeta(owner: string, repo: string, number: number, deps: PullDeps): Promise<Meta> {
  const p = (await githubGet(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`, deps)) as any;
  return { source: text(p?.head?.ref), target: text(p?.base?.ref), headSha: sha(p?.head?.sha), baseSha: sha(p?.base?.sha) };
}

async function githubFiles(owner: string, repo: string, number: number, deps: PullDeps) {
  const raw: Parameters<typeof finishFiles>[0] = [];
  let more = false;
  for (let page = 1; page <= GITHUB_PAGES; page++) {
    const body = await githubGet(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files?per_page=100&page=${page}`, deps);
    if (!Array.isArray(body)) throw new HostFix("GitHub sent an answer that could not be read.");
    for (const f of body as any[]) {
      const path = text(f?.filename, 1000);
      if (!path) continue;
      const oldPath = f?.previous_filename ? text(f.previous_filename, 1000) : path;
      const status: DiffFileView["status"] = f.status === "added" ? "added" : f.status === "removed" ? "deleted" : f.status === "renamed" ? "renamed" : "modified";
      const hunks = typeof f?.patch === "string" ? f.patch : null;
      const header = `diff --git a/${oldPath} b/${path}\n${status === "added" ? "new file mode 100644\n" : status === "deleted" ? "deleted file mode 100644\n" : status === "renamed" ? `rename from ${oldPath}\nrename to ${path}\n` : ""}`
        + (hunks ? `--- ${status === "added" ? "/dev/null" : `a/${oldPath}`}\n+++ ${status === "deleted" ? "/dev/null" : `b/${path}`}\n` : "");
      raw.push({
        path, oldPath, status, additions: Number(f?.additions) || 0, deletions: Number(f?.deletions) || 0,
        patch: hunks !== null ? header + hunks : null,
        withheld: hunks === null ? "GitHub gave no text for this file (binary, or too large). Open the pull request in the browser." : null,
      });
    }
    if ((body as any[]).length < 100) break;
    if (page === GITHUB_PAGES) more = true;
  }
  const done = finishFiles(raw);
  return { ...done, truncated: done.truncated || more };
}

/* ---------------- Azure DevOps ---------------- */

const arr = <T>(body: unknown, key = "value"): T[] => {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(v) ? (v as T[]) : [];
};

async function azureMeta(c: AzureClient, number: number): Promise<Meta> {
  const p = (await c.get(`/pullRequests/${number}`)) as any;
  return {
    source: branch(p?.sourceRefName), target: branch(p?.targetRefName),
    headSha: sha(p?.lastMergeSourceCommit?.commitId), baseSha: sha(p?.lastMergeTargetCommit?.commitId),
  };
}

async function azureText(c: AzureClient, path: string, commit: string): Promise<string | null | "big"> {
  try {
    const item = (await c.get("/items", {
      path, "versionDescriptor.version": commit, "versionDescriptor.versionType": "commit", includeContent: "true", $format: "json",
    })) as { content?: unknown };
    if (typeof item?.content !== "string") return null;
    if (item.content.length > MAX_COMPARE_CHARS) return "big";
    return item.content.includes("\0") ? null : item.content;
  } catch (e) {
    if (e instanceof AuthBlockedError) throw e;
    return null;
  }
}

async function azureFiles(c: AzureClient, number: number) {
  const its = arr<{ id?: number }>(await c.get(`/pullRequests/${number}/iterations`));
  const last = its.reduce((m, i) => Math.max(m, i.id ?? 0), 0);
  if (!last) return { files: [] as PrDiffFile[], truncated: false };
  const it = (await c.get(`/pullRequests/${number}/iterations/${last}`)) as any;
  const baseCommit = sha(it?.commonRefCommit?.commitId);
  const headCommit = sha(it?.sourceRefCommit?.commitId);

  const changes: { path: string; oldPath: string; status: DiffFileView["status"] }[] = [];
  let skip = 0;
  let truncated = false;
  for (;;) {
    const body = (await c.get(`/pullRequests/${number}/iterations/${last}/changes`, { $top: 100, $skip: skip })) as any;
    for (const e of arr<any>(body, "changeEntries")) {
      const path = e?.item?.path ? String(e.item.path).replace(/^\//, "") : "";
      if (!path || e.item.isFolder === true) continue;
      if (changes.length >= MAX_DIFF_FILES) { truncated = true; break; }
      const kind = String(e.changeType ?? "").toLowerCase();
      const status: DiffFileView["status"] = kind.includes("rename") ? "renamed" : kind.includes("delete") ? "deleted" : kind.includes("add") ? "added" : "modified";
      changes.push({ path, oldPath: e.originalPath ? String(e.originalPath).replace(/^\//, "") : path, status });
    }
    const next = Number(body?.nextSkip) || 0;
    if (truncated || !next) break;
    skip = next;
  }

  const raw: Parameters<typeof finishFiles>[0] = changes.map((ch) => ({ ...ch, additions: null, deletions: null, patch: null, withheld: "left out: too many files to compare here. Open the pull request in the browser." }));
  if (baseCommit && headCommit) {
    const work = raw.slice(0, AZURE_PATCH_FILES);
    let next = 0;
    const one = async (): Promise<void> => {
      while (next < work.length) {
        const r = work[next++]!;
        const [oldText, newText] = await Promise.all([
          r.status === "added" ? Promise.resolve("") : azureText(c, "/" + r.oldPath, baseCommit),
          r.status === "deleted" ? Promise.resolve("") : azureText(c, "/" + r.path, headCommit),
        ]);
        if (oldText === "big" || newText === "big") { r.withheld = "too large to compare here"; continue; }
        if (oldText === null || newText === null) { r.withheld = "binary file, or its text could not be read"; continue; }
        const patch = unifiedPatch({ path: r.path, oldPath: r.oldPath, oldText: r.status === "added" ? null : oldText, newText: r.status === "deleted" ? null : newText });
        if (!patch) { r.withheld = "the two versions differ too much to compare here"; continue; }
        r.patch = patch.patch; r.additions = patch.additions; r.deletions = patch.deletions; r.withheld = null;
      }
    };
    await Promise.all(Array.from({ length: AZURE_CONCURRENCY }, one));
  } else {
    for (const r of raw) r.withheld = "Azure DevOps did not give the commits for this pull request.";
  }
  const done = finishFiles(raw);
  return { ...done, truncated: done.truncated || truncated || changes.length > AZURE_PATCH_FILES };
}

/* ---------------- the entry point ---------------- */

/** Maps host failures to an error the screen can show as it is. */
function plain(e: unknown): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof HostFix) throw new HttpError(502, e.message);
  if (e instanceof AuthBlockedError) throw new HttpError(502, `Azure DevOps did not accept a sign-in. ${AZURE_HELP}`);
  if (e instanceof AzureError) throw new HttpError(502, `Azure DevOps: ${e.message}`);
  throw new HttpError(502, "The pull request changes could not be read.");
}

export async function pullDiff(cfg: GuardConfig, repoId: string, number: number, ignoreWhitespace: boolean, deps: PullDeps = {}): Promise<PrDiff> {
  if (!Number.isInteger(number) || number < 1) throw new HttpError(400, "Use a pull request number.");
  const repo = findRepo(cfg, repoId);
  if (!existsSync(repo.path)) throw new HttpError(409, "The folder for this repository does not exist on this computer.");
  const remote: Remote = await (deps.remote ?? remoteOf)(repo.path);
  if (remote.host === "unknown") throw new HttpError(409, "The origin remote is not on GitHub or Azure DevOps.");

  try {
    const client = remote.host === "azure-devops"
      ? createClient(remote.ctx, { credentials: azureCredentials(deps), timeoutMs: HOST_TIMEOUT_MS, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      : null;
    const meta = remote.host === "github" ? await githubMeta(remote.owner, remote.repo, number, deps) : await azureMeta(client!, number);

    // 1. The local clone, when it already holds both commits. Nothing is fetched.
    if (meta.headSha && meta.baseSha && (await hasCommit(repo.path, meta.headSha)) && (await hasCommit(repo.path, meta.baseSha))) {
      try {
        const d = await diffView(repo.path, meta.baseSha, meta.headSha, ignoreWhitespace, true);
        return {
          ...d, base: meta.target, head: meta.source, files: d.files, source: "local",
          sourceNote: "Computed from your local copy of the repository. Nothing was downloaded.",
        };
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
      }
    }

    // 2. The host's own API.
    const done = remote.host === "github" ? await githubFiles(remote.owner, remote.repo, number, deps) : await azureFiles(client!, number);
    const source = remote.host === "github" ? "github-api" : "azure-api";
    const limits = remote.host === "github"
      ? "Some files may have no text if GitHub left it out."
      : `Azure DevOps gives no patch text, so up to ${AZURE_PATCH_FILES} files were compared from their contents.`;
    return {
      base: meta.target, head: meta.source, ...totals(done.files), truncated: done.truncated, files: done.files, source,
      sourceNote: `Your local copy does not have this pull request's commits, so the changes were read from the host (read-only). ${limits}${ignoreWhitespace ? " Hide whitespace was not applied." : ""}`,
    };
  } catch (e) {
    return plain(e);
  }
}
