// The app's keyboard shortcuts. Defaults here, the owner's changes under one localStorage key.
import * as React from "react";

export const SHORTCUTS = [
  { id: "palette", label: "Command palette and search", keys: "mod+k" },
  { id: "newChat", label: "New chat", keys: "mod+shift+o" },
  { id: "findInChat", label: "Find in this chat", keys: "mod+f" },
  { id: "focusComposer", label: "Go to the message box", keys: "mod+shift+l" },
  { id: "toggleCanvas", label: "Show or hide the execution canvas", keys: "mod+shift+e" },
  { id: "settings", label: "Open settings", keys: "mod+," },
  { id: "help", label: "Show keyboard shortcuts", keys: "?" },
] as const;
export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/** Keys the app already uses elsewhere (sidebar, copy and paste, model picker), so they cannot be taken. */
const RESERVED = new Set(["mod+b", "mod+c", "mod+v", "mod+x", "mod+a", "mod+z", ...Array.from({ length: 9 }, (_, i) => `mod+${i + 1}`)]);

const KEY = "reo-keybindings";
type Overrides = Partial<Record<ShortcutId, string>>;

function load(): Overrides {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, unknown>;
    const out: Overrides = {};
    for (const s of SHORTCUTS) {
      const v = raw?.[s.id];
      if (typeof v === "string") out[s.id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

let overrides = load();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

function store(next: Overrides) {
  overrides = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: the change still applies until the page closes
  }
  listeners.forEach((l) => l());
}

export const useOverrides = () => React.useSyncExternalStore(subscribe, () => overrides);
/** An empty string means the shortcut is switched off. */
export const keysFor = (id: ShortcutId, o: Overrides = overrides): string => o[id] ?? SHORTCUTS.find((s) => s.id === id)!.keys;

export function setShortcut(id: ShortcutId, keys: string) {
  store({ ...overrides, [id]: keys });
}
export function resetShortcut(id: ShortcutId) {
  const next = { ...overrides };
  delete next[id];
  store(next);
}
export const resetAllShortcuts = () => store({});

const MODIFIERS = new Set(["control", "meta", "shift", "alt"]);

/** The combination a key press stands for, or null while only modifiers are held. */
export function comboOf(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): string | null {
  const key = e.key.toLowerCase();
  if (MODIFIERS.has(key)) return null;
  const mod = e.ctrlKey || e.metaKey;
  // Without Ctrl or Alt, Shift is already part of the typed character ("?").
  const shift = e.shiftKey && (mod || e.altKey || key.length > 1);
  return [mod && "mod", e.altKey && "alt", shift && "shift", key === " " ? "space" : key].filter(Boolean).join("+");
}

const NAMES: Record<string, string> = { mod: "Ctrl", alt: "Alt", shift: "Shift", space: "Space", escape: "Esc" };
export const label = (combo: string): string =>
  combo ? combo.split("+").map((p) => NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join(" ") : "Off";

/** Why a combination cannot be used for this shortcut, or null when it can. */
export function refusal(id: ShortcutId, combo: string): string | null {
  if (!/^(mod|alt)\+/.test(combo) && !(id === "help" && combo === "?")) return "Hold Ctrl or Alt with the key.";
  if (RESERVED.has(combo)) return `${label(combo)} is already used by the app or the text box.`;
  const other = SHORTCUTS.find((s) => s.id !== id && keysFor(s.id) === combo);
  return other ? `${label(combo)} is already used for "${other.label}".` : null;
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

/** Runs `handler` when the shortcut is pressed. */
export function useShortcut(id: ShortcutId, handler: () => void, enabled = true) {
  const latest = React.useRef(handler);
  latest.current = handler;
  React.useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const wanted = keysFor(id);
      if (!wanted || comboOf(e) !== wanted) return;
      if (!/^(mod|alt)\+/.test(wanted) && isTyping(e.target)) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [id, enabled]);
}
