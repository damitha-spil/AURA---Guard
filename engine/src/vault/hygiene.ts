// Read-only note hygiene: notes that say nearly the same thing, and notes nobody has touched for a while.
// Nothing here edits, moves or deletes a note. The owner decides.

import type { Note } from "../types.ts";

/** Two notes are flagged as look-alikes when this share of the smaller note's words appears in the other. */
export const DUPLICATE_OVERLAP_THRESHOLD = 0.8;
/** A note not reviewed or changed for this many days is listed as outdated. */
export const OUTDATED_AFTER_DAYS = 60;
/** Notes with fewer distinct words than this are not compared: tiny notes overlap by chance. */
export const MIN_WORDS_TO_COMPARE = 8;
/** Safety limit on how many pairs one run lists. */
export const MAX_DUPLICATE_PAIRS = 200;

const DAY_MS = 86_400_000;

export interface DuplicatePair {
  a: string;
  b: string;
  /** Shared words divided by the word count of the smaller note, 0 to 1. */
  overlap: number;
}

export interface OutdatedNote {
  id: string;
  /** The reviewed date if there is one, else the created date. YYYY-MM-DD. */
  lastUpdated: string;
  ageDays: number;
}

export interface NoteHygiene {
  threshold: number;
  outdatedAfterDays: number;
  duplicates: DuplicatePair[];
  outdated: OutdatedNote[];
}

export function noteWords(n: Note): Set<string> {
  const text = `${n.meta.title ?? ""} ${n.body}`.toLowerCase();
  const out = new Set<string>();
  for (const w of text.match(/[a-z0-9]{3,}/g) ?? []) out.add(w);
  return out;
}

export function overlapRatio(a: Set<string>, b: Set<string>): number {
  const smaller = a.size <= b.size ? a : b;
  const other = smaller === a ? b : a;
  if (smaller.size === 0) return 0;
  let shared = 0;
  for (const w of smaller) if (other.has(w)) shared++;
  return shared / smaller.size;
}

export function findNoteHygiene(notes: Note[], now: Date = new Date()): NoteHygiene {
  // Deprecated notes are already retired; they are not worth flagging again.
  const live = notes.filter((n) => n.meta.status !== "deprecated");
  const words = live.map((n) => noteWords(n));
  const duplicates: DuplicatePair[] = [];
  for (let i = 0; i < live.length && duplicates.length < MAX_DUPLICATE_PAIRS; i++) {
    const wi = words[i] as Set<string>;
    if (wi.size < MIN_WORDS_TO_COMPARE) continue;
    for (let j = i + 1; j < live.length && duplicates.length < MAX_DUPLICATE_PAIRS; j++) {
      const wj = words[j] as Set<string>;
      if (wj.size < MIN_WORDS_TO_COMPARE) continue;
      const overlap = overlapRatio(wi, wj);
      if (overlap >= DUPLICATE_OVERLAP_THRESHOLD) {
        duplicates.push({ a: (live[i] as Note).meta.id, b: (live[j] as Note).meta.id, overlap: Math.round(overlap * 100) / 100 });
      }
    }
  }
  duplicates.sort((x, y) => y.overlap - x.overlap);

  const outdated: OutdatedNote[] = [];
  for (const n of live) {
    const lastUpdated = n.meta.reviewed ?? n.meta.created;
    const t = Date.parse(`${lastUpdated}T00:00:00Z`);
    if (Number.isNaN(t)) continue;
    const ageDays = Math.floor((now.getTime() - t) / DAY_MS);
    if (ageDays > OUTDATED_AFTER_DAYS) outdated.push({ id: n.meta.id, lastUpdated, ageDays });
  }
  outdated.sort((x, y) => y.ageDays - x.ageDays);
  return { threshold: DUPLICATE_OVERLAP_THRESHOLD, outdatedAfterDays: OUTDATED_AFTER_DAYS, duplicates, outdated };
}
