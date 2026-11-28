import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { envValue } from "../config.ts";
import { buildPayload, DEFAULT_MODEL, postMessages } from "./client.ts";
import type { CompleteResult, Usage } from "./client.ts";
import { MODEL_ID_RE } from "./models.ts";
import { windowsFromClaudeStream, windowsFromHeaders } from "../usage/limits.ts";
import type { StoredWindow } from "../usage/limits.ts";
import { CancelledError } from "./stream.ts";

/**
 * A model backend. It only ever receives text that has ALREADY been masked and
 * audited by select.ts (one shared pipeline for every backend, API or CLI):
 * a CLI sends text to the provider just like the API does, so masking and the
 * audit line are not optional per backend.
 */
export interface BackendRequest {
  role: string;
  system: string[]; // masked, stable blocks first
  user: string; // masked
  maxTokens: number;
  /** Call once, with the exact text about to leave the machine, just before sending. */
  audit: (outgoing: string, model: string) => void;
  /** Rate-limit facts the provider returned with this call. */
  limits?: (windows: StoredWindow[]) => void;
  /** Aborts the call in flight. */
  signal?: AbortSignal;
  /**
   * Streaming sink, MASKED text pieces as they arrive. Only backends with `streams: true` call it; the
   * caller (select.ts) unmasks safely across chunk boundaries. The full masked text is still returned.
   */
  onText?: (maskedDelta: string) => void;
}

export interface BackendStatus { ok: boolean; detail: string }

export interface Backend {
  id: string;
  kind: "api" | "cli";
  /** True when `complete` honours `onText` (token streaming). Others return whole replies. */
  streams?: boolean;
  available(): Promise<BackendStatus>;
  /** Returns the model's raw (still masked) text. The caller unmasks. */
  complete(req: BackendRequest): Promise<CompleteResult>;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

// ---- constants (named, with the reason) ----

/** `claude --version` must answer this fast; availability checks must never hang `brain status`. */
export const VERSION_TIMEOUT_MS = 5_000;
/** One CLI completion. Aura allows 120 s for text-only CLIs; a diary prompt is bigger, so 180 s. */
export const CLI_TIMEOUT_MS = 180_000;
/** Most output we keep from a CLI. A runaway process is killed past this, not buffered forever. */
export const CLI_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Default Claude model for the CLI: an alias the CLI resolves itself (Aura's DEFAULT_CLAUDE_MODEL). */
export const DEFAULT_CLAUDE_CLI_MODEL = "sonnet";
/** Default model for Antigravity CLI subscription. */
export const DEFAULT_ANTIGRAVITY_CLI_MODEL = "gemini-4-neon-medium";
/** Longest model name accepted, so a pasted paragraph cannot become an argument. */
const MODEL_MAX_CHARS = 100;

/** Shown when Claude Code cannot be found. Same advice as Aura. */
export const CLAUDE_INSTALL_HELP =
  "Install Claude Code (https://claude.ai/install), then run `claude` once in a terminal to sign in.";
export const AGY_INSTALL_HELP =
  "Install Antigravity CLI (`agy`), then sign in to use your Antigravity subscription.";
const CLAUDE_SIGN_IN_HELP =
  "Claude Code is not signed in. Run `claude` once in a terminal to log in, then try again. Guard stores no key for it.";

/**
 * The CLI is a pure text model. Verified against Claude Code 2.1.327 (`claude --help`, and the
 * stream-json `init` event reported tools: [] and mcp_servers: []):
 *  --tools ""              no built-in tools (no Bash, Edit, Read, WebFetch, ...)
 *  --disallowedTools ...   belt and braces: deny the powerful tools by name even if the line above regressed
 *  --permission-mode dontAsk  never prompt; anything not allowed is denied (a headless run cannot ask)
 *  --strict-mcp-config     only MCP servers from --mcp-config; none is given, so none run
 *  --disable-slash-commands no skills or commands
 *  --setting-sources ""    ignore user/project/local settings (no hooks, no extra MCP, no allow-lists)
 *  --no-session-persistence no session file written to disk
 *  --system-prompt         replaces Claude Code's own prompt (its tools, its folder); the real
 *                          instructions go on stdin so they are not limited by the command line length.
 * And as a runtime guard parseClaudeStream refuses the run if init reports any tool or MCP server.
 */
const CLAUDE_SYSTEM = "You are a text-only language model inside SPIL REO. You have no tools and no files. Follow the instructions in the user's text and reply with only what they ask for.";
const DENIED_TOOLS = "Bash PowerShell Edit Write NotebookEdit WebFetch WebSearch Task Agent";

export function claudeArgs(model: string, partial = false): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose", // stream-json needs it with -p
    ...(partial ? ["--include-partial-messages"] : []), // token-level text_delta events; the final lines are the same
    "--model", model,
    "--permission-mode", "dontAsk",
    "--tools", "",
    "--disallowedTools", DENIED_TOOLS,
    "--system-prompt", CLAUDE_SYSTEM,
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources", "",
    "--no-session-persistence",
  ];
}

