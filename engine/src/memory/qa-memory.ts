// 3-layer persistent QA memory: Project, Execution, and Procedural.
// Hypotheses are stored separately from verified facts and never auto-promoted.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MemoryLayer = "project" | "execution" | "procedural";
export type MemoryConfidence = "verified" | "hypothesis";

export interface QaMemoryEntry {
  id: string;
  layer: MemoryLayer;
  confidence: MemoryConfidence;
  title: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: string;
  verifiedAt?: string;
}

/** Cap stored entries to keep local recall fast and bounded. */
export const MAX_MEMORY_ENTRIES = 500;

function memoryPath(dataDir: string): string {
  return join(dataDir, "qa-memory.json");
}

function readAll(dataDir: string): QaMemoryEntry[] {
  const file = memoryPath(dataDir);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as QaMemoryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(dataDir: string, entries: QaMemoryEntry[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(memoryPath(dataDir), JSON.stringify(entries.slice(0, MAX_MEMORY_ENTRIES), null, 2), "utf8");
}

export function listMemory(
  dataDir: string,
  filter?: { layer?: MemoryLayer; confidence?: MemoryConfidence; query?: string },
): QaMemoryEntry[] {
  let items = readAll(dataDir);
  if (filter?.layer) items = items.filter((m) => m.layer === filter.layer);
  if (filter?.confidence) items = items.filter((m) => m.confidence === filter.confidence);
  const q = filter?.query?.trim().toLowerCase();
  if (q) {
    items = items.filter((m) => `${m.title} ${m.content} ${m.tags.join(" ")}`.toLowerCase().includes(q));
  }
  return items;
}

export function addMemory(
  dataDir: string,
  input: {
    layer: MemoryLayer;
    confidence?: MemoryConfidence;
    title: string;
    content: string;
    tags?: string[];
    source?: string;
  },
): QaMemoryEntry {
  const now = new Date().toISOString();
  const confidence: MemoryConfidence = input.confidence === "verified" ? "verified" : "hypothesis";
  const entry: QaMemoryEntry = {
    id: `mem-${randomUUID().slice(0, 8)}`,
    layer: input.layer,
    confidence,
    title: input.title.trim().slice(0, 160),
    content: input.content.trim().slice(0, 2000),
    tags: (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12),
    source: input.source?.trim() || "manual",
    createdAt: now,
    ...(confidence === "verified" ? { verifiedAt: now } : {}),
  };
  const all = [entry, ...readAll(dataDir)];
  writeAll(dataDir, all);
  return entry;
}

export function verifyMemory(dataDir: string, id: string): QaMemoryEntry | null {
  const all = readAll(dataDir);
  const idx = all.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const updated: QaMemoryEntry = {
    ...all[idx]!,
    confidence: "verified",
    verifiedAt: new Date().toISOString(),
  };
  all[idx] = updated;
  writeAll(dataDir, all);
  return updated;
}

export function deleteMemory(dataDir: string, id: string): boolean {
  const all = readAll(dataDir);
  const next = all.filter((m) => m.id !== id);
  if (next.length === all.length) return false;
  writeAll(dataDir, next);
  return true;
}

/** Retrieve top relevant memory entries for a query, boosting verified knowledge over hypotheses. */
export function recallMemory(dataDir: string, query: string, limit = 5): QaMemoryEntry[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 2);
  const all = readAll(dataDir);
  if (all.length === 0) return [];

  const scored = all.map((entry) => {
    const hay = `${entry.title} ${entry.content} ${entry.tags.join(" ")}`.toLowerCase();
    let score = entry.confidence === "verified" ? 2 : 0;
    for (const tok of tokens) {
      if (hay.includes(tok)) score += 3;
    }
    return { entry, score };
  });

  return scored
    .filter((s) => (tokens.length > 0 ? s.score > 2 : true))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);
}
