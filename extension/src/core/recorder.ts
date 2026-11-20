import { localDate } from "./repoKey.ts";
import { buildEvent } from "./events.ts";
import type { EventKind } from "./events.ts";
import { hasConsent } from "./consent.ts";
import type { Consent } from "./consent.ts";
import type { Spool } from "./spool.ts";

export type Source = "commits" | "saves" | "tasks" | "terminal" | "diagnostics" | "chat";
const SOURCE_OF: Partial<Record<EventKind, Source>> = {
  commit: "commits", save: "saves", task: "tasks", terminal: "terminal", diagnostics: "diagnostics", chat: "chat",
};

export interface RecorderDeps {
  spool: Spool;
  repo: string;
  dev: string;
  getConsent: () => Consent | null;
  isPaused: () => boolean;
  sourceOn: (s: Source) => boolean;
  branch: () => string;
  now: () => Date;
}

export type RecordOutcome = "written" | "no-consent" | "paused" | "source-off" | "secret" | "cap" | "error";

/** The single gate every event passes: consent, not paused, source on, masked, under the cap. */
export class Recorder {
  today = 0;
  dropped = 0;
  private d: RecorderDeps;
  constructor(d: RecorderDeps) {
    this.d = d;
  }

  record(kind: EventKind, data: Record<string, unknown>, stableKey: string, at?: Date): RecordOutcome {
    if (!hasConsent(this.d.getConsent(), this.d.repo)) return "no-consent";
    if (this.d.isPaused()) return "paused";
    const src = SOURCE_OF[kind];
    if (src && !this.d.sourceOn(src)) return "source-off";
    const ts = at ?? this.d.now();
    const ev = buildEvent({ kind, ts, repo: this.d.repo, branch: this.d.branch(), dev: this.d.dev, data, stableKey });
    if (!ev) {
      this.dropped++;
      return "secret";
    }
    try {
      const r = this.d.spool.append(ev, localDate(ts));
      if (r === "written") this.today++;
      return r;
    } catch {
      return "error";
    }
  }

  /** Events already on disk for today, so the counter survives a reload. */
  refreshToday(): void {
    this.today = this.d.spool.count(this.d.repo, localDate(this.d.now()));
  }
}
