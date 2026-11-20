// `aura-guard dept ...` and the helpers every command uses to pick its department.
// Merge `deptCommands` into EXTRA_COMMANDS in main.ts.

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envValue } from "../config.ts";
import { PRODUCT_NAME } from "../brand.ts";
import type { GuardConfig } from "../types.ts";
import { ModelError, allSources, parseDepartment, slug } from "../departments/model.ts";
import type { Department } from "../departments/model.ts";
import {
  DuplicateDepartmentError, RegistryConflictError, UnknownDepartmentError, addDepartment, archiveDepartment,
  ensureStorage, listDepartments, loadRegistry, pathsFor, resolveDepartment, updateRegistry,
} from "../departments/registry.ts";
import type { LoadedRegistry } from "../departments/registry.ts";
import { checkSource, departmentHealth } from "../departments/health.ts";
import { seedDepartments } from "../departments/seed.ts";
import type { CommandContext } from "./main.ts";

type Out = (s: string) => void;
type Flags = Record<string, string | true>;

const copy = {
  usage: [
    "Usage:",
    "  dept list",
    "  dept show <id>",
    "  dept add <id> --name \"..\" [--template engineering|knowledge|support|analysis|custom] [--description \"..\"]",
    "  dept source add <dept> --path <folder> [--kind git|docs] [--module m] [--sub s] [--label l]",
    "  dept module add <dept> <name> [--description \"..\"]",
    "  dept sub add <dept> <module> <name>",
    "  dept archive <id>",
    "  dept purge <id> --yes",
    "  dept seed",
  ].join("\n"),
  badDept: (msg: string) => msg,
  needsSources: "needs sources",
  purgeNeedsYes: (id: string) => `This deletes the whole knowledge folder of "${id}" (notes, index, chats, reports). Run again with --yes to confirm.`,
  seeded: "Departments created.",
  alreadySeeded: "The registry already has departments. Nothing was changed.",
};

/** The department the command runs for: --dept, then QSB_DEPT / AURA_GUARD_DEPT, then the registry default. */
export function selectedDepartmentId(flags: Flags): string | undefined {
  const f = flags["dept"];
  if (typeof f === "string") return f;
  return envValue("DEPT");
}

export class DeptSelectionError extends Error {}

/** Resolves the cfg every command uses. Throws DeptSelectionError with a plain message. */
export function selectConfig(base: GuardConfig, flags: Flags): { cfg: GuardConfig; archived: boolean; reg: LoadedRegistry } {
  if (flags["dept"] === true) throw new DeptSelectionError("Use --dept <id>.");
  const reg = loadRegistry(base);
  try {
    const r = resolveDepartment(reg, selectedDepartmentId(flags), PRODUCT_NAME);
    return { cfg: r.cfg, archived: r.department.archived === true, reg };
  } catch (e) {
    if (e instanceof UnknownDepartmentError) {
      const ids = reg.data.departments.map((d) => d.id).join(", ");
      throw new DeptSelectionError(`${e.message} Departments: ${ids || "(none)"}.`);
    }
    throw e;
  }
}

// The CLI entry sits next to this file, whatever config root is in use.
const MAIN_TS = join(dirname(fileURLToPath(import.meta.url)), "main.ts");
const MAX_CHILD_OUTPUT = 8 * 1024 * 1024;

/** Runs main.ts as a child process with an argument list (never a shell). */
export function runChild(root: string, argv: string[], timeoutMin: number): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", MAIN_TS, ...argv],
      { cwd: root, timeout: timeoutMin * 60_000, maxBuffer: MAX_CHILD_OUTPUT, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ code, text: `${stdout}${stderr}`.trim() });
      },
    );
  });
}

/** `index --all`: index every non-archived department in turn, each in its own process. */
export async function indexAll(base: GuardConfig, flags: Flags, out: Out): Promise<number> {
  const reg = loadRegistry(base);
  const pass: string[] = [];
  if (flags["force"] === true) pass.push("--force");
  if (flags["graph"] === true) pass.push("--graph");
  if (typeof flags["max"] === "string") pass.push("--max", flags["max"]);
  let failed = 0;
  for (const d of listDepartments(reg)) {
    out(`== ${d.name} (${d.id}) ==`);
    const r = await runChild(base.root, ["index", "--dept", d.id, ...pass], 30);
    if (r.text) out(r.text);
    if (r.code !== 0) failed++;
  }
  return failed ? 1 : 0;
}

/** Finds a module by id or name (case-insensitive). */
function findModule(d: Department, key: string) {
  const k = key.toLowerCase();
  return d.modules.find((m) => m.id === key || m.name.toLowerCase() === k);
}

