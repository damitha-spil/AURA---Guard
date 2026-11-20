// Chat intent routing: does this message ask for QA, or is it an ordinary question?
// Deterministic. No model call, no network, no file access. The rules are plain regular expressions
// so a person can read why a message was routed the way it was (the `reason` field says which).

import type { ChatTurn } from "./answer.ts";

export type Intent = "qa" | "ask";

export interface IntentResult {
  intent: Intent;
  /** 0..1. Only a rough strength of the evidence; the route is decided by the rule that matched. */
  confidence: number;
  reason: string;
}

/** The first words of the bot's own questions, so a short reply to one is read as the answer. */
export const QA_NEEDS_INPUT_HEAD = "QA needs one answer before I start";
export const QA_RESULT_HEAD = "QA result";
/** A reply to a QA question may be a pasted feature description; longer than this is not treated as a reply. */
export const MAX_REPLY_CHARS = 4000;

/** Sub-commands of the existing `/qa` slash command; those run through /api/command, not the QA agent. */
const SLASH_SUBS = new Set(["status", "plan", "generate", "check", "run"]);

/** True when a stored bot message starts with the head (Markdown heading marks are ignored). */
export const isHead = (text: string, head: string): boolean => text.replace(/^[#*\s]+/, "").startsWith(head);

const norm = (s: string): string => s.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** The text after a leading `/qa`, or null when the message is not that slash command. */
export function slashQaText(message: string): string | null {
  const m = /^\/qa(?:\s+([\s\S]*))?$/i.exec(message.trim());
  return m ? (m[1] ?? "").trim() : null;
}

// ---- strong, explicit requests ----
const QA_WORD = String.raw`(?:qa|q\.a\.|uat)`;
const TEST_NOUN = String.raw`(?:test[- ]?cases?|test[- ]?plans?|test[- ]?scenarios?|test[- ]?checklists?|test[- ]?scripts?|test[- ]?matrix|testing[- ]plans?|acceptance[- ]criteria|acceptance tests?|smoke tests?|regression tests?|regression suite|sanity tests?|sanity[- ]checks?|qa plans?|qa checklists?)`;
const WRITE_VERB = String.raw`(?:write|draft|create|make|generate|prepare|produce|build|give me|get me|list|propose|suggest|design|need|want|put together|come up with)`;

const RE = {
  // "Can you QA it", "QA the latest change", "please QA PR 123", "do a QA pass", "run QA on ..."
  qaRequest: new RegExp(String.raw`^(?:(?:hey|hi|ok|okay|so|and|now|then)[ ,]+)?(?:(?:please|pls|can you|could you|would you|will you|can we|could we|let'?s|i want you to|i need you to|i'd like you to|go ahead and|just|kindly)[ ,]+)*(?:(?:do|run|start|perform|give|get|need|want|launch|kick off)(?: me)?(?: an?| the| some)?[ ,]+)?${QA_WORD}\b(?!\s*(?:is|was|are|does|did|means?|stands|team|process|policy|lead|engineer|server|environment|env)\b)`, "i"),
  qaAnywhereRequest: new RegExp(String.raw`\b(?:can|could|would|will) (?:you|we) ${QA_WORD}\b|\b(?:please|pls) ${QA_WORD}\b|\b(?:do|run|start|need|want|give me|get me) (?:an? |the |some )?${QA_WORD}(?: (?:pass|check|round|review|run|on|for|of))\b`, "i"),
  testNounRequest: new RegExp(String.raw`\b${WRITE_VERB}\b[^.?!\n]{0,40}\b${TEST_NOUN}\b`, "i"),
  testNounImperative: new RegExp(String.raw`^(?:(?:please|pls|can you|could you|would you)[ ,]+)?${TEST_NOUN}\b[ ]+(?:for|on|of|about)\b`, "i"),
  // "what should I test for the checkout feature", "what do we need to test", "how should I test this"
  whatToTest: /\b(?:what|which|how)(?: (?:should|do|can|would|will|shall|must))?(?: (?:i|we|you|qa|the team))?(?: (?:still|even|actually))? (?:need|have|ought|want)?(?: ?to)? ?(?:should )?(?:i |we )?(?:test|verify|check|retest|regression[- ]test)\b(?! (?:fail|pass|run|work|break|time|take|exist))/i,
  whatShouldTest: /\b(?:what|which|how)\b[^.?!\n]{0,30}\b(?:should|need to|have to|ought to|must|do we|do i|shall)\b[^.?!\n]{0,12}\b(?:test|verify|retest|qa|sanity[- ]check|smoke[- ]test)\b/i,
  testingAdvice: /\b(?:test(?:ing)? (?:ideas|advice|suggestions|strategy for)|ideas for testing|how (?:do|should|would) (?:i|we) (?:test|qa|verify))\b/i,
  // Imperative or polite verbs asking for work to be done on something.
  verbRequest: /^(?:(?:hey|hi|ok|okay|so|and|now|then)[ ,]+)?(?:(?:please|pls|can you|could you|would you|will you|can we|could we|let'?s|i want you to|i need you to|i'd like you to|go ahead and|help me|help us|kindly|just)[ ,]+)*(?:test|retest|re-test|verify|sanity[- ]?check|smoke[- ]?test|regression[- ]?test|validate|acceptance[- ]?test|exercise|check over|double[- ]check|run (?:a |the )?(?:smoke|regression|sanity|acceptance) (?:test|check|pass))\b[ ,]*(.*)$/i,
  helpTest: /\b(?:help me|help us|i need|we need|i want|we want)\b[^.?!\n]{0,20}\b(?:to )?(?:test|verify|qa|sanity[- ]check)\b/i,
  isItReady: /\b(?:is|are) (?:it|this|that|the (?:change|pr|pull request|branch|feature|build|release))\b[^.?!\n]{0,20}\b(?:ready (?:to|for) (?:test|qa|release|ship|merge)|safe to (?:merge|ship|release))\b/i,
};

/** After an imperative verb ("test ..."), the next words must look like an object, not a statement. */
const OBJECT_START = /^(?:it|this|that|these|those|them|the|my|our|your|a|an|all|every|everything|each|latest|last|recent|new|current|pr|pull|branch|commit|commits|change|changes|feature|features|fix|fixes|patch|release|build|screen|page|flow|module|department|#\d+|[\w.-]+\/[\w./-]+|[\w-]+\.[a-z]{1,5}\b|\d+\b|for|on|in|if|whether|that|before|after|against|with|how|what|where)/i;

/** Questions about tests (not requests for QA). */
const QUESTION_START = /^(?:why|where|who|whose|when|which|is|are|was|were|does|did|do(?= (?:you|we|they|the|our|these|those|any|all)b)|has|have|had|how many|how much|how long|how often|what(?:'s| is| are| was| were| does| did| do)?|explain|describe|define|tell me about|show me|list the|any idea)\b/i;
const ABOUT_TESTS = /\b(?:tests?|testing|qa)\b/i;

export function detectIntent(message: string, history: ChatTurn[] = []): IntentResult {
  const raw = message ?? "";
  const m = norm(raw);
  if (!m) return { intent: "ask", confidence: 1, reason: "empty message" };

  // 1. The slash command.
  const slash = slashQaText(m);
  if (slash !== null) {
    const first = slash.split(" ")[0]?.toLowerCase() ?? "";
    if (SLASH_SUBS.has(first)) return { intent: "ask", confidence: 0.9, reason: `/qa ${first} is an existing command; it runs through the command runner` };
    return { intent: "qa", confidence: 1, reason: "the /qa command" };
  }
  if (m.startsWith("/")) return { intent: "ask", confidence: 0.9, reason: "another slash command" };

  // 2. A short reply to the bot's own QA question.
  const lastBot = [...history].reverse().find((t) => t.role === "assistant");
  if (lastBot && isHead(lastBot.text, QA_NEEDS_INPUT_HEAD) && m.length <= MAX_REPLY_CHARS && !QUESTION_START.test(m)) {
    return { intent: "qa", confidence: 0.9, reason: "an answer to the QA question above" };
  }
  if (lastBot && isHead(lastBot.text, QA_NEEDS_INPUT_HEAD) && m.length <= MAX_REPLY_CHARS && /\b(?:qa|test)\b/i.test(m)) {
    return { intent: "qa", confidence: 0.8, reason: "an answer to the QA question above" };
  }
  if (lastBot && isHead(lastBot.text, QA_RESULT_HEAD) && isRunConfirmation(m)) {
    return { intent: "qa", confidence: 0.9, reason: "confirming the journey run offered above" };
  }

  const interrogative = QUESTION_START.test(m);
  const strong =
    RE.qaRequest.test(m) || RE.qaAnywhereRequest.test(m) || RE.testNounRequest.test(m) || RE.testNounImperative.test(m);

  // 3. Explicit QA / test-plan requests win, even when phrased as a question ("can you QA it?").
  if (strong) {
    // "what is a test plan", "where is the test plan" are questions about the thing, not requests to make it.
    if (interrogative && !/^(?:what|which) (?:should|do|would|can)\b/i.test(m)) {
      return { intent: "ask", confidence: 0.7, reason: "a question about QA or test plans, not a request" };
    }
    return { intent: "qa", confidence: 0.95, reason: "an explicit request for QA or test cases" };
  }

  // 4. "What should I test for X?"
  if (RE.whatShouldTest.test(m) || RE.testingAdvice.test(m)) {
    return { intent: "qa", confidence: 0.9, reason: "asks what to test" };
  }
  if (RE.whatToTest.test(m) && !/\b(?:test|tests) (?:fail|failed|failing|pass|passed|run|ran)\b/i.test(m)) {
    return { intent: "qa", confidence: 0.85, reason: "asks what to test" };
  }
  if (RE.isItReady.test(m)) return { intent: "qa", confidence: 0.7, reason: "asks whether a change is ready to test or ship" };

  // 5. Polite or imperative verbs ("test this change", "can you verify the checkout").
  const v = RE.verbRequest.exec(m);
  if (v) {
    const rest = (v[1] ?? "").trim();
    if (rest === "" || OBJECT_START.test(rest)) {
      return { intent: "qa", confidence: rest === "" ? 0.75 : 0.85, reason: "asks Guard to test or verify something" };
    }
    return { intent: "ask", confidence: 0.6, reason: "starts with a test word but is not a request" };
  }
  if (RE.helpTest.test(m) && !interrogative) return { intent: "qa", confidence: 0.75, reason: "asks for help testing" };

  // 6. Everything else, including questions that only mention tests.
  if (ABOUT_TESTS.test(m)) return { intent: "ask", confidence: 0.85, reason: "a question that mentions tests; answered from the vault and code" };
  return { intent: "ask", confidence: 0.95, reason: "an ordinary question" };
}

const CONFIRM_RUN = /^(?:(?:yes|yep|yeah|ok|okay|sure|please|go ahead|do it|confirmed?)[ ,.!]*)*(?:(?:run|start|go|execute|do)\b[^.?!\n]{0,30}\b(?:journeys?|them|it|those|the read-only|read only|the automated)\b|run them|go ahead|yes,? run)/i;

/** True when the message confirms the "run read-only journeys" offer. Needs the offer to exist; see qa-route. */
export function isRunConfirmation(message: string): boolean {
  const m = norm(message);
  return m.length <= 120 && CONFIRM_RUN.test(m);
}

/** The text of the request without the leading `/qa`. */
export function stripSlash(message: string): string {
  const s = slashQaText(norm(message));
  return s === null ? message.trim() : s;
}
