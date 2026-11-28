// The local chat server. Treat it like a local admin tool: 127.0.0.1 only, a per-launch token,
// Host and Origin checks, capped bodies, an allowlist for static files, no CORS.

import { findProvider } from "../brain/providers.ts";
import { isModelBackend } from "../brain/models.ts";
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
import { findNoteHygiene } from "../vault/hygiene.ts";
import { suggestLessonsForRepos } from "../vault/lessons.ts";
import { indexVault } from "../index/notes.ts";
import { revertNoteStatus, setNoteStatus } from "../rules/manage.ts";
import type { StatusSnapshot } from "../rules/manage.ts";
import { buildInbox, inboxNote, isNoteId, listReports, readReport, safeReportPath } from "./inbox.ts";
import { compareQaRuns, cuaDriverStatus, getQaRun, listGovernanceAndCost, listQaRuns, listQaSuite, safeQaScreenshotPath } from "../qa/harness_api.ts";
import { adviseDeveloper } from "../chat/advisor.ts";
import { buildPrReadinessReport } from "../prs/manager.ts";
import { runBackendQaSuite } from "../qa/backend_qa.ts";
import { LiveSessionController } from "../qa/dsl.ts";
import { buildPrEvidencePacket, runEvidence } from "../qa/evidence.ts";
import { runHealth } from "../health/health.ts";
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
import { PREBUILT_AGENTS, routeIntentToAgents } from "../agents/registry.ts";
import type { AgentId } from "../agents/registry.ts";
import { getEffectiveAgents, saveAgentProfile } from "../agents/profiles.ts";
import { runAgenticMission } from "../agents/runner.ts";
import { addMemory, deleteMemory, listMemory, verifyMemory } from "../memory/qa-memory.ts";
import type { MemoryConfidence, MemoryLayer } from "../memory/qa-memory.ts";
import { deleteAutomationRule, listAutomationRules, listCheckpoints, upsertAutomationRule } from "../automation/harness.ts";
import type { TriggerKind } from "../automation/harness.ts";
import { BUILTIN_TOOLS } from "../tools/registry.ts";
import type { DefectStatus } from "../defects/store.ts";
import { buildDailyDigest, DEFECT_STATUSES, generateDefectReportHtml, listDefects, listProductionDefects, saveDefectReportHtml, updateDefectStatus, upsertDefect } from "../defects/store.ts";
import { buildTeamsDefectPayload, listPlugins, listTeamMembers, removeTeamMember, updatePlugin, upsertTeamMember } from "../plugins/store.ts";
import type { PluginId } from "../plugins/store.ts";
import { getN8nStatus, n8nKeyStore, n8nListExecutions, n8nListWorkflows, n8nTriggerWebhook, validateN8nEndpoint } from "../plugins/n8n.ts";
import { validateApiKey } from "../brain/keystore.ts";
import { addFollowup, addTask, isItemId, listFollowups, listTasks, updateFollowup, updateTask } from "../followups/store.ts";
import { getStepList, isStepListId, listStepLists, replayStepList, saveStepList, stepsFromRun } from "../steps/store.ts";
import { digestModel, parseView, qaRunModel, renderReport } from "../reports/views.ts";
import { describeBackends } from "../brain/select.ts";
import { effectiveBrain } from "../brain/settings.ts";
import type { CompleteFn } from "../brain/client.ts";
import type { GuardConfig } from "../types.ts";
import { answer, MAX_QUESTION_CHARS, UNTRUSTED_MARK } from "../chat/answer.ts";
import { identityReply, isGreetingOrIdentity } from "../chat/identity.ts";
import { NOTES_NEED_INDEX, openAnswer } from "../chat/open-answer.ts";
import { createProviderRoutes } from "./providers.ts";
import { createRepoRoutes } from "../repos/routes.ts";
import type { RepoRouteDeps } from "../repos/routes.ts";
import { loadPrices } from "../usage/prices.ts";
import { readUsage } from "../usage/record.ts";
import { RANGES, usageReport } from "../usage/report.ts";
import type { Range } from "../usage/report.ts";
import { limitsReport } from "../usage/limits.ts";
import type { LimitsOptions } from "../usage/limits.ts";
import { parseToolLine, runToolLine } from "../tools/native/chat.ts";
import type { NativeDeps } from "../tools/native/chat.ts";
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

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The built web app is the only UI. Files are looked up on each request, so a build made after start is picked up. */
export const DEFAULT_UI_DIR = join(ROOT_DIR, "web", "dist");
/** Source copies of the pair page's assets, used while the app is not built. */
const PUBLIC_SOURCE_DIR = join(ROOT_DIR, "web", "public");