/** `claude/` prefix dropped; only plain model-id characters, never something that looks like a flag. */
export function cleanClaudeModel(raw: string | undefined): string {
  const m = (raw ?? "").trim().replace(/^claude\//, "").trim();
  const ok = m.length > 0 && m.length <= MODEL_MAX_CHARS && !m.startsWith("-") && /^[A-Za-z0-9._:\-[\]]+$/.test(m);
  return ok ? m : DEFAULT_CLAUDE_CLI_MODEL;
}

// ---- discovery (mirrors Aura's find_program + usual_location) ----

export interface Launcher { command: string; prefixArgs: string[] }

export interface DiscoveryOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  /** Explicit program, for tests or a saved path. Not validated beyond existence. */
  override?: string;
}

/**
 * First match on PATH, then Claude's usual install folders. On Windows only `.exe` is started:
 * Node cannot run a `.cmd` npm shim without a shell, and we never build a shell string (paths
 * have spaces). Aura also accepts `.cmd`; that is the one difference.
 */
export function findClaude(o: DiscoveryOptions = {}): Launcher | null {
  if (o.override) return existsSync(o.override) ? { command: o.override, prefixArgs: [] } : null;
  const env = o.env ?? process.env;
  const win = process.platform === "win32";
  const names = win ? ["claude.exe"] : ["claude"];
  const pathVar = env.PATH ?? env.Path ?? "";
  const dirs = pathVar.split(delimiter).filter((d) => d.length > 0);
  // Usual folder of the native installer (~/.local/bin). Aura also checks %APPDATA%\npm\claude.cmd; skipped (see above).
  dirs.push(join(o.home ?? env.USERPROFILE ?? env.HOME ?? homedir(), ".local", "bin"));
  for (const d of dirs) for (const n of names) {
    const p = join(d, n);
    if (existsSync(p)) return { command: p, prefixArgs: [] };
  }
  return null;
}

export function findAgy(o: DiscoveryOptions = {}): Launcher | null {
  if (o.override) return existsSync(o.override) ? { command: o.override, prefixArgs: [] } : null;
  const env = o.env ?? process.env;
  const win = process.platform === "win32";
  const names = win ? ["agy.exe"] : ["agy"];
  const pathVar = env.PATH ?? env.Path ?? "";
  const dirs = pathVar.split(delimiter).filter((d) => d.length > 0);
  const localApp = env.LOCALAPPDATA ?? join(o.home ?? env.USERPROFILE ?? env.HOME ?? homedir(), "AppData", "Local");
  dirs.push(join(localApp, "agy", "bin"));
  for (const d of dirs) for (const n of names) {
    const p = join(d, n);
    if (existsSync(p)) return { command: p, prefixArgs: [] };
  }
  return null;
}

