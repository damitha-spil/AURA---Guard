// The local chat server. Treat it like a local admin tool: 127.0.0.1 only, a per-launch token,
// Host and Origin checks, capped bodies, an allowlist for static files, no CORS.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME } from "../brand.ts";
import { handleBrainRoute } from "./brain.ts";
import type { BrainRouteOptions } from "./brain.ts";
import { HttpError, MAX_BODY_BYTES, readJson, sendJson } from "./http.ts";
import { projectSummary, suggestions } from "./project.ts";
import { ChatStore } from "../chat/store.ts";
import { openDb } from "../index/db.ts";
import { dbPath } from "../config.ts";
import type { Db } from "../index/db.ts";
import { getDoc, search } from "../index/search.ts";
import { appVersion, buildOverview } from "./overview.ts";
import { loadVault } from "../vault/load.ts";
import { indexVault } from "../index/notes.ts";
import { revertNoteStatus, setNoteStatus } from "../rules/manage.ts";
import type { StatusSnapshot } from "../rules/manage.ts";
import { buildInbox, inboxNote, isNoteId, listReports, readReport, safeReportPath } from "./inbox.ts";
import { compareQaRuns, cuaDriverStatus, getQaRun, listGovernanceAndCost, listQaRuns, listQaSuite, safeQaScreenshotPath } from "../qa/harness_api.ts";
import { adviseDeveloper } from "../chat/advisor.ts";
import { buildPrReadinessReport } from "../prs/manager.ts";
import { runBackendQaSuite } from "../qa/backend_qa.ts";
import { LiveSessionController } from "../qa/dsl.ts";
import { buildPrEvidencePacket } from "../qa/evidence.ts";
import { applyTriageDecision, loadQaHints } from "../qa/judge.ts";
import type { TriageAction } from "../qa/judge.ts";
import { draftJourneyFromRecording } from "../qa/recorder.ts";
import type { RecordedEvent } from "../qa/recorder.ts";
import { buildBugSheet } from "../qa/defects.ts";
import { crawlDesktopApp, probeDesktopCrawlers } from "../qa/desktop_crawler.ts";
import { findFeatureEntry } from "../qa/feature_map.ts";
import { runOpenApiChecks } from "../qa/openapi.ts";
import { runSecurityProbes } from "../qa/security_probes.ts";
import { recommendDurableConstraint } from "../qe/constraints.ts";
import { analyzeRefinementAndKbDrift } from "../qe/refine.ts";
import { analyzeCommitTrajectory } from "../qe/trajectory.ts";
import { getSkill, listSkills } from "../roles/skills.ts";
import type { SkillCategory } from "../roles/skills.ts";
import { describeBackends } from "../brain/select.ts";
import type { CompleteFn } from "../brain/client.ts";
import type { GuardConfig } from "../types.ts";
import { answer, MAX_QUESTION_CHARS } from "../chat/answer.ts";
import type { AnswerResult, ChatTurn, Step } from "../chat/answer.ts";
import { recordFeedback } from "../chat/feedback.ts";
import { isChatId } from "../chat/store.ts";
import { decideRoute, lastQaResult, routeQa } from "../chat/qa-route.ts";
import type { RouteMode } from "../chat/qa-route.ts";
import { COMMANDS, HeavyLock, loadCommandTable, parseSlash, runMainProcess } from "../chat/commands.ts";
import type { RunProcess } from "../chat/commands.ts";

export { MAX_BODY_BYTES };
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
  "/overview.js": { file: "overview.js", type: "text/javascript; charset=utf-8" },
  "/overview.css": { file: "overview.css", type: "text/css; charset=utf-8" },
  "/marks.js": { file: "marks.js", type: "text/javascript; charset=utf-8" },
  "/steps.js": { file: "steps.js", type: "text/javascript; charset=utf-8" },
  "/reveal.js": { file: "reveal.js", type: "text/javascript; charset=utf-8" },
  "/titles.js": { file: "titles.js", type: "text/javascript; charset=utf-8" },
  "/brand.js": { file: "brand.js", type: "text/javascript; charset=utf-8" },
  "/qa.js": { file: "qa.js", type: "text/javascript; charset=utf-8" },
  "/qa-view.js": { file: "qa-view.js", type: "text/javascript; charset=utf-8" },
  "/qa.css": { file: "qa.css", type: "text/css; charset=utf-8" },
  "/qa-harness.js": { file: "qa-harness.js", type: "text/javascript; charset=utf-8" },
  "/qa-harness-view.js": { file: "qa-harness-view.js", type: "text/javascript; charset=utf-8" },
  "/qa-harness.css": { file: "qa-harness.css", type: "text/css; charset=utf-8" },
  "/settings.js": { file: "settings.js", type: "text/javascript; charset=utf-8" },
  "/settings.css": { file: "settings.css", type: "text/css; charset=utf-8" },
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
  /** Model and API key settings: tests inject a fake environment, secret store and model call. */
  brain?: BrainRouteOptions;
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