/** The only files that are served by URL, besides the build's /assets/ folder. */
export const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
  "/favicon-16.png": { file: "favicon-16.png", type: "image/png" },
  "/favicon-32.png": { file: "favicon-32.png", type: "image/png" },
  "/favicon-48.png": { file: "favicon-48.png", type: "image/png" },
  "/favicon-256.png": { file: "favicon-256.png", type: "image/png" },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png" },
  "/favicon.ico": { file: "favicon.ico", type: "image/x-icon" },
  "/logo.png": { file: "logo.png", type: "image/png" },
  "/themes.css": { file: "themes.css", type: "text/css; charset=utf-8" },
  "/theme-init.js": { file: "theme-init.js", type: "text/javascript; charset=utf-8" },
  "/pair.css": { file: "pair.css", type: "text/css; charset=utf-8" },
};

export const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

/** Files the "Open Guard" page may load before a browser is paired: colours and the icon only. */
const PUBLIC_FILES = new Set(["/themes.css", "/pair.css", "/favicon.svg", "/favicon-32.png", "/logo.png"]);

const PAIR_PAGE = `<!doctype html><html lang="en" data-style="noir" data-mode="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SPIL REO</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="/themes.css"><link rel="stylesheet" href="/pair.css"></head><body><main class="pair"><img class="pair-logo" src="/favicon.svg" alt="" width="64" height="64"><h1>SPIL REO</h1><p>A Multi-Agent Quality Engineering &amp; Software Assurance Platform. Powered by SPIL Labs. Press the button to open SPIL REO here.</p><a class="pair-btn" href="/pair">Open SPIL REO</a><p class="pair-small">If the button does not work, start SPIL REO again with <code>npm run desktop</code> or <code>npm run ui</code>.</p></main></body></html>`;

/** Shown while web/dist is missing, for example during a build. It reloads by itself; no script (CSP). */
const BUILDING_PAGE = `<!doctype html><html lang="en" data-style="noir" data-mode="light"><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SPIL REO</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="/themes.css"><link rel="stylesheet" href="/pair.css"></head><body><main class="pair"><h1>SPIL REO</h1><p>The app is being built. This page reloads by itself.</p><p class="pair-small">If it stays here, run <code>npm run web:build</code>.</p></main></body></html>`;

export interface BackendInfo { wanted: string; picked: string | null; label: string; model?: string }

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
  /** Network, browser and process access of the native tools: tests inject fakes. */
  native?: NativeDeps;
  /** Access used by the limits report: tests inject fakes. */
  limits?: LimitsOptions;
  /** Access used by the repo and pull request routes: tests inject fakes. */
  repos?: RepoRouteDeps;
}

export function backendLabel(id: string | null): string {
  if (id === "antigravity-cli") return "Antigravity plan";
  if (id === "claude-cli") return "Claude plan";
  if (id === "anthropic-api") return "API key";
  if (id === "opencode-cli") return "OpenCode";
  const provider = findProvider(id ?? "");
  if (provider) return provider.label;
  return "No model";
}

