// QE Pillar 5: Structural Code Refinement & Knowledge Base Drift Engine.
// Scans PR diffs for structural complexity/duplication/magic-number smells and detects
// stale Vault anchors or undocumented new patterns, drafting proposed Vault updates only.

import { existsSync } from "node:fs";
import type { Db } from "../index/db.ts";
import { search } from "../index/search.ts";
import { findStale } from "../index/stale.ts";
import { maskDeep } from "../qa/safe-out.ts";
import { readDiff } from "../review/diff.ts";
import type { DiffResult } from "../review/diff.ts";
import { isTestPath } from "../review/tier0.ts";
import type { GuardConfig } from "../types.ts";

/** Added-line count in one file above which we recommend splitting helpers. */
export const LARGE_DIFF_FILE_LINES = 80;
/** Indentation depth (spaces) suggesting overly deep nesting. */
export const DEEP_NESTING_SPACES = 10;

export interface RefinementFinding {
  kind: "large-change" | "deep-nesting" | "duplicate-logic" | "magic-number";
  file: string;
  line: number;
  message: string;
}

export interface RefinementAndDriftReport {
  generatedAt: string;
  repo: string;
  refinements: RefinementFinding[];
  staleAnchors: { noteId: string; path: string; commitsBehind: number }[];
  undocumentedPatterns: string[];
  proposedVaultDrafts: { id: string; title: string; targetFile: string }[];
}

export function analyzeRefinementAndKbDrift(
  cfg: GuardConfig,
  db: Db | null,
  opts: { repo?: string; base?: string; head?: string; diffOverride?: DiffResult } = {},
): RefinementAndDriftReport {
  const targetRepo = (opts.repo ? cfg.repos.find((r) => r.id === opts.repo) : null) ?? cfg.repos.find((r) => r.id === "spil-aura") ?? cfg.repos[0];
  const repoId = targetRepo?.id ?? opts.repo ?? "none";
  let diff: DiffResult = opts.diffOverride ?? { base: "HEAD~1", head: "HEAD", baseSha: "", headSha: "", files: [], skipped: [] };

  if (!opts.diffOverride && targetRepo && existsSync(targetRepo.path)) {
    try {
      diff = readDiff(targetRepo.path, {
        ...(opts.base ? { base: opts.base } : {}),
        ...(opts.head ? { head: opts.head } : {}),
      });
    } catch {
      /* ignore empty/uninitialized git */
    }
  }

  const refinements: RefinementFinding[] = [];
  const lineCounts = new Map<string, { file: string; line: number; count: number }>();

  for (const f of diff.files) {
    if (f.status === "deleted" || isTestPath(f.path)) continue;
    if (f.addedLines.length > LARGE_DIFF_FILE_LINES) {
      refinements.push({
        kind: "large-change",
        file: f.path,
        line: f.addedLines[0]?.line ?? 1,
        message: `${f.addedLines.length} lines added in one file; consider extracting focused helpers.`,
      });
    }
    for (const l of f.addedLines) {
      const spaces = /^([ ]*)/.exec(l.text)?.[1]?.length ?? 0;
      const tabs = /^(\t*)/.exec(l.text)?.[1]?.length ?? 0;
      if ((spaces >= DEEP_NESTING_SPACES || tabs >= 5) && /\b(if|for|while|switch|match)\b/.test(l.text)) {
        refinements.push({
          kind: "deep-nesting",
          file: f.path,
          line: l.line,
          message: "Deeply nested control flow; prefer early returns or a helper function.",
        });
      }
      const norm = l.text.trim();
      if (norm.length >= 42 && !/^(import|export|const|let|type|interface|\*|\/\/)/.test(norm)) {
        const cur = lineCounts.get(norm);
        if (cur) cur.count++;
        else lineCounts.set(norm, { file: f.path, line: l.line, count: 1 });
      }
      if (!/^\s*(\/\/|\*|#)/.test(l.text) && /\b(?:timeout|limit|max|cap|retry|port)\b[^=\n]*[:=]\s*\d{3,}/i.test(l.text) && !/const\s+[A-Z0-9_]+/.test(l.text)) {
        refinements.push({
          kind: "magic-number",
          file: f.path,
          line: l.line,
          message: "Numeric operational limit inline; promote to a named constant with a comment explaining why.",
        });
      }
    }
  }

  for (const [text, info] of lineCounts.entries()) {
    if (info.count >= 2) {
      refinements.push({
        kind: "duplicate-logic",
        file: info.file,
        line: info.line,
        message: `Repeated non-trivial logic (${info.count}x): "${text.slice(0, 60)}" — extract a shared helper.`,
      });
    }
  }

  const changedSet = new Set(diff.files.map((f) => f.path));
  const staleAnchors: { noteId: string; path: string; commitsBehind: number }[] = [];
  const undocumentedPatterns: string[] = [];

  if (db) {
    try {
      for (const s of findStale(db)) {
        if (changedSet.size === 0 || changedSet.has(s.path)) {
          staleAnchors.push({ noteId: s.noteId, path: s.path, commitsBehind: s.commits.length });
        }
      }
    } catch {
      /* index not built */
    }
    for (const f of diff.files.slice(0, 15)) {
      if (isTestPath(f.path) || !/\.(ts|tsx|rs|cs)$/i.test(f.path)) continue;
      const baseName = f.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
      if (baseName.length < 4) continue;
      const hits = search(db, baseName, { audience: "internal_dev", kinds: ["note"], limit: 1 });
      if (hits.length === 0 && f.status === "added") {
        undocumentedPatterns.push(f.path);
      }
    }
  }

  const proposedVaultDrafts = undocumentedPatterns.slice(0, 5).map((p) => {
    const slug = p.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40);
    return {
      id: `pattern-${slug}`,
      title: `Pattern & architecture note for ${p}`,
      targetFile: `vault/inbox/pattern-${slug}.md`,
    };
  });

  return maskDeep({
    generatedAt: new Date().toISOString(),
    repo: repoId,
    refinements: refinements.slice(0, 25),
    staleAnchors: staleAnchors.slice(0, 15),
    undocumentedPatterns: undocumentedPatterns.slice(0, 15),
    proposedVaultDrafts,
  });
}