// ---- running a CLI ----

export interface RunOptions {
  launcher: Launcher;
  args: string[];
  stdin: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
  /** Called with the (empty) working folder, for tests. */
  onCwd?: (cwd: string) => void;
  /** Kills the program and rejects with CancelledError. */
  signal?: AbortSignal;
  /** Sees each stdout piece as it arrives (the full text is still collected). */
  onStdout?: (chunk: string) => void;
}

export interface RunResult { code: number | null; stdout: string; stderr: string }

/**
 * Starts the program with an argument array (no shell), an EMPTY temp folder as cwd (so it cannot
 * read the repo or project instruction files), the prompt on stdin, a timeout that kills it, and an
 * output cap.
 */
export function runProgram(o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), "guard-cli-"));
    o.onCwd?.(cwd);
    const done = (fn: () => void) => {
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
      fn();
    };
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.env)) if (v !== undefined) clean[k] = v;
    let child;
    try {
      child = spawn(o.launcher.command, [...o.launcher.prefixArgs, ...o.args], {
        cwd, env: clean, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      done(() => reject(new CliError(`Could not start the program: ${(e as Error).message}`)));
      return;
    }
    let stdout = "";
    let stderr = "";
    let size = 0;
    let settled = false;
    const onAbort = (): void => {
      child.kill();
      finish(() => reject(new CancelledError()));
    };
    if (o.signal?.aborted) queueMicrotask(onAbort);
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      done(fn);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new CliError(`The program timed out after ${Math.round(o.timeoutMs / 1000)}s and was stopped.`)));
    }, o.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      size += Buffer.byteLength(d);
      if (size > CLI_MAX_OUTPUT_BYTES) {
        child.kill();
        finish(() => reject(new CliError("The program produced too much output and was stopped.")));
        return;
      }
      stdout += d;
      try { o.onStdout?.(d); } catch { /* a broken listener must not break the run */ }
    });
    child.stderr.on("data", (d: string) => { if (stderr.length < 20_000) stderr += d; });
    child.on("error", (e) => finish(() => reject(new CliError(`Could not start the program: ${e.message}`))));
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
    // A program that exits before reading closes the pipe; its own output says why.
    child.stdin.on("error", () => {});
    child.stdin.end(o.stdin);
  });
}

// ---- Claude stream parsing ----

function looksLikeSignInProblem(text: string): boolean {
  const t = text.toLowerCase();
  return ["not logged in", "/login", "invalid api key", "authentication_error", "please run claude", "failed to authenticate", "oauth token"]
    .some((p) => t.includes(p));
}

function claudeFailure(detail: string): CliError {
  return new CliError(looksLikeSignInProblem(detail) ? CLAUDE_SIGN_IN_HELP : `Claude Code failed: ${detail.slice(0, 300)}`);
}

