// The local chat server. Treat it like a local admin tool: 127.0.0.1 only, a per-launch token,
// Host and Origin checks, capped bodies, an allowlist for static files, no CORS.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath } from "../config.ts";
import { openDb } from "../index/db.ts";
import type { Db } from "../index/db.ts";
import { getDoc } from "../index/search.ts";
import { loadVault } from "../vault/load.ts";
import { indexVault } from "../index/notes.ts";
import { revertNoteStatus, setNoteStatus } from "../rules/manage.ts";
import type { StatusSnapshot } from "../rules/manage.ts";
import { buildInbox, inboxNote, isNoteId, listReports, readReport, safeReportPath } from "./inbox.ts";
import { describeBackends } from "../brain/select.ts";
import type { CompleteFn } from "../brain/client.ts";
import type { GuardConfig } from "../types.ts";
import { answer, MAX_QUESTION_CHARS } from "../chat/answer.ts";
import type { AnswerResult, ChatTurn, Step } from "../chat/answer.ts";
import { recordFeedback } from "../chat/feedback.ts";
import { ChatStore, isChatId } from "../chat/store.ts";
import { COMMANDS, HeavyLock, loadCommandTable, parseSlash, runMainProcess } from "../chat/commands.ts";
import type { RunProcess } from "../chat/commands.ts";

/** JSON bodies larger than this are refused: a question is a few lines of text. */
export const MAX_BODY_BYTES = 32 * 1024;
/** Streamed command output stops after this many characters (the final result is still complete). */
export const MAX_STREAM_CHARS = 64 * 1024;
const NDJSON = "application/x-ndjson";
export const COOKIE_NAME = "guard_token";
/** The slash-menu data and the backend probe are cached this long (probing runs `claude`). */
const BACKEND_CACHE_MS = 30_000;

export const DEFAULT_UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "ui");

/** The only files that are served, by URL. Nothing else under ui/ is reachable. */
export const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/review.js": { file: "review.js", type: "text/javascript; charset=utf-8" },
  "/inbox.js": { file: "inbox.js", type: "text/javascript; charset=utf-8" },
  "/render.js": { file: "render.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
  "/themes.css": { file: "themes.css", type: "text/css; charset=utf-8" },
  "/theme.js": { file: "theme.js", type: "text/javascript; charset=utf-8" },
  "/marks.js": { file: "marks.js", type: "text/javascript; charset=utf-8" },
  "/steps.js": { file: "steps.js", type: "text/javascript; charset=utf-8" },
  "/reveal.js": { file: "reveal.js", type: "text/javascript; charset=utf-8" },
  "/titles.js": { file: "titles.js", type: "text/javascript; charset=utf-8" },
};

export const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'";

export interface BackendInfo { wanted: string; picked: string | null; label: string }

export interface ServerDeps {
  token: string;
  complete: CompleteFn;
  /** Opens the index; null when it does not exist. release() is called when the request is done. */
  openIndex?: () => { db: Db; release: () => void } | null;
  uiDir?: string;
  runProcess?: RunProcess;
  commandTable?: () => Promise<Set<string>>;
  backendInfo?: () => Promise<BackendInfo>;
}

export function backendLabel(id: string | null): string {
  if (id === "claude-cli") return "Claude plan";
  if (id === "anthropic-api") return "API key";
  return "No model";
}

async function defaultBackendInfo(cfg: GuardConfig): Promise<BackendInfo> {
  const d = await describeBackends(cfg);
  return { wanted: d.wanted, picked: d.picked, label: backendLabel(d.picked) };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "Send JSON.");
  const len = Number(req.headers["content-length"] ?? 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "That request is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "That request is too large.");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "That was not valid JSON.");
  }
}

