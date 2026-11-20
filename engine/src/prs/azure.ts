// Read-only Azure DevOps client for pull requests.
//
// Only HTTP GET is ever sent. The saved Git sign-in for the server's host is
// fetched in memory (`git credential fill`), used only as the Basic header to
// that same host, and never printed, logged or written anywhere.
//
// Endpoints (docs: learn.microsoft.com/rest/api/azure/devops/git, version 7.1):
//   GET {base}/pullrequests?searchCriteria.status=..&$top=..&$skip=..      Pull Requests - Get Pull Requests
//   GET {base}/pullRequests/{id}/threads                                    Pull Request Threads - List
//   GET {base}/pullRequests/{id}/iterations                                 Pull Request Iterations - List
//   GET {base}/pullRequests/{id}/iterations/{n}/changes?$top=..&$skip=..    Pull Request Iteration Changes - Get
//
// Stored data formats (all under data/prs/<repo>/, git-ignored):
//   <id>.json       one PR: title, status, branches, dates, merge commit, changed paths, threads.
//                   People appear only as "p-<6 hex>" plus a boolean isAuthor.
//   index.json      what was synced and when, so the next sync skips unchanged PRs.
//   dataset.jsonl   one line per merged PR for scoring the Reviewer against human review:
//                   {"pr":12,"mergeCommit":"<sha>","files":["a/b.ts"],
//                    "comments":[{"file":"a/b.ts","line":7,"text":"...","accepted":true}]}
//                   accepted is true when the thread ended fixed/closed, false when wontFix/byDesign,
//                   null when it was left open. Text is masked; secret-bearing comments are absent.

import { spawn } from "node:child_process";
import type { RepoCtx } from "./remote.ts";

/** Pinned so Azure answers in a shape we have checked against the docs. */
export const API_VERSION = "7.1";
const PAGE_SIZE = 100; // PRs per request
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1500;
const MAX_RETRY_WAIT_MS = 10_000;
/** Cheap by design: a PR's file list is capped. */
export const MAX_CHANGED_FILES = 200;

export class AzureError extends Error {}
/** No saved sign-in, or the server refused it. The message is safe to show. */
export class AuthBlockedError extends AzureError {}

export interface Creds {
  username: string;
  password: string;
}
export type CredentialProvider = (host: string) => Promise<Creds | undefined>;

export interface ClientOpts {
  fetch?: typeof fetch;
  credentials?: CredentialProvider;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AzureClient {
  ctx: RepoCtx;
  /** GET a path under the repository; returns parsed JSON. */
  get(path: string, query?: Record<string, string | number>): Promise<unknown>;
  /** HTTP status of one cheap request (no body kept). */
  probe(): Promise<number>;
}

/** The developer's saved Git sign-in for a host, through `git credential fill`, in memory only. */
export const gitCredential: CredentialProvider = (host) =>
  new Promise((resolve) => {
    const child = spawn("git", ["credential", "fill"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let out = "";
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("error", () => resolve(undefined));
    child.on("close", () => {
      clearTimeout(timer);
      const f: Record<string, string> = {};
      for (const line of out.split(/\r?\n/)) {
        const i = line.indexOf("=");
        if (i > 0) f[line.slice(0, i)] = line.slice(i + 1);
      }
      resolve(f["password"] ? { username: f["username"] ?? "", password: f["password"] } : undefined);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`protocol=https\nhost=${host}\n\n`);
  });

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isLoopback(host: string): boolean {
  const h = host.replace(/:\d+$/, "");
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
}

export function createClient(ctx: RepoCtx, opts: ClientOpts = {}): AzureClient {
  const doFetch = opts.fetch ?? fetch;
  const getCreds = opts.credentials ?? gitCredential;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  let header: string | undefined;

  // The sign-in must never travel in clear text off this machine.
  if (!ctx.origin.startsWith("https://") && !isLoopback(ctx.host)) {
    throw new AuthBlockedError("Refusing to send a saved sign-in over a non-HTTPS address.");
  }

  async function auth(): Promise<string> {
    if (header) return header;
    const c = await getCreds(ctx.host.replace(/:\d+$/, ""));
    if (!c) {
      throw new AuthBlockedError(
        "No saved Git sign-in for this server. Sign in once with git (for example fetch the repo) and run this again.",
      );
    }
    header = "Basic " + Buffer.from(`${c.username}:${c.password}`).toString("base64");
    return header;
  }

  function buildUrl(path: string, query: Record<string, string | number> = {}): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) q.set(k, String(v));
    q.set("api-version", API_VERSION);
    return `${ctx.origin}${ctx.projectPath}/_apis/git/repositories/${encodeURIComponent(ctx.repo)}${path}?${q.toString()}`;
  }

  async function request(url: string): Promise<{ status: number; body: unknown }> {
    const h = await auth();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "GET",
          redirect: "manual", // never follow a redirect to another host
          headers: { Authorization: h, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new AzureError("The server did not answer in time.");
      }
      if (res.status >= 300 && res.status < 400) {
        throw new AzureError(`The server redirected the request (HTTP ${res.status}); not followed.`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new AuthBlockedError(
          `The server refused the saved sign-in (HTTP ${res.status}). Sign in with git again, then retry. No other sign-in is tried.`,
        );
      }
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, MAX_RETRY_WAIT_MS) : RETRY_DELAY_MS);
        continue;
      }
      // Azure answers a missing or expired sign-in with a 203 or an HTML sign-in page.
      const type = res.headers.get("content-type") ?? "";
      if (res.status === 203 || (res.ok && !type.includes("json"))) {
        throw new AuthBlockedError("The server answered with a sign-in page, so the saved sign-in is not accepted.");
      }
      if (!res.ok) return { status: res.status, body: undefined };
      try {
        return { status: res.status, body: await res.json() };
      } catch {
        throw new AzureError("The server answered with data that is not JSON.");
      }
    }
  }

  return {
    ctx,
    async get(path, query) {
      const r = await request(buildUrl(path, query));
      if (r.status < 200 || r.status >= 300) throw new AzureError(`The server answered HTTP ${r.status}.`);
      return r.body;
    },
    async probe() {
      return (await request(buildUrl("/pullrequests", { "searchCriteria.status": "completed", $top: 1 }))).status;
    },
  };
}

