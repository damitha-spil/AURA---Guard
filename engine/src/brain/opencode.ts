import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { CLI_TIMEOUT_MS, CliError, runProgram, VERSION_TIMEOUT_MS } from "./backends.ts";
import type { Backend, BackendOptions, DiscoveryOptions, Launcher } from "./backends.ts";
import type { CompleteResult } from "./client.ts";
import { MODEL_ID_RE } from "./models.ts";

/**
 * OpenCode (`opencode`) reaches whatever the person signed in to with `opencode auth login`:
 * a ChatGPT, Z.AI Coding or OpenCode Go plan, among others. Guard uses it only as a text model:
 *  - an agent defined here with every tool off and every permission denied
 *  - an empty XDG_CONFIG_HOME, so the person's MCP servers, plugins and instructions are not loaded
 *    (sign-ins live in the data folder and still work)
 *  - no project or Claude Code files, no sharing, --pure (no external plugins)
 * Before each run `opencode debug agent` must report no enabled tool, and a reply that used a tool
 * is thrown away. The tool and config lockdown was checked against OpenCode 1.17.14.
 * Unlike the Claude CLI, OpenCode keeps a local session record (of the already masked text).
 */
export const OPENCODE_AGENT = "guard-text";
export const OPENCODE_INSTALL_HELP =
  "Install OpenCode (https://opencode.ai), then run `opencode auth login` once in a terminal to sign in.";
/** OpenCode takes a few seconds to start, longer than the other CLIs. */
const OPENCODE_QUERY_TIMEOUT_MS = 30_000;

const CONFIG = JSON.stringify({
  share: "disabled",
  autoupdate: false,
  agent: {
    [OPENCODE_AGENT]: {
      mode: "primary",
      description: "Text only",
      prompt: "You are a text-only language model inside SPIL AURA QA Bot. You have no tools and no files. Follow the instructions in the user's text and reply with only what they ask for.",
      tools: { "*": false },
      permission: { "*": "deny" },
    },
  },
});

export function findOpencode(o: DiscoveryOptions = {}): Launcher | null {
  if (o.override) return existsSync(o.override) ? { command: o.override, prefixArgs: [] } : null;
  const env = o.env ?? process.env;
  const name = process.platform === "win32" ? "opencode.exe" : "opencode";
  const home = o.home ?? env.USERPROFILE ?? env.HOME ?? homedir();
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((d) => d.length > 0);
  dirs.push(join(home, ".opencode", "bin"), join(home, ".bun", "bin"));
  for (const d of dirs) {
    const p = join(d, name);
    if (existsSync(p)) return { command: p, prefixArgs: [] };
  }
  return null;
}

export function opencodeArgs(model: string): string[] {
  return ["run", "--pure", "--format", "json", "--agent", OPENCODE_AGENT, "-m", model];
}

