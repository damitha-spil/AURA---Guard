// Which pull-request host a remote address points to. Only the official cloud hosts are known;
// any user name or token inside a remote address is dropped here and never returned.

import { parseRemote } from "../prs/remote.ts";
import type { RepoCtx } from "../prs/remote.ts";

export type HostKind = "azure-devops" | "github" | "unknown";
export type Remote =
  | { host: "azure-devops"; ctx: RepoCtx }
  | { host: "github"; owner: string; repo: string }
  | { host: "unknown" };

export const isAzureHost = (host: string): boolean => host === "dev.azure.com" || /^[a-z0-9-]+\.visualstudio\.com$/.test(host);

export function classifyRemote(raw: string): Remote {
  const url = raw.trim();
  const gh = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url);
  if (gh && !/^\.+$/.test(gh[1] as string) && !/^\.+$/.test(gh[2] as string)) return { host: "github", owner: gh[1] as string, repo: gh[2] as string };
  // SSH forms of Azure DevOps become the https form the client understands.
  const ssh = /^(?:ssh:\/\/)?[^@/]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/](?:22\/)?v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/.exec(url);
  const ctx = parseRemote(ssh ? `https://dev.azure.com/${ssh[1]}/${ssh[2]}/_git/${ssh[3]}` : url);
  if (ctx && ctx.origin.startsWith("https://") && isAzureHost(ctx.host)) return { host: "azure-devops", ctx };
  return { host: "unknown" };
}
