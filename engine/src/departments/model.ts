// The department data model. Everything that enters the registry (from the CLI, the web UI or a
// seed) passes through these schemas first, so a bad id or an unsafe path never reaches the disk.

import { z } from "zod";

export const COLORS = ["slate", "teal", "blue", "violet", "amber", "rose", "green", "orange"] as const;
export const TEMPLATE_IDS = ["engineering", "knowledge", "support", "analysis", "custom"] as const;
export const ROLE_KEYS = ["scribe", "reviewer", "refactor", "qa", "rules", "prs", "supportWriter", "quiz", "daily"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_PATH_CHARS = 500;

/** Lower-case words joined by dashes; empty text gives `fallback`. */
export function slug(text: string, fallback = "item", max = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return s || fallback;
}

/**
 * Why a source path is refused, or null when it is an absolute LOCAL path.
 * Refused: network (UNC) paths, URLs, relative paths, `..`, and control characters.
 */
export function pathProblem(p: string): string | null {
  if (typeof p !== "string" || p.trim() === "") return "Give a folder path.";
  if (p.length > MAX_PATH_CHARS) return "That path is too long.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) return "That path has a control character.";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return "Use a folder on this computer, not a web address.";
  if (p.startsWith("\\\\") || p.startsWith("//")) return "Network paths are not allowed. Use a folder on this computer.";
  const abs = /^[A-Za-z]:[\\/]/.test(p) || /^\/(?!\/)/.test(p);
  if (!abs) return "Use the full path, starting with a drive letter such as D:\\ or with /.";
  if (p.split(/[\\/]+/).some((s) => s === "..")) return "A path may not contain '..'.";
  return null;
}

const id = z.string().min(2).max(40).regex(KEBAB, "Use lower-case words joined by dashes.");
const optText = (max: number) => z.string().max(max).optional();

export const SourceSchema = z.object({
  id,
  kind: z.enum(["git", "docs"]),
  label: z.string().trim().min(1).max(80),
  path: z.string().superRefine((v, ctx) => {
    const p = pathProblem(v);
    if (p) ctx.addIssue({ code: "custom", message: p });
  }),
  branch: z.string().max(100).optional(),
  remoteHint: z.string().max(200).optional(),
});

export const SubModuleSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  description: optText(400),
  sources: z.array(SourceSchema).default([]),
});

export const ModuleSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  description: optText(400),
  subModules: z.array(SubModuleSchema).default([]),
  sources: z.array(SourceSchema).default([]),
});

export const RolesSchema = z.object({
  scribe: z.boolean().default(false),
  reviewer: z.boolean().default(false),
  refactor: z.boolean().default(false),
  qa: z.boolean().default(false),
  rules: z.boolean().default(false),
  prs: z.boolean().default(false),
  supportWriter: z.boolean().default(false),
  quiz: z.boolean().default(false),
  daily: z.boolean().default(false),
});

export const DepartmentSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  description: optText(400),
  owner: optText(80),
  template: z.enum(TEMPLATE_IDS),
  color: z.enum(COLORS).optional(),
  roles: RolesSchema,
  modules: z.array(ModuleSchema).default([]),
  sources: z.array(SourceSchema).default([]),
  createdAt: z.string().min(1).max(40),
  archived: z.boolean().optional(),
  storage: z.enum(["legacy", "department"]).optional(),
});

export const RegistrySchema = z.object({
  version: z.literal(1),
  defaultDepartment: id,
  departments: z.array(DepartmentSchema),
});

export type Source = z.infer<typeof SourceSchema>;
export type SubModule = z.infer<typeof SubModuleSchema>;
export type Module = z.infer<typeof ModuleSchema>;
export type Roles = z.infer<typeof RolesSchema>;
export type Department = z.infer<typeof DepartmentSchema>;
export type RegistryFile = z.infer<typeof RegistrySchema>;

/** Input for a new or edited department: ids and dates may be left out and are filled in. */
export class ModelError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(issues[0] ?? "Invalid department.");
    this.issues = issues;
  }
}

function issuesOf(e: z.ZodError): string[] {
  return e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
}

function uniqueId(base: string, taken: Set<string>): string {
  let out = base.length >= 2 ? base : `${base}-1`;
  for (let n = 2; taken.has(out); n++) out = `${base.slice(0, 36)}-${n}`;
  taken.add(out);
  return out;
}

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => v !== null && typeof v === "object" && !Array.isArray(v);

