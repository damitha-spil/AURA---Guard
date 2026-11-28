// Helpers for streaming answer text: abort handling, server-sent-event reading, and a safe unmasker
// for chunked text. Masking and the audit line are NOT done here; select.ts does them once per call
// exactly as for a whole reply. A stream is only a preview of the same text that is returned at the end.

/** Thrown when the caller's abort signal fired. Never a model failure; shown as "Stopped". */
export class CancelledError extends Error {
  constructor() {
    super("Stopped.");
    this.name = "CancelledError";
  }
}

/** The timeout and the caller's signal together; either one ends the request. */
export function withAbort(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([t, signal]) : t;
}

/** Turns an abort-shaped fetch error into CancelledError when the caller asked for the stop. */
export function asCancel(e: unknown, signal?: AbortSignal): unknown {
  return signal?.aborted ? new CancelledError() : e;
}

/**
 * Reads a server-sent-events body. `onEvent` gets the event name (or "") and the joined data lines of
 * each event. Stops reading (and cancels the body) when `onEvent` returns false.
 */
export async function readSse(
  res: Response,
  onEvent: (event: string, data: string) => boolean | void,
  /** A stream may not grow past this many characters of raw events (a guard against a runaway). */
  maxChars = 8 * 1024 * 1024,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let seen = 0;
  const flush = (block: string): boolean => {
    let event = "";
    const data: string[] = [];
    for (const raw of block.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length && !event) return true;
    return onEvent(event, data.join("\n")) !== false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = dec.decode(value, { stream: true });
      seen += part.length;
      if (seen > maxChars) throw new Error("The model stream was too long and was stopped.");
      buf += part.replace(/\r\n/g, "\n");
      let at: number;
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (!flush(block)) return;
      }
    }
    if (buf.trim()) flush(buf);
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/**
 * Puts original values back into streamed MASKED text without ever showing half a placeholder.
 * A placeholder is made of letters, digits and underscores (CUSTOMER_01). Text is released only up
 * to the last character that cannot be part of such a word; the trailing word is held until the next
 * chunk shows where it ends (or `end()` is called). The released piece therefore always starts and
 * ends on a word boundary, which is what `unmask` itself requires, so the output equals unmasking the
 * whole text at once. With an empty map, text passes through unchanged.
 */
export class StreamUnmasker {
  private held = "";
  private readonly keys: string[];
  private readonly re: RegExp | null;
  private readonly map: Map<string, string>;
  constructor(map: Map<string, string>) {
    this.map = map;
    this.keys = [...map.keys()].sort((a, b) => b.length - a.length);
    this.re = this.keys.length
      ? new RegExp(`(?<![A-Za-z0-9_])(?:${this.keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_])`, "g")
      : null;
  }
  private apply(s: string): string {
    return this.re ? s.replace(this.re, (m) => this.map.get(m) ?? m) : s;
  }
  push(chunk: string): string {
    if (!this.re) return chunk;
    const all = this.held + chunk;
    let cut = all.length;
    while (cut > 0 && /[A-Za-z0-9_]/.test(all[cut - 1]!)) cut--;
    this.held = all.slice(cut);
    return this.apply(all.slice(0, cut));
  }
  end(): string {
    const rest = this.held;
    this.held = "";
    return this.apply(rest);
  }
}

/**
 * Decides, from the first characters of one model turn, whether it is answer text (stream it) or a
 * machine request such as a JSON tool call or plan (never show it as answer text). Agent mode only.
 * Text is held until the decision is possible; `end()` releases a held answer that never decided.
 */
export class AnswerGate {
  private head = "";
  private mode: "undecided" | "answer" | "request" = "undecided";
  private readonly out: (t: string) => void;
  constructor(out: (t: string) => void) { this.out = out; }
  get isRequest(): boolean { return this.mode === "request"; }
  push(t: string): void {
    if (this.mode === "answer") return void this.out(t);
    if (this.mode === "request") return;
    this.head += t;
    const s = this.head.trimStart();
    if (!s) return;
    if (s.startsWith("{")) { this.mode = "request"; return; }
    if (s.startsWith("`")) {
      // A fenced reply is a request when it opens a json fence; wait for enough characters to tell.
      if (/^`{1,2}$/.test(s) || /^```(?:j|js|jso|json)?\s*$/i.test(s)) return; // not enough yet
      if (/^```(?:json)?\s*\{/i.test(s)) { this.mode = "request"; return; }
    }
    this.mode = "answer";
    this.out(this.head.trimStart());
    this.head = "";
  }
  end(): void {
    if (this.mode === "undecided" && this.head.trim()) {
      const s = this.head.trimStart();
      if (!/^```(?:json)?\s*\{/i.test(s)) this.out(s);
      this.mode = "answer";
    }
    this.head = "";
  }
}