/** Reads `--output-format stream-json` lines. Throws CliError for any failure or any tool/MCP presence. */
export function parseClaudeStream(stdout: string): CompleteResult {
  let text = "";
  let result: string | undefined;
  let error: string | undefined;
  let usage: Usage = { input_tokens: 0, output_tokens: 0, reported: false };
  let model: string | undefined;
  for (const line of stdout.split("\n")) {
    let v: any;
    try { v = JSON.parse(line.trim()); } catch { continue; }
    if (v?.type === "system" && v.subtype === "init") {
      const tools = Array.isArray(v.tools) ? v.tools.length : 0;
      const mcp = Array.isArray(v.mcp_servers) ? v.mcp_servers.length : 0;
      if (tools > 0 || mcp > 0) {
        throw new CliError(`Refused: Claude Code started with ${tools} tool(s) and ${mcp} MCP server(s). Guard only uses it as a text model.`);
      }
    } else if (v?.type === "assistant" && Array.isArray(v.message?.content)) {
      if (typeof v.message.model === "string" && MODEL_ID_RE.test(v.message.model)) model = v.message.model;
      const piece = v.message.content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
      if (piece.trim()) text += (text ? "\n\n" : "") + piece;
    } else if (v?.type === "result") {
      const body = String(v.result ?? "").trim();
      const failed = v.is_error === true || String(v.subtype ?? "").startsWith("error");
      if (failed) error = body || String(v.subtype ?? "error");
      else {
        result = body;
        const u = v.usage ?? {};
        if (v.usage) usage = {
          input_tokens: Number(u.input_tokens ?? 0),
          output_tokens: Number(u.output_tokens ?? 0),
          ...(u.cache_creation_input_tokens != null ? { cache_creation_input_tokens: Number(u.cache_creation_input_tokens) } : {}),
          ...(u.cache_read_input_tokens != null ? { cache_read_input_tokens: Number(u.cache_read_input_tokens) } : {}),
        };
      }
    }
  }
  if (error !== undefined) throw claudeFailure(error);
  const reply = (result && result.length > 0 ? result : text).trim();
  if (!reply) throw new CliError("Claude Code returned an empty response.");
  return { text: reply, usage, ...(model ? { model } : {}) };
}

/**
 * Reads the live stdout of `claude -p --output-format stream-json --include-partial-messages` and hands
 * each text_delta to `onText`. Text is released only after the init line proved the CLI has no tools and
 * no MCP servers (the same refusal parseClaudeStream applies at the end). Not-JSON lines are ignored.
 */
export class ClaudeDeltaReader {
  private buf = "";
  private ok = false;
  private readonly onText: (t: string) => void;
  constructor(onText: (t: string) => void) { this.onText = onText; }
  push(chunk: string): void {
    this.buf += chunk;
    let at: number;
    while ((at = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, at).trim();
      this.buf = this.buf.slice(at + 1);
      let v: any;
      try { v = JSON.parse(line); } catch { continue; }
      if (v?.type === "system" && v.subtype === "init") {
        this.ok = !(Array.isArray(v.tools) && v.tools.length > 0) && !(Array.isArray(v.mcp_servers) && v.mcp_servers.length > 0);
      } else if (this.ok && v?.type === "stream_event" && v.event?.type === "content_block_delta" && v.event.delta?.type === "text_delta" && typeof v.event.delta.text === "string") {
        this.onText(v.event.delta.text);
      }
    }
  }
}

// ---- backends ----

export interface BackendOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  model?: string;
  /** Replaces discovery (tests). */
  launcher?: Launcher | null;
  /** The same for OpenCode, which `launcher` does not cover (tests). */
  opencodeLauncher?: Launcher | null;
  home?: string;
  /** A key kept in the secure store (keystore.ts). Used only when ANTHROPIC_API_KEY is not set. */
  storedKey?: { exists(): Promise<boolean>; get(): Promise<string | null> };
  cliTimeoutMs?: number;
  onCwd?: (cwd: string) => void;
}

export function anthropicApiBackend(o: BackendOptions = {}): Backend {
  const env = o.env ?? process.env;
  const model = (): string => envValue("MODEL", env) || o.model || DEFAULT_MODEL;
  return {
    id: "anthropic-api",
    kind: "api",
    streams: true,
    async available() {
      if (env.ANTHROPIC_API_KEY) return { ok: true, detail: `ANTHROPIC_API_KEY is set (model ${model()})` };
      if (o.storedKey && (await o.storedKey.exists().catch(() => false))) {
        return { ok: true, detail: `a key saved in Guard is set (model ${model()})` };
      }
      return { ok: false, detail: "ANTHROPIC_API_KEY is not set and no key is saved in Guard" };
    },
    async complete(req) {
      // The stored key is read for this one call and not kept.
      const key = env.ANTHROPIC_API_KEY || (o.storedKey ? await o.storedKey.get() : null);
      if (!key) throw new CliError("No API key is set. Set ANTHROPIC_API_KEY, or save a key in Guard.");
      const payload = buildPayload(model(), req.maxTokens, req.system, req.user, !!req.onText);
      req.audit(payload, model());
      return postMessages({
        key, payload, fetch: o.fetch ?? fetch,
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.onText ? { onText: req.onText } : {}),
        sleep: o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
        onHeaders: (h) => req.limits?.(windowsFromHeaders(h)),
      });
    },
  };
}