function describe(d: Department): string {
  const flags = [d.archived ? "archived" : "", allSources(d).length === 0 ? copy.needsSources : ""].filter(Boolean).join(", ");
  return `${d.id.padEnd(14)} ${d.name.padEnd(18)} ${d.template.padEnd(12)} ${(d.storage ?? "department").padEnd(10)} sources ${allSources(d).length}${flags ? `  (${flags})` : ""}`;
}

function show(base: GuardConfig, d: Department, out: Out): void {
  const paths = pathsFor(d, base);
  out(`${d.name} (${d.id})${d.archived ? "  [archived]" : ""}`);
  if (d.description) out(`  ${d.description}`);
  if (d.owner) out(`  Owner: ${d.owner}`);
  out(`  Template: ${d.template}   Storage: ${d.storage ?? "department"}`);
  out(`  Vault: ${paths.vaultDir}`);
  out(`  Index: ${paths.dbFile}`);
  const on = Object.entries(d.roles).filter(([, v]) => v).map(([k]) => k);
  out(`  Helpers on: ${on.join(", ") || "none"}`);
  const line = (s: Department["sources"][number], pad: string) => out(`${pad}- ${s.label} [${s.kind}] ${s.path}  (id ${s.id})`);
  for (const s of d.sources) line(s, "  ");
  for (const m of d.modules) {
    out(`  Module: ${m.name} (${m.id})`);
    for (const s of m.sources) line(s, "    ");
    for (const sub of m.subModules) {
      out(`    Sub-module: ${sub.name} (${sub.id})${sub.sources.length === 0 ? "  needs sources" : ""}`);
      for (const s of sub.sources) line(s, "      ");
    }
    if (m.sources.length === 0 && m.subModules.length === 0) out("    needs sources");
  }
  if (allSources(d).length === 0) out(`  ${copy.needsSources}`);
  const h = departmentHealth(d, paths);
  out(`  Index: ${h.commits} commits, ${h.files} files; vault: ${h.notes} notes (${h.active} active, ${h.proposed} proposed)`);
}

function uniqueSourceId(d: Department, base: string): string {
  const taken = new Set(allSources(d).map((p) => p.source.id));
  const b = slug(base, "source");
  let id = b.length >= 2 ? b : `${b}-1`;
  for (let n = 2; taken.has(id); n++) id = `${b.slice(0, 36)}-${n}`;
  return id;
}

function fail(out: Out, e: unknown): number {
  if (e instanceof ModelError || e instanceof UnknownDepartmentError || e instanceof DuplicateDepartmentError || e instanceof RegistryConflictError || e instanceof DeptSelectionError) {
    out(e.message);
    return 1;
  }
  throw e;
}

const strFlag = (f: Flags, k: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : undefined);

