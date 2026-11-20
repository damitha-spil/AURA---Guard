// `dept seed`: creates a starting set of departments in the LOCAL registry
// (data/departments/registry.json, git-ignored) from a LOCAL seed file,
// data/departments/seed.json (also git-ignored). Department names, modules and folder paths are
// company facts, so they never live in code: see departments.seed.example.json for the shape.
// A source is created only when its folder exists on this machine; everything else is created
// empty and reported as "needs sources".

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import { parseDepartment } from "./model.ts";
import type { Department } from "./model.ts";
import { ensureStorage, loadRegistry, saveRegistry } from "./registry.ts";
import { templateRoles } from "./templates.ts";

interface SeedSource { id: string; label: string; path: string }
interface SeedSub { name: string; sources?: SeedSource[] }
interface SeedModule { name: string; sources?: SeedSource[]; subModules?: SeedSub[] }
interface SeedDept {
  id: string;
  name: string;
  description?: string;
  template: Department["template"];
  color: NonNullable<Department["color"]>;
  storage?: "legacy";
  modules?: SeedModule[];
}

export function seedFilePath(base: GuardConfig): string {
  return join(base.dataDir, "departments", "seed.json");
}

/** Reads the local seed file; null when there is none. Throws a plain error when it is malformed. */
export function loadSeedFile(base: GuardConfig): SeedDept[] | null {
  const file = seedFilePath(base);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`The seed file is not valid JSON: ${file}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { departments?: unknown })?.departments;
  if (!Array.isArray(list)) throw new Error(`The seed file needs a "departments" list: ${file}`);
  for (const d of list) {
    const x = d as Partial<SeedDept>;
    if (typeof x?.id !== "string" || typeof x?.name !== "string" || typeof x?.template !== "string" || typeof x?.color !== "string") {
      throw new Error(`Every department in the seed file needs id, name, template and color: ${file}`);
    }
  }
  return list as SeedDept[];
}

const isDir = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export interface SeedReport {
  id: string;
  name: string;
  sources: number;
  /** Seed sources left out because their folder is not on this machine. */
  missing: string[];
  needsSources: boolean;
}

export interface SeedResult {
  /** True when the registry already had departments, so nothing was changed. */
  alreadySeeded: boolean;
  /** Set when there is no seed file: the path where one can be created. */
  noSeedFile?: string;
  report: SeedReport[];
}

export function seedDepartments(base: GuardConfig, given?: SeedDept[]): SeedResult {
  const cur = loadRegistry(base);
  if (!cur.synthesized && cur.data.departments.length > 0) {
    return { alreadySeeded: true, report: [] };
  }
  const seed = given ?? loadSeedFile(base);
  if (!seed) return { alreadySeeded: false, noSeedFile: seedFilePath(base), report: [] };
  const now = new Date().toISOString();
  const report: SeedReport[] = [];
  const departments: Department[] = [];
  for (const s of seed) {
    const missing: string[] = [];
    const keep = (list: SeedSource[] | undefined) => {
      const out: { id: string; kind: "git"; label: string; path: string }[] = [];
      for (const x of list ?? []) {
        if (isDir(x.path)) out.push({ id: x.id, kind: "git", label: x.label, path: x.path });
        else missing.push(x.label);
      }
      return out;
    };
    const modules = (s.modules ?? []).map((m) => ({
      name: m.name,
      sources: keep(m.sources),
      subModules: (m.subModules ?? []).map((sub) => ({ name: sub.name, sources: keep(sub.sources) })),
    }));
    const dept = parseDepartment({
      id: s.id, name: s.name, description: s.description, template: s.template, color: s.color,
      roles: templateRoles(s.template, base.root), modules, sources: [], createdAt: now,
      storage: s.storage ?? "department",
    });
    departments.push(dept);
    const n = modules.reduce((a, m) => a + m.sources.length + m.subModules.reduce((b, x) => b + x.sources.length, 0), 0);
    report.push({ id: s.id, name: s.name, sources: n, missing, needsSources: n === 0 });
  }
  const first = departments[0];
  if (!first) return { alreadySeeded: false, report };
  saveRegistry(base, { version: 1, defaultDepartment: first.id, departments }, cur.etag);
  for (const d of departments) ensureStorage(d, base);
  return { alreadySeeded: false, report };
}
