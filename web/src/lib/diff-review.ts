// Reading a diff: which files are tests, and which files the person has marked as viewed.
import * as React from "react";
import type { DiffFile } from "@/lib/repos";

/** Folder and file names that mark a test in the common layouts. A guess by name only. */
export const isTestFile = (path: string): boolean =>
  /(^|\/)(tests?|__tests__|specs?)\//i.test(path) || /[._-](test|spec)\.[a-z0-9]+$/i.test(path) || /[a-z0-9]Tests?\.(cs|java|kt)$/.test(path);

const KEY = "diff-viewed";
/** Oldest marks are dropped beyond this, so the list cannot grow without end. */
const MAX_MARKS = 2000;

/** FNV-1a. Only used to notice that a file's changes differ from the ones that were marked. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}

/** Null when there is no text to compare, so a later change could not be noticed. */
export const viewedMark = (file: DiffFile): string | null => (file.patch ? `${hash(file.path)}.${hash(file.patch)}.${file.patch.length}` : null);

function load(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function useViewedMarks(): { has: (mark: string) => boolean; set: (mark: string, viewed: boolean) => void } {
  const [marks, setMarks] = React.useState(load);
  const all = React.useMemo(() => new Set(marks), [marks]);
  const set = React.useCallback((mark: string, viewed: boolean) => {
    // Read again first: another open diff may have added marks.
    const next = load().filter((m) => m !== mark);
    if (viewed) next.push(mark);
    const kept = next.slice(-MAX_MARKS);
    try {
      localStorage.setItem(KEY, JSON.stringify(kept));
    } catch {
      // storage unavailable: the mark still applies until the page closes
    }
    setMarks(kept);
  }, []);
  return { has: (m) => all.has(m), set };
}
