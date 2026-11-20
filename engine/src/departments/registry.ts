// The department registry and the ONLY way to get a department's config and paths.
//
// ISOLATION: a request gets its GuardConfig and its folders from resolveDepartment() and from
// nothing else. A department's cfg points at its own vault, its own guard.db and its own data
// folder (reports, chats, daily). No code path builds a path from another department's id.

import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { DocSourceConfig, GuardConfig, RepoConfig } from "../types.ts";
import { allSources, KEBAB, ModelError, parseDepartment, parseRegistry, slug } from "./model.ts";
import type { Department, RegistryFile } from "./model.ts";
import { templateRoles } from "./templates.ts";

export const VAULT_FOLDERS = ["rules", "adr", "patterns", "domain", "diary", "choices", "incidents", "journeys", "support", "inbox"];

export class RegistryConflictError extends Error {
  constructor() {
    super("Someone changed the departments since you opened them. Reload and try again.");
  }
}
export class UnknownDepartmentError extends Error {
  id: string;
  constructor(id: string) {
    super(`There is no department "${id}".`);
    this.id = id;
  }
}
export class DuplicateDepartmentError extends Error {
  constructor(id: string) {
    super(`A department with the id "${id}" already exists.`);
  }
}

export interface LoadedRegistry {
  data: RegistryFile;
  /** sha256 of the file text (or of the synthesised registry when there is no file). */
  etag: string;
  /** The config the registry hangs on: its dataDir holds departments/registry.json. */
  base: GuardConfig;
  /** True when no registry file exists and one legacy department was derived from the config. */
  synthesized: boolean;
}

export interface DepartmentPaths {
  /** Folder for reports, chats and the index. */
  dataDir: string;
  vaultDir: string;
  dbFile: string;
  chatsDir: string;
  legacy: boolean;
}

export interface ResolvedDepartment {
  department: Department;
  cfg: GuardConfig;
  paths: DepartmentPaths;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export const registryPath = (base: GuardConfig): string => join(base.dataDir, "departments", "registry.json");
export const departmentsRoot = (base: GuardConfig): string => join(base.dataDir, "departments");

/** One legacy department built from guard.config.local.json: behaves exactly as before. */
export function legacyDepartment(base: GuardConfig): Department {
  const sources = base.repos.map((r) => ({ id: r.id, kind: "git" as const, label: r.id, path: r.path }));
  return {
    id: "default",
    name: "Default",
    description: "The department Guard had before departments existed.",
    template: "engineering",
    roles: { ...templateRoles("engineering", base.root) },
    modules: [],
    sources,
    createdAt: "2026-01-01T00:00:00.000Z",
    storage: "legacy",
  };
}

export function synthesizeRegistry(base: GuardConfig): RegistryFile {
  return { version: 1, defaultDepartment: "default", departments: [legacyDepartment(base)] };
}

const text = (f: RegistryFile): string => JSON.stringify(f, null, 2) + "\n";

export function loadRegistry(base: GuardConfig): LoadedRegistry {
  const file = registryPath(base);
  if (!existsSync(file)) {
    const data = synthesizeRegistry(base);
    return { data, etag: sha256(text(data)), base, synthesized: true };
  }
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModelError(["registry.json is not valid JSON."]);
  }
  return { data: parseRegistry(parsed), etag: sha256(raw), base, synthesized: false };
}

/**
 * Writes the registry atomically (temp file, then rename), keeps the last version as
 * registry.json.bak, and refuses when `expectedEtag` is not the current etag.
 */
export function saveRegistry(base: GuardConfig, next: RegistryFile, expectedEtag?: string): string {
  const valid = parseRegistry(next);
  const file = registryPath(base);
  if (expectedEtag !== undefined && expectedEtag !== loadRegistry(base).etag) throw new RegistryConflictError();
  mkdirSync(join(base.dataDir, "departments"), { recursive: true });
  const body = text(valid);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body);
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  renameSync(tmp, file);
  return sha256(body);
}

