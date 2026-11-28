// /api/repos, /api/pulls, /api/source-control and /api/open-external. The server has already checked the cookie,
// Host and Origin before these run.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { CompleteFn } from "../brain/client.ts";
import type { Db } from "../index/db.ts";
import { HttpError, readJson, sendJson } from "../server/http.ts";
import type { GuardConfig } from "../types.ts";
import { createPullLister, defaultRunGh, findGh, PULL_STATES, quietGitCredential } from "../prs/pulls.ts";
import type { PullDeps, PullState } from "../prs/pulls.ts";
import { GitError } from "./safe-git.ts";
import { browseFolders } from "./browse.ts";
import { addRepo, diffView, listBranches, listCommits, openRepo, remoteOf, removeRepo, repoInfo } from "./repos.ts";
import { reviewRepo } from "./review.ts";
import { parseView, renderReport, reviewModel } from "../reports/views.ts";

export interface RepoRouteDeps {
  pulls?: PullDeps;
  /** Starts an editor or file window. */
  launch?: (command: string, args: string[]) => Promise<void>;
}

export interface RepoRouteContext {
  req: IncomingMessage; res: ServerResponse; path: string; method: string; cfg: GuardConfig; complete: CompleteFn;
  openIndex: () => { db: Db; release: () => void } | null;
}

const defaultLaunch = (command: string, args: string[]): Promise<void> =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
    child.once("error", fail);
    child.once("spawn", () => { child.unref(); done(); });
  });

/** The program for an "open in" button. Code.exe itself: the `code` command is a .cmd that needs a shell. */
export function openCommand(app: unknown, repoPath: string, env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync): { command: string; args: string[] } {
  const folder = resolve(repoPath);
  if (app === "explorer") {
    const command = process.platform === "win32" ? join(env.SystemRoot ?? "C:\\Windows", "explorer.exe") : process.platform === "darwin" ? "open" : "xdg-open";
    return { command, args: [folder] };
  }
  if (app === "vscode") {
    const places = [
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
      env.ProgramFiles && join(env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
      "/usr/bin/code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    ].filter((p): p is string => !!p);
    const command = places.find(exists);
    if (!command) throw new HttpError(404, "VS Code was not found on this computer.");
    return { command, args: [folder] };
  }
  throw new HttpError(400, "Use app: vscode or explorer.");
}

/** Longer than any pull request link, and well inside what Windows accepts on a command line. */
const MAX_EXTERNAL_URL_CHARS = 2000;

/** The normalised link if it may be opened outside the app, otherwise null: https on a known code host only. */
export function externalUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_EXTERNAL_URL_CHARS || /[\x00-\x20\\]/.test(raw)) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname;
  const known = host === "dev.azure.com" || host === "github.com" || /^[a-z0-9-]+\.visualstudio\.com$/.test(host);
  return known && u.href.length <= MAX_EXTERNAL_URL_CHARS ? u.href : null;
}

