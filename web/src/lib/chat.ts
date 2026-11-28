// Pure helpers for the chat box: the message limit, attached-file descriptions, recall of earlier
// messages, a plain Markdown copy of a chat, and marking search matches.

/** The engine refuses a longer typed message (MAX_QUESTION_CHARS in engine/src/chat/answer.ts). Files are sent separately. */
export const MAX_MESSAGE_CHARS = 4000;
/** What a model is given from earlier in the chat (MAX_HISTORY_TURNS and MAX_TURN_CHARS in engine/src/chat/prompt.ts). */
export const HISTORY_NOTE = "A model sees your last 10 messages in this chat (up to 2,500 characters each), the files attached in this chat within a size budget, and this message.";

/** Mirrors engine/src/chat/attachments.ts. */
export const MAX_FILES_PER_MESSAGE = 5;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface AttachmentInfo {
  id: string;
  name: string;
  size: number;
  type: string;
  kind: "text" | "pdf" | "docx" | "image" | "other";
  status: "read" | "cut" | "unreadable" | "blocked";
  note?: string;
  chars?: number;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const ID = /^[a-f0-9]{16}$/;
/**
 * The same-origin address of a stored file. Both ids come from the engine; anything else gives null,
 * so no address is ever built from other data (see the web-safety test).
 */
export function attachmentUrl(chatId: string, attId: string, part: "" | "text" | "open" = ""): string | null {
  return ID.test(chatId) && ID.test(attId) ? `/api/chats/${chatId}/attachments/${attId}${part ? `/${part}` : ""}` : null;
}

/** One line under the file name that says what REO could do with it. */
export function attachmentSummary(a: Pick<AttachmentInfo, "status" | "note" | "kind" | "chars">): string {
  if (a.status === "blocked") return `Not sent: ${a.note ?? "it looks like it holds a secret"}`;
  if (a.status === "unreadable") return a.kind === "image" ? "Picture: shown here, not read" : `Not read: ${a.note ?? "no text found"}`;
  const chars = a.chars ? `${a.chars.toLocaleString("en-US")} characters read` : "Read";
  return a.status === "cut" ? `${chars}; ${a.note ?? "cut"}` : chars;
}

/** Older messages kept the file as text: [Attached resource: name (size, type)] and maybe a fenced body. */
export function legacyAttachments(text: string): { files: { name: string; detail: string }[]; rest: string } {
  const files: { name: string; detail: string }[] = [];
  let rest = text;
  const fence = String.fromCharCode(96).repeat(3);
  const re = /^\[Attached resource: (.+?) \(([^()]*?)(?:, ([^(),]*))?\)\]\n?/;
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    files.push({ name: m[1]!, detail: [m[2], m[3]].filter(Boolean).join(", ") });
    rest = rest.slice(m[0].length);
    if (rest.startsWith(fence + "\n")) {
      const end = rest.indexOf("\n" + fence, 4);
      rest = end >= 0 ? rest.slice(end + 4) : "";
    }
    rest = rest.replace(/^\n+/, "");
  }
  return files.length ? { files, rest } : { files, rest: text };
}

/** Earlier messages that the up arrow can bring back, oldest first, without repeats in a row. */
export function recallable(messages: { role: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const t = legacyAttachments(m.text).rest;
    if (t && out[out.length - 1] !== t) out.push(t);
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
