// SPIL REO — Self-Learning Engine (AURA-inspired continuous learning).
// Persists bounded keyword->agent routing weights, tool reliability telemetry, repeated execution
// patterns, user correction lessons (hypothesis -> verified procedural memory), and user feedback.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QualityVerdict } from "../automation/harness.ts";
import { addMemory } from "../memory/qa-memory.ts";
import { maskOutgoing } from "../mask/mask.ts";
import { maskDeep } from "../qa/safe-out.ts";

/** Hard caps to keep learning state bounded on disk. */
export const MAX_LEARNED_PATTERNS = 200;
export const MAX_LEARNED_LESSONS = 200;
export const MAX_LEARNED_FEEDBACK = 500;
export const MAX_ROUTING_KEYWORDS = 250;
export const MAX_ROUTING_WEIGHT = 3.0;
const WEIGHT_DECAY = 0.98;
const LESSON_PROMOTE_CONFIRMATIONS = 2;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "check", "run", "please",
  "what", "when", "where", "how", "are", "you", "your", "all", "can", "about", "our",
]);

const LESSON_CUE_RE = /\b(never|always|do not|don't|dont|must|should not|shouldn't|instead|from now on|remember)\b/i;

export interface ToolLearningStat {
  runs: number;
  errors: number;
  avgMs: number;
}

export interface LearnedPattern {
  key: string;
  tools: string[];
  agents: string[];
  count: number;
  lastVerdict: QualityVerdict;
  lastSeenAt: string;
}

export interface LearnedLesson {
  id: string;
  normHash: string;
  text: string;
  source: "user-correction" | "feedback";
  confirmations: number;
  promoted: boolean;
  createdAt: string;
  lastSeenAt: string;
}

export interface FeedbackEntry {
  missionId: string;
  rating: "up" | "down";
  note?: string;
  at: string;
}

export interface LearningStore {
  routing: Record<string, Partial<Record<string, number>>>;
  toolStats: Record<string, ToolLearningStat>;
  patterns: LearnedPattern[];
  lessons: LearnedLesson[];
  feedback: FeedbackEntry[];
  missionIndex: Record<string, { keywords: string[]; agents: string[]; lessonIds: string[] }>;
}

function emptyStore(): LearningStore {
  return {
    routing: {},
    toolStats: {},
    patterns: [],
    lessons: [],
    feedback: [],
    missionIndex: {},
  };
}

function learningPath(dataDir: string): string {
  return join(dataDir, "learning.json");
}

export function loadLearningStore(dataDir: string): LearningStore {
  const file = learningPath(dataDir);
  if (!existsSync(file)) return emptyStore();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<LearningStore>;
    return {
      routing: raw.routing && typeof raw.routing === "object" ? raw.routing : {},
      toolStats: raw.toolStats && typeof raw.toolStats === "object" ? raw.toolStats : {},
      patterns: Array.isArray(raw.patterns) ? raw.patterns : [],
      lessons: Array.isArray(raw.lessons) ? raw.lessons : [],
      feedback: Array.isArray(raw.feedback) ? raw.feedback : [],
      missionIndex: raw.missionIndex && typeof raw.missionIndex === "object" ? raw.missionIndex : {},
    };
  } catch {
    return emptyStore();
  }
}

export function saveLearningStore(dataDir: string, store: LearningStore): void {
  mkdirSync(dataDir, { recursive: true });
  // Trim routing keys if needed
  const keys = Object.keys(store.routing);
  if (keys.length > MAX_ROUTING_KEYWORDS) {
    for (const k of keys.slice(0, keys.length - MAX_ROUTING_KEYWORDS)) {
      delete store.routing[k];
    }
  }
  const missionKeys = Object.keys(store.missionIndex);
  if (missionKeys.length > 100) {
    for (const mk of missionKeys.slice(0, missionKeys.length - 100)) {
      delete store.missionIndex[mk];
    }
  }
  store.patterns = store.patterns.slice(0, MAX_LEARNED_PATTERNS);
  store.lessons = store.lessons.slice(0, MAX_LEARNED_LESSONS);
  store.feedback = store.feedback.slice(0, MAX_LEARNED_FEEDBACK);
  writeFileSync(learningPath(dataDir), JSON.stringify(maskDeep(store), null, 2), "utf8");
}

