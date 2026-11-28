// GET /api/pulls/:repoId/:number/diff, GET /api/pulls/:repoId/:number/workitems and GET /api/workitems.
// Read-only. The server has already checked the cookie, Host and Origin before these run.

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson } from "../server/http.ts";
import type { GuardConfig } from "../types.ts";
import { GitError } from "../repos/safe-git.ts";
import { pullDiff } from "./pr-diff.ts";
import { createPullLister } from "./pulls.ts";
import type { PullDeps } from "./pulls.ts";
import { WORK_ITEM_STATES, createWorkItemLister, pullWorkItems } from "./workitems.ts";
import type { WorkItemState } from "./workitems.ts";

export interface PrRouteContext { req: IncomingMessage; res: ServerResponse; path: string; method: string; cfg: GuardConfig }

export function createPrRoutes(deps: PullDeps = {}) {
  const listPulls = createPullLister(deps);
  const wiDeps = { ...deps, listPulls };
  const listItems = createWorkItemLister(wiDeps);

  return async function route(c: PrRouteContext): Promise<boolean> {
    const { req, res, path, method, cfg } = c;
    if (method !== "GET") return false;
    const url = new URL(req.url ?? "/", "http://x");

    if (path === "/api/workitems") {
      const state = url.searchParams.get("state") ?? "open";
      if (!(WORK_ITEM_STATES as readonly string[]).includes(state)) throw new HttpError(400, `Use state: ${WORK_ITEM_STATES.join(", ")}.`);
      sendJson(res, 200, await listItems(cfg, url.searchParams.get("repoId") ?? "", state as WorkItemState, url.searchParams.get("refresh") === "1"));
      return true;
    }

    const m = /^\/api\/pulls\/([^/]+)\/(\d{1,9})\/(diff|workitems)$/.exec(path);
    if (!m) return false;
    let repoId: string;
    try { repoId = decodeURIComponent(m[1] as string); } catch { throw new HttpError(404, "No such repo."); }
    const number = Number(m[2]);
    try {
      if (m[3] === "diff") sendJson(res, 200, await pullDiff(cfg, repoId, number, url.searchParams.get("ignoreWhitespace") === "1", deps));
      else sendJson(res, 200, await pullWorkItems(cfg, repoId, number, wiDeps));
    } catch (e) {
      if (e instanceof GitError) throw new HttpError(409, e.message);
      throw e;
    }
    return true;
  };
}
