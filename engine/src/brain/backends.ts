import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { buildPayload, DEFAULT_MODEL, postMessages } from "./client.ts";
import type { CompleteResult, Usage } from "./client.ts";

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
}

export interface BackendStatus { ok: boolean; detail: string }

export interface Backend {
  id: string;
  kind: "api" | "cli";
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
/** Longest model name accepted, so a pasted paragraph cannot become an argument. */
const MODEL_MAX_CHARS = 100;

/** Shown when Claude Code cannot be found. Same advice as Aura. */
export const CLAUDE_INSTALL_HELP =
  "Install Claude Code (https://claude.ai/install), then run `claude` once in a terminal to sign in.";
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
const CLAUDE_SYSTEM = "You are a text-only language model inside AURA Guard. You have no tools and no files. Follow the instructions in the user's text and reply with only what they ask for.";
const DENIED_TOOLS = "Bash PowerShell Edit Write NotebookEdit WebFetch WebSearch Task Agent";

export function claudeArgs(model: string): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose", // stream-json needs it with -p
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

// ---- running a CLI ----

export interface RunOptions {
  launcher: Launcher;
  args: string[];
  stdin: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
  /** Called with the (empty) working folder, for tests. */
  onCwd?: (cwd: string) => void;
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
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
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
      const piece = v.message.content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
      if (piece.trim()) text += (text ? "\n\n" : "") + piece;
    } else if (v?.type === "result") {
      const body = String(v.result ?? "").trim();
      const failed = v.is_error === true || String(v.subtype ?? "").startsWith("error");
      if (failed) error = body || String(v.subtype ?? "error");
      else {
        result = body;
        const u = v.usage ?? {};
        usage = {
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
  return { text: reply, usage };
}

// ---- backends ----

export interface BackendOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  model?: string;
  /** Replaces discovery (tests). */
  launcher?: Launcher | null;
  home?: string;
  cliTimeoutMs?: number;
  onCwd?: (cwd: string) => void;
}

export function anthropicApiBackend(o: BackendOptions = {}): Backend {
  const env = o.env ?? process.env;
  const model = (): string => env.AURA_GUARD_MODEL || o.model || DEFAULT_MODEL;
  return {
    id: "anthropic-api",
    kind: "api",
    async available() {
      return env.ANTHROPIC_API_KEY
        ? { ok: true, detail: `ANTHROPIC_API_KEY is set (model ${model()})` }
        : { ok: false, detail: "ANTHROPIC_API_KEY is not set" };
    },
    async complete(req) {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) throw new CliError("ANTHROPIC_API_KEY is not set. Set it in the environment to use the paid model.");
      const payload = buildPayload(model(), req.maxTokens, req.system, req.user);
      req.audit(payload, model());
      return postMessages({
        key, payload, fetch: o.fetch ?? fetch,
        sleep: o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
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
      req.audit(claudeArgs(model).join(" ") + "\n" + prompt, `claude-cli/${model}`);
      const r = await runProgram({
        launcher: l, args: claudeArgs(model), stdin: prompt,
        timeoutMs: o.cliTimeoutMs ?? CLI_TIMEOUT_MS, env: childEnv(req.maxTokens),
        ...(o.onCwd ? { onCwd: o.onCwd } : {}),
      });
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
export const UNSUPPORTED_CLIS = ["codex", "gemini", "antigravity", "cursor"] as const;
