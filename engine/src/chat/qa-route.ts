// Glue between the chat server and the QA agent: decides whether a message goes to the agent, runs
// it, and turns its outcome into the pieces the server stores and streams. The server only calls
// `decideRoute` and `routeQa`; the event JSON shapes are documented in docs/qa-agent.md.

import type { CompleteFn } from "../brain/client.ts";
import type { Db } from "../index/db.ts";
import { runQaAgent } from "../qa/agent.ts";
import type { QaResult, QaStep } from "../qa/agent.ts";
import type { RunProbe } from "../qa/run.ts";
import type { RunDeps } from "../qa/runner.ts";
import type { NeedsInputOption } from "../qa/target.ts";
import type { GuardConfig } from "../types.ts";
import type { ChatTurn } from "./answer.ts";
import { detectIntent, isHead, isRunConfirmation, QA_RESULT_HEAD } from "./intent.ts";
import type { IntentResult } from "./intent.ts";
import type { StoredMessage } from "./store.ts";

export type RouteMode = "qa" | "ask";

/** Which pipeline a message takes. `mode` is an explicit choice from the screen and beats detection. */
export function decideRoute(message: string, history: ChatTurn[], opts: { mode?: RouteMode | undefined; runJourneys?: boolean | undefined } = {}): IntentResult {
  if (opts.runJourneys === true) return { intent: "qa", confidence: 1, reason: "runJourneys was requested" };
  if (opts.mode === "ask") return { intent: "ask", confidence: 1, reason: "the screen asked for a normal answer" };
  if (opts.mode === "qa") return { intent: "qa", confidence: 1, reason: "the screen asked for QA" };
  return detectIntent(message, history);
}

/** The QA result stored in the last bot message of a chat, if that message is a QA result. */
export function lastQaResult(messages: StoredMessage[]): QaResult | null {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last || last.qa === undefined || last.qa === null || !isHead(last.text, QA_RESULT_HEAD)) return null;
  return last.qa as QaResult;
}

export interface QaRouteDeps {
  cfg: GuardConfig;
  db: Db | null;
  complete?: CompleteFn | undefined;
  backend: string;
  onStep?: (s: QaStep) => void;
  now?: () => Date;
  probe?: RunProbe["probe"];
  runDeps?: RunDeps;
  writeArtifacts?: boolean;
}

export interface QaRouteInput {
  message: string;
  history: ChatTurn[];
  runJourneys?: boolean;
  lastQa?: QaResult | null;
  noModel?: boolean;
}

export type QaRouteOutcome =
  | { kind: "result"; ok: true; text: string; result: QaResult }
  | { kind: "needs-input"; ok: true; text: string; question: string; options: NeedsInputOption[] }
  | { kind: "blocked"; ok: false; text: string; blocked: { kind: string; count: number }[] }
  | { kind: "unavailable"; ok: false; text: string }
  | { kind: "error"; ok: false; text: string };

export async function routeQa(deps: QaRouteDeps, input: QaRouteInput): Promise<QaRouteOutcome> {
  // A run happens only for an explicit confirmation: the flag, or a clear "run them" reply to the offer.
  if (input.runJourneys === true && !input.lastQa) return { kind: "unavailable", ok: false, text: "There is no QA result in this chat to run journeys for. Ask me to QA a change first." };
  const confirm = input.lastQa != null && (input.runJourneys === true || isRunConfirmation(input.message));
  try {
    const out = await runQaAgent(
      {
        cfg: deps.cfg, db: deps.db, complete: deps.complete, backend: deps.backend,
        ...(deps.onStep ? { onStep: deps.onStep } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.probe ? { probe: deps.probe } : {}),
        ...(deps.runDeps ? { runDeps: deps.runDeps } : {}), ...(deps.writeArtifacts === false ? { writeArtifacts: false } : {}),
      },
      { message: input.message, history: input.history, ...(input.noModel ? { noModel: true } : {}), ...(confirm ? { confirmRun: true, prior: input.lastQa ?? null } : {}) },
    );
    if (out.kind === "result") return { kind: "result", ok: true, text: out.markdown, result: out.result };
    if (out.kind === "needs-input") return { kind: "needs-input", ok: true, text: out.text, question: out.question, options: out.options };
    if (out.kind === "blocked") return { kind: "blocked", ok: false, text: out.text, blocked: out.blocked };
    return { kind: "unavailable", ok: false, text: out.text };
  } catch (e) {
    return { kind: "error", ok: false, text: `The QA agent could not finish: ${((e as Error).message ?? "unknown error").split("\n")[0]}` };
  }
}
