// Read-only access to the pull request hosts, shared by the PR diff and the work item code. Only
// reads are sent. A token goes only to its own official host and is never logged or returned.

import type { CredentialProvider } from "./azure.ts";
import { findGh, defaultRunGh, quietGitCredential } from "./pulls.ts";
import type { PullDeps } from "./pulls.ts";

/** A message written for the screen: what went wrong and how to fix it. */
export class HostFix extends Error {}

export const GITHUB_HELP = "Set GH_TOKEN or GITHUB_TOKEN, or install the GitHub CLI and run `gh auth login`.";
export const AZURE_HELP = "Set AZURE_DEVOPS_PAT (Code: Read, Work Items: Read), or sign in with git once (for example fetch the repo yourself), then refresh.";

/** Time allowed for one request to a host. */
export const HOST_TIMEOUT_MS = 12_000;

/** The Azure DevOps sign-in: the PAT from the environment if set, otherwise the saved Git sign-in. */
export function azureCredentials(deps: PullDeps): CredentialProvider {
  const pat = (deps.env ?? process.env).AZURE_DEVOPS_PAT?.trim();
  return pat ? async () => ({ username: "", password: pat }) : deps.credentials ?? quietGitCredential;
}

/** GET a GitHub API path (for example `repos/o/r/pulls/5`) with a token or with gh. */
export async function githubGet(path: string, deps: PullDeps): Promise<unknown> {
  const env = deps.env ?? process.env;
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (token) {
    let res: Response;
    try {
      res = await (deps.fetch ?? fetch)(`https://api.github.com/${path}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "pull-diff" },
      });
    } catch { throw new HostFix("GitHub did not answer in time."); }
    if (res.status === 404) throw new HostFix("GitHub could not find that pull request, or the token cannot read this repo.");
    if (!res.ok) throw new HostFix(`GitHub answered ${res.status}. Check that the token can read this repo.`);
    try { return await res.json(); } catch { throw new HostFix("GitHub sent an answer that could not be read."); }
  }
  const exe = (deps.ghPath ?? (() => findGh(env)))();
  if (!exe) throw new HostFix(`No GitHub sign-in. ${GITHUB_HELP}`);
  try {
    // gh keeps its own token; Guard never sees it.
    return JSON.parse(await (deps.runGh ?? defaultRunGh)(exe, ["api", "--hostname", "github.com", "--method", "GET", path]));
  } catch { throw new HostFix(`The GitHub CLI could not read that. ${GITHUB_HELP}`); }
}
