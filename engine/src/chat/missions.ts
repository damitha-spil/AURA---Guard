// Background missions: one agent-loop run that keeps going inside the engine while the person moves to
// another page or chat. It survives page switches and a closed browser tab, NOT an engine restart (the
// list lives in memory; a restart ends every mission). Limits: one running mission per chat, two in
// total. Progress is the same step list the foreground chat shows. The engine itself writes the final
// reply into the chat when the mission ends, so it is there when the person comes back.
//
// This module only runs and tracks; what a mission may do is decided by the agent loop (agent-loop.ts):
// read-only tools, creating items in REO's own data, and approval cards. No new power is added here.

import { randomBytes } from "node:crypto";
import type { AnswerResult, Step } from "./answer.ts";
import type { CreatedItem } from "./follow-through.ts";
import { CreationLog } from "./follow-through.ts";

export const MAX_MISSIONS_RUNNING = 2;
/** Finished missions kept for the list (memory only). */
export const MAX_MISSIONS_KEPT = 20;
/** A mission's whole loop may run this long. A chat answer stops at MAX_LOOP_MS (240 s) in agent-loop.ts. */
export const MISSION_LOOP_MS = 600_000;
export const MAX_MISSION_STEPS = 60;

export type MissionStatus = "running" | "done" | "failed" | "cancelled";

export interface MissionView {
  id: string;
  chatId: string;
  /** The question, shortened. Masked by the caller. */
  title: string;
  status: MissionStatus;
  startedAt: string;
  endedAt?: string;
  steps: Step[];
  created: CreatedItem[];
  /** The last words of the result, for the list. */
  summary?: string;
}

export interface MissionContext {
  signal: AbortSignal;
  onStep: (s: Step) => void;
  creations: CreationLog;
  /** Plain-text id of the mission, for the caller's own records. */
  id: string;
}

export interface MissionStart {
  chatId: string;
  title: string;
  run: (ctx: MissionContext) => Promise<AnswerResult>;
  /** Called once when the mission ends, with the final view and the result (not for a restart). */
  onFinish: (view: MissionView, result: AnswerResult | null) => void;
}

interface Entry { view: MissionView; ctrl: AbortController; log: CreationLog }

export type StartOutcome = { ok: true; mission: MissionView } | { ok: false; error: string };

export class MissionManager {
  private entries = new Map<string, Entry>();

  private running(): Entry[] {
    return [...this.entries.values()].filter((e) => e.view.status === "running");
  }

  list(chatId?: string): MissionView[] {
    return [...this.entries.values()].map((e) => this.snapshot(e)).filter((v) => !chatId || v.chatId === chatId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): MissionView | null {
    const e = this.entries.get(id);
    return e ? this.snapshot(e) : null;
  }

  private snapshot(e: Entry): MissionView {
    return { ...e.view, steps: [...e.view.steps], created: [...e.log.items] };
  }

  start(a: MissionStart): StartOutcome {
    if (this.running().some((e) => e.view.chatId === a.chatId)) return { ok: false, error: "This chat already has a mission running. Wait for it or cancel it." };
    if (this.running().length >= MAX_MISSIONS_RUNNING) return { ok: false, error: `Only ${MAX_MISSIONS_RUNNING} missions can run at once. Wait for one to finish or cancel it.` };
    const id = randomBytes(8).toString("hex");
    const ctrl = new AbortController();
    const log = new CreationLog();
    const view: MissionView = { id, chatId: a.chatId, title: a.title.slice(0, 120), status: "running", startedAt: new Date().toISOString(), steps: [], created: [] };
    const entry: Entry = { view, ctrl, log };
    this.entries.set(id, entry);
    const onStep = (s: Step): void => {
      const i = view.steps.findIndex((t) => t.id === s.id);
      if (i >= 0) view.steps[i] = s;
      else if (view.steps.length < MAX_MISSION_STEPS) view.steps.push(s);
    };
    // Runs on its own: the caller's HTTP request has already been answered.
    void (async () => {
      let result: AnswerResult | null = null;
      try {
        result = await a.run({ signal: ctrl.signal, onStep, creations: log, id });
        view.status = ctrl.signal.aborted ? "cancelled" : result.ok ? "done" : "failed";
        view.summary = result.text.replace(/\s+/g, " ").slice(0, 200);
      } catch (e) {
        view.status = ctrl.signal.aborted ? "cancelled" : "failed";
        view.summary = e instanceof Error ? e.message.slice(0, 200) : "The mission failed.";
      }
      view.endedAt = new Date().toISOString();
      try { a.onFinish(this.snapshot(entry), result); } catch { /* the chat file may be gone */ }
      this.trim();
    })();
    return { ok: true, mission: this.snapshot(entry) };
  }

  /** Stops a running mission: the model call in flight is aborted and the loop ends. */
  cancel(id: string): MissionView | null {
    const e = this.entries.get(id);
    if (!e) return null;
    if (e.view.status === "running") e.ctrl.abort();
    return this.snapshot(e);
  }

  /** Cancels everything (engine shutdown). */
  cancelAll(): void {
    for (const e of this.running()) e.ctrl.abort();
  }

  private trim(): void {
    const done = [...this.entries.values()].filter((e) => e.view.status !== "running").sort((a, b) => a.view.startedAt.localeCompare(b.view.startedAt));
    for (const e of done.slice(0, Math.max(0, done.length - MAX_MISSIONS_KEPT))) this.entries.delete(e.view.id);
  }
}