export function extractKeywords(prompt: string, limit = 6): string[] {
  const words = prompt
    .toLowerCase()
    .replace(/@[a-z0-9-]+/gi, " ")
    .split(/[^a-z0-9_-]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^https?$/.test(w));
  return [...new Set(words)].slice(0, limit);
}

function clampWeight(n: number): number {
  return Number(Math.max(0, Math.min(MAX_ROUTING_WEIGHT, n)).toFixed(3));
}

function decayRouting(store: LearningStore): void {
  for (const kw of Object.keys(store.routing)) {
    const row = store.routing[kw];
    if (!row) continue;
    for (const ag of Object.keys(row)) {
      const next = clampWeight((row[ag] ?? 0) * WEIGHT_DECAY);
      if (next <= 0.01) delete row[ag];
      else row[ag] = next;
    }
    if (Object.keys(row).length === 0) delete store.routing[kw];
  }
}

/** Record mission execution outcome: updates routing weights, tool stats, and repeated pattern counts. */
export function recordMissionOutcome(
  dataDir: string,
  input: {
    missionId: string;
    prompt: string;
    agents: string[];
    tools: Array<{ id: string; ms: number; ok: boolean }>;
    verdict: QualityVerdict;
    successfulAgents?: string[];
    appliedLessonIds?: string[];
  },
): LearningStore {
  const store = loadLearningStore(dataDir);
  const now = new Date().toISOString();
  const keywords = extractKeywords(input.prompt, 6);

  // 1. Update tool telemetry
  for (const t of input.tools) {
    const cur = store.toolStats[t.id] ?? { runs: 0, errors: 0, avgMs: 0 };
    const nextRuns = cur.runs + 1;
    const avgMs = Math.round((cur.avgMs * cur.runs + Math.max(0, t.ms)) / nextRuns);
    store.toolStats[t.id] = {
      runs: nextRuns,
      errors: cur.errors + (t.ok ? 0 : 1),
      avgMs,
    };
  }

  // 2. Update routing weights (decay gently, reward active successful agents)
  decayRouting(store);
  const rewardAgents = input.successfulAgents?.length ? input.successfulAgents : input.agents;
  for (const kw of keywords) {
    const row = (store.routing[kw] ??= {});
    for (const ag of rewardAgents) {
      row[ag] = clampWeight((row[ag] ?? 0) + 0.25);
    }
  }

  // 3. Track repeated tool+agent execution pattern keyed by sorted top-3 keywords
  const top3 = [...keywords].slice(0, 3).sort();
  if (top3.length > 0 && input.tools.length > 0) {
    const toolIds = [...new Set(input.tools.map((t) => t.id))];
    const patternKey = `${top3.join("+")}::${[...input.agents].sort().join("+")}`;
    const idx = store.patterns.findIndex((p) => p.key === patternKey);
    if (idx >= 0) {
      const existing = store.patterns[idx]!;
      store.patterns[idx] = {
        ...existing,
        tools: toolIds,
        agents: [...new Set(input.agents)],
        count: existing.count + 1,
        lastVerdict: input.verdict,
        lastSeenAt: now,
      };
    } else {
      store.patterns.unshift({
        key: patternKey,
        tools: toolIds,
        agents: [...new Set(input.agents)],
        count: 1,
        lastVerdict: input.verdict,
        lastSeenAt: now,
      });
    }
  }

  store.missionIndex[input.missionId] = {
    keywords,
    agents: [...new Set(input.agents)],
    lessonIds: input.appliedLessonIds ?? [],
  };

  saveLearningStore(dataDir, store);
  return store;
}

