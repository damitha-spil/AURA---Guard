// Lesson suggestions: candidate notes from recent session records (owner turns that state a rule or a correction).
// Every note is written by newNote(), so it starts as `status: proposed`. Nothing here approves a note.

import { createHash } from "node:crypto";
import { maskOutgoing } from "../mask/mask.ts";
import type { Turn } from "../sessions/read.ts";
import { findSessionDir, readSessions } from "../sessions/read.ts";
import { loadVault } from "./load.ts";
import { newNote } from "./new.ts";

/** At most this many candidates are written per call, so one busy week cannot flood the inbox. */
export const MAX_LESSONS_PER_RUN = 10;
/** Only turns in this window count as recent. */
export const LESSON_WINDOW_DAYS = 14;
/** A turn shorter than this is a reply, not a lesson. */
const MIN_LESSON_CHARS = 25;
/** Longest quote kept in a note. */
const MAX_LESSON_CHARS = 600;

/** Plain wording that usually marks a rule or a correction from the owner. */
const LESSON_CUE = /\b(never|always|do not|don't|dont|must not|must|should not|shouldn't|instead of|stop |from now on|remember that|the rule is)\b/i;

export interface LessonResult {
  written: string[];
  skippedDuplicate: number;
  blocked: number;
}

export function lessonHash(t: Pick<Turn, "session" | "ts">): string {
  return createHash("sha256").update(`lesson|${t.session}|${t.ts}`).digest("hex").slice(0, 12);
}

export function isLessonCandidate(t: Turn): boolean {
  if (t.role !== "user") return false;
  const text = t.text.trim();
  return text.length >= MIN_LESSON_CHARS && LESSON_CUE.test(text);
}

/** Writes proposed `choice` notes for new candidates. Dedupes by hash against notes already in the vault. */
export function proposeLessonNotes(vaultDir: string, turns: Turn[], now: Date = new Date(), max: number = MAX_LESSONS_PER_RUN): LessonResult {
  const seen = new Set<string>();
  for (const n of loadVault(vaultDir).notes) {
    const m = /lesson-hash:([0-9a-f]+)/.exec(n.body);
    if (m) seen.add(m[1] as string);
  }
  const result: LessonResult = { written: [], skippedDuplicate: 0, blocked: 0 };
  for (const t of turns) {
    if (result.written.length >= max) break;
    if (!isLessonCandidate(t)) continue;
    const h = lessonHash(t);
    if (seen.has(h)) { result.skippedDuplicate++; continue; }
    const text = t.text.replace(/\s+/g, " ").trim().slice(0, MAX_LESSON_CHARS);
    const masked = maskOutgoing(text);
    if (!masked.ok) { result.blocked++; continue; }
    seen.add(h);
    const day = (t.ts || now.toISOString()).slice(0, 10);
    const body =
      `## What the owner said\n\n> ${masked.text}\n\n## Possible rule\n\n\n\n<!-- lesson-hash:${h} -->`;
    result.written.push(newNote(vaultDir, {
      type: "choice",
      title: `Lesson from session on ${day} (${h.slice(0, 6)})`,
      body,
      source: "session",
    }));
  }
  return result;
}

/** The owner-triggered action: every configured repo, sharing one cap. Only writes proposed notes. */
export function suggestLessonsForRepos(
  vaultDir: string, repoPaths: string[], opts: { now?: Date; sessionsRoot?: string } = {},
): LessonResult {
  const total: LessonResult = { written: [], skippedDuplicate: 0, blocked: 0 };
  for (const path of repoPaths) {
    const left = MAX_LESSONS_PER_RUN - total.written.length;
    if (left <= 0) break;
    const r = suggestLessons(vaultDir, path, { ...opts, max: left });
    total.written.push(...r.written);
    total.skippedDuplicate += r.skippedDuplicate;
    total.blocked += r.blocked;
  }
  return total;
}

/** Reads recent session records for one repo and proposes notes from them. Local only; no model call. */
export function suggestLessons(
  vaultDir: string, repoPath: string, opts: { now?: Date; sessionsRoot?: string; max?: number } = {},
): LessonResult {
  const now = opts.now ?? new Date();
  const dir = findSessionDir(repoPath, opts.sessionsRoot);
  if (!dir) return { written: [], skippedDuplicate: 0, blocked: 0 };
  const since = new Date(now.getTime() - LESSON_WINDOW_DAYS * 86_400_000).toISOString();
  const { turns } = readSessions(dir, { since });
  turns.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return proposeLessonNotes(vaultDir, turns, now, opts.max);
}
