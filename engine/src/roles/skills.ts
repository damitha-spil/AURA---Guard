// Dynamic Skill Registry: discovers and serves Security, QA, QE, and Core skills
// from plugin/aura-guard/skills/*/SKILL.md plus optional REO-generated skills under extraDir.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

export type SkillCategory = "security" | "qa" | "qe" | "core";

export interface SkillSummary {
  name: string;
  description: string;
  category: SkillCategory;
  file: string;
  createdBy?: "reo" | "system";
  origin?: string;
}

export interface SkillDoc extends SkillSummary {
  body: string;
}

const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CATEGORY_ORDER: Record<SkillCategory, number> = {
  security: 0,
  qa: 1,
  qe: 2,
  core: 3,
};

export function inferSkillCategory(name: string): SkillCategory {
  if (name.startsWith("sec-")) return "security";
  if (name.startsWith("qa-")) return "qa";
  if (name.startsWith("qe-")) return "qe";
  return "core";
}

function skillsRoot(root: string): string {
  return resolve(join(root, "plugin", "aura-guard", "skills"));
}

function parseSkillFile(raw: string, fallbackName: string, relFile: string, isGenerated = false): SkillDoc | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  let name = fallbackName;
  let description = "";
  let body = raw.trim();
  let createdBy: "reo" | "system" = isGenerated ? "reo" : "system";
  let origin: string | undefined;

  if (m) {
    try {
      const fm = (parseYaml(m[1] ?? "") ?? {}) as Record<string, unknown>;
      if (typeof fm["name"] === "string" && fm["name"].trim()) name = fm["name"].trim();
      if (typeof fm["description"] === "string") description = fm["description"].trim();
      if (fm["created_by"] === "reo") createdBy = "reo";
      if (typeof fm["origin"] === "string" && fm["origin"].trim()) origin = fm["origin"].trim();
    } catch {
      return null;
    }
    body = (m[2] ?? "").trim();
  }

  if (!name || !body) return null;
  return {
    name,
    description,
    category: inferSkillCategory(name),
    file: relFile,
    createdBy,
    ...(origin ? { origin } : {}),
    body,
  };
}

function readSkillsFromDir(dir: string, relPrefix: string, isGenerated: boolean): SkillSummary[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: SkillSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !SAFE_SKILL_NAME.test(e.name)) continue;
    const skillPath = join(dir, e.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const doc = parseSkillFile(readFileSync(skillPath, "utf8"), e.name, `${relPrefix}/${e.name}/SKILL.md`, isGenerated);
    if (!doc) continue;
    out.push({
      name: doc.name,
      description: doc.description,
      category: doc.category,
      file: doc.file,
      createdBy: doc.createdBy,
      ...(doc.origin ? { origin: doc.origin } : {}),
    });
  }
  return out;
}

export function listSkills(root: string, category?: SkillCategory, extraDir?: string): SkillSummary[] {
  const builtin = readSkillsFromDir(skillsRoot(root), "plugin/aura-guard/skills", false);
  const seen = new Set(builtin.map((s) => s.name));
  const generated = extraDir
    ? readSkillsFromDir(resolve(extraDir), "data/generated-skills", true).filter((s) => !seen.has(s.name))
    : [];

  const out = [...builtin, ...generated].filter((s) => !category || s.category === category);
  return out.sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || a.name.localeCompare(b.name));
}

export function getSkill(root: string, name: string, extraDir?: string): SkillDoc | null {
  if (!SAFE_SKILL_NAME.test(name)) return null;
  const base = skillsRoot(root);
  const file = resolve(join(base, name, "SKILL.md"));
  if (file.startsWith(base + sep) && existsSync(file)) {
    return parseSkillFile(readFileSync(file, "utf8"), name, `plugin/aura-guard/skills/${name}/SKILL.md`, false);
  }
  if (extraDir) {
    const genBase = resolve(extraDir);
    const genFile = resolve(join(genBase, name, "SKILL.md"));
    if (genFile.startsWith(genBase + sep) && existsSync(genFile)) {
      return parseSkillFile(readFileSync(genFile, "utf8"), name, `data/generated-skills/${name}/SKILL.md`, true);
    }
  }
  return null;
}
