// Chats live in data/chats/<id>.json (git-ignored). Text is stored MASKED, never raw.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskOutgoing } from "../mask/mask.ts";
import type { ChatSource, Step } from "./answer.ts";

/** A trace is a handful of short rows; this stops a runaway one from filling a chat file. */
export const MAX_TRACE_STEPS = 12;
export const MAX_STEP_TEXT = 300;

/** Stops a runaway chat file; the oldest messages are dropped first. */
export const MAX_STORED_MESSAGES = 200;
export const MAX_TITLE_CHARS = 60;
export const WITHHELD = "[text withheld: it looked like a secret]";
/** A stored sub-agent result larger than this is dropped (the Markdown text is still kept). */
export const MAX_STORED_AGENT_CHARS = 250_000;

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  ts: string;
  sources?: ChatSource[];
  error?: boolean;
  /** What Guard did to produce this answer (labels and timings only), so the "Worked for" line survives a reload. */
  trace?: Step[];
  /** The structured result of a sub-agent (the QA agent), masked and capped, so it survives a reload. */
  qa?: unknown;
  /** A question the QA agent asked, with its answer chips. */
  needsInput?: { question: string; options: { id: string; label: string; value: string }[] };
}

export interface Chat {
  id: string;
  title: string;
  created: string;
  updated: string;
  messages: StoredMessage[];
}

export interface ChatSummary { id: string; title: string; updated: string }

const ID_RE = /^[a-f0-9]{16}$/;
export const isChatId = (s: string): boolean => ID_RE.test(s);

/** Masks text for storage. A blocked secret is not stored at all. */
export function maskForStorage(text: string): string {
  const r = maskOutgoing(text);
  return r.ok ? r.text : WITHHELD;
}

/** Keys whose string values are ids, paths or hashes; they are left as they are. */
const STRUCT_KEYS = new Set([
  "id", "sha", "baseSha", "headSha", "repo", "path", "file", "journeyId", "markdownPath", "jsonPath", "reportPath", "screenshot",
  "rangeLabel", "kind", "type", "priority", "status", "state", "risk", "riskLevel", "department", "version", "generatedAt", "source", "backend",
]);

/** Masks every string in a JSON-like value. A string that looks like a secret is replaced, never kept. */
export function maskDeep<T>(value: T, key = ""): T {
  if (typeof value === "string") return (STRUCT_KEYS.has(key) ? value : maskForStorage(value)) as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, key)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskDeep(v, k);
    return out as T;
  }
  return value;
}

export class ChatStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "chats");
  }

  private file(id: string): string {
    if (!isChatId(id)) throw new Error("Bad chat id");
    return join(this.dir, `${id}.json`);
  }

  create(): Chat {
    mkdirSync(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const chat: Chat = { id: randomBytes(8).toString("hex"), title: "New chat", created: now, updated: now, messages: [] };
    this.save(chat);
    return chat;
  }

  get(id: string): Chat | null {
    if (!isChatId(id)) return null;
    const f = this.file(id);
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as Chat;
    } catch {
      return null;
    }
  }

  save(chat: Chat): void {
    mkdirSync(this.dir, { recursive: true });
    const f = this.file(chat.id);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(chat, null, 2));
    renameSync(tmp, f);
  }

  delete(id: string): boolean {
    if (!isChatId(id) || !existsSync(this.file(id))) return false;
    rmSync(this.file(id));
    return true;
  }

  list(): ChatSummary[] {
    if (!existsSync(this.dir)) return [];
    const rows: ChatSummary[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const c = this.get(f.slice(0, -5));
      if (c) rows.push({ id: c.id, title: c.title, updated: c.updated });
    }
    return rows.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** Appends a message (masked) and keeps the title in step with the first question. */
  append(id: string, m: { role: "user" | "assistant"; text: string; sources?: ChatSource[]; error?: boolean; trace?: Step[]; qa?: unknown; needsInput?: StoredMessage["needsInput"] }): Chat | null {
    const chat = this.get(id);
    if (!chat) return null;
    const text = maskForStorage(m.text);
    const msg: StoredMessage = { role: m.role, text, ts: new Date().toISOString() };
    if (m.sources) msg.sources = m.sources;
    if (m.error) msg.error = true;
    if (m.trace?.length) {
      msg.trace = m.trace.slice(0, MAX_TRACE_STEPS).map((t) => ({
        id: t.id, kind: t.kind, status: t.status, ...(t.agent ? { agent: t.agent } : {}),
        label: maskForStorage(t.label).slice(0, MAX_STEP_TEXT),
        ...(t.detail ? { detail: maskForStorage(t.detail).slice(0, MAX_STEP_TEXT) } : {}),
        ...(typeof t.ms === "number" ? { ms: t.ms } : {}),
      }));
    }
    if (m.qa !== undefined) {
      const safe = maskDeep(m.qa);
      if (JSON.stringify(safe).length <= MAX_STORED_AGENT_CHARS) msg.qa = safe;
    }
    if (m.needsInput) msg.needsInput = maskDeep(m.needsInput);
    chat.messages.push(msg);
    if (chat.messages.length > MAX_STORED_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_STORED_MESSAGES);
    if (m.role === "user" && chat.title === "New chat") {
      chat.title = text === WITHHELD ? "New chat" : text.replace(/\s+/g, " ").slice(0, MAX_TITLE_CHARS);
    }
    chat.updated = msg.ts;
    this.save(chat);
    return chat;
  }
}
