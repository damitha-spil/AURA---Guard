// Azure DevOps work items, read only: the ones linked to pull requests and the ones assigned to the
// signed-in user. The list of ids comes from one WIQL query (a POST that only reads: Azure has no GET
// form of it); everything else is GET. Titles and names are untrusted text for the screen only.

import { existsSync } from "node:fs";
import type { GuardConfig } from "../types.ts";
import { HttpError } from "../server/http.ts";
import { findRepo, remoteOf } from "../repos/repos.ts";
import { AuthBlockedError, AzureError, API_VERSION, createClient } from "./azure.ts";
import type { CredentialProvider } from "./azure.ts";
import { AZURE_HELP, HOST_TIMEOUT_MS, azureCredentials } from "./host-access.ts";
import type { PullDeps } from "./pulls.ts";
import type { PullState } from "./pulls.ts";
import type { RepoCtx } from "./remote.ts";

export const WORK_ITEM_STATES = ["open", "closed", "all"] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

/** Most ids one WIQL query returns. */
export const MAX_WIQL_ITEMS = 100;
/** Most pull requests per repository whose linked work items are read: one request each. */
export const MAX_PRS_FOR_LINKS = 20;
/** Azure's own limit for reading work items by id in one request is 200. */
const BATCH = 100;
const MAX_ITEMS = 200;
const CACHE_MS = 60_000;
const FIELDS = ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo", "System.ChangedDate"];

export interface WorkItem {
  id: number; title: string; type: string; state: string; assignedTo: string; url: string; changedDate: string;
  repoId: string; via: ("assigned" | "linked")[]; pulls: number[];
}
export interface WorkItemSource { repoId: string; ok: boolean; error: string | null }
export interface WorkItemList { checkedAt: string; sources: WorkItemSource[]; items: WorkItem[] }

export interface WorkItemDeps extends PullDeps {
  /** Lists pull requests; the route passes the shared lister. */
  listPulls: (cfg: GuardConfig, state: PullState, refresh?: boolean) => Promise<{ pulls: { number: number; repoId: string }[] }>;
}

class Fix extends Error {}

const text = (v: unknown, max = 300): string => String(v ?? "").slice(0, max);

/** True for a state that means the work is over, in the common Azure processes. */
export const isClosedState = (s: string): boolean => /^(closed|done|removed|completed|resolved)$/i.test(s.trim());

export const workItemUrl = (ctx: RepoCtx, id: number): string => `${ctx.origin}${ctx.projectPath}/_workitems/edit/${id}`;