export function claudeCliBackend(o: BackendOptions = {}): Backend {
  const env = o.env ?? process.env;
  const model = cleanClaudeModel(o.model);
  const find = (): Launcher | null =>
    o.launcher !== undefined ? o.launcher : findClaude({ env, ...(o.home ? { home: o.home } : {}) });
  // The plan login is the CLI's own. A key in the environment would silently switch it to API billing.
  const childEnv = (maxTokens?: number): Record<string, string | undefined> => {
    const e = { ...env };
    delete e.ANTHROPIC_API_KEY;
    delete e.ANTHROPIC_AUTH_TOKEN;
    if (maxTokens) e.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
    return e;
  };
  return {
    id: "claude-cli",
    kind: "cli",
    streams: true,
    async available() {
      const l = find();
      if (!l) return { ok: false, detail: `Claude Code not found. ${CLAUDE_INSTALL_HELP}` };
      try {
        const r = await runProgram({ launcher: l, args: ["--version"], stdin: "", timeoutMs: VERSION_TIMEOUT_MS, env: childEnv() });
        const v = r.stdout.trim().split("\n")[0] ?? "";
        if (r.code !== 0) return { ok: false, detail: `found at ${basename(l.command)} but --version failed` };
        // Login is the CLI's own business and is not read here; `brain test` proves it.
        return { ok: true, detail: `${v || "Claude Code"} (model ${model}; login not checked, run brain test)` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
    async complete(req) {
      const l = find();
      if (!l) throw new CliError(`Claude Code was not found. ${CLAUDE_INSTALL_HELP}`);
      // Everything goes on stdin: a Windows command line holds about 32,000 characters.
      const prompt = `=== INSTRUCTIONS ===\n${req.system.join("\n\n")}\n\n=== INPUT ===\n${req.user}\n`;
      const args = claudeArgs(model, !!req.onText);
      req.audit(args.join(" ") + "\n" + prompt, `claude-cli/${model}`);
      const reader = req.onText ? new ClaudeDeltaReader(req.onText) : null;
      const r = await runProgram({
        launcher: l, args, stdin: prompt,
        timeoutMs: o.cliTimeoutMs ?? CLI_TIMEOUT_MS, env: childEnv(req.maxTokens),
        ...(req.signal ? { signal: req.signal } : {}),
        ...(reader ? { onStdout: (c: string) => reader.push(c) } : {}),
        ...(o.onCwd ? { onCwd: o.onCwd } : {}),
      });
      req.limits?.(windowsFromClaudeStream(r.stdout));
      if (r.code !== 0) {
        // A non-zero exit may still carry a result line that explains it.
        try { parseClaudeStream(r.stdout); } catch (e) { if (e instanceof CliError) throw e; }
        throw claudeFailure(r.stderr.trim() || `exit status ${r.code}`);
      }
      return parseClaudeStream(r.stdout);
    },
  };
}

/**
 * Not ported, on purpose. Aura's Codex route runs `codex exec --sandbox read-only`, which still
 * reads any file and runs commands (Aura itself marks Codex "not chat capable"); Aura's Google
 * route is Antigravity (`agy -p --mode plan --sandbox`), also not a no-tools mode, and Aura has no
 * Gemini CLI at all. Guard refuses a CLI it cannot lock down to plain text.
 */
export function agyArgs(model: string, prompt: string): string[] {
  return [
    "--output-format", "text",
    "--disable-slash-commands",
    "--model", model,
    "-p", prompt.slice(0, 24_000),
  ];
}

const AGY_MODELS_CACHE_MS = 60_000;
let agyModelsCache: { cmd: string; at: number; models: { id: string; label: string }[] } | null = null;

/** Parses `agy models` tab-separated output (`id\tLabel`), dropping banners and invalid IDs. */
export function parseAgyModelsOutput(stdout: string): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const tab = raw.indexOf("\t");
    if (tab <= 0) continue;
    const id = raw.slice(0, tab).trim();
    const label = raw.slice(tab + 1).trim().slice(0, 80);
    if (!id || !label || !MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label });
  }
  return out;
}

