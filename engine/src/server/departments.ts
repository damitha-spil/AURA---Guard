// Department support for the chat server: one lazily built context per department (its config,
// its index handle, its chat store) and the /api/departments endpoints.
//
// ISOLATION: every request gets its cfg, vault, index and chats from DepartmentHost.context(),
// which calls resolveDepartment(). Nothing in the server holds a "current" department.

import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PRODUCT_NAME } from "../brand.ts";
import { openDb } from "../index/db.ts";
import type { Db } from "../index/db.ts";
import { ChatStore } from "../chat/store.ts";
import type { GuardConfig } from "../types.ts";
import { ModelError, allSources, parseDepartment } from "../departments/model.ts";
import type { Department } from "../departments/model.ts";
import {
  DuplicateDepartmentError, RegistryConflictError, UnknownDepartmentError, addDepartment, archiveDepartment,
  loadRegistry, replaceDepartment, resolveDepartment,
} from "../departments/registry.ts";
import type { LoadedRegistry, ResolvedDepartment } from "../departments/registry.ts";
import { checkSource, departmentHealth } from "../departments/health.ts";
import type { Health } from "../departments/health.ts";
import { loadTemplates } from "../departments/templates.ts";
import { HttpError, readJson, sendJson } from "./http.ts";

/** Health numbers are cached this long so a dashboard refresh never re-reads every vault. */
export const HEALTH_CACHE_MS = 5000;

export interface DeptContext extends ResolvedDepartment {
  archived: boolean;
  store: ChatStore;
  /** Opens this department's index; null when it does not exist. release() ends the request's use. */
  openIndex: () => { db: Db; release: () => void } | null;
}

export class DepartmentHost {
  readonly base: GuardConfig;
  private dbs = new Map<string, { file: string; db: Db }>();
  private health = new Map<string, { at: number; value: Health }>();
  private override: (() => { db: Db; release: () => void } | null) | undefined;

  constructor(base: GuardConfig, openIndexOverride?: () => { db: Db; release: () => void } | null) {
    this.base = base;
    this.override = openIndexOverride;
  }

  registry(): LoadedRegistry {
    return loadRegistry(this.base);
  }

  /** The only way a request reaches a department. Unknown id: UnknownDepartmentError. */
  context(reg: LoadedRegistry, id: string | undefined): DeptContext {
    const r = resolveDepartment(reg, id, PRODUCT_NAME);
    const key = r.department.id;
    const openIndex = this.override
      ? this.override
      : (): { db: Db; release: () => void } | null => {
          if (!existsSync(r.paths.dbFile)) return null;
          let h = this.dbs.get(key);
          if (!h || h.file !== r.paths.dbFile) {
            h?.db.close();
            h = { file: r.paths.dbFile, db: openDb(r.paths.dbFile) };
            this.dbs.set(key, h);
          }
          return { db: h.db, release: () => {} };
        };
    return { ...r, archived: r.department.archived === true, store: new ChatStore(r.cfg.dataDir), openIndex };
  }

  healthFor(reg: LoadedRegistry, d: Department): Health {
    const hit = this.health.get(d.id);
    if (hit && Date.now() - hit.at < HEALTH_CACHE_MS) return hit.value;
    const value = departmentHealth(d, resolveDepartment(reg, d.id).paths);
    this.health.set(d.id, { at: Date.now(), value });
    return value;
  }

  /** Forget cached state for a department (after it changed or its folder was deleted). */
  invalidate(id: string): void {
    const h = this.dbs.get(id);
    if (h) {
      try { h.db.close(); } catch { /* already closed */ }
      this.dbs.delete(id);
    }
    this.health.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.dbs.keys()]) this.invalidate(id);
  }
}

const COUNTS = (d: Department) => ({
  modules: d.modules.length,
  subModules: d.modules.reduce((n, m) => n + m.subModules.length, 0),
  sources: allSources(d).length,
});

function summary(host: DepartmentHost, reg: LoadedRegistry, d: Department) {
  return {
    id: d.id,
    name: d.name,
    description: d.description ?? null,
    owner: d.owner ?? null,
    template: d.template,
    color: d.color ?? null,
    archived: d.archived === true,
    roles: d.roles,
    counts: COUNTS(d),
    health: host.healthFor(reg, d),
  };
}