/** One read-only request under {project}/_apis/. POST is allowed for the WIQL query only. */
async function wit(ctx: RepoCtx, creds: CredentialProvider, fetchFn: typeof fetch, method: "GET" | "POST", path: string, query: Record<string, string | number>, body?: unknown): Promise<unknown> {
  if (method === "POST" && path !== "wit/wiql") throw new Error("Only the WIQL query may be sent as a POST.");
  if (!ctx.origin.startsWith("https://")) throw new Fix("Refusing to send a sign-in over a non-HTTPS address.");
  const c = await creds(ctx.host.replace(/:\d+$/, ""));
  if (!c) throw new Fix(`No sign-in for Azure DevOps. ${AZURE_HELP}`);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) q.set(k, String(v));
  q.set("api-version", API_VERSION);
  let res: Response;
  try {
    res = await fetchFn(`${ctx.origin}${ctx.projectPath}/_apis/${path}?${q}`, {
      method, redirect: "manual", signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
      headers: {
        Authorization: "Basic " + Buffer.from(`${c.username}:${c.password}`).toString("base64"), Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Fix("Azure DevOps did not answer in time. Check the connection and refresh."); }
  if (res.status >= 300 && res.status < 400) throw new Fix("Azure DevOps redirected the request, which is not followed. Check the repository's origin address.");
  if (res.status === 401 || res.status === 403) throw new Fix(`Azure DevOps refused the sign-in (HTTP ${res.status}). The token needs Work Items: Read. ${AZURE_HELP}`);
  if (res.status === 404) throw new Fix("Azure DevOps could not find that project or work items. Check the repository's origin address.");
  const type = res.headers.get("content-type") ?? "";
  if (res.status === 203 || (res.ok && !type.includes("json"))) throw new Fix(`Azure DevOps answered with a sign-in page. ${AZURE_HELP}`);
  if (!res.ok) throw new Fix(`Azure DevOps answered HTTP ${res.status}.`);
  try { return await res.json(); } catch { throw new Fix("Azure DevOps sent an answer that could not be read."); }
}

const ids = (body: unknown, key = "value"): number[] => {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(v) ? (v as any[]).map((x) => Number(x?.id)).filter((n) => Number.isInteger(n) && n > 0) : [];
};

async function details(ctx: RepoCtx, creds: CredentialProvider, f: typeof fetch, list: number[]): Promise<Omit<WorkItem, "repoId" | "via" | "pulls">[]> {
  const out: Omit<WorkItem, "repoId" | "via" | "pulls">[] = [];
  for (let i = 0; i < list.length; i += BATCH) {
    const body = (await wit(ctx, creds, f, "GET", "wit/workitems", { ids: list.slice(i, i + BATCH).join(","), fields: FIELDS.join(",") })) as any;
    for (const w of Array.isArray(body?.value) ? body.value : []) {
      const id = Number(w?.id);
      if (!Number.isInteger(id)) continue;
      const fl = w.fields ?? {};
      const who = fl["System.AssignedTo"];
      out.push({
        id, title: text(fl["System.Title"]), type: text(fl["System.WorkItemType"], 60), state: text(fl["System.State"], 60),
        assignedTo: text(typeof who === "object" ? who?.displayName : who, 120), url: workItemUrl(ctx, id), changedDate: text(fl["System.ChangedDate"], 40),
      });
    }
  }
  return out;
}

/** The query for items assigned to whoever owns the token. */
export function assignedQuery(state: WorkItemState): string {
  const clause = state === "open" ? " AND [System.StateCategory] NOT IN ('Completed','Removed')"
    : state === "closed" ? " AND [System.StateCategory] IN ('Completed','Removed')" : "";
  return `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me${clause} ORDER BY [System.ChangedDate] DESC`;
}

const keep = (state: WorkItemState, s: string): boolean => state === "all" || (state === "open" ? !isClosedState(s) : isClosedState(s));

/** Work items linked to one pull request. */
export async function pullWorkItems(cfg: GuardConfig, repoId: string, number: number, deps: WorkItemDeps): Promise<{ items: WorkItem[] }> {
  if (!Number.isInteger(number) || number < 1) throw new HttpError(400, "Use a pull request number.");
  const repo = findRepo(cfg, repoId);
  if (!existsSync(repo.path)) throw new HttpError(409, "The folder for this repository does not exist on this computer.");
  const remote = await (deps.remote ?? remoteOf)(repo.path);
  if (remote.host !== "azure-devops") return { items: [] };
  try {
    const creds = azureCredentials(deps);
    const f = deps.fetch ?? fetch;
    const client = createClient(remote.ctx, { credentials: creds, timeoutMs: HOST_TIMEOUT_MS, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    const linked = ids(await client.get(`/pullRequests/${number}/workitems`)).slice(0, MAX_ITEMS);
    const items = (await details(remote.ctx, creds, f, linked)).map((w): WorkItem => ({ ...w, repoId, via: ["linked"], pulls: [number] }));
    return { items };
  } catch (e) { return fail(e); }
}

function fail(e: unknown): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof Fix) throw new HttpError(502, e.message);
  if (e instanceof AuthBlockedError) throw new HttpError(502, `Azure DevOps did not accept a sign-in. ${AZURE_HELP}`);
  if (e instanceof AzureError) throw new HttpError(502, `Azure DevOps: ${e.message}`);
  throw new HttpError(502, "Work items could not be read.");
}

const message = (e: unknown): string => {
  try { fail(e); } catch (x) { return (x as Error).message; }
  return "Work items could not be read.";
};

export function createWorkItemLister(deps: WorkItemDeps) {
  const cache = new Map<string, { at: number; value: Promise<WorkItemList> }>();

  async function load(cfg: GuardConfig, repoId: string, state: WorkItemState): Promise<WorkItemList> {
    const repos = repoId ? [findRepo(cfg, repoId)] : cfg.repos;
    const creds = azureCredentials(deps);
    const f = deps.fetch ?? fetch;
    const sources: WorkItemSource[] = [];
    const byKey = new Map<string, WorkItem>();
    const doneProjects = new Set<string>();

    for (const r of repos) {
      try {
        if (!existsSync(r.path)) throw new Fix("The folder does not exist on this computer.");
        const remote = await (deps.remote ?? remoteOf)(r.path);
        if (remote.host !== "azure-devops") {
          // Asked for by name: say why there is nothing. In the all-repositories view it is simply left out.
          if (repoId) throw new Fix("Work items come from Azure DevOps. This repository is not on Azure DevOps.");
          continue;
        }
        const ctx = remote.ctx;
        const projectKey = `${ctx.origin}${ctx.projectPath}`;
        const add = (w: Omit<WorkItem, "repoId" | "via" | "pulls">, via: "assigned" | "linked", pull?: number): void => {
          const key = `${projectKey}#${w.id}`;
          const have = byKey.get(key);
          if (!have) byKey.set(key, { ...w, repoId: r.id, via: [via], pulls: pull ? [pull] : [] });
          else {
            if (!have.via.includes(via)) have.via.push(via);
            if (pull && !have.pulls.includes(pull)) have.pulls.push(pull);
          }
        };

        // Assigned to the signed-in user: once for each project.
        if (!doneProjects.has(projectKey)) {
          doneProjects.add(projectKey);
          const found = await wit(ctx, creds, f, "POST", "wit/wiql", { $top: MAX_WIQL_ITEMS }, { query: assignedQuery(state) });
          for (const w of await details(ctx, creds, f, ids(found, "workItems"))) add(w, "assigned");
        }

        // Linked to this repository's pull requests: the newest few, one request each.
        const client = createClient(ctx, { credentials: creds, timeoutMs: HOST_TIMEOUT_MS, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
        const pulls = (await deps.listPulls({ ...cfg, repos: [r] }, state === "open" ? "open" : "all")).pulls.slice(0, MAX_PRS_FOR_LINKS);
        for (const p of pulls) {
          const linked = ids(await client.get(`/pullRequests/${p.number}/workitems`)).slice(0, 50);
          if (!linked.length) continue;
          for (const w of await details(ctx, creds, f, linked)) if (keep(state, w.state)) add(w, "linked", p.number);
        }
        sources.push({ repoId: r.id, ok: true, error: null });
      } catch (e) {
        sources.push({ repoId: r.id, ok: false, error: e instanceof Fix ? e.message : message(e) });
      }
    }
    const items = [...byKey.values()].sort((a, b) => b.changedDate.localeCompare(a.changedDate)).slice(0, MAX_ITEMS);
    return { checkedAt: new Date().toISOString(), sources, items };
  }

  return (cfg: GuardConfig, repoId: string, state: WorkItemState, refresh = false): Promise<WorkItemList> => {
    const key = `${repoId}\0${state}\0${cfg.repos.map((r) => `${r.id}=${r.path}`).join("\0")}`;
    const hit = cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = load(cfg, repoId, state);
    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.delete(key));
    return value;
  };
}
