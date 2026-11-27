// Greetings and "what model are you" get a fixed reply: no model call and no index needed.

import { PRODUCT_NAME } from "../brand.ts";

const GREETING = /^(?:(?:hi|hii+|hello|hey|yo|good (?:morning|afternoon|evening|day))(?: there| reo| spil reo)?\b ?)+/;
const MODEL_QUESTION =
  /^(?:and )?(?:(?:what|which) (?:ai )?(?:model|llm|ai) (?:are you(?: using| running(?: on)?)?|do you (?:use|run on)|is this|am i (?:talking|chatting|speaking) (?:to|with)|powers you)|(?:who|what) are you)(?: right now| now| exactly)?$/;

/** Only whole short messages match, so a real question that starts with "hi" is still answered. */
export function isGreetingOrIdentity(message: string): boolean {
  if (message.length > 120) return false;
  const text = message.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const rest = text.replace(GREETING, "").trim();
  if (rest === "") return GREETING.test(text);
  return MODEL_QUESTION.test(rest) || (GREETING.test(text) && /^how are you(?: doing| today)?$/.test(rest));
}

export function identityReply(backend: { picked: string | null; label: string; model?: string } | null): string {
  const intro = `Hello, I am ${PRODUCT_NAME}, an engineering assistant.`;
  if (!backend?.picked) return `${intro} No model backend is ready right now. Choose and set one up in Settings.`;
  // The label already carries the model name when one is known.
  const model = backend.model && !backend.label.includes(backend.model) ? ` (model ${backend.model})` : "";
  return `${intro} The selected backend and model: ${backend.label}${model} [${backend.picked}].`;
}
