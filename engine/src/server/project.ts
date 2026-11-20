// The two read endpoints the home screen needs: /api/project (a summary of the one project) and
// /api/suggestions (starter questions). No file contents, no secrets; a repo is shown by the last
// segment of its folder only.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { PRODUCT_NAME, PRODUCT_SHORT } from "../brand.ts";
import { dbPath } from "../config.ts";
import type { Db } from "../index/db.ts";
import { gitTry } from "../review/git.ts";
import type { GuardConfig } from "../types.ts";
import { loadVault } from "../vault/load.ts";
import { buildInbox } from "./inbox.ts";

export const MAX_SUGGESTIONS = 4;
export const MAX_SUGGESTION_TITLE_CHARS = 100;

/** Used when the vault has no rule notes yet. */
export const GENERIC_SUGGESTIONS: readonly string[] = [
  "What changed in the last few days?",
  "Which rules should I check before I change this code?",
  "Why does the AI never get an ERP create tool?",
  "Can you QA the latest change?",
];

export interface ProjectRepo {
  id: string;
  label: string;
  branch: string | null;
  lastCommitAt: string | null;
  indexedAt: string | null;
  commits: number;
}

export interface ProjectSummary {
  productName: string;
  productShort: string;
  repos: ProjectRepo[];
  index: { indexedAt: string | null; commits: number; files: number; notes: number };
  vault: { notes: number; active: number; proposed: number; stale: number; problems: number };
  inbox: { pending: number };
  lastDaily: string | null;
}

/** The index keeps no timestamp of its own, so this is the last write time of its file. */
function indexedAtOf(cfg: GuardConfig): string | null {
  const file = dbPath(cfg);
  let latest = 0;
  for (const f of [file, `${file}-wal`]) {
    try { if (existsSync(f)) latest = Math.max(latest, statSync(f).mtimeMs); } catch { /* ignore */ }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function lastDaily(cfg: GuardConfig): string | null {
  try {
    const days = readdirSync(join(cfg.dataDir, "daily")).map((f) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f)?.[1]).filter((d): d is string => !!d);
    return days.sort().pop() ?? null;
  } catch {
    return null;
  }
}

export function projectSummary(cfg: GuardConfig, db: Db | null): ProjectSummary {
  const indexedAt = db ? indexedAtOf(cfg) : null;
  const kinds: Record<string, number> = {};
  const perRepo = new Map<string, { commits: number; last: string | null }>();
  const synced = new Set<string>();
  if (db) {
    for (const r of db.prepare("SELECT kind, COUNT(*) AS n FROM docs GROUP BY kind").all() as { kind: string; n: number }[]) kinds[r.kind] = r.n;
    for (const r of db.prepare("SELECT repo, COUNT(*) AS n, MAX(date) AS last FROM docs WHERE kind='commit' AND repo IS NOT NULL GROUP BY repo").all() as { repo: string; n: number; last: string | null }[]) {
      perRepo.set(r.repo, { commits: r.n, last: r.last });
    }
    for (const r of db.prepare("SELECT repo FROM repo_state").all() as { repo: string }[]) synced.add(r.repo);
  }
  const { notes, problems } = loadVault(cfg.vaultDir);
  const count = (s: string): number => notes.filter((n) => n.meta.status === s).length;
  return {
    productName: PRODUCT_NAME,
    productShort: PRODUCT_SHORT,
    repos: cfg.repos.map((r) => {
      const head = gitTry(r.path, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || null;
      const stats = perRepo.get(r.id);
      return {
        id: r.id,
        label: basename(r.path.replace(/[\\/]+$/, "")) || r.id,
        branch: head,
        lastCommitAt: stats?.last ?? null,
        indexedAt: synced.has(r.id) ? indexedAt : null,
        commits: stats?.commits ?? 0,
      };
    }),
    index: { indexedAt, commits: kinds["commit"] ?? 0, files: kinds["file"] ?? 0, notes: kinds["note"] ?? 0 },
    vault: { notes: notes.length, active: count("active"), proposed: count("proposed"), stale: count("stale"), problems: problems.length },
    inbox: { pending: buildInbox(cfg).total },
    lastDaily: lastDaily(cfg),
  };
}

/** Plain text only: no markup characters, no control characters, one line, capped. */
function cleanTitle(t: string): string {
  return t.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SUGGESTION_TITLE_CHARS).trim();
}

/** Up to four questions from the active and proposed rule notes; generic ones when there are none. */
export function suggestions(cfg: GuardConfig): string[] {
  const rank = (s: string): number => (s === "active" ? 0 : 1);
  const rules = loadVault(cfg.vaultDir).notes
    .filter((n) => n.meta.type === "rule" && (n.meta.status === "active" || n.meta.status === "proposed"))
    .sort((a, b) => rank(a.meta.status) - rank(b.meta.status) || b.meta.created.localeCompare(a.meta.created) || a.meta.id.localeCompare(b.meta.id));
  const out: string[] = [];
  for (const n of rules) {
    const title = cleanTitle(n.meta.title ?? n.meta.id);
    if (title) out.push(`What is the rule: ${title}?`);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out.length > 0 ? out : [...GENERIC_SUGGESTIONS];
}
