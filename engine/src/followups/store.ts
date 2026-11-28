// Follow-ups and per-session tasks: small JSON files on this machine under the data folder.
// Text with a secret is refused, so no secret is stored. Use maskedFollowup before any model use.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskOutgoing } from "../mask/mask.ts";

export type FollowupStatus = "open" | "done";
export const MAX_TEXT_CHARS = 500;
export const MAX_ITEMS = 1000;

export interface Followup {
  id: string;
  text: string;
  owner: string;
  due: string | null;
  status: FollowupStatus;
  /** A defect id or QA run id this follows up on. */
  link: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionTask {
  id: string;
  sessionId: string;
  text: string;
  status: FollowupStatus;
  createdAt: string;
  updatedAt: string;
}

const SAFE_ID = /^[a-zA-Z0-9_-]{3,80}$/;
export const isItemId = (s: string): boolean => SAFE_ID.test(s);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function file(dataDir: string, name: string): string {
  const dir = join(dataDir, "followups");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function readList<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function writeList(path: string, items: unknown[]): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(items, null, 2), "utf8");
  renameSync(tmp, path);
}

function cleanText(raw: unknown): string {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS) : "";
  if (!text) throw new Error("Write what needs to be done.");
  if (!maskOutgoing(text).ok) throw new Error("That text looks like it holds a secret, so it was not saved. Remove it and try again.");
  return text;
}

function cleanOwner(raw: unknown): string {
  const owner = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  if (owner && !maskOutgoing(owner).ok) throw new Error("The owner field looks like it holds a secret.");
  return owner;
}

const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString("hex")}`;

export function listFollowups(dataDir: string, status?: FollowupStatus): Followup[] {
  const all = readList<Followup>(file(dataDir, "followups.json"));
  return status ? all.filter((f) => f.status === status) : all;
}

export function addFollowup(dataDir: string, input: { text: unknown; owner?: unknown; due?: unknown; link?: unknown }, now: Date = new Date()): Followup {
  const text = cleanText(input.text);
  const due = typeof input.due === "string" && input.due ? input.due : null;
  if (due !== null && !DATE.test(due)) throw new Error("The due date must look like 2026-12-31.");
  const link = typeof input.link === "string" && input.link ? input.link : null;
  if (link !== null && !isItemId(link)) throw new Error("The link must be a defect or run id.");
  const owner = cleanOwner(input.owner);
  const path = file(dataDir, "followups.json");
  const all = readList<Followup>(path);
  if (all.length >= MAX_ITEMS) throw new Error("Too many follow-ups. Mark old ones done and remove them.");
  const iso = now.toISOString();
  const rec: Followup = { id: newId("fu"), text, owner, due, status: "open", link, createdAt: iso, updatedAt: iso };
  writeList(path, [...all, rec]);
  return rec;
}

export function updateFollowup(dataDir: string, id: string, patch: { status?: unknown; owner?: unknown; due?: unknown; text?: unknown }, now: Date = new Date()): Followup | null {
  const path = file(dataDir, "followups.json");
  const all = readList<Followup>(path);
  const rec = all.find((f) => f.id === id);
  if (!rec) return null;
  // Check everything first so a bad field leaves the record unchanged.
  if (patch.status !== undefined && patch.status !== "open" && patch.status !== "done") throw new Error("Status is open or done.");
  const text = patch.text !== undefined ? cleanText(patch.text) : null;
  const owner = typeof patch.owner === "string" ? cleanOwner(patch.owner) : null;
  let due: string | null | undefined;
  if (patch.due !== undefined) {
    if (patch.due === null || patch.due === "") due = null;
    else if (typeof patch.due === "string" && DATE.test(patch.due)) due = patch.due;
    else throw new Error("The due date must look like 2026-12-31.");
  }
  if (patch.status === "open" || patch.status === "done") rec.status = patch.status;
  if (text !== null) rec.text = text;
  if (owner !== null) rec.owner = owner;
  if (due !== undefined) rec.due = due;
  rec.updatedAt = now.toISOString();
  writeList(path, all);
  return rec;
}

/** The copy that may go to a model: text and owner masked. */
export function maskedFollowup(f: Followup): Followup {
  return { ...f, text: maskOutgoing(f.text).text, owner: maskOutgoing(f.owner).text };
}

export function listTasks(dataDir: string, sessionId: string): SessionTask[] {
  return readList<SessionTask>(file(dataDir, "tasks.json")).filter((t) => t.sessionId === sessionId);
}

export function addTask(dataDir: string, sessionId: unknown, text: unknown, now: Date = new Date()): SessionTask {
  if (typeof sessionId !== "string" || !isItemId(sessionId)) throw new Error("A session id is needed.");
  const clean = cleanText(text);
  const path = file(dataDir, "tasks.json");
  const all = readList<SessionTask>(path);
  if (all.length >= MAX_ITEMS) throw new Error("Too many tasks saved.");
  const iso = now.toISOString();
  const rec: SessionTask = { id: newId("tk"), sessionId, text: clean, status: "open", createdAt: iso, updatedAt: iso };
  writeList(path, [...all, rec]);
  return rec;
}

export function updateTask(dataDir: string, id: string, status: unknown, now: Date = new Date()): SessionTask | null {
  if (status !== "open" && status !== "done") throw new Error("Status is open or done.");
  const path = file(dataDir, "tasks.json");
  const all = readList<SessionTask>(path);
  const rec = all.find((t) => t.id === id);
  if (!rec) return null;
  rec.status = status;
  rec.updatedAt = now.toISOString();
  writeList(path, all);
  return rec;
}
