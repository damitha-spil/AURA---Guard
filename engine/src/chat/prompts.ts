// Saved prompts the owner can put back into the chat box. data/prompts/prompts.json (git-ignored).
// Text with a detected secret is refused, so none is stored.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskOutgoing } from "../mask/mask.ts";
import { MAX_QUESTION_CHARS } from "./answer.ts";

/** A short list a person can still scan. */
export const MAX_SAVED_PROMPTS = 100;
export const MAX_PROMPT_NAME_CHARS = 60;

export interface SavedPrompt { id: string; name: string; text: string; created: string }

const fileOf = (dataDir: string): string => join(dataDir, "prompts", "prompts.json");

export function listPrompts(dataDir: string): SavedPrompt[] {
  const f = fileOf(dataDir);
  if (!existsSync(f)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(raw)
      ? (raw as SavedPrompt[]).filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && typeof p.text === "string")
      : [];
  } catch {
    return [];
  }
}

function write(dataDir: string, prompts: SavedPrompt[]): void {
  const f = fileOf(dataDir);
  mkdirSync(join(dataDir, "prompts"), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(prompts, null, 2));
  renameSync(tmp, f);
}

/** True when masking would block the text or change it. */
function hasSecret(text: string): boolean {
  const r = maskOutgoing(text);
  return !r.ok || r.text !== text;
}

export function addPrompt(dataDir: string, name: string, text: string): { ok: true; prompt: SavedPrompt } | { ok: false; error: string } {
  const n = name.replace(/\s+/g, " ").trim();
  const t = text.trim();
  if (!n || !t) return { ok: false, error: "A saved prompt needs a name and text." };
  if (n.length > MAX_PROMPT_NAME_CHARS) return { ok: false, error: `Keep the name within ${MAX_PROMPT_NAME_CHARS} characters.` };
  if (t.length > MAX_QUESTION_CHARS) return { ok: false, error: `Keep the prompt within ${MAX_QUESTION_CHARS} characters.` };
  if (hasSecret(n) || hasSecret(t)) return { ok: false, error: "This looks like it holds a secret or private value, so it was not saved." };
  const all = listPrompts(dataDir);
  if (all.length >= MAX_SAVED_PROMPTS) return { ok: false, error: `You can keep up to ${MAX_SAVED_PROMPTS} prompts. Delete one first.` };
  const prompt: SavedPrompt = { id: randomBytes(8).toString("hex"), name: n, text: t, created: new Date().toISOString() };
  write(dataDir, [...all, prompt]);
  return { ok: true, prompt };
}

export function removePrompt(dataDir: string, id: string): boolean {
  const all = listPrompts(dataDir);
  const rest = all.filter((p) => p.id !== id);
  if (rest.length === all.length) return false;
  write(dataDir, rest);
  return true;
}