/** Queries `agy models` once per minute when Antigravity CLI is installed. Never throws. */
export async function discoverAgyModels(
  o: { env?: Record<string, string | undefined>; home?: string; launcher?: Launcher | null } = {},
): Promise<{ id: string; label: string }[]> {
  if (o.launcher !== undefined) return [];
  const env = o.env ?? process.env;
  const l = findAgy({ env, ...(o.home ? { home: o.home } : {}) });
  if (!l) return [];
  if (agyModelsCache && agyModelsCache.cmd === l.command && Date.now() - agyModelsCache.at < AGY_MODELS_CACHE_MS) {
    return agyModelsCache.models;
  }
  try {
    const r = await runProgram({ launcher: l, args: ["models"], stdin: "", timeoutMs: VERSION_TIMEOUT_MS, env });
    if (r.code !== 0) return [];
    const models = parseAgyModelsOutput(r.stdout);
    agyModelsCache = { cmd: l.command, at: Date.now(), models };
    return models;
  } catch {
    return [];
  }
}

export function antigravityCliBackend(o: BackendOptions = {}): Backend {
  const env = o.env ?? process.env;
  const model = (o.model ?? "").trim() || DEFAULT_ANTIGRAVITY_CLI_MODEL;
  const find = (): Launcher | null =>
    o.launcher !== undefined ? o.launcher : findAgy({ env, ...(o.home ? { home: o.home } : {}) });
  return {
    id: "antigravity-cli",
    kind: "cli",
    async available() {
      const l = find();
      if (!l) return { ok: false, detail: `Antigravity CLI not found. ${AGY_INSTALL_HELP}` };
      try {
        const r = await runProgram({ launcher: l, args: ["--version"], stdin: "", timeoutMs: VERSION_TIMEOUT_MS, env });
        const v = r.stdout.trim().split("\n")[0] ?? "";
        if (r.code !== 0) return { ok: false, detail: `found at ${basename(l.command)} but --version failed` };
        return { ok: true, detail: `${v || "Antigravity CLI"} (model ${model}; login not checked, run brain test)` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
    async complete(req) {
      const l = find();
      if (!l) throw new CliError(`Antigravity CLI was not found. ${AGY_INSTALL_HELP}`);
      const prompt = `=== INSTRUCTIONS ===\n${req.system.join("\n\n")}\n\n=== INPUT ===\n${req.user}\n`;
      const args = agyArgs(model, prompt);
      req.audit(args.join(" "), `antigravity-cli/${model}`);
      const r = await runProgram({
        launcher: l, args, stdin: "",
        timeoutMs: o.cliTimeoutMs ?? CLI_TIMEOUT_MS, env,
        ...(o.onCwd ? { onCwd: o.onCwd } : {}),
      });
      if (r.code !== 0) {
        throw new CliError(`Antigravity CLI failed: ${(r.stderr || r.stdout || `exit status ${r.code}`).trim().slice(0, 300)}`);
      }
      const reply = r.stdout.trim();
      if (!reply) throw new CliError("Antigravity CLI returned an empty response.");
      // Text output carries no token counts.
      return { text: reply, usage: { input_tokens: 0, output_tokens: 0, reported: false } };
    },
  };
}

export const UNSUPPORTED_CLIS = ["codex", "gemini", "cursor"] as const;