export function createGuardServer(cfg: GuardConfig, deps: ServerDeps): Server {
  const uiDir = deps.uiDir ?? DEFAULT_UI_DIR;
  const store = new ChatStore(cfg.dataDir);
  // One lazily opened index handle for the one project.
  let cached: { file: string; db: Db } | null = null;
  const openIndex = (): { db: Db; release: () => void } | null => {
    if (deps.openIndex) return deps.openIndex();
    const file = dbPath(cfg);
    if (!existsSync(file)) return null;
    if (!cached || cached.file !== file) {
      cached?.db.close();
      cached = { file, db: openDb(file) };
    }
    return { db: cached.db, release: () => {} };
  };
  const lock = new HeavyLock();
  const liveQa = new LiveSessionController();
  const runProcess = deps.runProcess ?? runMainProcess;
  const commandTable = deps.commandTable ?? loadCommandTable;
  const backendInfo = deps.backendInfo ?? (() => defaultBackendInfo(cfg));
  let backendCache: { at: number; value: BackendInfo } | null = null;
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
  const changed = new Map<string, StatusSnapshot>(); // key: note id
  const MAX_UNDO = 100;
  const reindex = async (): Promise<void> => {
    await withIndex((db) => indexVault(db, cfg.vaultDir));
  };

  const json = sendJson;

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
    // Model and key settings are machine-wide. A stray `dept` parameter from an older page is ignored.
    if (await handleBrainRoute({ req, res, path, method, cfg, ...(deps.brain ? { options: deps.brain } : {}) })) return;
    const dcfg = cfg;
    if (path === "/api/status" && method === "GET") {
      const index = await withIndex((db) => {
        const rows = db.prepare("SELECT kind, COUNT(*) AS n FROM docs GROUP BY kind").all() as { kind: string; n: number }[];
        const counts: Record<string, number> = {};
        for (const r of rows) counts[r.kind] = r.n;
        return counts;
      });
      const { notes, problems } = loadVault(dcfg.vaultDir);
      return json(res, 200, {
        index: index ?? null,
        vault: { notes: notes.length, problems: problems.length },
        backend: await cachedBackend().catch(() => ({ wanted: "auto", picked: null, label: "No model" })),
        running: lock.running,
        productName: PRODUCT_NAME,
        version: appVersion(),
      });
    }

    if (path === "/api/project" && method === "GET") {
      const h = openIndex();
      try {
        return json(res, 200, projectSummary(dcfg, h?.db ?? null));
      } finally {
        h?.release();
      }
    }

    if (path === "/api/overview" && method === "GET") {
      const h = openIndex();
      try {
        return json(res, 200, buildOverview(dcfg, h?.db ?? null));
      } finally {
        h?.release();
      }
    }

    // Quick search over notes, commits and files for the top bar. Read-only, internal_dev audience.
    if (path === "/api/search" && method === "GET") {
      const q = (new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "").slice(0, 200);
      const hits = await withIndex((db) => search(db, q, { audience: "internal_dev", limit: 8 }));
      return json(res, 200, { hits: (hits ?? []).map((x) => ({ kind: x.kind, ref: x.ref, title: x.title, status: x.status ?? null })) });
    }

    if (path === "/api/suggestions" && method === "GET") return json(res, 200, { suggestions: suggestions(dcfg) });

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
        // QA requests go to the QA sub-agent (deterministic routing, no model call to decide).
        const modeIn = body["mode"] === "qa" || body["mode"] === "ask" ? (body["mode"] as RouteMode) : undefined;
        const runJourneys = body["runJourneys"] === true;
        if (decideRoute(question, history, { mode: modeIn, runJourneys }).intent === "qa") {
          live?.({ type: "agent", agent: "qa", label: "QA agent", state: "started" });
          const h = openIndex();
          let out;
          try {
            out = await routeQa(
              { cfg: dcfg, db: h?.db ?? null, complete: deps.complete, backend, onStep: (s) => onStep(s) },
              { message: question, history, runJourneys, lastQa: lastQaResult(chat.messages) },
            );
          } finally {
            h?.release();
          }
          const qa = out.kind === "result" ? out.result : undefined;
          const needsInput = out.kind === "needs-input" ? { question: out.question, options: out.options } : undefined;
          const stored = store.append(id, { role: "assistant", text: out.text, sources: [], trace, ...(qa ? { qa } : {}), ...(needsInput ? { needsInput } : {}), ...(out.ok ? {} : { error: true }) });
          if (live) {
            live({ type: "agent", agent: "qa", label: "QA agent", state: out.ok ? "done" : "error" });
            if (out.kind === "result") live({ type: "qa", result: out.result });
            if (out.kind === "needs-input") live({ type: "needs-input", question: out.question, options: out.options });
            live(out.ok ? { type: "answer", text: out.text, sources: [], chat: stored } : { type: "error", message: out.text, kind: out.kind === "blocked" ? "blocked" : "qa", chat: stored });
            return void res.end();
          }
          return json(res, 200, { ok: out.ok, text: out.text, sources: [], agent: "qa", trace, ...(qa ? { qa } : {}), ...(needsInput ? { needsInput } : {}), ...(out.ok ? {} : { error: out.kind === "blocked" ? "blocked" : "qa" }), chat: stored });
        }
        const r: AnswerResult | null = await withIndex((db) => answer(dcfg, db, { history, question, notesOnly }, { complete: deps.complete, onStep, backend }));
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
      const argv = parsed.argv;
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
        r = await runProcess(argv, cfg.root, onChunk);
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
      const r = recordFeedback(dcfg.dataDir, body, (cid) => store.get(cid) !== null);
      if (!r.ok) throw new HttpError(r.status, r.error);
      return json(res, 200, { ok: true });
    }

    if (path === "/api/inbox" && method === "GET") return json(res, 200, buildInbox(dcfg));

    if (path === "/api/inbox/note" && method === "GET") {
      const id = new URL(req.url ?? "/", "http://x").searchParams.get("id") ?? "";
      if (!isNoteId(id)) throw new HttpError(400, "That is not a note id.");
      const n = inboxNote(dcfg, id);
      if (!n) throw new HttpError(404, "No such note.");
      return json(res, 200, n);
    }

    const nm = /^\/api\/notes\/([^/]+)\/(status|undo)$/.exec(path);
    if (nm && method === "POST") {
      const id = nm[1] as string;
      if (!isNoteId(id)) throw new HttpError(400, "That is not a note id.");
      const body = await readJson(req);
      if (!loadVault(dcfg.vaultDir).notes.some((n) => n.meta.id === id)) throw new HttpError(404, "No such note.");
      if (nm[2] === "undo") {
        const snap = changed.get(id);
        if (!snap) throw new HttpError(409, "Nothing to undo for this note.");
        const r = revertNoteStatus(dcfg, snap, "chat");
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
      const r = setNoteStatus(dcfg, id, to, { via: "chat", ...(from ? { from: from as "proposed" | "shadow" | "active" } : {}) });
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

    if (path === "/api/reports" && method === "GET") return json(res, 200, { reports: listReports(dcfg) });

    if (path === "/api/report" && method === "GET") {
      const p = new URL(req.url ?? "/", "http://x").searchParams.get("path") ?? "";
      const hit = safeReportPath(dcfg, p);
      if (!hit) throw new HttpError(404, "No such report.");
      const r = readReport(hit.file);
      return json(res, 200, { path: hit.rel, name: hit.rel.split("/").pop(), kind: hit.kind, ...r });
    }

    if (path === "/api/qa/runs" && method === "GET") return json(res, 200, listQaRuns(dcfg));

    if (path === "/api/qa/run" && method === "GET") {
      const id = new URL(req.url ?? "/", "http://x").searchParams.get("id") ?? "";
      const detail = getQaRun(dcfg, id);
      if (!detail) throw new HttpError(404, "No such QA run.");
      return json(res, 200, detail);
    }

    if (path === "/api/qa/compare" && method === "GET") {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const cmp = compareQaRuns(dcfg, q.get("base") ?? "", q.get("head") ?? "");
      if (!cmp) throw new HttpError(404, "One or both QA runs were not found.");
      return json(res, 200, cmp);
    }

    if (path === "/api/qa/suite" && method === "GET") return json(res, 200, listQaSuite(dcfg));

    if (path === "/api/qa/governance" && method === "GET") return json(res, 200, listGovernanceAndCost(dcfg));

    if (path === "/api/qa/driver" && method === "GET") return json(res, 200, await cuaDriverStatus(dcfg));

    if (path === "/api/qa/live/status" && method === "GET") {
      return json(res, 200, { ...liveQa.getSnapshot(), hints: loadQaHints(dcfg) });
    }

    if (path === "/api/qa/live/control" && method === "POST") {
      const body = await readJson(req);
      const act = body["action"];
      if (act === "pause") return json(res, 200, liveQa.pause());
      if (act === "resume") return json(res, 200, liveQa.resume());
      if (act === "step") return json(res, 200, liveQa.stepOver());
      if (act === "abort") return json(res, 200, liveQa.abort());
      if (act === "hint") {
        const hint = typeof body["hint"] === "string" ? body["hint"].trim() : "";
        if (!hint) throw new HttpError(400, "Provide hint text.");
        return json(res, 200, liveQa.injectHint(hint));
      }
      throw new HttpError(400, "Use action: pause, resume, step, hint, or abort.");
    }

    if (path === "/api/qa/triage" && method === "POST") {
      const body = await readJson(req);
      const act = body["action"];
      if (act !== "real_bug" && act !== "update_baseline" && act !== "flaky_hint") {
        throw new HttpError(400, "Use action: real_bug, update_baseline, or flaky_hint.");
      }
      const runId = typeof body["runId"] === "string" ? body["runId"] : "";
      const journey = typeof body["journey"] === "string" ? body["journey"] : "";
      const step = typeof body["step"] === "string" ? body["step"] : "";
      if (!runId || !journey || !step) throw new HttpError(400, "runId, journey, and step are required.");
      const resTriage = applyTriageDecision(dcfg, {
        action: act as TriageAction,
        runId,
        journey,
        step,
        ...(typeof body["expected"] === "string" ? { expected: body["expected"] } : {}),
        ...(typeof body["actual"] === "string" ? { actual: body["actual"] } : {}),
        ...(typeof body["width"] === "number" ? { width: body["width"] } : {}),
        ...(typeof body["screenshotPath"] === "string" ? { screenshotPath: body["screenshotPath"] } : {}),
        ...(typeof body["hint"] === "string" ? { hint: body["hint"] } : {}),
      });
      return json(res, resTriage.ok ? 200 : 400, resTriage);
    }

    if (path === "/api/qa/evidence" && method === "GET") {
      const id = new URL(req.url ?? "/", "http://x").searchParams.get("id") ?? "";
      const built = await buildPrEvidencePacket(dcfg, id);
      if (!built) throw new HttpError(404, "No such QA run.");
      return json(res, 200, built);
    }

    if (path === "/api/qa/pr-readiness" && method === "GET") {
      const repo = new URL(req.url ?? "/", "http://x").searchParams.get("repo") ?? undefined;
      const h = openIndex();
      try {
        return json(res, 200, buildPrReadinessReport(dcfg, h?.db ?? null, { ...(repo ? { repo } : {}) }));
      } finally {
        h?.release();
      }
    }

    if (path === "/api/qa/backend-check" && method === "POST") {
      return json(res, 200, await runBackendQaSuite(dcfg));
    }

    if (path === "/api/qa/record/draft" && method === "POST") {
      const body = await readJson(req);
      const id = typeof body["id"] === "string" ? body["id"].trim() : "";
      const title = typeof body["title"] === "string" ? body["title"].trim() : "";
      const area = typeof body["area"] === "string" ? body["area"].trim() : "ui";
      const events = Array.isArray(body["events"]) ? (body["events"] as RecordedEvent[]) : [];
      if (!id || !title) throw new HttpError(400, "id and title are required.");
      const draft = draftJourneyFromRecording(dcfg, {
        id,
        title,
        area,
        tier: body["tier"] === 1 ? 1 : 0,
        events,
        writeProposal: body["writeProposal"] === true,
      });
      return json(res, 200, draft);
    }

    if (path === "/api/advisor" && method === "GET") {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const query = q.get("q") ?? "";
      if (!query.trim()) throw new HttpError(400, "Missing query q.");
      const repo = q.get("repo") ?? undefined;
      const filePath = q.get("path") ?? undefined;
      const h = openIndex();
      try {
        return json(res, 200, adviseDeveloper(dcfg, h?.db ?? null, query, { ...(repo ? { repo } : {}), ...(filePath ? { path: filePath } : {}) }));
      } finally {
        h?.release();
      }
    }

    if (path === "/api/skills" && method === "GET") {
      const cat = new URL(req.url ?? "/", "http://x").searchParams.get("category");
      const valid = cat === "security" || cat === "qa" || cat === "qe" || cat === "core" ? (cat as SkillCategory) : undefined;
      return json(res, 200, { skills: listSkills(dcfg.root, valid) });
    }

    if (path === "/api/skill" && method === "GET") {
      const name = new URL(req.url ?? "/", "http://x").searchParams.get("name") ?? "";
      const skill = getSkill(dcfg.root, name);
      if (!skill) throw new HttpError(404, "No such skill.");
      return json(res, 200, skill);
    }

    if (path === "/api/qe/trajectory" && method === "GET") {
      const repo = new URL(req.url ?? "/", "http://x").searchParams.get("repo") ?? undefined;
      const h = openIndex();
      try {
        return json(res, 200, analyzeCommitTrajectory(dcfg, h?.db ?? null, { ...(repo ? { repo } : {}) }));
      } finally {
        h?.release();
      }
    }

    if (path === "/api/qe/refine" && method === "GET") {
      const repo = new URL(req.url ?? "/", "http://x").searchParams.get("repo") ?? undefined;
      const h = openIndex();
      try {
        return json(res, 200, analyzeRefinementAndKbDrift(dcfg, h?.db ?? null, { ...(repo ? { repo } : {}) }));
      } finally {
        h?.release();
      }
    }

    if (path === "/api/qa/bug-sheet" && method === "GET") {
      const id = new URL(req.url ?? "/", "http://x").searchParams.get("id") ?? "";
      const sheet = buildBugSheet(dcfg, id);
      if (!sheet) throw new HttpError(404, "No such QA run.");
      return json(res, 200, sheet);
    }

    if (path === "/api/qa/openapi" && method === "POST") {
      const body = await readJson(req);
      const baseUrl = typeof body["baseUrl"] === "string" ? body["baseUrl"].trim() : "";
      const specText = typeof body["specText"] === "string" ? body["specText"] : "";
      if (!baseUrl) throw new HttpError(400, "baseUrl is required.");
      try {
        return json(res, 200, await runOpenApiChecks(dcfg, { baseUrl, specText }));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }

    if (path === "/api/qa/security-probes" && method === "POST") {
      const body = await readJson(req);
      const baseUrl = typeof body["baseUrl"] === "string" ? body["baseUrl"].trim() : "";
      const paths = Array.isArray(body["paths"]) ? body["paths"].filter((p): p is string => typeof p === "string") : undefined;
      if (!baseUrl) throw new HttpError(400, "baseUrl is required.");
      try {
        return json(res, 200, await runSecurityProbes(dcfg, { baseUrl, ...(paths ? { paths } : {}) }));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }

    if (path === "/api/qa/crawlers" && method === "GET") {
      return json(res, 200, await probeDesktopCrawlers(dcfg));
    }

    if (path === "/api/qa/crawl" && method === "POST") {
      const body = await readJson(req);
      const matchTitle = typeof body["matchTitle"] === "string" ? body["matchTitle"].trim() : undefined;
      const dryRun = body["dryRun"] !== false;
      const maxActions = typeof body["maxActions"] === "number" ? body["maxActions"] : 5;
      try {
        return json(res, 200, await crawlDesktopApp(dcfg, { ...(matchTitle ? { matchTitle } : {}), dryRun, maxActions, tier: body["tier"] === 1 ? 1 : 0 }));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }

    if (path === "/api/qa/features" && method === "GET") {
      const q = new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "";
      return json(res, 200, { features: findFeatureEntry(dcfg, q) });
    }

    if (path === "/api/qe/constraint" && method === "POST") {
      const body = await readJson(req);
      const pattern = typeof body["pattern"] === "string" ? body["pattern"].trim() : "";
      if (!pattern) throw new HttpError(400, "pattern is required.");
      return json(res, 200, recommendDurableConstraint({
        pattern,
        occurrences: typeof body["occurrences"] === "number" ? body["occurrences"] : 1,
        mechanicallyDetectable: body["mechanicallyDetectable"] === true,
        canDesignOutInTypesOrApi: body["canDesignOutInTypesOrApi"] === true,
        isMultiStepProcedure: body["isMultiStepProcedure"] === true,
      }));
    }

    if (path === "/api/qa/artifact" && method === "GET") {
      const p = new URL(req.url ?? "/", "http://x").searchParams.get("path") ?? "";
      const hit = safeQaScreenshotPath(dcfg, p);
      if (!hit) throw new HttpError(404, "No such QA artifact.");
      const ext = hit.toLowerCase();
      const type = ext.endsWith(".jpg") || ext.endsWith(".jpeg") ? "image/jpeg" : ext.endsWith(".webp") ? "image/webp" : "image/png";
      res.writeHead(200, { "Content-Type": type });
      return void res.end(readFileSync(hit));
    }

    throw new HttpError(404, "Not found.");
  }

  const server = createServer((req, res) => {
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
  // Close the index handle with the server.
  server.on("close", () => { try { cached?.db.close(); } catch { /* already closed */ } cached = null; });
  return server;
}