export function createGuardServer(cfg: GuardConfig, deps: ServerDeps): Server {
  const uiDir = deps.uiDir ?? DEFAULT_UI_DIR;
  const store = new ChatStore(cfg.dataDir);
  const lock = new HeavyLock();
  const runProcess = deps.runProcess ?? runMainProcess;
  const commandTable = deps.commandTable ?? loadCommandTable;
  const backendInfo = deps.backendInfo ?? (() => defaultBackendInfo(cfg));
  let backendCache: { at: number; value: BackendInfo } | null = null;
  const openIndex =
    deps.openIndex ??
    (() => {
      const f = dbPath(cfg);
      if (!existsSync(f)) return null;
      const db = openDb(f);
      return { db, release: () => db.close() };
    });

  const withIndex = async <T>(fn: (db: Db) => Promise<T> | T): Promise<T | null> => {
    const h = openIndex();
    if (!h) return null;
    try {
      return await fn(h.db);
    } finally {
      h.release();
    }
  };

  // What this server session changed, so Undo can put a note back. Memory only; text of notes stays here.
  const changed = new Map<string, StatusSnapshot>();
  const MAX_UNDO = 100;
  const reindex = async (): Promise<void> => {
    await withIndex((db) => indexVault(db, cfg.vaultDir));
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const data = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
    res.end(data);
  };

  const wantsNdjson = (req: IncomingMessage): boolean => (req.headers.accept ?? "").includes(NDJSON);
  /** Starts a newline-delimited JSON reply; each event is flushed as it is written. */
  const startStream = (res: ServerResponse): ((ev: unknown) => void) => {
    res.writeHead(200, { "Content-Type": NDJSON + "; charset=utf-8", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    return (ev) => {
      if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(ev) + "\n");
    };
  };

  async function cachedBackend(): Promise<BackendInfo> {
    if (backendCache && Date.now() - backendCache.at < BACKEND_CACHE_MS) return backendCache.value;
    const value = await backendInfo();
    backendCache = { at: Date.now(), value };
    return value;
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
    if (path === "/api/status" && method === "GET") {
      const index = await withIndex((db) => {
        const rows = db.prepare("SELECT kind, COUNT(*) AS n FROM docs GROUP BY kind").all() as { kind: string; n: number }[];
        const counts: Record<string, number> = {};
        for (const r of rows) counts[r.kind] = r.n;
        return counts;
      });
      const { notes, problems } = loadVault(cfg.vaultDir);
      return json(res, 200, {
        index: index ?? null,
        vault: { notes: notes.length, problems: problems.length },
        backend: await cachedBackend().catch(() => ({ wanted: "auto", picked: null, label: "No model" })),
        running: lock.running,
      });
    }

    if (path === "/api/commands" && method === "GET") {
      const table = await commandTable();
      return json(res, 200, {
        commands: COMMANDS.map((c) => ({ name: c.name, usage: c.usage, help: c.help, heavy: c.heavy, available: !c.requires || table.has(c.requires) })),
        running: lock.running,
      });
    }

    if (path === "/api/doc" && method === "GET") {
      const ref = new URL(req.url ?? "/", "http://x").searchParams.get("ref") ?? "";
      if (!ref || ref.length > 500) throw new HttpError(400, "Missing ref.");
      const doc = await withIndex((db) => getDoc(db, ref, "internal_dev"));
      if (!doc) throw new HttpError(404, "Not found.");
      return json(res, 200, doc);
    }

    if (path === "/api/chats" && method === "GET") return json(res, 200, { chats: store.list() });
    if (path === "/api/chats" && method === "POST") return json(res, 201, store.create());

    const m = /^\/api\/chats\/([^/]+)(\/ask)?$/.exec(path);
    if (m) {
      const id = m[1] as string;
      if (!isChatId(id)) throw new HttpError(404, "No such chat.");
      if (!m[2] && method === "GET") {
        const c = store.get(id);
        if (!c) throw new HttpError(404, "No such chat.");
        return json(res, 200, c);
      }
      if (!m[2] && method === "DELETE") {
        if (!store.delete(id)) throw new HttpError(404, "No such chat.");
        return json(res, 200, { deleted: true });
      }
      if (m[2] && method === "POST") {
        const body = await readJson(req);
        const question = typeof body["question"] === "string" ? body["question"].trim() : "";
        if (!question) throw new HttpError(400, "Type a question.");
        if (question.length > MAX_QUESTION_CHARS) throw new HttpError(400, "That question is too long.");
        const chat = store.get(id);
        if (!chat) throw new HttpError(404, "No such chat.");
        const history: ChatTurn[] = chat.messages.filter((x) => !x.error).map((x) => ({ role: x.role, text: x.text }));
        store.append(id, { role: "user", text: question });
        const notesOnly = body["notesOnly"] === true;
        const streaming = wantsNdjson(req);
        const trace: Step[] = [];
        let live: ((ev: unknown) => void) | null = null;
        if (streaming) live = startStream(res);
        const backend = await cachedBackend().then((b) => b.label).catch(() => "the model");
        const onStep = (step: Step): void => {
          const i = trace.findIndex((t) => t.id === step.id);
          if (i >= 0) trace[i] = step; else trace.push(step);
          live?.({ type: "step", step });
        };
        const r: AnswerResult | null = await withIndex((db) => answer(cfg, db, { history, question, notesOnly }, { complete: deps.complete, onStep, backend }));
        const result: AnswerResult = r ?? { ok: false, text: "The index is not built yet. Type /index to build it.", sources: [] };
        const updated = store.append(id, { role: "assistant", text: result.text, sources: result.sources, trace, ...(result.ok ? {} : { error: true }) });
        if (live) {
          live(result.ok ? { type: "answer", text: result.text, sources: result.sources, chat: updated } : { type: "error", message: result.text, kind: result.error ?? null, chat: updated });
          return void res.end();
        }
        return json(res, 200, { ...result, chat: updated });
      }
    }

    if (path === "/api/command" && method === "POST") {
      const body = await readJson(req);
      const line = typeof body["line"] === "string" ? body["line"] : "";
      const chatId = typeof body["chatId"] === "string" && isChatId(body["chatId"]) ? body["chatId"] : null;
      const parsed = parseSlash(line, await commandTable());
      if (!parsed.ok) return json(res, 400, { ok: false, error: parsed.error });
      if (parsed.heavy && !lock.tryAcquire(parsed.spec.name)) {
        return json(res, 409, { ok: false, busy: true, error: `/${lock.running ?? "another command"} is still running. Wait for it to finish.` });
      }
      const live = wantsNdjson(req) ? startStream(res) : null;
      let sent = 0;
      live?.({ type: "started", command: parsed.display });
      const onChunk = (chunk: string): void => {
        if (!live || sent >= MAX_STREAM_CHARS) return;
        const part = chunk.slice(0, MAX_STREAM_CHARS - sent);
        sent += part.length;
        live({ type: "output", chunk: part, ...(sent >= MAX_STREAM_CHARS ? { truncated: true } : {}) });
      };
      let r;
      try {
        r = await runProcess(parsed.argv, cfg.root, onChunk);
      } finally {
        if (parsed.heavy) lock.release();
      }
      const output = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n") || "(no output)";
      const text = r.timedOut ? `${output}\n\nStopped: it ran too long.` : output;
      if (chatId && store.get(chatId)) {
        store.append(chatId, { role: "user", text: parsed.display });
        store.append(chatId, { role: "assistant", text: "```\n" + text + "\n```", ...(r.code === 0 ? {} : { error: true }) });
      }
      if (live) {
        if (sent === 0) onChunk(text); // a runner that does not stream still shows its result
        live({ type: "done", ok: r.code === 0, code: r.code, command: parsed.display, ...(r.timedOut ? { timedOut: true } : {}), chat: chatId ? store.get(chatId) : null });
        return void res.end();
      }
      return json(res, 200, { ok: r.code === 0, code: r.code, command: parsed.display, output: text, chat: chatId ? store.get(chatId) : null });
    }

    if (path === "/api/feedback" && method === "POST") {
      const body = await readJson(req);
      const r = recordFeedback(cfg.dataDir, body, (cid) => store.get(cid) !== null);
      if (!r.ok) throw new HttpError(r.status, r.error);
      return json(res, 200, { ok: true });
    }

    if (path === "/api/inbox" && method === "GET") return json(res, 200, buildInbox(cfg));

    if (path === "/api/inbox/note" && method === "GET") {
      const id = new URL(req.url ?? "/", "http://x").searchParams.get("id") ?? "";
      if (!isNoteId(id)) throw new HttpError(400, "That is not a note id.");
      const n = inboxNote(cfg, id);
      if (!n) throw new HttpError(404, "No such note.");
      return json(res, 200, n);
    }

    const nm = /^\/api\/notes\/([^/]+)\/(status|undo)$/.exec(path);
    if (nm && method === "POST") {
      const id = nm[1] as string;
      if (!isNoteId(id)) throw new HttpError(400, "That is not a note id.");
      const body = await readJson(req);
      if (!loadVault(cfg.vaultDir).notes.some((n) => n.meta.id === id)) throw new HttpError(404, "No such note.");
      if (nm[2] === "undo") {
        const snap = changed.get(id);
        if (!snap) throw new HttpError(409, "Nothing to undo for this note.");
        const r = revertNoteStatus(cfg, snap, "chat");
        if (!r.ok) throw new HttpError(409, `Could not undo: ${r.reason}`);
        changed.delete(id);
        await reindex();
        return json(res, 200, { ok: true, id, status: snap.from });
      }
      const to = body["to"];
      if (to !== "active" && to !== "deprecated") throw new HttpError(400, "Use to: active or deprecated.");
      const from = body["from"];
      const FROM = ["proposed", "shadow", "active"];
      if (from !== undefined && (typeof from !== "string" || !FROM.includes(from))) throw new HttpError(400, "Bad from.");
      const r = setNoteStatus(cfg, id, to, { via: "chat", ...(from ? { from: from as "proposed" | "shadow" | "active" } : {}) });
      if (!r.ok) {
        const status = r.code === "not-found" ? 404 : r.code === "invalid" ? 422 : 409;
        throw new HttpError(status, r.reason ?? "That change was refused.");
      }
      if (r.snapshot) {
        changed.set(id, r.snapshot);
        if (changed.size > MAX_UNDO) changed.delete(changed.keys().next().value as string);
      }
      await reindex();
      return json(res, 200, { ok: true, id, from: r.from, to: r.to, fields: r.changes.map((c) => c.field), undoable: !!r.snapshot });
    }

    if (path === "/api/reports" && method === "GET") return json(res, 200, { reports: listReports(cfg) });

    if (path === "/api/report" && method === "GET") {
      const p = new URL(req.url ?? "/", "http://x").searchParams.get("path") ?? "";
      const hit = safeReportPath(cfg, p);
      if (!hit) throw new HttpError(404, "No such report.");
      const r = readReport(hit.file);
      return json(res, 200, { path: hit.rel, name: hit.rel.split("/").pop(), kind: hit.kind, ...r });
    }

    throw new HttpError(404, "Not found.");
  }

  return createServer((req, res) => {
    const h = (): void => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", CSP);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
    };
    h();
    const fail = (status: number, message: string): void => json(res, status, { error: message });

    void (async () => {
      try {
        const portNum = req.socket.localPort ?? 0;
        const hosts = [`127.0.0.1:${portNum}`, `localhost:${portNum}`];
        const host = req.headers.host ?? "";
        if (!hosts.includes(host)) return fail(403, "Wrong host.");
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== `http://${host}`) return fail(403, "Wrong origin.");

        const url = new URL(req.url ?? "/", `http://${host}`);
        const method = req.method ?? "GET";
        const supplied = url.searchParams.get("t");
        if (method === "GET" && url.pathname === "/" && supplied !== null) {
          if (!safeEqual(supplied, deps.token)) return fail(401, "Open Guard from its own window.");
          res.writeHead(302, {
            "Set-Cookie": `${COOKIE_NAME}=${deps.token}; HttpOnly; SameSite=Strict; Path=/`,
            Location: "/",
          });
          return void res.end();
        }
        const cookie = cookieValue(req.headers.cookie, COOKIE_NAME);
        if (cookie === null || !safeEqual(cookie, deps.token)) return fail(401, "Open Guard from its own window.");

        if (url.pathname.startsWith("/api/")) return await api(req, res, url.pathname, method);

        const entry = STATIC_FILES[url.pathname];
        if (entry && (method === "GET" || method === "HEAD")) {
          const file = join(uiDir, entry.file);
          if (!existsSync(file)) return fail(404, "Not found.");
          res.writeHead(200, { "Content-Type": entry.type });
          return void res.end(method === "HEAD" ? undefined : readFileSync(file));
        }
        return fail(404, "Not found.");
      } catch (e) {
        if (res.headersSent) return void res.end();
        if (e instanceof HttpError) {
          if (e.status === 413) res.setHeader("Connection", "close");
          return fail(e.status, e.message);
        }
        return fail(500, "Something went wrong in Guard.");
      }
    })();
  });
}
