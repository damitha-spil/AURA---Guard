import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import { getChangedFiles, getThreads, listPullRequests } from "./azure.ts";
import type { AzureClient, Identity, PrStatus, RawPr, RawThread } from "./azure.ts";
import { branchName, cleanText, loadSalt, nameTerms, personHash, sameIdentity } from "./privacy.ts";

export interface StoredComment {
  isAuthor: boolean;
  person: string; // p-<6 hex>
  text: string; // masked
  date: string;
}
export interface StoredThread {
  id: number;
  status: string;
  file?: string;
  line?: number;
  comments: StoredComment[];
}
export interface StoredPr {
  id: number;
  title: string;
  status: string;
  source: string;
  target: string;
  created?: string;
  closed?: string;
  mergeCommit?: string;
  files: string[];
  filesTruncated: boolean;
  threads: StoredThread[];
}
interface IndexFile {
  lastSync?: string;
  prs: Record<string, string>; // id -> signature
}

export function prsDir(cfg: GuardConfig): string {
  return join(cfg.dataDir, "prs");
}
export function repoDir(cfg: GuardConfig, repoId: string): string {
  return join(prsDir(cfg), repoId);
}
function readIndex(dir: string): IndexFile {
  try {
    return JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as IndexFile;
  } catch {
    return { prs: {} };
  }
}

/** Later syncs skip a closed PR whose signature is unchanged. Active PRs are always refetched (comments change). */
function signature(pr: RawPr): string {
  return [pr.status ?? "", pr.closedDate ?? "", pr.lastMergeSourceCommit?.commitId ?? ""].join("|");
}

const BOT_COMMENT = /^(policy|the pull request is mergeable|the pull request is mergable|auto-?complete|build \d+|\[?bot\]?)/i;

/** Pure: turns Azure's raw PR and threads into the masked, person-free stored form. */
export function toStoredPr(
  pr: RawPr,
  threads: RawThread[],
  files: { files: string[]; truncated: boolean },
  salt: string,
): { stored: StoredPr; secretsDropped: number } {
  const people: Identity[] = [];
  if (pr.createdBy) people.push(pr.createdBy);
  for (const t of threads) for (const c of t.comments ?? []) if (c.author) people.push(c.author);
  const names = nameTerms(people);
  let secretsDropped = 0;
  const clean = (s: string): string | undefined => {
    const r = cleanText(s, names);
    if (r.secret) {
      secretsDropped++;
      return undefined;
    }
    return r.text;
  };
  const out: StoredThread[] = [];
  for (const t of threads) {
    // System threads (votes, merge attempts, reviewer changes) carry a thread type property.
    if (t.isDeleted || t.properties?.["CodeReviewThreadType"] !== undefined) continue;
    const comments: StoredComment[] = [];
    for (const c of t.comments ?? []) {
      if (c.isDeleted || !c.content?.trim()) continue;
      if (c.commentType === "system" || c.commentType === "codeChange" || c.author?.isContainer) continue;
      if (BOT_COMMENT.test(c.content.trim())) continue;
      const text = clean(c.content);
      if (text === undefined) continue;
      comments.push({
        isAuthor: sameIdentity(c.author, pr.createdBy),
        person: personHash(salt, c.author),
        text,
        date: c.publishedDate ?? "",
      });
    }
    if (!comments.length) continue;
    const ctx = t.threadContext;
    const file = ctx?.filePath ? clean(ctx.filePath.replace(/^\//, "")) : undefined;
    const line = ctx?.rightFileStart?.line ?? ctx?.leftFileStart?.line;
    out.push({
      id: t.id,
      status: t.status ?? "unknown",
      ...(file ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      comments,
    });
  }
  const stored: StoredPr = {
    id: pr.pullRequestId,
    title: clean(pr.title ?? "") ?? "[withheld]",
    status: pr.status ?? "unknown",
    source: branchName(pr.sourceRefName, salt),
    target: branchName(pr.targetRefName, salt),
    ...(pr.creationDate ? { created: pr.creationDate } : {}),
    ...(pr.closedDate ? { closed: pr.closedDate } : {}),
    ...(pr.lastMergeCommit?.commitId ? { mergeCommit: pr.lastMergeCommit.commitId } : {}),
    files: files.files.map((f) => clean(f) ?? "[withheld]"),
    filesTruncated: files.truncated,
    threads: out,
  };
  return { stored, secretsDropped };
}

export interface SyncResult {
  listed: number;
  fetched: number;
  skipped: number;
  threads: number;
  comments: number;
  secretsDropped: number;
}

export async function syncPrs(
  cfg: GuardConfig,
  client: AzureClient,
  repoId: string,
  o: { limit?: number; status?: PrStatus; since?: string; now?: () => Date } = {},
): Promise<SyncResult> {
  const dir = repoDir(cfg, repoId);
  mkdirSync(dir, { recursive: true });
  const salt = loadSalt(prsDir(cfg));
  const index = readIndex(dir);
  const list = await listPullRequests(client, {
    status: o.status ?? "completed",
    top: o.limit ?? 50,
    ...(o.since ? { since: o.since } : {}),
  });
  const r: SyncResult = { listed: list.length, fetched: 0, skipped: 0, threads: 0, comments: 0, secretsDropped: 0 };
  for (const pr of list) {
    const sig = signature(pr);
    const known = index.prs[String(pr.pullRequestId)];
    if (known === sig && pr.status !== "active" && existsSync(join(dir, `${pr.pullRequestId}.json`))) {
      r.skipped++;
      continue;
    }
    const [threads, files] = await Promise.all([getThreads(client, pr.pullRequestId), getChangedFiles(client, pr.pullRequestId)]);
    const { stored, secretsDropped } = toStoredPr(pr, threads, files, salt);
    writeFileSync(join(dir, `${stored.id}.json`), JSON.stringify(stored, null, 2));
    index.prs[String(pr.pullRequestId)] = sig;
    r.fetched++;
    r.threads += stored.threads.length;
    r.comments += stored.threads.reduce((n, t) => n + t.comments.length, 0);
    r.secretsDropped += secretsDropped;
  }
  index.lastSync = (o.now?.() ?? new Date()).toISOString();
  writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 2));
  return r;
}

export function loadStoredPrs(cfg: GuardConfig, repoId: string): StoredPr[] {
  const dir = repoDir(cfg, repoId);
  if (!existsSync(dir)) return [];
  const out: StoredPr[] = [];
  for (const f of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as StoredPr);
    } catch {
      // a damaged file is skipped
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

export function storedStatus(cfg: GuardConfig, repoId: string): { lastSync?: string; prs: number; threads: number } {
  const prs = loadStoredPrs(cfg, repoId);
  const idx = readIndex(repoDir(cfg, repoId));
  return {
    ...(idx.lastSync ? { lastSync: idx.lastSync } : {}),
    prs: prs.length,
    threads: prs.reduce((n, p) => n + p.threads.length, 0),
  };
}
