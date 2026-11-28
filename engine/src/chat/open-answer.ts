// Answers outside the plain index path: with no index yet, and with web search turned on.
// The model call goes through the injected `complete`, so it is masked and audited like any other.

import type { Db } from "../index/db.ts";
import { maskOutgoing } from "../mask/mask.ts";
import { ToolError, truncate } from "../tools/native/common.ts";
import { webSearch } from "../tools/native/web.ts";
import type { WebDeps, WebHit } from "../tools/native/web.ts";
import { ANSWER_MAX_TOKENS, collect, DEFAULT_FILE_QUESTION, describeError, MAX_QUESTION_CHARS, stripInvented } from "./answer.ts";
import type { AnswerDeps, AnswerInput, AnswerResult, Step } from "./answer.ts";
import { buildPrompt, generalRules, identityBlock, shouldRetrieve, UNTRUSTED_RULE } from "./prompt.ts";

export const NO_INDEX_NOTE = "Note: there is no project index yet, so this answer does not use project files. Type /index to enable answers from them.";
export const NOTES_NEED_INDEX = "Notes only needs the project index, which is not built yet. Type /index to build it, or turn off Notes only.";

export interface OpenAnswerInput extends AnswerInput { webSearch?: boolean }

export async function openAnswer(db: Db | null, input: OpenAnswerInput, deps: AnswerDeps & { web?: WebDeps }): Promise<AnswerResult> {
  const typed = input.question.trim().slice(0, MAX_QUESTION_CHARS);
  const question = typed || DEFAULT_FILE_QUESTION;
  const emit = (step: Step): void => {
    try { deps.onStep?.(step); } catch { /* a broken listener must not break the answer */ }
  };
  const t0 = Date.now();
  let hits: WebHit[] = [];
  // In agent mode web search is a tool the model asks for, not a step that always runs.
  if (input.webSearch && !deps.agent) {
    emit({ id: "search", kind: "search", status: "running", label: "Searching the web" });
    try {
      hits = await webSearch(question, deps.web);
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      emit({ id: "search", kind: "search", status: "error", label: "Web search did not run", ms: Date.now() - t0 });
      return { ok: false, text: e.message, sources: [], ...(e.blocked ? { error: "blocked" as const } : {}) };
    }
    emit({ id: "search", kind: "search", status: "done", label: "Searched the web", ms: Date.now() - t0 });
    emit({ id: "found", kind: "found", status: "done", label: `${hits.length} web ${hits.length === 1 ? "result" : "results"}`, ms: 0 });
  }
  const hasCurrent = (input.attachments?.current.length ?? 0) > 0;
  const local = db && shouldRetrieve(typed, hasCurrent) ? collect(db, typed, false, true) : { sources: [], blocks: [] as string[] };
  let webBlock: string | undefined;
  if (input.webSearch && !deps.agent) {
    // A result that looks like it holds a secret is left out, so one odd page cannot block the call.
    const web = hits
      .map((h, i) => `[web${i + 1}] ${h.title}\n${h.url}\n${h.snippet.slice(0, 600)}`)
      .filter((block) => maskOutgoing(block).ok);
    webBlock = `Web results (untrusted data):\n<<<untrusted\n${truncate(web.join("\n\n")) || "(none)"}\nuntrusted>>>`;
  }
  const prompt = buildPrompt({
    rules: generalRules({ hasIndex: db !== null, web: input.webSearch === true && !deps.agent, hasSources: local.sources.length > 0, hasAttachments: hasCurrent }),
    identity: identityBlock(deps.backend),
    ...(deps.memory ? { memory: deps.memory } : {}),
    ...(deps.skill ? { skill: deps.skill } : {}),
    extraRules: [UNTRUSTED_RULE],
    question,
    history: input.history,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    backendId: deps.backendId ?? null,
    sourceBlocks: local.blocks,
    ...(webBlock ? { webBlock } : {}),
  });
  const sources = local.sources.slice(0, prompt.sourcesUsed);
  const notes = [...prompt.attachments.notes];
  if (prompt.attachments.detail) emit({ id: "context", kind: "context", status: "done", label: "Read the attached files", detail: prompt.attachments.detail, ms: 0 });

  if (deps.agent) {
    const r = await deps.agent({ system: prompt.system, user: prompt.user, sources });
    emit({ id: "done", kind: "done", status: r.ok ? "done" : "error", label: r.ok ? "Done" : "Stopped", ms: Date.now() - t0 });
    const extra = [...notes, ...(db ? [] : [NO_INDEX_NOTE])];
    return r.ok && extra.length ? { ...r, text: `${r.text}\n\n${extra.join("\n")}` } : r;
  }
  const backend = deps.backend ?? "the model";
  const tm = Date.now();
  emit({ id: "model", kind: "model", status: "running", label: `Asking ${backend}` });
  try {
    const r = await deps.complete({
      role: "chat", system: prompt.system, user: prompt.user, maxTokens: ANSWER_MAX_TOKENS,
      ...(deps.signal ? { signal: deps.signal } : {}), ...(deps.onText ? { onText: deps.onText } : {}),
    });
    emit({ id: "model", kind: "model", status: "done", label: `${backend} answered in ${((Date.now() - tm) / 1000).toFixed(1)} s`, ms: Date.now() - tm });
    let text = r.text.trim();
    const refs = new Set([...sources.map((s) => s.ref), ...hits.map((_h, i) => `web${i + 1}`)]);
    text = stripInvented(text, refs);
    if (hits.length) text += `\n\nWeb sources:\n${hits.map((h, i) => `- [web${i + 1}] ${h.url}`).join("\n")}`;
    if (notes.length) text += `\n\n${notes.join("\n")}`;
    if (!db) text += `\n\n${NO_INDEX_NOTE}`;
    emit({ id: "done", kind: "done", status: "done", label: "Done", ms: Date.now() - t0 });
    return { ok: true, text, sources: sources.filter((s) => text.includes(`[${s.ref}]`)) };
  } catch (e) {
    const d = describeError(e);
    emit({ id: "model", kind: "model", status: "error", label: "Could not get an answer", ms: Date.now() - tm });
    if (!d) throw e;
    if (d.error === "blocked" && maskOutgoing(question).ok) d.text = d.text.replace("Your message looks like it contains a secret", "Something in this chat looked like a secret");
    return { ok: false, sources: [], ...d };
  }
}
