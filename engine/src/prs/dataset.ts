import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import { loadStoredPrs, prsDir } from "./store.ts";

export interface DatasetLine {
  pr: number;
  mergeCommit: string;
  files: string[];
  comments: { file?: string; line?: number; text: string; accepted: boolean | null }[];
}

/** One line per merged PR (format described at the top of azure.ts). Only reviewer comments, never the author's. */
export function buildDataset(cfg: GuardConfig, repoId: string): DatasetLine[] {
  const lines: DatasetLine[] = [];
  for (const pr of loadStoredPrs(cfg, repoId)) {
    if (pr.status !== "completed" || !pr.mergeCommit) continue;
    const comments: DatasetLine["comments"] = [];
    for (const t of pr.threads) {
      const accepted = t.status === "fixed" || t.status === "closed" ? true : t.status === "wontFix" || t.status === "byDesign" ? false : null;
      for (const c of t.comments) {
        if (c.isAuthor) continue;
        comments.push({ ...(t.file ? { file: t.file } : {}), ...(t.line !== undefined ? { line: t.line } : {}), text: c.text, accepted });
      }
    }
    lines.push({ pr: pr.id, mergeCommit: pr.mergeCommit, files: pr.files, comments });
  }
  return lines;
}

export function writeDataset(cfg: GuardConfig, repoId: string): { file: string; prs: number; comments: number } {
  const lines = buildDataset(cfg, repoId);
  mkdirSync(prsDir(cfg), { recursive: true });
  const file = join(prsDir(cfg), "dataset.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  return { file, prs: lines.length, comments: lines.reduce((n, l) => n + l.comments.length, 0) };
}
