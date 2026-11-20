export const WINDOW_MS = 5 * 60 * 1000;

export interface SaveBucket {
  path: string;
  language: string;
  count: number;
  windowStart: number;
  windowEnd: number;
}

/** Counts saves per file per 5-minute window. Holds no file contents. */
export class SaveAggregator {
  private buckets = new Map<string, SaveBucket>();

  add(path: string, language: string, atMs: number): void {
    const start = Math.floor(atMs / WINDOW_MS) * WINDOW_MS;
    const key = `${start}\0${path}`;
    const b = this.buckets.get(key);
    if (b) b.count++;
    else this.buckets.set(key, { path, language, count: 1, windowStart: start, windowEnd: start + WINDOW_MS });
  }

  /** Windows that have ended by `nowMs` (all of them when `all`). They are removed. */
  flush(nowMs: number, all = false): SaveBucket[] {
    const out: SaveBucket[] = [];
    for (const [k, b] of this.buckets) {
      if (all || b.windowEnd <= nowMs) {
        out.push(b);
        this.buckets.delete(k);
      }
    }
    return out;
  }
}
