// The pull request list across the loaded repos. Only reads are sent. A token goes only to its
// own official host and is never logged or returned. Titles and names are untrusted text: they are
// passed to the screen and never to a model.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { GuardConfig } from "../types.ts";
import { remoteOf } from "../repos/repos.ts";
import type { HostKind, Remote } from "../repos/hosts.ts";
import { AuthBlockedError, AzureError, createClient, listPullRequests } from "./azure.ts";
import type { CredentialProvider, PrStatus, RawPr } from "./azure.ts";
import type { RepoCtx } from "./remote.ts";

export const PULL_STATES = ["open", "merged", "closed", "all"] as const;
export type PullState = (typeof PULL_STATES)[number];

const TIMEOUT_MS = 8_000;
const CREDENTIAL_TIMEOUT_MS = 10_000;
const CACHE_MS = 60_000;
export const MAX_PULLS_PER_REPO = 50;

export interface Pull {
  id: string; repoId: string; host: HostKind; number: number; title: string; author: string; state: "open" | "merged" | "closed";
  draft: boolean; sourceBranch: string; targetBranch: string; createdAt: string; updatedAt: string | null; labels: string[]; url: string | null;
}
export interface PullSource { repoId: string; host: HostKind; ok: boolean; error: string | null }
export interface PullList { checkedAt: string; sources: PullSource[]; pulls: Pull[] }

export interface PullDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** The saved Git sign-in. */
  credentials?: CredentialProvider;
  /** Path of the gh program, or null when it is not installed. */
  ghPath?: () => string | null;
  /** Runs gh and gives its output; rejects when it fails. */
  runGh?: (exe: string, args: string[]) => Promise<string>;
  remote?: (repoPath: string) => Promise<Remote>;
}

/** The saved Git sign-in for a host, never opening a sign-in window or a prompt. */
export const quietGitCredential: CredentialProvider = (host) =>
  new Promise((resolve) => {
    const child = spawn("git", ["credential", "fill"], {
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" },
    });
    let out = "";
    const timer = setTimeout(() => child.kill(), CREDENTIAL_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.on("error", () => resolve(undefined));
    child.on("close", () => {
      clearTimeout(timer);
      const field = (name: string): string => new RegExp(`^${name}=(.*?)\\r?$`, "m").exec(out)?.[1] ?? "";
      resolve(field("password") ? { username: field("username"), password: field("password") } : undefined);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`protocol=https\nhost=${host}\n\n`);
  });

export function findGh(env: Record<string, string | undefined> = process.env): string | null {
  const name = process.platform === "win32" ? "gh.exe" : "gh";
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  if (env.ProgramFiles) dirs.push(join(env.ProgramFiles, "GitHub CLI"));
  return dirs.map((d) => join(d, name)).find((p) => existsSync(p)) ?? null;
}

export const defaultRunGh = (exe: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      (e, stdout) => (e ? reject(new Error("gh failed")) : resolve(stdout)));
  });

/** A message for the screen. */
class Fix extends Error {}

const GITHUB_HELP = "Set GH_TOKEN or GITHUB_TOKEN, or install the GitHub CLI and run `gh auth login`.";
const AZURE_HELP = "Set AZURE_DEVOPS_PAT (Code: Read), or sign in with git once (for example fetch the repo yourself), then refresh.";

