// Memory: short facts the owner asked REO to remember ("remember that I prefer short answers").
// One JSON file per machine under the data folder (data/memory/memory.json, git-ignored). Rules:
//  - capped: MAX_MEMORIES entries of MAX_MEMORY_CHARS each;
//  - anything the masker flags (a secret, or a value it would replace such as a customer name or e-mail)
//    is REFUSED, so nothing like that is ever stored;
//  - text is masked again before it goes to a model, and entries that now fail the mask are left out;
//  - memory is context about the owner and how to work with them. It is NOT a source for facts about the
//    project: those still need a cited source (the block says so to the model).
// This file only reads and writes the store; it never talks to a model.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskOutgoing } from "../mask/mask.ts";
import { PRODUCT_NAME } from "../brand.ts";

/** A short list a person can still read in one screen, and a bounded cost on every chat call. */
export const MAX_MEMORIES = 40;
export const MAX_MEMORY_CHARS = 300;
/** The most characters of memory put into one chat prompt. Newest entries are kept first. */
export const MEMORY_PROMPT_CHARS = 1500;

export interface MemoryEntry { id: string; text: string; created: string; updated: string }

const fileOf = (dataDir: string): string => join(dataDir, "memory", "memory.json");
export const isMemoryId = (s: string): boolean => /^[a-f0-9]{16}$/.test(s);

export function listMemory(dataDir: string): MemoryEntry[] {
  const f = fileOf(dataDir);
  if (!existsSync(f)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(raw)
      ? (raw as MemoryEntry[]).filter((e) => e && typeof e.id === "string" && typeof e.text === "string")
      : [];
  } catch {
    return [];
  }
}

function write(dataDir: string, entries: MemoryEntry[]): void {
  const f = fileOf(dataDir);
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  renameSync(tmp, f);
}

/** Why a text may not be remembered, or null when it may. Never repeats the flagged value. */
export function memoryProblem(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "There is nothing to remember.";
  if (t.length > MAX_MEMORY_CHARS) return `Keep a memory within ${MAX_MEMORY_CHARS} characters.`;
  const r = maskOutgoing(t);
  if (!r.ok) return "That looks like it holds a secret, so it was not remembered.";
  if (r.text !== t) return "That holds a private value (a name, address or similar), so it was not remembered. Say it in general words.";
  return null;
}

export type MemoryResult = { ok: true; entry: MemoryEntry } | { ok: false; error: string };

export function addMemory(dataDir: string, text: string, now: Date = new Date()): MemoryResult {
  const problem = memoryProblem(text);
  if (problem) return { ok: false, error: problem };
  const t = text.replace(/\s+/g, " ").trim();
  const all = listMemory(dataDir);
  const dup = all.find((e) => e.text.toLowerCase() === t.toLowerCase());
  if (dup) return { ok: true, entry: dup };
  if (all.length >= MAX_MEMORIES) return { ok: false, error: `Memory is full (${MAX_MEMORIES}). Delete one in Settings > Memory first.` };
  const ts = now.toISOString();
  const entry: MemoryEntry = { id: randomBytes(8).toString("hex"), text: t, created: ts, updated: ts };
  write(dataDir, [...all, entry]);
  return { ok: true, entry };
}

export function updateMemory(dataDir: string, id: string, text: string, now: Date = new Date()): MemoryResult | null {
  const all = listMemory(dataDir);
  const at = all.findIndex((e) => e.id === id);
  if (at < 0) return null;
  const problem = memoryProblem(text);
  if (problem) return { ok: false, error: problem };
  const entry: MemoryEntry = { ...all[at]!, text: text.replace(/\s+/g, " ").trim(), updated: now.toISOString() };
  all[at] = entry;
  write(dataDir, all);
  return { ok: true, entry };
}

export function removeMemory(dataDir: string, id: string): boolean {
  const all = listMemory(dataDir);
  const rest = all.filter((e) => e.id !== id);
  if (rest.length === all.length) return false;
  write(dataDir, rest);
  return true;
}

/**
 * "remember ..." at the start of a message. Returns the text to keep, or null when the message is not
 * a remember request. "remember" inside a longer question ("do you remember when ...") is not one.
 */
export function parseRemember(message: string): string | null {
  const m = /^\s*(?:please\s+|pls\s+)?remember(?:\s*:|\s*,|\s+that\b|\s+this\b)?\s+(\S[\s\S]*)$/i.exec(message);
  if (!m) return null;
  const text = m[1]!.trim();
  // A question about memory is not an instruction to store it.
  if (/\?\s*$/.test(text) && /^(?:when|what|how|why|if|whether|who|where)\b/i.test(text)) return null;
  return text;
}

/**
 * The block added to the chat system prompt. Entries are re-checked with the mask; one that fails
 * (for example a dictionary term added later) is left out. Empty string when there is nothing to add.
 */
export function memoryBlock(dataDir: string, budget: number = MEMORY_PROMPT_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (const e of listMemory(dataDir).slice().reverse()) {
    const r = maskOutgoing(e.text);
    if (!r.ok) continue;
    const line = `- ${r.text}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return "";
  return [
    `Memory (notes the owner asked ${PRODUCT_NAME} to remember: preferences and context, newest first).`,
    "Use them to tailor your answer. They are not sources: a fact about the project still needs a cited [ref].",
    ...lines,
  ].join("\n");
}