/** Loads, lets `fn` change a copy, validates and saves. Returns the new etag. */
export function updateRegistry(base: GuardConfig, fn: (r: RegistryFile) => void, expectedEtag?: string): { data: RegistryFile; etag: string } {
  const cur = loadRegistry(base);
  const data = structuredClone(cur.data);
  fn(data);
  const valid = parseRegistry(data);
  const etag = saveRegistry(base, valid, expectedEtag ?? cur.etag);
  return { data: valid, etag };
}

export function pathsFor(dept: Department, base: GuardConfig): DepartmentPaths {
  if (dept.storage === "legacy") {
    return { dataDir: base.dataDir, vaultDir: base.vaultDir, dbFile: join(base.dataDir, "guard.db"), chatsDir: join(base.dataDir, "chats"), legacy: true };
  }
  if (!KEBAB.test(dept.id)) throw new Error("Bad department id");
  const dataDir = join(departmentsRoot(base), dept.id);
  return { dataDir, vaultDir: join(dataDir, "vault"), dbFile: join(dataDir, "guard.db"), chatsDir: join(dataDir, "chats"), legacy: false };
}

/** A GuardConfig for one department: repos are all its git sources, so existing modules work unchanged. */
export function cfgFor(dept: Department, base: GuardConfig, productName?: string): GuardConfig {
  const paths = pathsFor(dept, base);
  const repos: RepoConfig[] = [];
  const docSources: DocSourceConfig[] = [];
  for (const { source, module, sub } of allSources(dept)) {
    const place = { ...(module ? { module: module.name } : {}), ...(sub ? { sub: sub.name } : {}) };
    if (source.kind === "git") repos.push({ id: source.id, path: source.path, ...place });
    else docSources.push({ id: source.id, path: source.path, label: source.label, ...place });
  }
  return {
    ...base,
    department: paths.legacy ? base.department : dept.id,
    dataDir: paths.dataDir,
    vaultDir: paths.vaultDir,
    repos,
    docSources,
    roles: { ...dept.roles },
    departmentId: dept.id,
    departmentName: dept.name,
    ...(productName ? { productName } : {}),
  };
}

export function listDepartments(reg: LoadedRegistry, opts: { includeArchived?: boolean } = {}): Department[] {
  return reg.data.departments.filter((d) => opts.includeArchived || !d.archived);
}

/** The only door to a department: returns its config and paths, or throws UnknownDepartmentError. */
export function resolveDepartment(reg: LoadedRegistry, id: string | undefined, productName?: string): ResolvedDepartment {
  const wanted = id ?? reg.data.defaultDepartment;
  const department = reg.data.departments.find((d) => d.id === wanted);
  if (!department) throw new UnknownDepartmentError(wanted);
  return { department, cfg: cfgFor(department, reg.base, productName), paths: pathsFor(department, reg.base) };
}

/** Makes the folders of a department and copies the vault README and templates. Never overwrites. */
export function ensureStorage(dept: Department, base: GuardConfig): DepartmentPaths {
  const paths = pathsFor(dept, base);
  if (paths.legacy) return paths;
  mkdirSync(paths.vaultDir, { recursive: true });
  mkdirSync(paths.chatsDir, { recursive: true });
  for (const f of VAULT_FOLDERS) mkdirSync(join(paths.vaultDir, f), { recursive: true });
  const readme = join(base.vaultDir, "README.md");
  if (existsSync(readme) && !existsSync(join(paths.vaultDir, "README.md"))) copyFileSync(readme, join(paths.vaultDir, "README.md"));
  const tpl = join(base.vaultDir, "_templates");
  if (existsSync(tpl) && !existsSync(join(paths.vaultDir, "_templates"))) cpSync(tpl, join(paths.vaultDir, "_templates"), { recursive: true });
  return paths;
}

