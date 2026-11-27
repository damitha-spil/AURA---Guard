// The typed tool lines of the chat (/web, /read, ...). The tool runs here and its result is
// shown as it is: no model is called.

import type { GuardConfig } from "../../types.ts";
import type { AnswerResult, Step, StepKind } from "../../chat/answer.ts";
import { fenced, ToolError } from "./common.ts";
import { browserRender } from "./browser.ts";
import type { BrowserDeps } from "./browser.ts";
import { listDir, readTextFile, searchFiles } from "./files.ts";
import { getTime, listProcesses, systemInfo } from "./system.ts";
import type { RunTaskList } from "./system.ts";
import { webFetch, webSearch } from "./web.ts";
import type { WebDeps, WebHit } from "./web.ts";

export interface NativeDeps extends WebDeps, BrowserDeps { runTaskList?: RunTaskList }

interface ToolLine {
  usage: string;
  needsArg: boolean;
  kind: StepKind;
  label: string;
  run: (cfg: GuardConfig, arg: string, deps: NativeDeps) => Promise<string> | string;
}

/** Search results as plain list lines. Page text cannot add links or formatting of its own. */
export function formatHits(hits: WebHit[]): string {
  const plain = (s: string): string => s.replace(/[[\]`*_<>|#]/g, " ").replace(/\s+/g, " ").trim();
  return hits.map((h, i) => `${i + 1}. ${plain(h.title)}\n   ${h.url}\n   ${plain(h.snippet)}`).join("\n");
}

const TOOL_LINES: Record<string, ToolLine> = {
  "/web": {
    usage: "/web <query>", needsArg: true, kind: "search", label: "Web search",
    run: async (_c, arg, deps) => {
      const hits = await webSearch(arg, deps);
      return hits.length ? `Web results (from outside sources, not checked):\n\n${formatHits(hits)}` : "No results.";
    },
  },
  "/fetch": {
    usage: "/fetch <url>", needsArg: true, kind: "context", label: "Read web page",
    run: async (_c, arg, deps) => {
      const r = await webFetch(arg, deps);
      return `Text of ${r.url}:\n\n${fenced(r.text)}`;
    },
  },
  "/browse": {
    usage: "/browse <url>", needsArg: true, kind: "context", label: "Rendered web page",
    run: async (_c, arg, deps) => {
      const r = await browserRender(arg, deps);
      return `Rendered text of ${r.url}:\n\n${fenced(r.text)}`;
    },
  },
  "/ls": { usage: "/ls <path>", needsArg: false, kind: "context", label: "Listed folder", run: (c, arg) => fenced(listDir(c, arg)) },
  "/read": { usage: "/read <path>", needsArg: true, kind: "context", label: "Read file", run: (c, arg) => fenced(readTextFile(c, arg)) },
  "/find": { usage: "/find <text>", needsArg: true, kind: "search", label: "Searched files", run: async (c, arg) => fenced(await searchFiles(c, arg)) },
  "/system": { usage: "/system", needsArg: false, kind: "context", label: "Read system information", run: (c) => fenced(systemInfo(c)) },
  "/processes": { usage: "/processes", needsArg: false, kind: "context", label: "Listed processes", run: async (_c, _a, deps) => fenced(await listProcesses(deps.runTaskList)) },
  "/time": { usage: "/time", needsArg: false, kind: "context", label: "Read the clock", run: () => fenced(getTime()) },
};

export function parseToolLine(line: string): { name: string; arg: string } | null {
  const m = /^(\/[a-z]+)(?:\s+([\s\S]*))?$/i.exec(line.trim());
  const name = m?.[1]?.toLowerCase() ?? "";
  return Object.hasOwn(TOOL_LINES, name) ? { name, arg: (m?.[2] ?? "").trim() } : null;
}

export async function runToolLine(
  cfg: GuardConfig, line: { name: string; arg: string }, deps: NativeDeps, onStep: (s: Step) => void,
): Promise<AnswerResult> {
  const t = TOOL_LINES[line.name] as ToolLine;
  if (t.needsArg && !line.arg) return { ok: false, text: `Type it as: ${t.usage}`, sources: [] };
  const t0 = Date.now();
  const step = (status: Step["status"]): void => onStep({ id: t.kind, kind: t.kind, status, label: t.label, ...(status === "running" ? {} : { ms: Date.now() - t0 }) });
  step("running");
  try {
    const text = await t.run(cfg, line.arg, deps);
    step("done");
    onStep({ id: "done", kind: "done", status: "done", label: "Done", ms: Date.now() - t0 });
    return { ok: true, text, sources: [] };
  } catch (e) {
    step("error");
    // Only ToolError messages are written for the user; anything else could carry a local path.
    const text = e instanceof ToolError ? e.message : "The tool could not finish.";
    return { ok: false, text, sources: [], ...(e instanceof ToolError && e.blocked ? { error: "blocked" as const } : {}) };
  }
}
