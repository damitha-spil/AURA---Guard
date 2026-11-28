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
import { getN8nStatus, n8nListExecutions, n8nListWorkflows, n8nTriggerWebhook } from "../../plugins/n8n.ts";

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
  "/n8n": {
    usage: "/n8n status|workflows|executions [workflowId]|trigger <webhookPath> [json]",
    needsArg: true,
    kind: "context",
    label: "n8n Automation",
    run: async (cfg, arg) => {
      const parts = arg.trim().split(/\s+/);
      const sub = (parts[0] || "").toLowerCase();
      try {
        if (sub === "status") {
          const st = await getN8nStatus(cfg.dataDir);
          return fenced(JSON.stringify(st, null, 2));
        }
        if (sub === "workflows") {
          const list = await n8nListWorkflows(cfg.dataDir);
          return list.length ? fenced(JSON.stringify(list, null, 2)) : "No n8n workflows found.";
        }
        if (sub === "executions") {
          const list = await n8nListExecutions(cfg.dataDir, parts[1]);
          return list.length ? fenced(JSON.stringify(list, null, 2)) : "No n8n executions found.";
        }
        if (sub === "trigger") {
          const pathOrUrl = parts[1];
          if (!pathOrUrl) throw new ToolError("Usage: /n8n trigger <webhookPath> [json]");
          const jsonRaw = arg.trim().slice(parts[0]!.length).trim().slice(pathOrUrl.length).trim();
          let payload: Record<string, unknown> = { source: "spil-reo" };
          if (jsonRaw) {
            try {
              const parsed = JSON.parse(jsonRaw) as unknown;
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                payload = parsed as Record<string, unknown>;
              }
            } catch {
              throw new ToolError("Invalid JSON payload for /n8n trigger.");
            }
          }
          const res = await n8nTriggerWebhook(cfg.dataDir, { pathOrUrl, payload });
          return fenced(JSON.stringify(res, null, 2));
        }
        throw new ToolError("Usage: /n8n status|workflows|executions [workflowId]|trigger <webhookPath> [json]");
      } catch (e) {
        if (e instanceof ToolError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new ToolError(msg, msg.startsWith("Blocked n8n webhook trigger"));
      }
    },
  },
};

export function parseToolLine(line: string): { name: string; arg: string } | null {
  const m = /^(\/[a-z0-9]+)(?:\s+([\s\S]*))?$/i.exec(line.trim());
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
