// Thumbs up / down on an answer. One JSON line per rating in data/chats/feedback.jsonl.
// A line holds ids, the rating and an optional short note (masked). Never the question or the answer.

import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isChatId, maskForStorage } from "./store.ts";

export const MAX_NOTE_CHARS = 200;
/** A feedback file this big means something is wrong (a loop); new lines are refused. */
export const MAX_FEEDBACK_BYTES = 1_000_000;
export const MAX_MESSAGE_INDEX = 1000;

export interface FeedbackLine {
  ts: string;
  chatId: string;
  messageIndex: number;
  rating: "up" | "down";
  note?: string;
}

export type FeedbackResult = { ok: true; line: FeedbackLine } | { ok: false; status: number; error: string };

export function feedbackFile(dataDir: string): string {
  return join(dataDir, "chats", "feedback.jsonl");
}

export function recordFeedback(dataDir: string, body: Record<string, unknown>, chatExists: (id: string) => boolean): FeedbackResult {
  const chatId = body["chatId"];
  if (typeof chatId !== "string" || !isChatId(chatId)) return { ok: false, status: 400, error: "Bad chat id." };
  const idx = body["messageIndex"];
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx > MAX_MESSAGE_INDEX) return { ok: false, status: 400, error: "Bad message index." };
  const rating = body["rating"];
  if (rating !== "up" && rating !== "down") return { ok: false, status: 400, error: "Use rating: up or down." };
  const rawNote = body["note"];
  if (rawNote !== undefined && typeof rawNote !== "string") return { ok: false, status: 400, error: "The note must be text." };
  if (!chatExists(chatId)) return { ok: false, status: 404, error: "No such chat." };

  const note = typeof rawNote === "string" ? maskForStorage(rawNote.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS)).slice(0, MAX_NOTE_CHARS) : "";
  const line: FeedbackLine = { ts: new Date().toISOString(), chatId, messageIndex: idx, rating, ...(note ? { note } : {}) };
  const file = feedbackFile(dataDir);
  mkdirSync(join(dataDir, "chats"), { recursive: true });
  if (existsSync(file) && statSync(file).size > MAX_FEEDBACK_BYTES) return { ok: false, status: 409, error: "The feedback file is full." };
  appendFileSync(file, JSON.stringify(line) + "\n");
  return { ok: true, line };
}
