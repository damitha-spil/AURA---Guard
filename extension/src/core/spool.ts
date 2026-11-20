import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DAILY_CAP } from "./events.ts";
import type { GuardEvent } from "./events.ts";

/** Setting, then env AURA_GUARD_SPOOL, then ~/.aura-guard/spool. Local paths only. */
export function resolveSpoolDir(setting: string, env: Record<string, string | undefined>, home = homedir()): string {
  const chosen = (setting || env.AURA_GUARD_SPOOL || "").trim();
  if (!chosen) return join(home, ".aura-guard", "spool");
  if (chosen.startsWith("\\\\") || chosen.startsWith("//") || /^[a-z][a-z0-9+.-]+:\/\//i.test(chosen)) {
    throw new Error("The spool folder must be a local folder, not a network path.");
  }
  if (!isAbsolute(chosen)) throw new Error("The spool folder must be an absolute path.");
  return chosen;
}

export type AppendResult = "written" | "cap";

export class Spool {
  private counts = new Map<string, number>();
  readonly dir: string;
  readonly cap: number;
  constructor(dir: string, cap = DAILY_CAP) {
    this.dir = dir;
    this.cap = cap;
  }

  file(repo: string, date: string): string {
    return join(this.dir, repo, `events-${date}.jsonl`);
  }

  /** Lines already in the day's file (counted once, then tracked in memory). */
  count(repo: string, date: string): number {
    const key = `${repo}\0${date}`;
    let n = this.counts.get(key);
    if (n === undefined) {
      const f = this.file(repo, date);
      n = existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length : 0;
      this.counts.set(key, n);
    }
    return n;
  }

  /** One write call per line in append mode, so a line is never split. */
  append(ev: GuardEvent, date: string): AppendResult {
    const n = this.count(ev.repo, date);
    if (n >= this.cap) return "cap";
    mkdirSync(join(this.dir, ev.repo), { recursive: true });
    appendFileSync(this.file(ev.repo, date), JSON.stringify(ev) + "\n", { encoding: "utf8", flag: "a" });
    this.counts.set(`${ev.repo}\0${date}`, n + 1);
    return "written";
  }

  /** Forget cached counts (after a purge). */
  reset(): void {
    this.counts.clear();
  }
}
