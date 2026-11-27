// Appearance settings beyond scheme, colour theme and radius (those are in themes.ts).
// Stored under one localStorage key. public/theme-init.js applies them, both before the
// first paint and after each change, so the rules exist in one place.
import * as React from "react";

export interface CustomTheme {
  name: string;
  hue: number;
  chroma: number;
}

export interface Appearance {
  contrast: number;
  glass: number;
  chatWidth: "compact" | "comfortable" | "wide" | "full";
  showWork: boolean;
  reduceMotion: boolean;
  uiFont: "inter" | "system" | "segoe" | "arial" | "georgia";
  uiSize: number;
  monoFont: "default" | "consolas" | "cascadia" | "courier";
  /** 0 keeps each screen's own code size. */
  monoSize: number;
  wordWrap: boolean;
  custom: CustomTheme | null;
}

export const DEFAULT_APPEARANCE: Appearance = {
  contrast: 100,
  glass: 100,
  chatWidth: "comfortable",
  showWork: true,
  reduceMotion: false,
  uiFont: "inter",
  uiSize: 16,
  monoFont: "default",
  monoSize: 0,
  wordWrap: false,
  custom: null,
};

declare global {
  interface Window {
    reoApplyAppearance?: (a: Appearance) => void;
  }
}

const KEY = "appearance";

function load(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, unknown>;
    const out: Record<string, unknown> = { ...DEFAULT_APPEARANCE };
    for (const [k, v] of Object.entries(DEFAULT_APPEARANCE)) {
      if (k !== "custom" && typeof raw?.[k] === typeof v) out[k] = raw[k];
    }
    const c = raw?.custom as Partial<CustomTheme> | null | undefined;
    if (c && typeof c.name === "string" && typeof c.hue === "number" && typeof c.chroma === "number") {
      out.custom = { name: c.name, hue: c.hue, chroma: c.chroma };
    }
    return out as unknown as Appearance;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function updateAppearance(patch: Partial<Appearance>) {
  current = { ...current, ...patch };
  window.reoApplyAppearance?.(current);
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // storage unavailable: the change still applies until the page closes
  }
  listeners.forEach((l) => l());
}

/** Keeps the saved custom theme; everything else goes back to the default. */
export function resetAppearance() {
  updateAppearance({ ...DEFAULT_APPEARANCE, custom: current.custom });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const useAppearance = () => React.useSyncExternalStore(subscribe, () => current);
