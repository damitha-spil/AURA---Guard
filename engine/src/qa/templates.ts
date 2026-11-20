// Data for the QA agent: the offline case templates and the role file. Both are plain files in
// roles/ so a company can change them without a code change. When a Guard copy has no roles/ folder
// (a test root), the shipped files are used.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { GUARD_ROOT } from "../config.ts";
import type { GuardConfig } from "../types.ts";

export const CASE_TYPES = ["functional", "regression", "edge", "negative", "security", "accessibility", "performance", "data", "compat"] as const;
export const PRIORITIES = ["P0", "P1", "P2"] as const;
export type CaseType = (typeof CASE_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];

const TemplateCase = z.object({
  type: z.enum(CASE_TYPES), priority: z.enum(PRIORITIES), title: z.string().min(1),
  preconditions: z.array(z.string()).default([]), steps: z.array(z.string()).min(1), expected: z.array(z.string()).min(1),
  automatable: z.boolean().default(false),
});
const Category = z.object({
  id: z.string().min(1), label: z.string().min(1), match: z.array(z.string()).min(1),
  riskWeight: z.number().min(0), ui: z.boolean().default(false), service: z.boolean().default(false), cases: z.array(TemplateCase),
});
export const TemplatesSchema = z.object({
  version: z.literal(1),
  thresholds: z.object({ medium: z.number(), high: z.number() }),
  churnPerPoint: z.number().positive(),
  categories: z.array(Category).min(1),
  requirementCases: z.array(TemplateCase).default([]),
  regression: z.array(z.string()).default([]),
  notCovered: z.array(z.string()).default([]),
});
export type Templates = z.infer<typeof TemplatesSchema>;
export type Category = z.infer<typeof Category>;

export interface QaRole {
  limits: { max_tokens: number; max_model_calls: number };
  rules: string[];
  safety: string[];
  reply_shape: unknown;
  evidence_rules: { always: string[]; ui_change: string[]; service_change: string[]; no_user_visible_change: string[] };
  check_command_tools: string[];
}

function roleFile(cfg: GuardConfig, name: string): string {
  const mine = join(cfg.root, "roles", name);
  return existsSync(mine) ? mine : join(GUARD_ROOT, "roles", name);
}

let cache: { key: string; t: Templates; compiled: { id: string; res: RegExp[] }[] } | null = null;

export function loadTemplates(cfg: GuardConfig): Templates {
  return compiled(cfg).t;
}

function compiled(cfg: GuardConfig): NonNullable<typeof cache> {
  const f = roleFile(cfg, "qa-case-templates.json");
  const raw = readFileSync(f, "utf8");
  if (cache && cache.key === raw) return cache;
  const t = TemplatesSchema.parse(JSON.parse(raw));
  cache = { key: raw, t, compiled: t.categories.map((c) => ({ id: c.id, res: c.match.map((m) => new RegExp(m, "i")) })) };
  return cache;
}

/** First matching category for a path (the last one is a catch-all). */
export function categoryOf(cfg: GuardConfig, path: string): Category {
  const c = compiled(cfg);
  const hit = c.compiled.find((k) => k.res.some((re) => re.test(path)));
  return c.t.categories.find((k) => k.id === hit?.id) ?? (c.t.categories[c.t.categories.length - 1] as Category);
}

export function loadQaRole(cfg: GuardConfig): QaRole {
  const y = parse(readFileSync(roleFile(cfg, "qa-agent.yaml"), "utf8")) as Record<string, any>;
  const ev = (y["evidence_rules"] ?? {}) as Record<string, string[]>;
  return {
    limits: { max_tokens: Number(y["limits"]?.max_tokens ?? 6000), max_model_calls: Number(y["limits"]?.max_model_calls ?? 2) },
    rules: (y["rules"] ?? []) as string[],
    safety: (y["safety"] ?? []) as string[],
    reply_shape: y["reply_shape"],
    evidence_rules: {
      always: ev["always"] ?? [], ui_change: ev["ui_change"] ?? [], service_change: ev["service_change"] ?? [],
      no_user_visible_change: ev["no_user_visible_change"] ?? [],
    },
    check_command_tools: (y["check_command_tools"] ?? []) as string[],
  };
}

/** Evidence the change needs, from the fixed rules (never from the model). */
export function evidenceFor(role: QaRole, flags: { ui: boolean; service: boolean }): string[] {
  const need = [...(flags.ui ? role.evidence_rules.ui_change : []), ...(flags.service ? role.evidence_rules.service_change : [])];
  if (!flags.ui && !flags.service) need.push(...role.evidence_rules.no_user_visible_change);
  return [...need, ...role.evidence_rules.always];
}