function deptCommand(ctx: CommandContext): number {
  const { rest, flags, out } = ctx;
  const base = ctx.base ?? ctx.cfg;
  const [sub, a, b, c] = rest;
  try {
    if (sub === "list") {
      const reg = loadRegistry(base);
      out(`Default: ${reg.data.defaultDepartment}${reg.synthesized ? "  (no registry file yet; one legacy department is derived from guard.config.local.json)" : ""}`);
      for (const d of reg.data.departments) out(describe(d));
      return 0;
    }
    if (sub === "show") {
      if (!a) return (out(copy.usage), 2);
      const reg = loadRegistry(base);
      const d = reg.data.departments.find((x) => x.id === a);
      if (!d) throw new UnknownDepartmentError(a);
      show(base, d, out);
      return 0;
    }
    if (sub === "add") {
      const name = strFlag(flags, "name");
      if (!a || !name) return (out(copy.usage), 2);
      const r = addDepartment(base, {
        id: a, name, template: strFlag(flags, "template") ?? "custom",
        ...(strFlag(flags, "description") ? { description: strFlag(flags, "description") } : {}),
        ...(strFlag(flags, "owner") ? { owner: strFlag(flags, "owner") } : {}),
        ...(strFlag(flags, "color") ? { color: strFlag(flags, "color") } : {}),
      });
      out(`Added department ${r.department.id}. Add sources with: dept source add ${r.department.id} --path <folder>`);
      return 0;
    }
    if (sub === "module" && a === "add") {
      const dept = b;
      const name = c;
      if (!dept || !name) return (out(copy.usage), 2);
      updateRegistry(base, (r) => {
        const d = r.departments.find((x) => x.id === dept);
        if (!d) throw new UnknownDepartmentError(dept);
        const taken = new Set(d.modules.map((m) => m.id));
        let id = slug(name, "module");
        for (let n = 2; taken.has(id); n++) id = `${slug(name, "module").slice(0, 36)}-${n}`;
        d.modules.push({ id: id.length >= 2 ? id : `${id}-1`, name, ...(strFlag(flags, "description") ? { description: strFlag(flags, "description") as string } : {}), subModules: [], sources: [] });
      });
      out(`Added module "${name}" to ${dept}.`);
      return 0;
    }
    if (sub === "sub" && a === "add") {
      const [dept, mod, name] = [b, c, rest[4]];
      if (!dept || !mod || !name) return (out(copy.usage), 2);
      updateRegistry(base, (r) => {
        const d = r.departments.find((x) => x.id === dept);
        if (!d) throw new UnknownDepartmentError(dept);
        const m = findModule(d, mod);
        if (!m) throw new ModelError([`${dept} has no module "${mod}". Add it first: dept module add ${dept} "${mod}"`]);
        const taken = new Set(m.subModules.map((s) => s.id));
        let id = slug(name, "sub-module");
        for (let n = 2; taken.has(id); n++) id = `${slug(name, "sub-module").slice(0, 36)}-${n}`;
        m.subModules.push({ id: id.length >= 2 ? id : `${id}-1`, name, sources: [] });
      });
      out(`Added sub-module "${name}" to ${dept}/${mod}.`);
      return 0;
    }
    if (sub === "source" && a === "add") {
      const dept = b;
      const path = strFlag(flags, "path");
      if (!dept || !path) return (out(copy.usage), 2);
      const kindFlag = strFlag(flags, "kind");
      if (kindFlag !== undefined && kindFlag !== "git" && kindFlag !== "docs") return (out("--kind must be git or docs."), 2);
      const probe = checkSource(path, kindFlag ?? "docs");
      if (!probe.exists) return (out(probe.error ?? "That folder does not exist."), 1);
      const kind: "git" | "docs" = kindFlag ?? (probe.isGit ? "git" : "docs");
      if (kind === "git" && !probe.isGit) return (out("That folder is not a git repository. Use --kind docs for a plain folder."), 1);
      const tail = path.split(/[\\/]+/).filter(Boolean).pop() ?? "source";
      const label = strFlag(flags, "label") ?? tail;
      const mod = strFlag(flags, "module");
      const subName = strFlag(flags, "sub");
      if (subName && !mod) return (out("--sub needs --module."), 2);
      updateRegistry(base, (r) => {
        const d = r.departments.find((x) => x.id === dept);
        if (!d) throw new UnknownDepartmentError(dept);
        const src = { id: uniqueSourceId(d, label), kind, label, path, ...(probe.branch ? { branch: probe.branch } : {}) };
        if (!mod) return void d.sources.push(src);
        const m = findModule(d, mod);
        if (!m) throw new ModelError([`${dept} has no module "${mod}". Add it first: dept module add ${dept} "${mod}"`]);
        if (!subName) return void m.sources.push(src);
        const s = m.subModules.find((x) => x.id === subName || x.name.toLowerCase() === subName.toLowerCase());
        if (!s) throw new ModelError([`Module ${m.name} has no sub-module "${subName}". Add it first: dept sub add ${dept} "${m.name}" "${subName}"`]);
        s.sources.push(src);
      });
      out(`Added ${kind} source "${label}" to ${dept}. Index it with: index --dept ${dept}`);
      return 0;
    }
    if (sub === "archive") {
      if (!a) return (out(copy.usage), 2);
      archiveDepartment(base, a);
      out(`Archived ${a}. Its knowledge folder is kept.`);
      return 0;
    }
    if (sub === "purge") {
      if (!a) return (out(copy.usage), 2);
      const reg = loadRegistry(base);
      const d = reg.data.departments.find((x) => x.id === a);
      if (!d) throw new UnknownDepartmentError(a);
      if (d.storage === "legacy") return (out("The legacy department's knowledge is never deleted. Use: dept archive " + a), 1);
      if (flags["yes"] !== true) return (out(copy.purgeNeedsYes(a)), 1);
      const r = archiveDepartment(base, a, { purge: true });
      out(r.purged ? `Deleted the knowledge folder of ${a} and removed it from the list.` : `Removed ${a} from the list (it had no folder).`);
      return 0;
    }
    if (sub === "seed") {
      const r = seedDepartments(base);
      if (r.alreadySeeded) return (out(copy.alreadySeeded), 0);
      if (r.noSeedFile) {
        out(`There is no seed file. Copy departments.seed.example.json to ${r.noSeedFile}, edit it, and run this again. Or add departments in the app or with: dept add`);
        return 1;
      }
      out(copy.seeded);
      for (const x of r.report) {
        out(`  ${x.id.padEnd(10)} ${x.name.padEnd(10)} sources ${x.sources}${x.needsSources ? "  needs sources" : ""}${x.missing.length ? `  (folder not on this computer: ${x.missing.join(", ")})` : ""}`);
      }
      return 0;
    }
    out(copy.usage);
    return 2;
  } catch (e) {
    return fail(out, e);
  }
}

export const deptCommands: Record<string, (ctx: CommandContext) => Promise<number> | number> = {
  dept: deptCommand,
};

// Re-exported so tests can reach the helpers without the whole CLI.
export { ensureStorage, parseDepartment };