// ---- Shapes we read (only the fields we use). ----

export interface Identity {
  id?: string;
  uniqueName?: string;
  displayName?: string;
  isContainer?: boolean;
}
export interface RawPr {
  pullRequestId: number;
  title?: string;
  status?: string;
  createdBy?: Identity;
  creationDate?: string;
  closedDate?: string;
  sourceRefName?: string;
  targetRefName?: string;
  lastMergeCommit?: { commitId?: string };
  lastMergeSourceCommit?: { commitId?: string };
}
export interface RawComment {
  id?: number;
  parentCommentId?: number;
  author?: Identity;
  content?: string;
  publishedDate?: string;
  commentType?: string;
  isDeleted?: boolean;
}
export interface RawThread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  comments?: RawComment[];
  properties?: Record<string, unknown>;
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line?: number };
    leftFileStart?: { line?: number };
  } | null;
}

function arr<T>(body: unknown, key = "value"): T[] {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

export type PrStatus = "completed" | "active" | "abandoned" | "all";

/** Newest first, paged with $top/$skip. `since` (ISO date) stops at older PRs. */
export async function listPullRequests(
  c: AzureClient,
  o: { status?: PrStatus; top?: number; since?: string } = {},
): Promise<RawPr[]> {
  const want = o.top ?? 50;
  const out: RawPr[] = [];
  let skip = 0;
  while (out.length < want) {
    const size = Math.min(PAGE_SIZE, want - out.length);
    const page = arr<RawPr>(
      await c.get("/pullrequests", { "searchCriteria.status": o.status ?? "completed", $top: size, $skip: skip }),
    );
    for (const pr of page) {
      if (o.since && (pr.creationDate ?? "") < o.since) return out;
      out.push(pr);
    }
    if (page.length < size) break;
    skip += page.length;
  }
  return out.slice(0, want);
}

export async function getThreads(c: AzureClient, prId: number): Promise<RawThread[]> {
  return arr<RawThread>(await c.get(`/pullRequests/${prId}/threads`));
}

/** Paths changed in the latest iteration against the common base, capped. */
export async function getChangedFiles(
  c: AzureClient,
  prId: number,
  cap: number = MAX_CHANGED_FILES,
): Promise<{ files: string[]; truncated: boolean }> {
  const its = arr<{ id?: number }>(await c.get(`/pullRequests/${prId}/iterations`));
  const last = its.reduce((m, i) => Math.max(m, i.id ?? 0), 0);
  if (!last) return { files: [], truncated: false };
  const files: string[] = [];
  let skip = 0;
  let truncated = false;
  for (;;) {
    const body = await c.get(`/pullRequests/${prId}/iterations/${last}/changes`, { $top: Math.min(cap, 100), $skip: skip });
    for (const e of arr<{ item?: { path?: string } }>(body, "changeEntries")) {
      const p = e.item?.path;
      if (!p) continue;
      if (files.length >= cap) {
        truncated = true;
        break;
      }
      files.push(p.replace(/^\//, ""));
    }
    const next = (body as { nextSkip?: number }).nextSkip ?? 0;
    if (truncated || !next) break;
    skip = next;
  }
  return { files, truncated };
}
