import type * as vscode from "vscode";
import { MAX_ANSWER, MAX_TEXT, cap } from "../core/events.ts";
import { maskOutgoing } from "../core/mask.ts";
import type { AnswerResult } from "../core/cli.ts";
import type { Session } from "./session.ts";

export const HELP = [
  "**@guard** answers questions about how Aura is built and why, using SPIL AURA QA Bot's notes.",
  "",
  "- Ask a plain question, for example `@guard why do helpers ask for a kind of help?`",
  "- Notes that are not approved yet are marked as such.",
  "- Never paste passwords, keys or connection strings. A question with a secret is refused and nothing is sent.",
  "- If capture is on, your question and the answer are saved in your local spool, masked.",
].join("\n");

/** Marks notes that nobody has approved yet, in the answer text and in the source list. */
export function renderAnswer(r: AnswerResult): string {
  let text = r.text;
  for (const src of r.sources) {
    if (src.status && src.status !== "approved" && src.ref) {
      text = text.split(src.ref).join(`${src.ref} (not approved yet)`);
    }
  }
  if (r.sources.length === 0) return text;
  const list = r.sources.map((x) => `- \`${x.ref}\`${x.title ? ` ${x.title}` : ""}${x.status && x.status !== "approved" ? ` _(${x.status}, not approved yet)_` : ""}`).join("\n");
  return `${text}\n\n**Sources**\n${list}`;
}

export function makeChatHandler(s: Session): vscode.ChatRequestHandler {
  return async (request, _ctx, stream) => {
    try {
      if (request.command === "help" || !request.prompt.trim()) {
        stream.markdown(HELP);
        return {};
      }
      const q = request.prompt.trim();
      // A secret in the question: refuse, send nothing anywhere.
      if (!maskOutgoing(q).ok) {
        stream.markdown("That question looks like it contains a secret (a password, key or token). I did not send it anywhere. Remove the secret and ask again.");
        return {};
      }
      const problem = s.guardProblem();
      if (problem) {
        stream.markdown(`${problem} Run **Guard: Set up** first.`);
        return {};
      }
      stream.progress("Asking SPIL AURA QA Bot...");
      const r = await s.cli().answer(q);
      stream.markdown(renderAnswer(r));
      if (s.recorder && s.state === "capturing") {
        s.recorder.record(
          "chat",
          { participant: "guard", question: cap(q, MAX_TEXT), answer: cap(r.text, MAX_ANSWER), sources: r.sources.map((x) => x.ref) },
          q,
        );
        s.changed();
      }
      return {};
    } catch (e) {
      s.env.log(`chat: ${(e as Error).message}`);
      stream.markdown(`Guard could not answer: ${(e as Error).message}`);
      return {};
    }
  };
}

export function registerChat(s: Session): vscode.Disposable | undefined {
  const chat = (s.vsc as Partial<VsCodeChat>).chat;
  if (!chat || typeof chat.createChatParticipant !== "function") return undefined;
  const p = chat.createChatParticipant("aura-guard.guard", makeChatHandler(s));
  return p;
}
type VsCodeChat = { chat: typeof vscode.chat };
