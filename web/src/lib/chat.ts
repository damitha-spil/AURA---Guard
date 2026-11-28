// Pure helpers for the chat box: fitting a message to the engine's limit, recall of earlier
// messages, a plain Markdown copy of a chat, and marking search matches.

/** The engine refuses a longer message (MAX_QUESTION_CHARS in engine/src/chat/answer.ts). */
export const MAX_MESSAGE_CHARS = 4000;
/** What a model is given from earlier in the chat (MAX_HISTORY_TURNS and MAX_TURN_CHARS, same file). */
export const HISTORY_NOTE = "A model sees your last 6 messages in this chat, up to 1,500 characters of each, plus this one.";

export interface Attachment {
  name: string;
  sizeLabel: string;
  type: string;
  text?: string;
}

const CUT = "\n... [shortened to fit]";

function block(a: Attachment, room: number): string {
  const head = `[Attached resource: ${a.name} (${a.sizeLabel}`;
  if (a.text === undefined) return `${head}, ${a.type})]`;
  const body = a.text.length <= room ? a.text : `${a.text.slice(0, Math.max(0, room - CUT.length))}${CUT}`;
  return `${head})]\n\`\`\`\n${body}\n\`\`\``;
}

/**
 * The message that will be sent. File text is shortened, in equal shares, so the whole message stays
 * within the engine's limit. `fits` is false when even the names and the typed text are too long.
 */
export function composeMessage(typed: string, files: Attachment[]): { text: string; shortened: boolean; fits: boolean } {
  const val = typed.trim();
  const join = (room: number) => [...files.map((f) => block(f, room)), val].filter(Boolean).join("\n\n");
  const full = join(Number.MAX_SAFE_INTEGER);
  if (full.length <= MAX_MESSAGE_CHARS) return { text: full, shortened: false, fits: true };
  const withText = files.filter((f) => f.text !== undefined).length;
  if (!withText) return { text: full, shortened: false, fits: false };
  const bare = join(CUT.length).length;
  const share = CUT.length + Math.max(0, Math.floor((MAX_MESSAGE_CHARS - bare) / withText));
  const text = join(share);
  return { text, shortened: true, fits: text.length <= MAX_MESSAGE_CHARS };
}

/** Earlier messages that the up arrow can bring back, oldest first, without repeats in a row. */
export function recallable(messages: { role: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" || m.text.startsWith("[Attached resource:")) continue;
    if (out[out.length - 1] !== m.text) out.push(m.text);
  }
  return out;
}

export function chatMarkdown(title: string, messages: { role: string; text: string; pending?: boolean }[]): string {
  const body = messages
    .filter((m) => !m.pending)
    .map((m) => `## ${m.role === "user" ? "You" : "SPIL REO"}\n\n${m.text}`)
    .join("\n\n");
  return `# ${title}\n\n${body}\n`;
}

/** Splits text around every match, so matches can be marked while the text stays plain text. */
export function splitMatches(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.toLowerCase();
  const low = text.toLowerCase();
  // A few characters change length in lower case; offsets would then be wrong, so nothing is marked.
  if (!q || low.length !== text.length) return [{ text, match: false }];
  const out: { text: string; match: boolean }[] = [];
  let from = 0;
  for (let at = low.indexOf(q); at >= 0; at = low.indexOf(q, from)) {
    if (at > from) out.push({ text: text.slice(from, at), match: false });
    out.push({ text: text.slice(at, at + q.length), match: true });
    from = at + q.length;
  }
  if (from < text.length) out.push({ text: text.slice(from), match: false });
  return out;
}