function bad(e: unknown): HttpError {
  if (e instanceof ModelError) return new HttpError(400, e.message);
  if (e instanceof DuplicateDepartmentError) return new HttpError(409, e.message);
  if (e instanceof RegistryConflictError) return new HttpError(409, e.message);
  if (e instanceof UnknownDepartmentError) return new HttpError(404, e.message);
  if (e instanceof HttpError) return e;
  return new HttpError(500, "Something went wrong in Guard.");
}

const asBody = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Handles /api/departments*. Returns true when the path was one of them. */
export async function handleDepartmentApi(
  host: DepartmentHost, req: IncomingMessage, res: ServerResponse, path: string, method: string,
): Promise<boolean> {
  if (path !== "/api/departments" && !path.startsWith("/api/departments/")) return false;
  try {
    if (path === "/api/departments" && method === "GET") {
      const reg = host.registry();
      sendJson(res, 200, {
        productName: PRODUCT_NAME,
        defaultDepartment: reg.data.defaultDepartment,
        departments: reg.data.departments.map((d) => summary(host, reg, d)),
        templates: loadTemplates(host.base.root).map((t) => ({ id: t.id, name: t.name, description: t.description, hint: t.hint, roles: t.roles })),
        etag: reg.etag,
      });
      return true;
    }

    if (path === "/api/departments" && method === "POST") {
      const body = await readJson(req);
      if (typeof body["name"] !== "string" || body["name"].trim() === "") throw new HttpError(400, "Give the department a name.");
      if (typeof body["template"] !== "string") throw new HttpError(400, "Choose a template.");
      const input: Record<string, unknown> = {};
      for (const k of ["id", "name", "description", "owner", "template", "color", "roles", "modules", "sources"]) if (body[k] !== undefined) input[k] = body[k];
      const etag = typeof body["etag"] === "string" ? body["etag"] : undefined;
      const r = addDepartment(host.base, input, etag);
      sendJson(res, 201, { department: r.department, etag: r.etag });
      return true;
    }

    const m = /^\/api\/departments\/([^/]+)(\/sources\/check)?$/.exec(path);
    if (!m) throw new HttpError(404, "Not found.");
    const id = decodeURIComponent(m[1] as string);
    const reg = host.registry();
    const dept = reg.data.departments.find((d) => d.id === id);
    if (!dept) throw new HttpError(404, `There is no department "${id}".`);

    if (m[2]) {
      if (method !== "POST") throw new HttpError(404, "Not found.");
      const body = await readJson(req);
      const p = body["path"];
      const kind = body["kind"];
      if (typeof p !== "string") throw new HttpError(400, "Give a folder path.");
      if (kind !== "git" && kind !== "docs") throw new HttpError(400, "Use kind: git or docs.");
      sendJson(res, 200, checkSource(p, kind));
      return true;
    }

    if (method === "GET") {
      const sources = allSources(dept).map((p) => ({
        id: p.source.id,
        label: p.source.label,
        kind: p.source.kind,
        path: p.source.path,
        ...(p.module ? { module: p.module.id, moduleName: p.module.name } : {}),
        ...(p.sub ? { sub: p.sub.id, subName: p.sub.name } : {}),
        status: checkSource(p.source.path, p.source.kind),
      }));
      sendJson(res, 200, { department: dept, etag: reg.etag, health: host.healthFor(reg, dept), sources });
      return true;
    }

    if (method === "PUT") {
      const body = await readJson(req);
      if (typeof body["etag"] !== "string") throw new HttpError(400, "Send the etag you loaded.");
      if (body["department"] === null || typeof body["department"] !== "object") throw new HttpError(400, "Send the whole department.");
      // Validate first so a bad body is a 400 even when the etag is also stale.
      parseDepartment({ ...asBody(body["department"]), id, createdAt: dept.createdAt, storage: dept.storage });
      const r = replaceDepartment(host.base, id, body["department"], body["etag"]);
      host.invalidate(id);
      sendJson(res, 200, { department: r.department, etag: r.etag });
      return true;
    }

    if (method === "DELETE") {
      const body = await readJson(req);
      if (body["confirm"] !== id) throw new HttpError(400, "Type the department id to confirm.");
      const purge = body["purge"] === true;
      if (purge && dept.storage === "legacy") throw new HttpError(400, "This department's knowledge is never deleted. Archive it instead.");
      host.invalidate(id);
      const r = archiveDepartment(host.base, id, { purge });
      sendJson(res, 200, { ok: true, id, archived: !purge, purged: r.purged, etag: r.etag });
      return true;
    }

    throw new HttpError(404, "Not found.");
  } catch (e) {
    throw bad(e);
  }
}