/** Deletes ONE department's storage folder. Refuses legacy storage and anything outside departments/<id>. */
export function purgeStorage(dept: Department, base: GuardConfig): boolean {
  if (dept.storage === "legacy") throw new Error("The legacy storage is never deleted.");
  const paths = pathsFor(dept, base);
  const root = resolve(departmentsRoot(base));
  const dir = resolve(paths.dataDir);
  if (!dir.startsWith(root + sep) || dir === root) throw new Error("Refusing to delete outside the department folder.");
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function uniqueDepartmentId(base: string, taken: Set<string>): string {
  const b = base.length >= 2 ? base : `${base}-dept`;
  let id = b;
  for (let n = 2; taken.has(id); n++) id = `${b.slice(0, 36)}-${n}`;
  return id;
}

/** Adds a department (id generated from the name when missing) and creates its storage. */
export function addDepartment(base: GuardConfig, raw: Record<string, unknown>, expectedEtag?: string): { department: Department; etag: string } {
  const cur = loadRegistry(base);
  const taken = new Set(cur.data.departments.map((d) => d.id));
  const name = typeof raw["name"] === "string" ? raw["name"] : "";
  const explicit = typeof raw["id"] === "string" && raw["id"] !== "";
  const id = explicit ? (raw["id"] as string) : uniqueDepartmentId(slug(name, "department"), taken);
  if (taken.has(id)) throw new DuplicateDepartmentError(id);
  const template = (raw["template"] as Department["template"] | undefined) ?? "custom";
  const department = parseDepartment({
    ...raw,
    id,
    template,
    roles: { ...templateRoles(template, base.root), ...(isRecord(raw["roles"]) ? raw["roles"] : {}) },
    createdAt: new Date().toISOString(),
    storage: "department",
    archived: undefined,
  });
  const { etag } = updateRegistry(base, (r) => {
    r.departments.push(department);
    if (!r.departments.some((d) => d.id === r.defaultDepartment)) r.defaultDepartment = department.id;
  }, expectedEtag);
  ensureStorage(department, base);
  return { department, etag };
}

/** Replaces a whole department (modules, sub-modules, sources, roles). The id, createdAt and storage cannot change. */
export function replaceDepartment(base: GuardConfig, id: string, raw: unknown, expectedEtag: string): { department: Department; etag: string } {
  const cur = loadRegistry(base);
  const old = cur.data.departments.find((d) => d.id === id);
  if (!old) throw new UnknownDepartmentError(id);
  const body = isRecord(raw) ? raw : {};
  const archived = typeof body["archived"] === "boolean" ? body["archived"] : old.archived;
  const department = parseDepartment({ ...body, id, createdAt: old.createdAt, storage: old.storage, archived });
  const { etag } = updateRegistry(base, (r) => {
    r.departments = r.departments.map((d) => (d.id === id ? department : d));
  }, expectedEtag);
  ensureStorage(department, base);
  return { department, etag };
}

/** Archives (default) or removes the department and deletes its storage. Legacy storage is never purged. */
export function archiveDepartment(base: GuardConfig, id: string, opts: { purge?: boolean } = {}): { etag: string; purged: boolean } {
  const cur = loadRegistry(base);
  const dept = cur.data.departments.find((d) => d.id === id);
  if (!dept) throw new UnknownDepartmentError(id);
  if (opts.purge && dept.storage === "legacy") throw new Error("The legacy department's knowledge is never deleted. Archive it instead.");
  if (!opts.purge) {
    const { etag } = updateRegistry(base, (r) => {
      const d = r.departments.find((x) => x.id === id);
      if (d) d.archived = true;
    });
    return { etag, purged: false };
  }
  const { etag } = updateRegistry(base, (r) => {
    r.departments = r.departments.filter((x) => x.id !== id);
    if (r.defaultDepartment === id) {
      const next = r.departments.find((x) => !x.archived) ?? r.departments[0];
      if (next) r.defaultDepartment = next.id;
    }
  });
  return { etag, purged: purgeStorage(dept, base) };
}
