import type { GuardConfig } from "../types.ts";
import { findCorrections } from "./corrections.ts";
import type { Candidate } from "./corrections.ts";
import { findSessionDir, readSessions } from "./read.ts";
import { maskCandidate, writeCandidates } from "./to-notes.ts";

export interface MineResult {
  sessions: number;
  turns: number; // owner turns
  candidates: Candidate[]; // masked and secret-free
  blocked: number; // dropped because a secret was found
  written: string[];
  skippedDuplicate: number;
}

export function mineSessions(
  cfg: GuardConfig,
  opts: { repoPath: string; since?: string; minScore?: number; max?: number; dryRun?: boolean; sessionsRoot?: string },
): MineResult {
  const dir = findSessionDir(opts.repoPath, opts.sessionsRoot);
  if (!dir) return { sessions: 0, turns: 0, candidates: [], blocked: 0, written: [], skippedDuplicate: 0 };
  const { files, turns } = readSessions(dir, opts.since ? { since: opts.since } : {});
  const candidates: Candidate[] = [];
  let blocked = 0;
  for (const c of findCorrections(turns)) {
    const m = maskCandidate(c);
    if (m) candidates.push(m);
    else blocked++;
  }
  let written: string[] = [];
  let skippedDuplicate = 0;
  if (!opts.dryRun) {
    const w = writeCandidates(cfg.vaultDir, candidates, { minScore: opts.minScore ?? 0.6, max: opts.max ?? 30 });
    written = w.written;
    skippedDuplicate = w.skippedDuplicate;
  }
  return { sessions: files, turns: turns.filter((t) => t.role === "user").length, candidates, blocked, written, skippedDuplicate };
}
