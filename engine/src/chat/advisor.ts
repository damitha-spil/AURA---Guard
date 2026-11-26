// Wise Knowledge Advisor:
// Synthesizes matching vault rules (active separated from proposed), ADRs, past incidents,
// co-changed partners, and code-graph blast radius into a structured engineering brief.

import { coChanged } from "../index/cochange.ts";
import type { Db } from "../index/db.ts";
import { blastRadius } from "../index/graph.ts";
import { search } from "../index/search.ts";
import { maskDeep } from "../qa/safe-out.ts";
import type { GuardConfig } from "../types.ts";
import { loadVault } from "../vault/load.ts";

export interface AdvisorRuleRef {
  id: string;
  title: string;
  type: string;
  status: string;
  summary: string;
}

export interface AdvisorBrief {
  topic: string;
  activeRules: AdvisorRuleRef[];
  proposedHints: AdvisorRuleRef[];
  relatedIncidents: AdvisorRuleRef[];
  adrs: AdvisorRuleRef[];
  blastRadius: { path: string; label: string; depth: number }[];
  coChangedFiles: { path: string; together: number; ratio: number }[];
  recommendations: string[];
  citations: string[];
}

function firstMeaningfulLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    return t.slice(0, 180);
  }
  return "";
}

export function adviseDeveloper(
  cfg: GuardConfig,
  db: Db | null,
  query: string,
  opts: { repo?: string; path?: string } = {},
): AdvisorBrief {
  const cleanQuery = query.trim();
  const { notes } = loadVault(cfg.vaultDir);
  const byId = new Map(notes.map((n) => [n.meta.id, n]));

  const searchHits = db && cleanQuery ? search(db, cleanQuery, { audience: "internal_dev", limit: 12 }) : [];
  const matchedNoteIds = new Set<string>();
  const matchedFiles: string[] = [];

  for (const h of searchHits) {
    if (h.kind === "note") matchedNoteIds.add(h.ref);
    else if (h.kind === "file") {
      const idx = h.ref.indexOf(":");
      matchedFiles.push(idx >= 0 ? h.ref.slice(idx + 1) : h.ref);
    }
  }

  // Fallback keyword match across vault notes if DB isn't built or returned few notes.
  const qWords = cleanQuery.toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
  for (const n of notes) {
    if (n.meta.status === "stale" || n.meta.status === "deprecated") continue;
    const hay = `${n.meta.id} ${n.meta.title ?? ""} ${n.body}`.toLowerCase();
    if (qWords.some((w) => hay.includes(w))) matchedNoteIds.add(n.meta.id);
  }

  const activeRules: AdvisorRuleRef[] = [];
  const proposedHints: AdvisorRuleRef[] = [];
  const relatedIncidents: AdvisorRuleRef[] = [];
  const adrs: AdvisorRuleRef[] = [];
  const citations = new Set<string>();

  for (const id of matchedNoteIds) {
    const n = byId.get(id);
    if (!n) continue;
    const ref: AdvisorRuleRef = {
      id: n.meta.id,
      title: n.meta.title ?? n.meta.id,
      type: n.meta.type,
      status: n.meta.status,
      summary: firstMeaningfulLine(n.body),
    };
    citations.add(n.meta.id);
    if (n.meta.type === "incident") relatedIncidents.push(ref);
    else if (n.meta.type === "adr") adrs.push(ref);
    else if (n.meta.status === "active") activeRules.push(ref);
    else proposedHints.push(ref);
  }

  const repoId = opts.repo ?? cfg.repos[0]?.id ?? "spil-aura";
  const targetPath = opts.path ?? matchedFiles[0] ?? "";
  let blast: { path: string; label: string; depth: number }[] = [];
  let co: { path: string; together: number; ratio: number }[] = [];

  if (db && targetPath) {
    try {
      blast = blastRadius(db, repoId, targetPath).slice(0, 10).map((b) => ({ path: b.path || b.id, label: b.label, depth: b.depth }));
    } catch {
      blast = [];
    }
    try {
      co = coChanged(db, repoId, targetPath, 8).map((c) => ({ path: c.path, together: c.together, ratio: c.ratio }));
    } catch {
      co = [];
    }
    citations.add(`${repoId}:${targetPath}`);
  }

  const recommendations: string[] = [];
  if (activeRules.length > 0) {
    recommendations.push(`Follow ${activeRules.length} active rule(s): ${activeRules.slice(0, 3).map((r) => r.title).join("; ")}.`);
  }
  if (proposedHints.length > 0) {
    recommendations.push(`Review ${proposedHints.length} unapproved (proposed) vault hint(s) before relying on them.`);
  }
  if (relatedIncidents.length > 0) {
    recommendations.push(`Avoid past incident regressions (${relatedIncidents.slice(0, 2).map((i) => i.title).join("; ")}).`);
  }
  if (blast.length > 0) {
    recommendations.push(`Verify ${blast.length} dependent symbol/file(s) around ${targetPath}.`);
  }
  if (co.length > 0) {
    recommendations.push(`Check co-change partners: ${co.slice(0, 3).map((c) => c.path).join(", ")}.`);
  }
  if (recommendations.length === 0) {
    recommendations.push("No matching active rules or incidents found; run `npm run guard -- index` or widen query terms.");
  }

  return maskDeep({
    topic: cleanQuery,
    activeRules: activeRules.slice(0, 8),
    proposedHints: proposedHints.slice(0, 8),
    relatedIncidents: relatedIncidents.slice(0, 6),
    adrs: adrs.slice(0, 6),
    blastRadius: blast,
    coChangedFiles: co,
    recommendations,
    citations: [...citations],
  });
}