/** Apply thumbs-up / thumbs-down feedback on a completed mission. */
export function recordFeedback(
  dataDir: string,
  missionId: string,
  rating: "up" | "down",
  note?: string,
): { ok: boolean; store: LearningStore } {
  const store = loadLearningStore(dataDir);
  const idx = store.missionIndex[missionId];
  const delta = rating === "up" ? 0.5 : -0.75;
  if (idx) {
    for (const kw of idx.keywords) {
      const row = (store.routing[kw] ??= {});
      for (const ag of idx.agents) {
        const next = clampWeight((row[ag] ?? 0) + delta);
        if (next <= 0) delete row[ag];
        else row[ag] = next;
      }
    }
    if (rating === "up" && idx.lessonIds.length > 0) {
      for (const lid of idx.lessonIds) {
        const lesson = store.lessons.find((l) => l.id === lid);
        if (lesson && !lesson.promoted) {
          lesson.promoted = true;
          addMemory(dataDir, {
            layer: "procedural",
            confidence: "verified",
            title: `Learned rule: ${lesson.text.slice(0, 72)}`,
            content: lesson.text,
            tags: ["self-learned"],
            source: missionId,
          });
        }
      }
    }
  }

  let safeNote: string | undefined;
  if (note && note.trim()) {
    const masked = maskOutgoing(note.trim());
    if (!masked.ok) {
      throw new Error(`Feedback note blocked by secret masking gate.`);
    }
    safeNote = masked.text.slice(0, 400);
  }

  store.feedback.unshift({
    missionId,
    rating,
    ...(safeNote ? { note: safeNote } : {}),
    at: new Date().toISOString(),
  });
  saveLearningStore(dataDir, store);

  if (safeNote && LESSON_CUE_RE.test(safeNote)) {
    recordUserCorrection(dataDir, safeNote, missionId, "feedback");
  }
  return { ok: true, store: loadLearningStore(dataDir) };
}

/** Detect user correction / rule language and track hypothesis -> verified procedural memory. */
export function recordUserCorrection(
  dataDir: string,
  rawText: string,
  missionId: string,
  source: "user-correction" | "feedback" = "user-correction",
): LearnedLesson | null {
  const trimmed = rawText.trim();
  if (trimmed.length < 8 || !LESSON_CUE_RE.test(trimmed)) return null;

  const masked = maskOutgoing(trimmed);
  if (!masked.ok) return null;

  const cleanText = masked.text.replace(/\s+/g, " ").trim().slice(0, 400);
  const norm = cleanText.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normHash = createHash("sha256").update(norm).digest("hex").slice(0, 12);
  const now = new Date().toISOString();

  const store = loadLearningStore(dataDir);
  const existing = store.lessons.find((l) => l.normHash === normHash);
  if (existing) {
    existing.confirmations += 1;
    existing.lastSeenAt = now;
    if (!existing.promoted && existing.confirmations >= LESSON_PROMOTE_CONFIRMATIONS) {
      existing.promoted = true;
      addMemory(dataDir, {
        layer: "procedural",
        confidence: "verified",
        title: `Learned rule: ${existing.text.slice(0, 72)}`,
        content: existing.text,
        tags: ["self-learned"],
        source: missionId,
      });
    }
    saveLearningStore(dataDir, store);
    return existing;
  }

  const lesson: LearnedLesson = {
    id: `les-${normHash.slice(0, 8)}`,
    normHash,
    text: cleanText,
    source,
    confirmations: 1,
    promoted: false,
    createdAt: now,
    lastSeenAt: now,
  };
  store.lessons.unshift(lesson);
  saveLearningStore(dataDir, store);

  addMemory(dataDir, {
    layer: "procedural",
    confidence: "hypothesis",
    title: `Hypothesis lesson: ${cleanText.slice(0, 72)}`,
    content: cleanText,
    tags: ["self-learned"],
    source: missionId,
  });
  return lesson;
}

export function getLearnedRouting(dataDir: string): Record<string, Partial<Record<string, number>>> {
  return loadLearningStore(dataDir).routing;
}

/** Recall up to 3 promoted lessons relevant to a prompt. */
export function recallLessons(dataDir: string, prompt: string, limit = 3): LearnedLesson[] {
  const store = loadLearningStore(dataDir);
  const promoted = store.lessons.filter((l) => l.promoted);
  if (promoted.length === 0) return [];
  const kws = extractKeywords(prompt, 8);
  const scored = promoted.map((l) => {
    const lower = l.text.toLowerCase();
    const hits = kws.filter((w) => lower.includes(w)).length;
    return { l, score: hits * 10 + l.confirmations };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.l);
}

export function deleteLesson(dataDir: string, id: string): boolean {
  const store = loadLearningStore(dataDir);
  const next = store.lessons.filter((l) => l.id !== id);
  if (next.length === store.lessons.length) return false;
  store.lessons = next;
  saveLearningStore(dataDir, store);
  return true;
}

export function resetLearning(dataDir: string): LearningStore {
  const clean = emptyStore();
  saveLearningStore(dataDir, clean);
  return clean;
}