/** Runs OpenCode with the locked-down environment and an empty config folder. */
async function runLocked(
  l: Launcher, args: string[], stdin: string, timeoutMs: number,
  env: Record<string, string | undefined>, onCwd?: (cwd: string) => void,
) {
  const configHome = mkdtempSync(join(tmpdir(), "guard-opencode-"));
  try {
    const clean = { ...env };
    delete clean.OPENCODE_CONFIG;
    delete clean.OPENCODE_CONFIG_DIR;
    delete clean.OPENCODE_PERMISSION;
    return await runProgram({
      launcher: l, args, stdin, timeoutMs,
      env: {
        ...clean,
        XDG_CONFIG_HOME: configHome,
        OPENCODE_CONFIG_CONTENT: CONFIG,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
      },
      ...(onCwd ? { onCwd } : {}),
    });
  } finally {
    try { rmSync(configHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Throws unless the agent description shows a tool list with nothing switched on. */
export function assertNoTools(stdout: string): void {
  let tools: unknown;
  try { tools = JSON.parse(stdout.slice(stdout.indexOf("{"))).tools; } catch { /* handled below */ }
  if (!tools || typeof tools !== "object") {
    throw new CliError("Refused: OpenCode did not report which tools are on, so Guard will not use it.");
  }
  const on = Object.entries(tools).filter(([, v]) => v !== false).map(([k]) => k);
  if (on.length > 0) throw new CliError(`Refused: OpenCode would start with tools on (${on.join(", ").slice(0, 200)}).`);
}

/** Reads `--format json` event lines. */
export function parseOpencodeStream(stdout: string): CompleteResult {
  let text = "";
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reported = false;
  for (const line of stdout.split("\n")) {
    let v: any;
    try { v = JSON.parse(line.trim()); } catch { continue; }
    if (v?.type === "tool_use" || v?.part?.type === "tool") {
      throw new CliError("Refused: OpenCode used a tool. Guard only uses it as a text model.");
    }
    if (v?.type === "error") {
      const msg = String(v.error?.data?.message ?? v.error?.name ?? "error").slice(0, 300);
      throw new CliError(`OpenCode failed: ${msg} (If the sign-in has expired, run \`opencode auth login\`.)`);
    }
    if (v?.type === "text") text += String(v.part?.text ?? "");
    if (v?.type === "step_finish") {
      input += Number(v.part?.tokens?.input ?? 0);
      // Reasoning tokens are billed as output and OpenCode counts them apart.
      output += Number(v.part?.tokens?.output ?? 0) + Number(v.part?.tokens?.reasoning ?? 0);
      cacheRead += Number(v.part?.tokens?.cache?.read ?? 0);
      cacheWrite += Number(v.part?.tokens?.cache?.write ?? 0);
      if (v.part?.tokens) reported = true;
    }
  }
  if (!text.trim()) throw new CliError("OpenCode returned an empty response.");
  return {
    text: text.trim(),
    usage: {
      input_tokens: input, output_tokens: output,
      ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}), ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
      ...(reported ? {} : { reported: false }),
    },
  };
}

let listCache: { cmd: string; at: number; ids: string[] } | null = null;

/** `opencode models`: one provider/model per line, for the signed-in providers. Never throws. */
export async function discoverOpencodeModels(
  o: { env?: Record<string, string | undefined>; home?: string; launcher?: Launcher | null } = {},
): Promise<string[]> {
  if (o.launcher !== undefined) return [];
  const env = o.env ?? process.env;
  const l = findOpencode({ env, ...(o.home ? { home: o.home } : {}) });
  if (!l) return [];
  if (listCache && listCache.cmd === l.command && Date.now() - listCache.at < 60_000) return listCache.ids;
  try {
    const r = await runLocked(l, ["models", "--pure"], "", OPENCODE_QUERY_TIMEOUT_MS, env);
    if (r.code !== 0) return [];
    const ids = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.includes("/") && MODEL_ID_RE.test(s));
    listCache = { cmd: l.command, at: Date.now(), ids };
    return ids;
  } catch {
    return [];
  }
}

export function opencodeCliBackend(o: BackendOptions = {}): Backend {
  const env = o.env ?? process.env;
  const model = (o.model ?? "").trim();
  // The shared `launcher` test override stands in for another CLI, so OpenCode has its own.
  const find = (): Launcher | null =>
    o.opencodeLauncher !== undefined ? o.opencodeLauncher
      : o.launcher !== undefined ? null
        : findOpencode({ env, ...(o.home ? { home: o.home } : {}) });
  return {
    id: "opencode-cli",
    kind: "cli",
    async available() {
      const l = find();
      if (!l) return { ok: false, detail: `OpenCode not found. ${OPENCODE_INSTALL_HELP}` };
      try {
        const r = await runLocked(l, ["--version"], "", VERSION_TIMEOUT_MS * 2, env);
        if (r.code !== 0) return { ok: false, detail: "OpenCode was found but --version failed" };
        const v = r.stdout.trim().split("\n")[0] ?? "";
        if (!model) return { ok: false, detail: `OpenCode ${v} found. Pick a model to use it` };
        return { ok: true, detail: `OpenCode ${v} (model ${model}; login not checked, run brain test)` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
    async complete(req) {
      const l = find();
      if (!l) throw new CliError(`OpenCode was not found. ${OPENCODE_INSTALL_HELP}`);
      if (!model) throw new CliError("No model is picked for OpenCode.");
      const check = await runLocked(l, ["debug", "agent", OPENCODE_AGENT, "--pure"], "", OPENCODE_QUERY_TIMEOUT_MS, env);
      assertNoTools(check.stdout);
      const prompt = `=== INSTRUCTIONS ===\n${req.system.join("\n\n")}\n\n=== INPUT ===\n${req.user}\n`;
      req.audit(opencodeArgs(model).join(" ") + "\n" + prompt, `opencode-cli/${model}`);
      const r = await runLocked(l, opencodeArgs(model), prompt, o.cliTimeoutMs ?? CLI_TIMEOUT_MS, env, o.onCwd);
      if (r.code !== 0) {
        parseOpencodeStream(r.stdout); // throws with the CLI's own reason when it gave one
        throw new CliError(`OpenCode failed: ${(r.stderr.trim() || `exit status ${r.code}`).slice(0, 300)}`);
      }
      return parseOpencodeStream(r.stdout);
    },
  };
}
