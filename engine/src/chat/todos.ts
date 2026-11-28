// A per-chat to-do list the agent loop can maintain while it works on a multi-part request, and the
// person can see in a panel. data/todos/<chatId>.json (git-ignored), max 50 items, text checked with the
// mask. The list is REO's own data: changing it needs no approval. It is replaced as a whole by update_todos.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskOutgoing } from "../mask/mask.ts";

export const MAX_TODOS = 50;
export const MAX_TODO_CHARS = 160;

export interface TodoItem { text: string; done: boolean }

const ID = /^[a-f0-9]{16}$/;
const fileOf = (dataDir: string, chatId: string): string => join(dataDir, "todos", `${chatId}.json`);

export function listTodos(dataDir: string, chatId: string): TodoItem[] {
  if (!ID.test(chatId)) return [];
  const f = fileOf(dataDir, chatId);
  if (!existsSync(f)) return [];
  try {
    const v: unknown = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(v) ? (v as TodoItem[]).filter((t) => t && typeof t.text === "string").map((t) => ({ text: t.text, done: t.done === true })) : [];
  } catch {
    return [];
  }
}

/** Replaces the list. Returns an error sentence when an item holds a secret; nothing is stored then. */
export function setTodos(dataDir: string, chatId: string, raw: unknown): { ok: true; items: TodoItem[] } | { ok: false; error: string } {
  if (!ID.test(chatId)) return { ok: false, error: "There is no chat to keep a list for." };
  if (!Array.isArray(raw)) return { ok: false, error: "items must be a list of {text, done}." };
  const items: TodoItem[] = [];
  for (const r of raw.slice(0, MAX_TODOS)) {
    const o = (typeof r === "string" ? { text: r, done: false } : r) as { text?: unknown; done?: unknown } | null;
    const text = typeof o?.text === "string" ? o.text.replace(/\s+/g, " ").trim().slice(0, MAX_TODO_CHARS) : "";
    if (!text) continue;
    if (!maskOutgoing(text).ok) return { ok: false, error: "An item looks like it holds a secret, so the list was not changed." };
    items.push({ text, done: o?.done === true });
  }
  mkdirSync(join(dataDir, "todos"), { recursive: true });
  const f = fileOf(dataDir, chatId);
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(items, null, 2));
  renameSync(tmp, f);
  return { ok: true, items };
}