/** Hands a checked link to the system browser: a program and an argument list, never a shell. */
export function browserCommand(url: string, platform: string = process.platform, env: Record<string, string | undefined> = process.env): { command: string; args: string[] } {
  if (platform === "win32") return { command: join(env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"), args: ["url.dll,FileProtocolHandler", url] };
  return { command: platform === "darwin" ? "open" : "xdg-open", args: [url] };
}

type Status = "ready" | "not-authenticated" | "not-installed";

async function sourceControl(cfg: GuardConfig, deps: PullDeps) {
  const env = deps.env ?? process.env;
  const version = await new Promise<string | null>((done) =>
    execFile("git", ["--version"], { timeout: 5_000, windowsHide: true }, (e, out) => done(e ? null : out.trim().replace(/^git version /, ""))));
  const provider = (id: "github" | "azure-devops", label: string, status: Status, detail: string) => ({ id, label, status, detail });

  let github;
  if (env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()) github = provider("github", "GitHub", "ready", "A token is set in the environment. It is checked when pull requests are listed.");
  else {
    const exe = (deps.ghPath ?? (() => findGh(env)))();
    if (!exe) github = provider("github", "GitHub", "not-installed", "No token is set and the GitHub CLI is not installed. Set GH_TOKEN, or install gh and run `gh auth login`.");
    else {
      const signedIn = await (deps.runGh ?? defaultRunGh)(exe, ["auth", "status", "--hostname", "github.com"]).then(() => true, () => false);
      github = signedIn ? provider("github", "GitHub", "ready", "The GitHub CLI reports a sign-in.")
        : provider("github", "GitHub", "not-authenticated", "The GitHub CLI is installed but not signed in. Run `gh auth login`.");
    }
  }

  let azure;
  if (env.AZURE_DEVOPS_PAT?.trim()) azure = provider("azure-devops", "Azure DevOps", "ready", "AZURE_DEVOPS_PAT is set. It is checked when pull requests are listed.");
  else if (!version) azure = provider("azure-devops", "Azure DevOps", "not-installed", "Git is not installed, and AZURE_DEVOPS_PAT is not set.");
  else {
    const hosts = new Set<string>();
    for (const r of cfg.repos) {
      if (!existsSync(r.path)) continue;
      const remote = await (deps.remote ?? remoteOf)(r.path);
      if (remote.host === "azure-devops") hosts.add(remote.ctx.host);
    }
    let found = false;
    for (const h of hosts.size ? hosts : ["dev.azure.com"]) if (await (deps.credentials ?? quietGitCredential)(h)) found = true;
    azure = found ? provider("azure-devops", "Azure DevOps", "ready", "A saved Git sign-in was found. It is checked when pull requests are listed.")
      : provider("azure-devops", "Azure DevOps", "not-authenticated", "No saved Git sign-in. Set AZURE_DEVOPS_PAT, or sign in with git once.");
  }
  return { git: { available: version !== null, version }, providers: [github, azure] };
}

export function createRepoRoutes(deps: RepoRouteDeps = {}) {
  const listPulls = createPullLister(deps.pulls);
  const launch = deps.launch ?? defaultLaunch;

  async function route(c: RepoRouteContext): Promise<boolean> {
    const { req, res, path, method, cfg } = c;
    const url = new URL(req.url ?? "/", "http://x");
    const done = (status: number, body: unknown): true => (sendJson(res, status, body), true);

    if (path === "/api/pulls" && method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      if (!(PULL_STATES as readonly string[]).includes(state)) throw new HttpError(400, `Use state: ${PULL_STATES.join(", ")}.`);
      return done(200, await listPulls(cfg, state as PullState, url.searchParams.get("refresh") === "1"));
    }
    // The desktop window ignores window.open, so the engine opens pull request links.
    if (path === "/api/open-external" && method === "POST") {
      const link = externalUrl((await readJson(req))["url"]);
      if (!link) throw new HttpError(400, "Only https links to Azure DevOps or GitHub can be opened. Copy the link instead.");
      const cmd = browserCommand(link);
      try { await launch(cmd.command, cmd.args); } catch { throw new HttpError(500, "Could not open the browser. Copy the link instead."); }
      return done(200, { opened: true });
    }
    if (path === "/api/source-control" && method === "GET") return done(200, await sourceControl(cfg, deps.pulls ?? {}));
    if (path === "/api/repos" && method === "GET") return done(200, { repos: await Promise.all(cfg.repos.map(repoInfo)) });
    if (path === "/api/repos" && method === "POST") {
      const body = await readJson(req);
      return done(201, { repo: await repoInfo(await addRepo(cfg, body["path"], body["id"])) });
    }

    if (path === "/api/repos/browse" && method === "GET") return done(200, browseFolders(cfg, url.searchParams.get("path") ?? ""));

    const m = /^\/api\/repos\/([^/]+)(?:\/(branches|diff|commits|review|open))?$/.exec(path);
    if (!m) return false;
    let id: string;
    try { id = decodeURIComponent(m[1] as string); } catch { throw new HttpError(404, "No such repo."); }
    const action = m[2];
    if (!action && method === "DELETE") {
      removeRepo(cfg, id);
      return done(200, { removed: true });
    }
    if (action === "branches" && method === "GET") {
      const { current, branches } = await listBranches(openRepo(cfg, id).path);
      return done(200, { current, branches: branches.map(({ ref: _ref, ...b }) => b) });
    }
    if (action === "commits" && method === "GET") {
      const repo = openRepo(cfg, id);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return done(200, { commits: await listCommits(repo.path, url.searchParams.get("ref") || "HEAD", limit) });
    }
    if (action === "diff" && method === "GET") {
      const repo = openRepo(cfg, id);
      return done(200, await diffView(repo.path, url.searchParams.get("base") ?? "", url.searchParams.get("head") ?? "", url.searchParams.get("ignoreWhitespace") === "1"));
    }
    if (action === "open" && method === "POST") {
      const body = await readJson(req);
      const cmd = openCommand(body["app"], openRepo(cfg, id).path);
      try { await launch(cmd.command, cmd.args); } catch { throw new HttpError(500, "Could not start that program."); }
      return done(200, { opened: true });
    }
    if (action === "review" && method === "POST") {
      const body = await readJson(req);
      const repo = openRepo(cfg, id);
      const input = { base: String(body["base"] ?? ""), head: String(body["head"] ?? ""), ai: body["ai"] === true };
      const stream = (req.headers.accept ?? "").includes("application/x-ndjson");
      let send: ((ev: unknown) => void) | null = null;
      const emit = (ev: unknown): void => {
        // The stream starts with the first event, so a bad ref still gets a normal error status.
        if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
        if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(ev) + "\n");
      };
      if (stream) send = emit;
      const index = c.openIndex();
      try {
        const result = await reviewRepo(cfg, index?.db ?? null, repo, input, {
          complete: c.complete, ...(send ? { onStep: (s) => { if (s.status !== "running" || res.headersSent) send!({ type: "step", step: s }); } } : {}),
        });
        const reviewView = parseView(url.searchParams.get("view"));
        const report = renderReport(reviewModel(repo.id, result), reviewView);
        if (!send) return done(200, { ...result, report });
        send({ type: "result", ...result, report });
        res.end();
        return true;
      } catch (e) {
        if (!res.headersSent) throw e;
        emit({ type: "error", message: e instanceof HttpError || e instanceof GitError ? e.message : "The review could not finish." });
        res.end();
        return true;
      } finally {
        index?.release();
      }
    }
    return false;
  }

  return async (c: RepoRouteContext): Promise<boolean> => {
    try {
      return await route(c);
    } catch (e) {
      if (e instanceof GitError) throw new HttpError(409, e.message);
      throw e;
    }
  };
}
