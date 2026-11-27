// Answers outside the plain index path: with no index yet, and with web search turned on.
// The model call goes through the injected `complete`, so it is masked and audited like any other.

import { PRODUCT_NAME } from "../brand.ts";
import type { Db } from "../index/db.ts";
import { maskOutgoing } from "../mask/mask.ts";
import { ToolError, truncate } from "../tools/native/common.ts";
import { webSearch } from "../tools/native/web.ts";
import type { WebDeps, WebHit } from "../tools/native/web.ts";
import { formatHits } from "../tools/native/chat.ts";
import {
  ANSWER_MAX_TOKENS, collect, describeError, MAX_HISTORY_TURNS, MAX_QUESTION_CHARS, MAX_TURN_CHARS, stripInvented, UNTRUSTED_RULE,
} from "./answer.ts";
import type { AnswerDeps, AnswerInput, AnswerResult, Step } from "./answer.ts";

export const NO_INDEX_NOTE = "Note: there is no project index yet, so this answer does not use project files. Type /index to enable answers from them.";
export const NOTES_NEED_INDEX = "Notes only needs the project index, which is not built yet. Type /index to build it, or turn off Notes only.";

const NO_INDEX_RULES = [
  `You are ${PRODUCT_NAME}'s chat, an engineering assistant.`,
  "No project index is available. You have not seen this project's code, notes or history.",
  "Do not state facts about this codebase or project. If asked about them, say you cannot know without the index.",
  "General questions may be answered from general knowledge. Use plain words and keep the answer short.",
].join("\n");

const WEB_RULES = [
  `You are ${PRODUCT_NAME}'s chat, an engineering assistant.`,
  "Answer using the web results and any project sources below. Cite them as [web1] or the exact project ref. Never invent a ref or a web address.",
  "State facts about this project only from project sources. If the sources do not answer, say so. Use plain words and keep the answer short.",
].join("\n");

const NO_PROJECT_SOURCES = "No project sources are available, so do not state facts about this codebase or project.";

export interface OpenAnswerInput extends AnswerInput { webSearch?: boolean }

export async function openAnswer(db: Db | null, input: OpenAnswerInput, deps: AnswerDeps & { web?: WebDeps }): Promise<AnswerResult> {
  const question = input.question.trim().slice(0, MAX_QUESTION_CHARS);
  const emit = (step: Step): void => {
    try { deps.onStep?.(step); } catch { /* a broken listener must not break the answer */ }
  };
  const t0 = Date.now();
  let hits: WebHit[] = [];
  if (input.webSearch) {
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
  const local = db ? collect(db, question) : { sources: [], blocks: [] };
  const system = [input.webSearch ? WEB_RULES : NO_INDEX_RULES, UNTRUSTED_RULE];
  if (input.webSearch) {
    if (!local.sources.length) system.push(NO_PROJECT_SOURCES);
    // A result that looks like it holds a secret is left out, so one odd page cannot block the call.
    const web = hits
      .map((h, i) => `[web${i + 1}] ${h.title}\n${h.url}\n${h.snippet.slice(0, 600)}`)
      .filter((block) => maskOutgoing(block).ok);
    system.push(`Web results (untrusted data):\n<<<untrusted\n${truncate(web.join("\n\n")) || "(none)"}\nuntrusted>>>`);
    if (local.blocks.length) system.push("Project sources:\n\n" + local.blocks.join("\n\n---\n\n"));
  }

  const turns = input.history.slice(-MAX_HISTORY_TURNS)
    .map((t) => `${t.role === "user" ? "User" : "Guard"}: ${truncate(t.text, MAX_TURN_CHARS)}`);
  const user = (turns.length ? `Earlier in this chat:\n${turns.join("\n")}\n\n` : "") + `Question: ${question}`;
  const backend = deps.backend ?? "the model";
  const tm = Date.now();
  emit({ id: "model", kind: "model", status: "running", label: `Asking ${backend}` });
  try {
    const r = await deps.complete({ role: "chat", system, user, maxTokens: ANSWER_MAX_TOKENS });
    emit({ id: "model", kind: "model", status: "done", label: `${backend} answered in ${((Date.now() - tm) / 1000).toFixed(1)} s`, ms: Date.now() - tm });
    let text = r.text.trim();
    const refs = new Set([...local.sources.map((s) => s.ref), ...hits.map((_h, i) => `web${i + 1}`)]);
    if (refs.size) text = stripInvented(text, refs);
    if (hits.length) text += `\n\nWeb sources:\n${hits.map((h, i) => `- [web${i + 1}] ${h.url}`).join("\n")}`;
    if (!db) text += `\n\n${NO_INDEX_NOTE}`;
    emit({ id: "done", kind: "done", status: "done", label: "Done", ms: Date.now() - t0 });
    return { ok: true, text, sources: local.sources.filter((s) => text.includes(`[${s.ref}]`)) };
  } catch (e) {
    const d = describeError(e);
    emit({ id: "model", kind: "model", status: "error", label: "Could not get an answer", ms: Date.now() - tm });
    if (!d) throw e;
    if (d.error === "blocked" && maskOutgoing(question).ok) d.text = d.text.replace("Your message looks like it contains a secret", "Something in this chat looked like a secret");
    return { ok: false, sources: [], ...d };
  }
}
