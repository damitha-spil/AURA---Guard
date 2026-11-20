// Shared helpers for the reviewer and the refactor advisor: repo lookup, role files, context, JSON.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { GuardConfig } from "../types.ts";
import type { Db } from "../index/db.ts";
import { blastRadius } from "../index/graph.ts";
import { getDoc, search } from "../index/search.ts";
import { loadVault } from "../vault/load.ts";

/** Words in a path that say nothing about the topic, left out of the note search. */
const PATH_STOP = new Set(["src", "index", "main", "lib", "components", "component", "test", "tests", "apps", "crates", "mod", "tsx", "ts", "rs", "js"]);
/** Search words taken from the changed paths. */
export const MAX_SEARCH_WORDS = 14;
/** Blast radius shown per file and across the whole prompt. */
export const BLAST_PER_FILE = 6;
export const BLAST_FILES = 8;

export interface RepoRef { id: string; path: string }

/** Accepts a configured repo id, or an existing folder path (used by tests and one-off runs). */
export function resolveRepo(cfg: GuardConfig, repo: string): RepoRef {
  const hit = cfg.repos.find((r) => r.id === repo);
  if (hit) return hit;
  if (existsSync(repo)) return { id: basename(repo), path: repo };
  throw new Error(`Unknown repo "${repo}". Configured: ${cfg.repos.map((r) => r.id).join(", ") || "(none)"}.`);
}

export interface RoleFile {
  limits?: Record<string, number | boolean>;
  rules?: string[];
}

export function loadRoleFile(cfg: GuardConfig, name: string): RoleFile {
  const file = join(cfg.root, "roles", `${name}.yaml`);
  return existsSync(file) ? (parse(readFileSync(file, "utf8")) as RoleFile) : {};
}

export function limitOf(role: RoleFile, key: string, fallback: number): number {
  const v = role.limits?.[key];
  return typeof v === "number" ? v : fallback;
}

/** Titles of rules the model should keep in mind. Active first; proposed ones are marked. */
export function ruleTitles(cfg: GuardConfig): string[] {
  const { notes } = loadVault(cfg.vaultDir);
  const rules = notes.filter((n) => n.meta.type === "rule" && (n.meta.status === "active" || n.meta.status === "proposed"));
  rules.sort((a, b) => Number(b.meta.status === "active") - Number(a.meta.status === "active"));
  return rules.map((n) => (n.meta.status === "active" ? `- ${n.meta.title}` : `- (proposed, not approved yet) ${n.meta.title}`));
}

export function topicWords(paths: string[]): string {
  const words: string[] = [];
  for (const p of paths) {
    for (const w of p.split(/[\\/._-]+/)) {
      const t = w.toLowerCase();
      if (t.length >= 3 && !PATH_STOP.has(t) && !words.includes(t)) words.push(t);
    }
  }
  return words.slice(0, MAX_SEARCH_WORDS).join(" ");
}

export interface NoteContext { ref: string; title: string; status: string; text: string }

/** The notes most relevant to some paths: active ones first, proposed ones marked as such. */
export function relevantNotes(db: Db | null, paths: string[], max: number, chars: number): NoteContext[] {
  if (!db) return [];
  const q = topicWords(paths);
  if (!q) return [];
  let hits;
  try {
    hits = search(db, q, { kinds: ["note"], audience: "internal_dev", limit: max * 3 });
  } catch {
    return [];
  }
  const out: NoteContext[] = [];
  for (const h of hits) {
    if (h.status !== "active" && h.status !== "proposed") continue;
    const doc = getDoc(db, h.ref, "internal_dev");
    if (!doc) continue;
    out.push({ ref: h.ref, title: h.title, status: h.status, text: doc.body.slice(0, chars) });
  }
  out.sort((a, b) => Number(b.status === "active") - Number(a.status === "active"));
  return out.slice(0, max);
}

export function formatNotes(notes: NoteContext[]): string {
  if (notes.length === 0) return "(no related notes)";
  return notes
    .map((n) => `### ${n.title}${n.status === "proposed" ? " (proposed, not approved yet)" : ""}\n${n.text}`)
    .join("\n\n");
}

/** What uses a file, from the code graph. Empty when no graph is loaded. */
export function blastFor(db: Db | null, repoId: string, path: string, max = BLAST_PER_FILE): string[] {
  if (!db) return [];
  try {
    return [...new Set(blastRadius(db, repoId, path).map((h) => h.path).filter(Boolean))].slice(0, max);
  } catch {
    return [];
  }
}

export function extractJson(text: string, who: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new ModelReplyError(`${who}: the model reply had no JSON object.`);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ModelReplyError(`${who}: the model reply was not valid JSON.`);
  }
}

/** The model answered, but not in the shape we asked for. The fixed checks still stand. */
export class ModelReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelReplyError";
  }
}
