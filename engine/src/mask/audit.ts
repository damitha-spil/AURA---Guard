import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface EgressRecord {
  ts: string; // ISO timestamp
  role: string;
  model: string;
  sha256: string; // hash of the masked payload
  blocked: { kind: string; count: number }[];
  replaced: { kind: string; count: number }[];
}

function counts(list: { kind: string; count: number }[]): { kind: string; count: number }[] {
  return list.map((c) => ({ kind: String(c.kind), count: Number(c.count) }));
}

/**
 * Appends one JSON line to <logDir>/egress-YYYY-MM-DD.jsonl.
 * Only hashes and counts are written. The record type has no field for the
 * payload, and unknown fields on the input are dropped.
 */
export function auditOutgoing(logDir: string, record: EgressRecord): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(record.ts)?.[0] ?? new Date().toISOString().slice(0, 10);
  mkdirSync(logDir, { recursive: true });
  const file = join(logDir, `egress-${day}.jsonl`);
  const line = {
    ts: record.ts,
    role: record.role,
    model: record.model,
    sha256: record.sha256,
    blocked: counts(record.blocked),
    replaced: counts(record.replaced),
  };
  appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
  return file;
}
