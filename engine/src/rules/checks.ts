// The "check block" inside a pattern or rule note, and the loader of ACTIVE checks.
// A check is a fixed (Tier 0) rule: no model is needed to apply it. The reviewer reads
// loadActiveChecks(cfg); nothing here writes into any repository.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { GuardConfig, Note } from "../types.ts";
import { loadVault } from "../vault/load.ts";

const globs = z.array(z.string().min(1)).min(1);

export const checkSchema = z.object({
  kind: z.literal("co-change"),
  /** If any file matching these globs changes ... */
  if_changed: globs,
  /** ... the change should also touch files matching these. */
  then_changed: globs,
  evidence: z.object({
    commits: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1),
    repo: z.string().min(1),
  }),
});

export type Check = z.infer<typeof checkSchema>;

export interface ActiveCheck {
  id: string;
  title: string;
  check: Check;
}

export type CheckParse = { state: "none" } | { state: "invalid"; reason: string } | { state: "ok"; check: Check };

/** Finds the first ```json fenced block in a note body and validates it as a check. */
export function parseCheckBlock(body: string): CheckParse {
  const m = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(body);
  if (!m) return { state: "none" };
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch (e) {
    return { state: "invalid", reason: `check block is not valid JSON: ${(e as Error).message.split("\n")[0]}` };
  }
  const r = checkSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    return { state: "invalid", reason: `check block: ${i?.path.join(".") || "shape"}: ${i?.message ?? "invalid"}` };
  }
  return { state: "ok", check: r.data };
}

const CHECK_TYPES = new Set(["pattern", "rule"]);

/** Checks of ACTIVE pattern/rule notes that carry a valid check block. */
export function activeChecksFromNotes(notes: Note[]): ActiveCheck[] {
  const out: ActiveCheck[] = [];
  for (const n of notes) {
    if (n.meta.status !== "active" || !CHECK_TYPES.has(n.meta.type)) continue;
    const p = parseCheckBlock(n.body);
    if (p.state === "ok") out.push({ id: n.meta.id, title: n.meta.title ?? n.meta.id, check: p.check });
  }
  return out;
}

export function loadActiveChecks(cfg: GuardConfig): ActiveCheck[] {
  return activeChecksFromNotes(loadVault(cfg.vaultDir).notes);
}

export function activeChecksPath(cfg: GuardConfig): string {
  return join(cfg.dataDir, "tier0", "active-checks.json");
}

/** Writes data/tier0/active-checks.json (git-ignored with the rest of data/). */
export function exportActiveChecks(cfg: GuardConfig): { file: string; checks: ActiveCheck[] } {
  const checks = loadActiveChecks(cfg);
  const file = activeChecksPath(cfg);
  mkdirSync(join(cfg.dataDir, "tier0"), { recursive: true });
  writeFileSync(file, JSON.stringify({ checks }, null, 2) + "\n");
  return { file, checks };
}

/** Reads the exported file back, validating every check. Throws on a bad shape. */
export function parseExported(text: string): ActiveCheck[] {
  const schema = z.object({
    checks: z.array(z.object({ id: z.string(), title: z.string(), check: checkSchema })),
  });
  return schema.parse(JSON.parse(text)).checks;
}
