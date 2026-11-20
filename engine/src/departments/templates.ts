// Department templates: roles/department-templates/*.json. They are product defaults that a
// company may edit; a template that cannot be read is skipped, never fatal.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { GUARD_ROOT } from "../config.ts";
import { RolesSchema, TEMPLATE_IDS } from "./model.ts";
import type { Roles, TemplateId } from "./model.ts";

const TemplateSchema = z.object({
  id: z.enum(TEMPLATE_IDS),
  name: z.string().min(1).max(80),
  description: z.string().max(400),
  hint: z.string().max(400),
  sourceKind: z.enum(["git", "docs"]).default("docs"),
  roles: RolesSchema,
});
export type DepartmentTemplate = z.infer<typeof TemplateSchema>;

export const NO_ROLES: Roles = {
  scribe: false, reviewer: false, refactor: false, qa: false, rules: false, prs: false, supportWriter: false, quiz: false, daily: false,
};

export function loadTemplates(root: string = GUARD_ROOT): DepartmentTemplate[] {
  let dir = join(root, "roles", "department-templates");
  // A config rooted somewhere else (a test, a copy) falls back to the product defaults.
  if (!existsSync(dir)) dir = join(GUARD_ROOT, "roles", "department-templates");
  if (!existsSync(dir)) return [];
  const out: DepartmentTemplate[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = TemplateSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (r.success) out.push(r.data);
    } catch {
      // a broken template file is skipped
    }
  }
  const order = (t: DepartmentTemplate): number => TEMPLATE_IDS.indexOf(t.id);
  return out.sort((a, b) => order(a) - order(b));
}

export function templateRoles(id: TemplateId, root: string = GUARD_ROOT): Roles {
  return loadTemplates(root).find((t) => t.id === id)?.roles ?? { ...NO_ROLES };
}