const text = (v: unknown, max = 300): string => String(v ?? "").slice(0, max);
const branch = (ref: unknown): string => text(ref).replace(/^refs\/heads\//, "");

async function azurePulls(repoId: string, ctx: RepoCtx, state: PullState, deps: PullDeps): Promise<Pull[]> {
  const pat = (deps.env ?? process.env).AZURE_DEVOPS_PAT?.trim();
  const credentials: CredentialProvider = pat ? async () => ({ username: "", password: pat }) : deps.credentials ?? quietGitCredential;
  const client = createClient(ctx, { credentials, timeoutMs: TIMEOUT_MS, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const status: Record<PullState, PrStatus> = { open: "active", merged: "completed", closed: "abandoned", all: "all" };
  let rows: (RawPr & { isDraft?: boolean; labels?: { name?: string }[] })[];
  try {
    rows = await listPullRequests(client, { status: status[state], top: MAX_PULLS_PER_REPO });
  } catch (e) {
    if (e instanceof AuthBlockedError) throw new Fix(`Azure DevOps did not accept a sign-in. ${AZURE_HELP}`);
    if (e instanceof AzureError) throw new Fix(`Azure DevOps: ${e.message}`);
    throw e;
  }
  return rows.map((p): Pull => ({
    id: `${repoId}#${p.pullRequestId}`, repoId, host: "azure-devops", number: p.pullRequestId,
    title: text(p.title), author: text(p.createdBy?.displayName, 120),
    state: p.status === "completed" ? "merged" : p.status === "abandoned" ? "closed" : "open",
    draft: p.isDraft === true, sourceBranch: branch(p.sourceRefName), targetBranch: branch(p.targetRefName),
    createdAt: text(p.creationDate), updatedAt: p.closedDate ?? null,
    labels: (p.labels ?? []).map((l) => text(l.name, 60)).filter(Boolean),
    url: `${ctx.origin}${ctx.projectPath}/_git/${encodeURIComponent(ctx.repo)}/pullrequest/${p.pullRequestId}`,
  }));
}

async function githubPulls(repoId: string, owner: string, repo: string, state: PullState, deps: PullDeps): Promise<Pull[]> {
  const env = deps.env ?? process.env;
  const query = new URLSearchParams({
    state: state === "open" ? "open" : state === "all" ? "all" : "closed", sort: "updated", direction: "desc", per_page: String(MAX_PULLS_PER_REPO),
  });
  const path = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query}`;
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  let body: unknown;
  if (token) {
    let res: Response;
    try {
      res = await (deps.fetch ?? fetch)(`https://api.github.com/${path}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "pull-list" },
      });
    } catch { throw new Fix("GitHub did not answer in time."); }
    if (!res.ok) throw new Fix(`GitHub answered ${res.status}. Check that the token can read this repo.`);
    body = await res.json();
  } else {
    const exe = (deps.ghPath ?? (() => findGh(env)))();
    if (!exe) throw new Fix(`No GitHub sign-in. ${GITHUB_HELP}`);
    try {
      // gh keeps its own token; Guard never sees it.
      body = JSON.parse(await (deps.runGh ?? defaultRunGh)(exe, ["api", "--hostname", "github.com", "--method", "GET", path]));
    } catch { throw new Fix(`The GitHub CLI could not list pull requests. ${GITHUB_HELP}`); }
  }
  if (!Array.isArray(body)) throw new Fix("GitHub sent an answer that could not be read.");
  return (body as any[]).map((p): Pull => ({
    id: `${repoId}#${Number(p.number)}`, repoId, host: "github", number: Number(p.number),
    title: text(p.title), author: text(p.user?.login, 120),
    state: p.merged_at ? "merged" : p.state === "closed" ? "closed" : "open",
    draft: p.draft === true, sourceBranch: text(p.head?.ref), targetBranch: text(p.base?.ref),
    createdAt: text(p.created_at), updatedAt: p.updated_at ? text(p.updated_at) : null,
    labels: Array.isArray(p.labels) ? p.labels.map((l: any) => text(l?.name, 60)).filter(Boolean) : [],
    url: `https://github.com/${owner}/${repo}/pull/${Number(p.number)}`,
  })).filter((p) => state === "all" || p.state === state);
}

export function createPullLister(deps: PullDeps = {}) {
  const cache = new Map<string, { at: number; value: Promise<PullList> }>();

  async function load(cfg: GuardConfig, state: PullState): Promise<PullList> {
    const results = await Promise.all(cfg.repos.map(async (r) => {
      let host: HostKind = "unknown";
      try {
        if (!existsSync(r.path)) throw new Fix("The folder does not exist on this computer.");
        const remote = await (deps.remote ?? remoteOf)(r.path);
        host = remote.host;
        if (remote.host === "unknown") throw new Fix("The origin remote is not on GitHub or Azure DevOps.");
        const pulls = remote.host === "github"
          ? await githubPulls(r.id, remote.owner, remote.repo, state, deps)
          : await azurePulls(r.id, remote.ctx, state, deps);
        return { source: { repoId: r.id, host, ok: true, error: null }, pulls };
      } catch (e) {
        // Only messages written for the screen are shown; others could carry a request address.
        return { source: { repoId: r.id, host, ok: false, error: e instanceof Fix ? e.message : "The pull request list could not be read." }, pulls: [] as Pull[] };
      }
    }));
    return {
      checkedAt: new Date().toISOString(),
      sources: results.map((x) => x.source),
      pulls: results.flatMap((x) => x.pulls).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  return (cfg: GuardConfig, state: PullState, refresh = false): Promise<PullList> => {
    const key = `${state}\0${cfg.repos.map((r) => `${r.id}=${r.path}`).join("\0")}`;
    const hit = cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = load(cfg, state);
    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.delete(key));
    return value;
  };
}
