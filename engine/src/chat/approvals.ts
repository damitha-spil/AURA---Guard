// Approval cards. Agent mode may only change REO's own data on its own. Anything else it wants to do
// outside that must be shown to the owner as a card with Approve and Decline, and nothing runs until the
// owner approves. The model never runs the action: it asks, REO shows the card, and on Approve REO itself
// runs a fixed action it built (the model's text is only data in the card).
//
// Actions that exist today (see ACTION_KINDS):
//   open_attachment  open a file stored in this chat with the default program (allow-listed extensions)
//   open_link        open an https link to a known code host in the browser (same check as pull requests)
// Not available, with or without a card: git writes, PR comments or votes, shell, writing repo files,
// ERP, desktop clicks. Adding an action kind needs the owner's decision and an ADR (see AGENTS.md).
//
// Cards live in memory (a restart declines them). A card waits at most APPROVAL_WAIT_MS.

import { randomBytes } from "node:crypto";

export const ACTION_KINDS = ["open_attachment", "open_link"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** How long a card waits for the owner; then it counts as declined. */
export const APPROVAL_WAIT_MS = 5 * 60_000;
/** Cards waiting at once, over all chats. */
export const MAX_PENDING_APPROVALS = 10;
/** Cards kept after they are decided, so the screen can show the outcome. */
const KEEP_DECIDED = 50;

export type ApprovalState = "pending" | "approved" | "declined" | "expired";

/** What the screen shows. Only this reaches the client: never the action's function. */
export interface ApprovalCard {
  id: string;
  chatId: string | null;
  kind: ActionKind;
  title: string;
  /** What exactly will happen: a file name, or the link. Plain text. */
  detail: string;
  state: ApprovalState;
  created: string;
}

export interface ApprovalRequest {
  chatId: string | null;
  kind: ActionKind;
  title: string;
  detail: string;
  /** Runs only after Approve. Returns a short result for the model. */
  run: () => Promise<string>;
  signal?: AbortSignal;
  /** Called when the card is created, so a live stream can show it. */
  onCard?: (card: ApprovalCard) => void;
  /** Called when the card is decided. */
  onDecided?: (card: ApprovalCard) => void;
}

export interface ApprovalOutcome { state: Exclude<ApprovalState, "pending">; result?: string }

interface Entry {
  card: ApprovalCard;
  run: () => Promise<string>;
  settle: (o: ApprovalOutcome) => void;
  onDecided?: (card: ApprovalCard) => void;
}

export class ApprovalHub {
  private entries = new Map<string, Entry>();
  private readonly waitMs: number;
  constructor(waitMs: number = APPROVAL_WAIT_MS) { this.waitMs = waitMs; }

  /** Cards, pending first, newest first. */
  list(chatId?: string | null): ApprovalCard[] {
    return [...this.entries.values()].map((e) => e.card)
      .filter((c) => chatId === undefined || chatId === null || c.chatId === chatId)
      .sort((a, b) => (a.state === "pending" ? 0 : 1) - (b.state === "pending" ? 0 : 1) || b.created.localeCompare(a.created));
  }
  pending(): number { return this.list().filter((c) => c.state === "pending").length; }

  /** Shows a card and waits for the owner. Resolves when decided, expired, or the run was stopped. */
  request(r: ApprovalRequest): Promise<ApprovalOutcome> {
    if (!(ACTION_KINDS as readonly string[]).includes(r.kind)) return Promise.resolve({ state: "declined", result: "That action is not available." });
    if (this.pending() >= MAX_PENDING_APPROVALS) return Promise.resolve({ state: "declined", result: "Too many approvals are waiting. Answer those first." });
    if (r.signal?.aborted) return Promise.resolve({ state: "declined", result: "Stopped before it was shown." });
    const card: ApprovalCard = {
      id: randomBytes(8).toString("hex"), chatId: r.chatId, kind: r.kind, title: r.title.slice(0, 120), detail: r.detail.slice(0, 600),
      state: "pending", created: new Date().toISOString(),
    };
    return new Promise<ApprovalOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => { this.finish(card.id, "expired", "Stopped while waiting for approval."); };
      const settle = (o: ApprovalOutcome): void => {
        clearTimeout(timer);
        r.signal?.removeEventListener("abort", onAbort);
        resolve(o);
      };
      this.entries.set(card.id, { card, run: r.run, settle, ...(r.onDecided ? { onDecided: r.onDecided } : {}) });
      timer = setTimeout(() => this.finish(card.id, "expired", "No answer in time, so it was not done."), this.waitMs);
      r.signal?.addEventListener("abort", onAbort, { once: true });
      try { r.onCard?.({ ...card }); } catch { /* a broken listener must not block the card */ }
    });
  }

  /** The owner's choice. Returns the card, or null when there is no such pending card. */
  async decide(id: string, approve: boolean): Promise<ApprovalCard | null> {
    const e = this.entries.get(id);
    if (!e || e.card.state !== "pending") return null;
    if (!approve) return this.finish(id, "declined", "The owner declined. It was not done.");
    // Mark first so a second click cannot run the action twice.
    e.card.state = "approved";
    let result: string;
    try {
      result = await e.run();
    } catch (err) {
      result = `It was approved but failed: ${err instanceof Error ? err.message.slice(0, 160) : "unknown error"}`;
    }
    return this.finish(id, "approved", result, true);
  }

  private finish(id: string, state: Exclude<ApprovalState, "pending">, result: string, force = false): ApprovalCard | null {
    const e = this.entries.get(id);
    if (!e || (e.card.state !== "pending" && !force)) return e?.card ?? null;
    e.card.state = state;
    e.settle({ state, result });
    try { e.onDecided?.({ ...e.card }); } catch { /* ignore */ }
    this.trim();
    return { ...e.card };
  }

  /** A restart or shutdown declines everything that waits. */
  declineAll(): void {
    for (const id of [...this.entries.keys()]) this.finish(id, "declined", "The app is closing.");
  }

  private trim(): void {
    const decided = [...this.entries.values()].filter((e) => e.card.state !== "pending").sort((a, b) => a.card.created.localeCompare(b.card.created));
    for (const e of decided.slice(0, Math.max(0, decided.length - KEEP_DECIDED))) this.entries.delete(e.card.id);
  }
}
