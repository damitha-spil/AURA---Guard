import { execFileSync } from "node:child_process";

/** Where a repository lives on an Azure DevOps server, worked out from its `origin` remote. */
export interface RepoCtx {
  /** scheme://host[:port], no trailing slash. */
  origin: string;
  host: string;
  /** Encoded path up to the project, e.g. "/org/proj" or "/proj". */
  projectPath: string;
  org?: string;
  project: string;
  repo: string;
}

function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Understands both remote styles:
 *   https://<org>.visualstudio.com/<project>/_git/<repo>
 *   https://dev.azure.com/<org>/<project>/_git/<repo>
 * Names are URL-decoded. Any user or password part of the URL is ignored.
 */
export function parseRemote(url: string): RepoCtx | undefined {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  const parts = u.pathname.split("/").filter(Boolean);
  const gi = parts.indexOf("_git");
  if (gi < 1 || gi + 1 >= parts.length) return undefined;
  const repo = dec(parts[gi + 1]!);
  const before = parts.slice(0, gi);
  const host = u.host.toLowerCase();
  const origin = `${u.protocol}//${host}`;
  if (host.endsWith("azure.com")) {
    if (before.length < 2) return undefined;
    const org = dec(before[0]!);
    const project = dec(before[1]!);
    return { origin, host, projectPath: `/${encodeURIComponent(org)}/${encodeURIComponent(project)}`, org, project, repo };
  }
  const project = dec(before[before.length - 1]!);
  const org = host.endsWith(".visualstudio.com") ? host.split(".")[0] : undefined;
  return { origin, host, projectPath: `/${encodeURIComponent(project)}`, ...(org ? { org } : {}), project, repo };
}

/** The `origin` fetch URL of a local clone (read-only git command). */
export function originUrl(repoPath: string): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function repoCtxFromPath(repoPath: string): RepoCtx | undefined {
  const u = originUrl(repoPath);
  return u ? parseRemote(u) : undefined;
}
