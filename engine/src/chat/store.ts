// Chats live in data/chats/<id>.json (git-ignored). Text is stored MASKED, never raw.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskOutgoing } from "../mask/mask.ts";
import type { ChatSource, Step } from "./answer.ts";
import type { CreatedItem } from "./follow-through.ts";

/** A trace is a handful of short rows; this stops a runaway one from filling a chat file. */
export const MAX_TRACE_STEPS = 40;
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
  /** Files sent with this message (metadata only; the files are in data/attachments). */
  attachments?: StoredAttachment[];
  /** A question the QA agent asked, with its answer chips. */
  needsInput?: { question: string; options: { id: string; label: string; value: string }[] };
  /** Items agent mode created in REO's own data for this answer; the screen shows them as links. */
  created?: CreatedItem[];
  /** Set when a background mission wrote this answer. */
  mission?: string;
}

/** What a message keeps about an attached file. */
export interface StoredAttachment { id: string; name: string; size: number; type: string; kind: string; status: string; note?: string; chars?: number }

export interface Chat {
  id: string;
  title: string;
  created: string;
  updated: string;
  messages: StoredMessage[];
  pinned?: boolean;
}

export interface ChatSummary { id: string; title: string; updated: string; pinned?: boolean }
export interface ChatHit extends ChatSummary { snippet: string; matches: number }

/** Bounds a search over every chat file, so one request stays quick. */
export const MAX_CHAT_HITS = 30;
export const MAX_CHAT_QUERY_CHARS = 200;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;

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
      if (c) rows.push({ id: c.id, title: c.title, updated: c.updated, ...(c.pinned ? { pinned: true } : {}) });
    }
    return rows.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** Case-insensitive text search over titles and stored (already masked) messages, newest chat first. */
  search(query: string): ChatHit[] {
    const q = query.trim().slice(0, MAX_CHAT_QUERY_CHARS).toLowerCase();
    if (!q) return [];
    const hits: ChatHit[] = [];
    for (const row of this.list()) {
      const chat = this.get(row.id);
      if (!chat) continue;
      let matches = 0;
      let snippet = "";
      for (const m of chat.messages) {
        const at = m.text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        matches++;
        snippet ||= m.text.slice(Math.max(0, at - SNIPPET_BEFORE), at + q.length + SNIPPET_AFTER).replace(/\s+/g, " ").trim();
      }
      if (matches || row.title.toLowerCase().includes(q)) hits.push({ ...row, snippet, matches });
      if (hits.length >= MAX_CHAT_HITS) break;
    }
    return hits;
  }

  /** Renames or pins a chat. `updated` is left alone so the chat keeps its place in the history. */
  update(id: string, patch: { title?: string; pinned?: boolean }): Chat | null {
    const chat = this.get(id);
    if (!chat) return null;
    if (patch.title !== undefined) chat.title = maskForStorage(patch.title).replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS) || chat.title;
    if (patch.pinned !== undefined) {
      if (patch.pinned) chat.pinned = true;
      else delete chat.pinned;
    }
    this.save(chat);
    return chat;
  }

  /** Appends a message (masked) and keeps the title in step with the first question. */
  append(id: string, m: { role: "user" | "assistant"; text: string; sources?: ChatSource[]; error?: boolean; trace?: Step[]; qa?: unknown; needsInput?: StoredMessage["needsInput"]; attachments?: StoredAttachment[]; created?: CreatedItem[]; mission?: string }): Chat | null {
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
    if (m.created?.length) msg.created = m.created.slice(0, 10).map((c) => ({ kind: c.kind, id: c.id, label: maskForStorage(c.label).slice(0, 80) }));
    if (m.mission && /^[a-f0-9]{16}$/.test(m.mission)) msg.mission = m.mission;
    if (m.attachments?.length) msg.attachments = m.attachments.slice(0, 10).map((a) => ({ id: a.id, name: a.name, size: a.size, type: a.type, kind: a.kind, status: a.status, ...(a.note ? { note: a.note } : {}), ...(typeof a.chars === "number" ? { chars: a.chars } : {}) }));
    chat.messages.push(msg);
    if (chat.messages.length > MAX_STORED_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_STORED_MESSAGES);
    if (m.role === "user" && chat.title === "New chat") {
      chat.title = text === WITHHELD ? "New chat" : text.replace(/\s+/g, " ").slice(0, MAX_TITLE_CHARS) || (m.attachments?.[0]?.name ?? "New chat").slice(0, MAX_TITLE_CHARS);
    }
    chat.updated = msg.ts;
    this.save(chat);
    return chat;
  }
}
