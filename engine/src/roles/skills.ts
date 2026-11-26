// Dynamic Skill Registry: discovers and serves Security, QA, QE, and Core skills
// from plugin/aura-guard/skills/*/SKILL.md so the bot, MCP clients, and UI can inspect
// and select the right skill on demand.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

export type SkillCategory = "security" | "qa" | "qe" | "core";

export interface SkillSummary {
  name: string;
  description: string;
  category: SkillCategory;
  file: string;
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

function parseSkillFile(raw: string, fallbackName: string, relFile: string): SkillDoc | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  let name = fallbackName;
  let description = "";
  let body = raw.trim();

  if (m) {
    try {
      const fm = (parseYaml(m[1] ?? "") ?? {}) as Record<string, unknown>;
      if (typeof fm["name"] === "string" && fm["name"].trim()) name = fm["name"].trim();
      if (typeof fm["description"] === "string") description = fm["description"].trim();
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
    body,
  };
}

export function listSkills(root: string, category?: SkillCategory): SkillSummary[] {
  const dir = skillsRoot(root);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: SkillSummary[] = [];

  for (const e of entries) {
    if (!e.isDirectory() || !SAFE_SKILL_NAME.test(e.name)) continue;
    const skillPath = join(dir, e.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const doc = parseSkillFile(readFileSync(skillPath, "utf8"), e.name, `plugin/aura-guard/skills/${e.name}/SKILL.md`);
    if (!doc) continue;
    if (category && doc.category !== category) continue;
    out.push({
      name: doc.name,
      description: doc.description,
      category: doc.category,
      file: doc.file,
    });
  }

  return out.sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || a.name.localeCompare(b.name));
}

export function getSkill(root: string, name: string): SkillDoc | null {
  if (!SAFE_SKILL_NAME.test(name)) return null;
  const base = skillsRoot(root);
  const file = resolve(join(base, name, "SKILL.md"));
  if (!file.startsWith(base + sep) || !existsSync(file)) return null;
  return parseSkillFile(readFileSync(file, "utf8"), name, `plugin/aura-guard/skills/${name}/SKILL.md`);
}