async function defaultBackendInfo(cfg: GuardConfig): Promise<BackendInfo> {
  const eff = effectiveBrain(cfg);
  const d = await describeBackends(cfg);
  const model = isModelBackend(d.picked) ? eff.models[d.picked].id : undefined;
  const base = backendLabel(d.picked);
  return { wanted: d.wanted, picked: d.picked, label: model ? `${base} (${model})` : base, ...(model ? { model } : {}) };
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
  const repoRoutes = createRepoRoutes(deps.repos);
  const providerRoutes = createProviderRoutes();
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
    if (await handleBrainRoute({ req, res, path, method, cfg, ...(deps.brain ? { options: deps.brain } : {}) })) {
      if (method !== "GET") {
        backendCache = null;
        providerRoutes.forget();
      }
      return;
    }
    if (await providerRoutes.handle({ req, res, path, method, cfg, options: deps.brain ?? {} })) {
      if (method !== "GET") backendCache = null;
      return;
    }
    const dcfg = cfg;
    if (await repoRoutes({ req, res, path, method, cfg, complete: deps.complete, openIndex })) return;
    if (path === "/api/health" && method === "GET") return json(res, 200, await runHealth(dcfg, deps.brain ? { brain: deps.brain } : {}));
    if (path === "/api/usage" && method === "GET") {
      const range = new URL(req.url ?? "/", "http://x").searchParams.get("range") ?? "7d";
      if (!(RANGES as readonly string[]).includes(range)) throw new HttpError(400, `Use range: ${RANGES.join(", ")}.`);
      return json(res, 200, usageReport(readUsage(dcfg.dataDir), range as Range, loadPrices(dcfg.root)));
    }
    if (path === "/api/usage/limits" && method === "GET") return json(res, 200, await limitsReport(dcfg, deps.limits));
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
        const history: ChatTurn[] = chat.messages.flatMap((x, i) => {
          if (x.error) return [];
          const asked = chat.messages[i - 1];
          const fromTool = x.role === "assistant" && asked?.role === "user" && parseToolLine(asked.text) !== null;
          return [{ role: x.role, text: fromTool ? `${UNTRUSTED_MARK} ${x.text}` : x.text }];
        });
        store.append(id, { role: "user", text: question });
        const notesOnly = body["notesOnly"] === true;
        const streaming = wantsNdjson(req);
        const trace: Step[] = [];
        let live: ((ev: unknown) => void) | null = null;
        if (streaming) live = startStream(res);
        // Names the chat on every model call, for the usage record.
        const complete: CompleteFn = (r) => deps.complete({ ...r, sessionId: id });
        const toolLine = parseToolLine(question);
        const greeting = !toolLine && body["mode"] !== "qa" && isGreetingOrIdentity(question);
        const info = toolLine ? null : await cachedBackend().catch(() => null);
        const backend = info?.label ?? "the model";
        const onStep = (step: Step): void => {
          const i = trace.findIndex((t) => t.id === step.id);
          if (i >= 0) trace[i] = step; else trace.push(step);
          live?.({ type: "step", step });
        };
        // QA requests go to the QA sub-agent (deterministic routing, no model call to decide).
        const modeIn = body["mode"] === "qa" || body["mode"] === "ask" ? (body["mode"] as RouteMode) : undefined;
        const runJourneys = body["runJourneys"] === true;
        const reply = (result: AnswerResult): void => {
          const updated = store.append(id, { role: "assistant", text: result.text, sources: result.sources, trace, ...(result.ok ? {} : { error: true }) });
          if (live) {
            live(result.ok ? { type: "answer", text: result.text, sources: result.sources, chat: updated } : { type: "error", message: result.text, kind: result.error ?? null, chat: updated });
            return void res.end();
          }
          return json(res, 200, { ...result, chat: updated });
        };
        // A typed tool line runs the tool and shows its result: no model and no index.
        if (toolLine) return reply(await runToolLine(dcfg, toolLine, deps.native ?? {}, onStep));
        if (greeting) return reply({ ok: true, text: identityReply(info), sources: [] });
        if (decideRoute(question, history, { mode: modeIn, runJourneys }).intent === "qa") {
          live?.({ type: "agent", agent: "qa", label: "QA agent", state: "started" });
          const h = openIndex();
          let out;
          try {
            out = await routeQa(
              { cfg: dcfg, db: h?.db ?? null, complete, backend, onStep: (s) => onStep(s) },
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
        const useWeb = body["webSearch"] === true && !notesOnly;
        const run = (db: Db | null): Promise<AnswerResult> =>
          db && !useWeb
            ? answer(dcfg, db, { history, question, notesOnly }, { complete, onStep, backend })
            : openAnswer(db, { history, question, webSearch: useWeb }, { complete, onStep, backend, ...(deps.native ? { web: deps.native } : {}) });
        const indexed = await withIndex(run);
        return reply(indexed ?? (notesOnly ? { ok: false, text: NOTES_NEED_INDEX, sources: [] } : await run(null)));
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
      const view = parseView(new URL(req.url ?? "/", "http://x").searchParams.get("view"));
      return json(res, 200, { ...detail, evidence: runEvidence(dcfg, detail), report: renderReport(qaRunModel(detail), view) });
    }

    // Repeated steps: saved from a passed run; replay is dry unless {"run": true} is sent. Never calls a model.
    if (path === "/api/steps" && method === "GET") return json(res, 200, { steps: listStepLists(dcfg.dataDir) });
    if (path === "/api/steps" && method === "POST") {
      const body = await readJson(req);
      const runId = typeof body["runId"] === "string" ? body["runId"] : "";
      const detail = getQaRun(dcfg, runId);
      if (!detail) throw new HttpError(404, "No such QA run.");
      const steps = stepsFromRun(detail);
      if (!steps.length) throw new HttpError(409, "Only a run that passed can be saved as steps.");
      try {
        const name = typeof body["name"] === "string" && body["name"].trim() ? body["name"] : `Steps from ${runId}`;
        return json(res, 201, { steps: saveStepList(dcfg.dataDir, { name, sourceRunId: runId, steps }) });
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "Could not save the steps.");
      }
    }
    const stepsReplay = /^\/api\/steps\/([^/]+)\/replay$/.exec(path);
    if (stepsReplay && method === "POST") {
      const id = decodeURIComponent(stepsReplay[1] || "");
      const list = isStepListId(id) ? getStepList(dcfg.dataDir, id) : null;
      if (!list) throw new HttpError(404, "No such step list.");
      const body = await readJson(req);
      return json(res, 200, await replayStepList(dcfg, list, { dryRun: body["run"] !== true }));
    }

    // Follow-ups and per-session tasks (stored on this machine; text with a secret is refused).
    if (path === "/api/followups" && method === "GET") {
      const st = new URL(req.url ?? "/", "http://x").searchParams.get("status");
      return json(res, 200, { followups: listFollowups(dcfg.dataDir, st === "open" || st === "done" ? st : undefined) });
    }
    if (path === "/api/followups" && method === "POST") {
      const body = await readJson(req);
      try {
        return json(res, 201, { followup: addFollowup(dcfg.dataDir, { text: body["text"], owner: body["owner"], due: body["due"], link: body["link"] }) });
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "Could not save the follow-up.");
      }
    }
    const followupMatch = /^\/api\/followups\/([^/]+)$/.exec(path);
    if (followupMatch && method === "PATCH") {
      const body = await readJson(req);
      const id = decodeURIComponent(followupMatch[1] || "");
      try {
        const updated = isItemId(id) ? updateFollowup(dcfg.dataDir, id, { status: body["status"], owner: body["owner"], due: body["due"], text: body["text"] }) : null;
        if (!updated) throw new HttpError(404, "Follow-up not found.");
        return json(res, 200, { followup: updated });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, e instanceof Error ? e.message : "Could not update the follow-up.");
      }
    }
    if (path === "/api/tasks" && method === "GET") {
      const sid = new URL(req.url ?? "/", "http://x").searchParams.get("session") ?? "";
      return json(res, 200, { tasks: isItemId(sid) ? listTasks(dcfg.dataDir, sid) : [] });
    }
    if (path === "/api/tasks" && method === "POST") {
      const body = await readJson(req);
      try {
        return json(res, 201, { task: addTask(dcfg.dataDir, body["sessionId"], body["text"]) });
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "Could not save the task.");
      }
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (taskMatch && method === "PATCH") {
      const body = await readJson(req);
      const id = decodeURIComponent(taskMatch[1] || "");
      try {
        const updated = isItemId(id) ? updateTask(dcfg.dataDir, id, body["status"]) : null;
        if (!updated) throw new HttpError(404, "Task not found.");
        return json(res, 200, { task: updated });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, e instanceof Error ? e.message : "Could not update the task.");
      }
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

    if (path === "/api/reo/agents" && method === "GET") {
      return json(res, 200, { agents: getEffectiveAgents(dcfg.dataDir), tools: BUILTIN_TOOLS });
    }

    const agentProfMatch = /^\/api\/reo\/agents\/([a-z]+)$/.exec(path);
    if (agentProfMatch && method === "PUT") {
      const id = agentProfMatch[1] as AgentId;
      if (!PREBUILT_AGENTS.some((a) => a.id === id)) throw new HttpError(404, "Agent not found.");
      const body = await readJson(req);
      const agent = saveAgentProfile(dcfg.dataDir, id, body);
      return json(res, 200, { ok: true, agent });
    }

    if (path === "/api/reo/system" && method === "GET") {
      const { notes, problems } = loadVault(dcfg.vaultDir);
      return json(res, 200, {
        repos: dcfg.repos.map((r) => ({ id: r.id, label: r.module || r.id, path: r.path })),
        vaultNotes: notes.length,
        vaultProblems: problems.length,
        skillsCount: listSkills(dcfg.root).length,
        defectsCount: listProductionDefects(dcfg.dataDir).length,
        guardrails: {
          readOnlyRepos: true,
          maskingGate: "100% synthetic block",
          localOnlyProbes: true,
          erpWritesBlocked: true,
        },
      });
    }

    if (path === "/api/reo/notes" && method === "GET") {
      const { notes } = loadVault(dcfg.vaultDir);
      return json(res, 200, {
        notes: notes.map((n) => ({
          id: n.meta.id,
          title: n.meta.title || n.meta.id,
          type: n.meta.type,
          status: n.meta.status,
          audience: n.meta.audience,
          ref: n.meta.id,
          anchors: n.meta.code_anchors?.length ?? 0,
        })),
      });
    }

    if (path === "/api/reo/route" && method === "POST") {
      const body = await readJson(req);
      const prompt = typeof body["prompt"] === "string" ? body["prompt"] : "";
      return json(res, 200, routeIntentToAgents(prompt));
    }

    if (path === "/api/reo/mission" && method === "POST") {
      const body = await readJson(req);
      const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
      if (!prompt) throw new HttpError(400, "prompt is required.");
      res.writeHead(200, { "Content-Type": NDJSON, "Cache-Control": "no-store" });
      await runAgenticMission(dcfg, prompt, (ev) => {
        if (!res.writableEnded) res.write(JSON.stringify(ev) + "\n");
      });
      return void res.end();
    }

    if (path === "/api/reo/memory" && method === "GET") {
      const qs = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      const layer = qs.get("layer") as MemoryLayer | null;
      const confidence = qs.get("confidence") as MemoryConfidence | null;
      const query = qs.get("q") || undefined;
      return json(res, 200, {
        entries: listMemory(dcfg.dataDir, {
          ...(layer ? { layer } : {}),
          ...(confidence ? { confidence } : {}),
          ...(query ? { query } : {}),
        }),
      });
    }

    if (path === "/api/reo/memory" && method === "POST") {
      const body = await readJson(req);
      const layer = body["layer"];
      const title = typeof body["title"] === "string" ? body["title"].trim() : "";
      const content = typeof body["content"] === "string" ? body["content"].trim() : "";
      if (layer !== "project" && layer !== "execution" && layer !== "procedural") {
        throw new HttpError(400, "layer must be project, execution, or procedural.");
      }
      if (!title || !content) throw new HttpError(400, "title and content are required.");
      const entry = addMemory(dcfg.dataDir, {
        layer,
        confidence: body["confidence"] === "verified" ? "verified" : "hypothesis",
        title,
        content,
        tags: Array.isArray(body["tags"]) ? body["tags"].map(String) : [],
        source: typeof body["source"] === "string" ? body["source"] : "manual",
      });
      return json(res, 201, { ok: true, entry });
    }

    const memVerifyMatch = /^\/api\/reo\/memory\/(mem-[a-z0-9-]+)\/verify$/.exec(path);
    if (memVerifyMatch && method === "PUT") {
      const entry = verifyMemory(dcfg.dataDir, memVerifyMatch[1]!);
      if (!entry) throw new HttpError(404, "Memory entry not found.");
      return json(res, 200, { ok: true, entry });
    }

    const memDelMatch = /^\/api\/reo\/memory\/(mem-[a-z0-9-]+)$/.exec(path);
    if (memDelMatch && method === "DELETE") {
      if (!deleteMemory(dcfg.dataDir, memDelMatch[1]!)) throw new HttpError(404, "Memory entry not found.");
      return json(res, 200, { ok: true });
    }

    if (path === "/api/reo/automation" && method === "GET") {
      return json(res, 200, { rules: listAutomationRules(dcfg.dataDir) });
    }

    if (path === "/api/reo/automation" && method === "POST") {
      const body = await readJson(req);
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
      if (!name || !prompt) throw new HttpError(400, "name and prompt are required.");
      const rule = upsertAutomationRule(dcfg.dataDir, {
        name,
        trigger: (typeof body["trigger"] === "string" ? body["trigger"] : "on_commit") as TriggerKind,
        ...(typeof body["schedule"] === "string" ? { schedule: body["schedule"] } : {}),
        prompt,
        enabled: body["enabled"] !== false,
      });
      return json(res, 201, { ok: true, rule });
    }

    const autoRunMatch = /^\/api\/reo\/automation\/([a-z0-9-]+)\/run$/.exec(path);
    if (autoRunMatch && method === "POST") {
      const rule = listAutomationRules(dcfg.dataDir).find((r) => r.id === autoRunMatch[1]);
      if (!rule) throw new HttpError(404, "Automation rule not found.");
      const result = await runAgenticMission(dcfg, rule.prompt, () => {});
      const updated = upsertAutomationRule(dcfg.dataDir, {
        id: rule.id,
        lastRunAt: new Date().toISOString(),
        lastVerdict: result.verdict,
      });
      return json(res, 200, {
        ok: true,
        rule: updated,
        verdict: result.verdict,
        defectsCount: result.defects.length,
        checkpointId: result.checkpointId,
      });
    }

    const autoMatch = /^\/api\/reo\/automation\/([a-z0-9-]+)$/.exec(path);
    if (autoMatch && method === "PUT") {
      const existing = listAutomationRules(dcfg.dataDir).find((r) => r.id === autoMatch[1]);
      if (!existing) throw new HttpError(404, "Automation rule not found.");
      const body = await readJson(req);
      const rule = upsertAutomationRule(dcfg.dataDir, { id: existing.id, ...body });
      return json(res, 200, { ok: true, rule });
    }
    if (autoMatch && method === "DELETE") {
      if (!deleteAutomationRule(dcfg.dataDir, autoMatch[1]!)) throw new HttpError(404, "Automation rule not found.");
      return json(res, 200, { ok: true });
    }

    if (path === "/api/reo/checkpoints" && method === "GET") {
      return json(res, 200, { checkpoints: listCheckpoints(dcfg.dataDir) });
    }

    if (path === "/api/defects" && method === "GET") {
      return json(res, 200, { defects: listDefects(dcfg.dataDir) });
    }

    // Plain daily digest: new, recurring and acknowledged defects. Sample records are left out.
    if (path === "/api/defects/digest" && method === "GET") {
      const q = new URL(req.url ?? "/", "http://x").searchParams.get("date") ?? "";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : new Date().toISOString().slice(0, 10);
      const recs = listProductionDefects(dcfg.dataDir);
      const text = buildDailyDigest(recs, date);
      const view = parseView(new URL(req.url ?? "/", "http://x").searchParams.get("view"));
      const open = recs.filter((d) => d.status !== "fixed" && d.status !== "resolved" && d.status !== "false_positive");
      const counts = { total: recs.length, open: open.length, acknowledged: open.filter((d) => d.acknowledged === true).length, recurring: recs.filter((d) => (d.recurrenceCount ?? 1) > 1).length };
      return json(res, 200, { date, text, report: renderReport(digestModel(date, text, counts), view) });
    }

    // Read-only: look-alike notes and notes not updated for a while. Nothing is changed.
    if (path === "/api/notes/hygiene" && method === "GET") {
      return json(res, 200, findNoteHygiene(loadVault(dcfg.vaultDir).notes));
    }

    // Owner-triggered only: reads recent local session records and writes proposed notes. No model call.
    if (path === "/api/notes/lessons" && method === "POST") {
      const r = suggestLessonsForRepos(dcfg.vaultDir, dcfg.repos.map((x) => x.path));
      if (r.written.length) await reindex();
      return json(res, 200, { written: r.written.length, skippedDuplicate: r.skippedDuplicate, blocked: r.blocked });
    }

    if (path === "/api/defects" && method === "POST") {
      const body = await readJson(req);
      const title = typeof body["title"] === "string" ? body["title"].trim() : "";
      if (!title) throw new HttpError(400, "Defect title is required.");
      const rec = upsertDefect(dcfg.dataDir, {
        appName: typeof body["appName"] === "string" ? body["appName"] : "SPIL AURA",
        branch: typeof body["branch"] === "string" ? body["branch"] : "development",
        commitSha: typeof body["commitSha"] === "string" ? body["commitSha"] : "",
        testedDate: typeof body["testedDate"] === "string" ? body["testedDate"] : undefined,
        testedBy: typeof body["testedBy"] === "string" ? body["testedBy"] : "QA Engineer",
        assignedTo: typeof body["assignedTo"] === "string" ? body["assignedTo"] : "",
        agentSource: (["qa", "review", "security", "api", "qe"].includes(String(body["agentSource"])) ? body["agentSource"] : "qa") as "qa" | "review" | "security" | "api" | "qe",
        severity: (["critical", "high", "medium", "low"].includes(String(body["severity"])) ? body["severity"] : "medium") as "critical" | "high" | "medium" | "low",
        title,
        expected: typeof body["expected"] === "string" ? body["expected"] : "",
        actual: typeof body["actual"] === "string" ? body["actual"] : "",
        reproSteps: Array.isArray(body["reproSteps"]) ? body["reproSteps"].map(String) : [],
        codeSuggestion: typeof body["codeSuggestion"] === "string" ? body["codeSuggestion"] : "",
        fileRef: typeof body["fileRef"] === "string" ? body["fileRef"] : "",
        evidencePaths: Array.isArray(body["evidencePaths"]) ? body["evidencePaths"].map(String) : [],
        sample: body["sample"] === true,
        fixture: body["fixture"] === true,
      });
      return json(res, 200, { defect: rec });
    }

    if (path === "/api/defects/report" && method === "POST") {
      const body = await readJson(req);
      const ids = Array.isArray(body["ids"]) ? body["ids"].map(String) : null;
      // Sample records never go into an exported report.
      const all = listProductionDefects(dcfg.dataDir);
      const filtered = ids && ids.length ? all.filter((d) => ids.includes(d.id)) : all;
      const html = generateDefectReportHtml(filtered, {
        appName: typeof body["appName"] === "string" ? body["appName"] : undefined,
        branch: typeof body["branch"] === "string" ? body["branch"] : undefined,
        generatedBy: typeof body["generatedBy"] === "string" ? body["generatedBy"] : undefined,
      });
      const outPath = saveDefectReportHtml(dcfg.root, html, typeof body["branch"] === "string" ? body["branch"] : "defects");
      return json(res, 200, { ok: true, path: outPath, html });
    }

    if (path === "/api/defects/notify-teams" && method === "POST") {
      const body = await readJson(req);
      const recipientName = typeof body["recipientName"] === "string" && body["recipientName"].trim() ? body["recipientName"].trim() : "Engineering Team";
      const note = typeof body["note"] === "string" ? body["note"] : "";
      const ids = Array.isArray(body["ids"]) ? body["ids"].map(String) : [];
      // Sample records are never sent to people.
      const all = listProductionDefects(dcfg.dataDir);
      const picked = ids.length ? all.filter((d) => ids.includes(d.id)) : all.slice(0, 10);
      if (ids.length && !picked.length) throw new HttpError(400, "There are no real defects to send. Sample records are not sent.");
      const payload = buildTeamsDefectPayload({ recipientName, note, defects: picked });
      const webhookUrl = typeof body["webhookUrl"] === "string" ? body["webhookUrl"].trim() : "";
      const confirmed = body["confirmed"] === true;
      if (confirmed && webhookUrl.startsWith("https://")) {
        const resp = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!resp.ok) throw new HttpError(502, `Teams webhook returned HTTP ${resp.status}.`);
        const now = new Date().toISOString();
        for (const d of picked) updateDefectStatus(dcfg.dataDir, d.id, { status: "notified", sentTeamsAt: now });
        return json(res, 200, { ok: true, sent: true, count: picked.length, payload });
      }
      return json(res, 200, { ok: true, sent: false, preview: payload });
    }

    const defectMatch = /^\/api\/defects\/([^/]+)$/.exec(path);
    if (defectMatch && method === "PATCH") {
      const body = await readJson(req);
      const id = decodeURIComponent(defectMatch[1] || "");
      if (body["status"] !== undefined && !(DEFECT_STATUSES as readonly unknown[]).includes(body["status"])) throw new HttpError(400, "Unknown defect status.");
      const updated = updateDefectStatus(dcfg.dataDir, id, {
        status: body["status"] as DefectStatus | undefined,
        assignedTo: typeof body["assignedTo"] === "string" ? body["assignedTo"] : undefined,
        acknowledged: typeof body["acknowledged"] === "boolean" ? body["acknowledged"] : undefined,
        resolved: body["resolved"] === true ? true : undefined,
      });
      if (!updated) throw new HttpError(404, "Defect not found.");
      return json(res, 200, { defect: updated });
    }

    if (path === "/api/plugins" && method === "GET") {
      return json(res, 200, { plugins: listPlugins(dcfg.dataDir), team: listTeamMembers(dcfg.dataDir) });
    }

    const pluginMatch = /^\/api\/plugins\/([^/]+)$/.exec(path);
    if (pluginMatch && method === "PUT") {
      const body = await readJson(req);
      const id = decodeURIComponent(pluginMatch[1] || "") as PluginId;
      let endpoint = typeof body["endpoint"] === "string" ? body["endpoint"].trim() : undefined;
      if (id === "n8n" && endpoint) {
        try {
          endpoint = validateN8nEndpoint(endpoint);
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : "Invalid n8n endpoint.");
        }
      }
      const updated = updatePlugin(dcfg.dataDir, id, {
        enabled: typeof body["enabled"] === "boolean" ? body["enabled"] : undefined,
        endpoint,
        scope: body["scope"] === "notify" || body["scope"] === "read_only" ? body["scope"] : undefined,
        hasCredential: typeof body["hasCredential"] === "boolean" ? body["hasCredential"] : undefined,
      });
      if (!updated) throw new HttpError(404, "Plugin not found.");
      return json(res, 200, { plugin: updated });
    }

    if (path === "/api/n8n/status" && method === "GET") {
      return json(res, 200, await getN8nStatus(dcfg.dataDir));
    }

    if (path === "/api/n8n/key" && method === "PUT") {
      const body = await readJson(req);
      const chk = validateApiKey(body["key"]);
      if (!chk.ok) throw new HttpError(400, chk.error);
      const keys = n8nKeyStore(dcfg.dataDir);
      await keys.set(chk.key);
      updatePlugin(dcfg.dataDir, "n8n", { hasCredential: true });
      return json(res, 200, { ok: true, ...(await getN8nStatus(dcfg.dataDir)) });
    }

    if (path === "/api/n8n/key" && method === "DELETE") {
      await n8nKeyStore(dcfg.dataDir).remove();
      updatePlugin(dcfg.dataDir, "n8n", { hasCredential: false });
      return json(res, 200, { ok: true, ...(await getN8nStatus(dcfg.dataDir)) });
    }

    if (path === "/api/n8n/workflows" && method === "GET") {
      try {
        return json(res, 200, { workflows: await n8nListWorkflows(dcfg.dataDir) });
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "Could not list n8n workflows.");
      }
    }

    if (path === "/api/n8n/executions" && method === "GET") {
      try {
        const wfId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("workflowId") || undefined;
        return json(res, 200, { executions: await n8nListExecutions(dcfg.dataDir, wfId) });
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "Could not list n8n executions.");
      }
    }

    if (path === "/api/n8n/trigger" && method === "POST") {
      const body = await readJson(req);
      const pathOrUrl = typeof body["pathOrUrl"] === "string" ? body["pathOrUrl"].trim() : "";
      if (!pathOrUrl) throw new HttpError(400, "pathOrUrl is required.");
      const payload =
        body["payload"] && typeof body["payload"] === "object" && !Array.isArray(body["payload"])
          ? (body["payload"] as Record<string, unknown>)
          : {};
      const reqMethod = body["method"] === "GET" ? "GET" : "POST";
      try {
        return json(res, 200, await n8nTriggerWebhook(dcfg.dataDir, { pathOrUrl, payload, method: reqMethod }));
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "Could not trigger n8n webhook.");
      }
    }

    if (path === "/api/team" && method === "POST") {
      const body = await readJson(req);
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      if (!name) throw new HttpError(400, "Engineer name is required.");
      const member = upsertTeamMember(dcfg.dataDir, {
        id: typeof body["id"] === "string" ? body["id"] : undefined,
        name,
        email: typeof body["email"] === "string" ? body["email"] : "",
        gitAlias: typeof body["gitAlias"] === "string" ? body["gitAlias"] : "",
        role: typeof body["role"] === "string" ? body["role"] : "Engineer",
        teamsWebhookOrId: typeof body["teamsWebhookOrId"] === "string" ? body["teamsWebhookOrId"] : "",
      });
      return json(res, 200, { member });
    }

    const teamMatch = /^\/api\/team\/([^/]+)$/.exec(path);
    if (teamMatch && method === "DELETE") {
      const id = decodeURIComponent(teamMatch[1] || "");
      return json(res, 200, { removed: removeTeamMember(dcfg.dataDir, id) });
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
      res.setHeader("X-Frame-Options", "DENY");
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
        // The desktop shell opens "/landing.html?t=<token>" and a browser window opens "/?t=<token>". Both mean
        // the same thing: pair this browser, then show the app at "/". A wrong or old token is not an error page
        // of its own: it falls through to the normal pairing rules below (friendly page, never raw JSON).
        const isEntry = url.pathname === "/" || url.pathname === "/landing.html";
        if (method === "GET" && isEntry && supplied !== null && safeEqual(supplied, deps.token)) {
          res.writeHead(302, {
            "Set-Cookie": `${COOKIE_NAME}=${deps.token}; HttpOnly; SameSite=Strict; Path=/`,
            Location: "/",
          });
          return void res.end();
        }
        const cookie = cookieValue(req.headers.cookie, COOKIE_NAME);
        const paired = cookie !== null && safeEqual(cookie, deps.token);
        if (!paired && method === "GET" && PUBLIC_FILES.has(url.pathname)) {
          const pub = STATIC_FILES[url.pathname];
          const found = pub && [uiDir, PUBLIC_SOURCE_DIR].map((dir) => join(dir, pub.file)).find((f) => existsSync(f));
          if (pub && found) {
            res.writeHead(200, { "Content-Type": pub.type });
            return void res.end(readFileSync(found));
          }
        }
        if (!paired && method === "GET" && (isEntry || url.pathname === "/pair")) {
          // Pairing without a token link. A browser sends Sec-Fetch-* headers that a web page on another
          // site cannot forge: "none" means the person typed or bookmarked the address, "same-origin" with
          // user activation means they pressed the button on our own page. Anything else gets the plain page.
          const h = (n: string): string | undefined => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v; };
          const typed = isEntry && h("sec-fetch-site") === "none" && h("sec-fetch-mode") === "navigate" && (h("sec-fetch-dest") ?? "document") === "document";
          const pressed = url.pathname === "/pair" && h("sec-fetch-site") === "same-origin" && h("sec-fetch-mode") === "navigate" && h("sec-fetch-user") === "?1";
          if (typed || pressed) {
            res.writeHead(302, { "Set-Cookie": `${COOKIE_NAME}=${deps.token}; HttpOnly; SameSite=Strict; Path=/`, Location: "/" });
            return void res.end();
          }
          res.setHeader("X-Frame-Options", "DENY");
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
          return void res.end(PAIR_PAGE);
        }
        if (!paired) {
          // Page navigations get the friendly page; only API and fetch calls get JSON.
          const dest = req.headers["sec-fetch-dest"];
          const accept = String(req.headers["accept"] ?? "");
          const navigation = !url.pathname.startsWith("/api/") && method === "GET" && (dest === "document" || dest === "iframe" || (dest === undefined && accept.includes("text/html")));
          if (navigation) {
            res.setHeader("X-Frame-Options", "DENY");
            res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
            return void res.end(PAIR_PAGE);
          }
          return fail(401, "Open Guard from its own window.");
        }
        if (url.pathname === "/landing.html") {
          res.writeHead(302, { Location: "/" });
          return void res.end();
        }
        if (url.pathname === "/pair") {
          res.writeHead(302, { Location: "/" });
          return void res.end();
        }

        if (url.pathname.startsWith("/api/")) return await api(req, res, url.pathname, method);

        if (url.pathname === "/" && (method === "GET" || method === "HEAD") && !existsSync(join(uiDir, "index.html"))) {
          res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Retry-After": "3" });
          return void res.end(method === "HEAD" ? undefined : BUILDING_PAGE);
        }
        const entry = STATIC_FILES[url.pathname];
        if (entry && (method === "GET" || method === "HEAD")) {
          // The pair and building pages' assets also come from the source folder when there is no build.
          const dirs = PUBLIC_FILES.has(url.pathname) ? [uiDir, PUBLIC_SOURCE_DIR] : [uiDir];
          const file = dirs.map((dir) => join(dir, entry.file)).find((f) => existsSync(f));
          if (!file) return fail(404, "Not found.");
          res.writeHead(200, { "Content-Type": entry.type });
          return void res.end(method === "HEAD" ? undefined : readFileSync(file));
        }
        const assetMatch = /^\/assets\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
        if (assetMatch && (method === "GET" || method === "HEAD")) {
          const name = assetMatch[1] ?? "";
          const file = join(uiDir, "assets", name);
          if (!existsSync(file)) return fail(404, "Not found.");
          const lower = name.toLowerCase();
          const type = lower.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : lower.endsWith(".css")
              ? "text/css; charset=utf-8"
              : lower.endsWith(".svg")
                ? "image/svg+xml"
                : lower.endsWith(".png")
                  ? "image/png"
                  : lower.endsWith(".woff2")
                    ? "font/woff2"
                    : "application/octet-stream";
          res.writeHead(200, { "Content-Type": type });
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