/** Fill in missing ids (from names or labels). Unique ids are kept as given; clashes are caught by validation. */
function fillSources(list: unknown, taken: Set<string>): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((s) => {
    if (!isObj(s)) return s;
    if (typeof s["id"] === "string" && s["id"]) {
      taken.add(s["id"]);
      return s;
    }
    const label = typeof s["label"] === "string" ? s["label"] : "";
    const path = typeof s["path"] === "string" ? s["path"] : "";
    const tail = path.split(/[\\/]+/).filter(Boolean).pop() ?? "";
    return { ...s, id: uniqueId(slug(label || tail, "source"), taken), label: label || tail || "Source" };
  });
}

function fillChildren<T extends Loose>(list: unknown, nameKey: string, taken: Set<string>, each: (x: T, ids: Set<string>) => T): unknown {
  if (!Array.isArray(list)) return list;
  const ids = new Set<string>();
  for (const x of list) if (isObj(x) && typeof x["id"] === "string") ids.add(x["id"]);
  return list.map((x) => {
    if (!isObj(x)) return x;
    const withId = typeof x["id"] === "string" && x["id"] ? x : { ...x, id: uniqueId(slug(String(x[nameKey] ?? ""), "item"), ids) };
    return each(withId as T, taken);
  });
}

/** Generates missing ids for modules, sub-modules and sources. Does not validate. */
export function withGeneratedIds(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const taken = new Set<string>();
  const out: Loose = { ...raw };
  out["sources"] = fillSources(raw["sources"], taken);
  out["modules"] = fillChildren<Loose>(raw["modules"], "name", taken, (m, t) => ({
    ...m,
    sources: fillSources(m["sources"], t),
    subModules: fillChildren<Loose>(m["subModules"], "name", t, (s, t2) => ({ ...s, sources: fillSources(s["sources"], t2) })),
  }));
  return out;
}

/** Rules a schema cannot express: unique ids inside a parent, unique source ids per department. */
export function structureProblems(d: Department): string[] {
  const out: string[] = [];
  const dup = (what: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const x of ids) {
      if (seen.has(x)) out.push(`${what}: the id "${x}" is used twice.`);
      seen.add(x);
    }
  };
  dup("modules", d.modules.map((m) => m.id));
  const sourceIds: string[] = [...d.sources.map((s) => s.id)];
  for (const m of d.modules) {
    dup(`module ${m.id} sub-modules`, m.subModules.map((s) => s.id));
    sourceIds.push(...m.sources.map((s) => s.id));
    for (const s of m.subModules) sourceIds.push(...s.sources.map((x) => x.id));
  }
  dup("sources", sourceIds);
  return out;
}

/** Validates a department (ids are generated when missing). Throws ModelError with plain messages. */
export function parseDepartment(raw: unknown): Department {
  const r = DepartmentSchema.safeParse(withGeneratedIds(raw));
  if (!r.success) throw new ModelError(issuesOf(r.error));
  const problems = structureProblems(r.data);
  if (problems.length) throw new ModelError(problems);
  return r.data;
}

export function parseRegistry(raw: unknown): RegistryFile {
  const r = RegistrySchema.safeParse(raw);
  if (!r.success) throw new ModelError(issuesOf(r.error));
  const out: string[] = [];
  const seen = new Set<string>();
  let legacy = 0;
  for (const d of r.data.departments) {
    if (seen.has(d.id)) out.push(`The department id "${d.id}" is used twice.`);
    seen.add(d.id);
    if (d.storage === "legacy") legacy++;
    out.push(...structureProblems(d).map((p) => `${d.id}: ${p}`));
  }
  if (legacy > 1) out.push("Only one department may use the legacy storage.");
  if (r.data.departments.length && !seen.has(r.data.defaultDepartment)) out.push("The default department does not exist.");
  if (out.length) throw new ModelError(out);
  return r.data;
}

/** Every source of a department with where it sits. */
export interface PlacedSource { source: Source; module?: { id: string; name: string }; sub?: { id: string; name: string } }

export function allSources(d: Department): PlacedSource[] {
  const out: PlacedSource[] = d.sources.map((source) => ({ source }));
  for (const m of d.modules) {
    for (const source of m.sources) out.push({ source, module: { id: m.id, name: m.name } });
    for (const s of m.subModules) {
      for (const source of s.sources) out.push({ source, module: { id: m.id, name: m.name }, sub: { id: s.id, name: s.name } });
    }
  }
  return out;
}
