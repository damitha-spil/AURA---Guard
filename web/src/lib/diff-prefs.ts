// Settings > Diffs & pull requests. Stored under one localStorage key.
import * as React from "react";

export interface DiffPrefs {
  layout: "stacked" | "split";
  hideWhitespace: boolean;
  files: "expanded" | "collapsed";
  colors: "red-green" | "orange-blue";
  openPullsInApp: boolean;
  hideTests: boolean;
  /** The changed-files list in the diff viewer: flat, or folders you can open and close. */
  fileList: "list" | "tree";
}

export const DEFAULT_DIFF_PREFS: DiffPrefs = {
  layout: "stacked",
  hideWhitespace: false,
  files: "expanded",
  colors: "red-green",
  openPullsInApp: true,
  hideTests: false,
  fileList: "list",
};

/** A file with more patch lines than this starts closed, so a large diff stays responsive. */
export const LARGE_FILE_LINES = 400;

const KEY = "diff-prefs";

function load(): DiffPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<DiffPrefs>;
    const pick = <T>(v: unknown, allowed: readonly T[], fallback: T) => (allowed.includes(v as T) ? (v as T) : fallback);
    const d = DEFAULT_DIFF_PREFS;
    return {
      layout: pick(raw?.layout, ["stacked", "split"] as const, d.layout),
      hideWhitespace: pick(raw?.hideWhitespace, [true, false], d.hideWhitespace),
      files: pick(raw?.files, ["expanded", "collapsed"] as const, d.files),
      colors: pick(raw?.colors, ["red-green", "orange-blue"] as const, d.colors),
      openPullsInApp: pick(raw?.openPullsInApp, [true, false], d.openPullsInApp),
      hideTests: pick(raw?.hideTests, [true, false], d.hideTests),
      fileList: pick(raw?.fileList, ["list", "tree"] as const, d.fileList),
    };
  } catch {
    return DEFAULT_DIFF_PREFS;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function updateDiffPrefs(patch: Partial<DiffPrefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // storage unavailable: the change still applies until the page closes
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const useDiffPrefs = () => React.useSyncExternalStore(subscribe, () => current);
