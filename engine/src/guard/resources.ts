import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import type { GuardConfig } from "../types.ts";

const run = promisify(execFile);

/**
 * Below this much free memory we pause background work. Rust builds of Aura
 * can use several GB and this PC has run out of memory during them, so we
 * leave a generous margin rather than waiting for the OS to start paging.
 */
export const LOW_MEMORY_MB = 2048;

function norm(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/, "");
}

/** Parses `tasklist /fo csv /nh` output into image names (first CSV column). */
export function parseTasklistCsv(csv: string): string[] {
  const names: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"((?:[^"]|"")*)"/.exec(line.trim());
    if (m?.[1]) names.push(m[1].replace(/""/g, '"'));
  }
  return names;
}

export function parsePsComm(out: string): string[] {
  return out.split(/\r?\n/).map((l) => l.trim().split("/").pop() ?? "").filter(Boolean);
}

export async function busyProcesses(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  let running: string[];
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      running = parseTasklistCsv(stdout);
    } else {
      const { stdout } = await run("ps", ["-A", "-o", "comm="], { maxBuffer: 16 * 1024 * 1024 });
      running = parsePsComm(stdout);
    }
  } catch {
    return []; // cannot tell; memoryPressure still protects the machine
  }
  const set = new Set(running.map(norm));
  return names.filter((n) => set.has(norm(n)));
}

export function memoryPressure(): { freeMb: number; totalMb: number; low: boolean } {
  const freeMb = Math.round(freemem() / 1048576);
  const totalMb = Math.round(totalmem() / 1048576);
  return { freeMb, totalMb, low: freeMb < LOW_MEMORY_MB };
}

export async function canRunHeavyWork(cfg: GuardConfig): Promise<{ ok: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const busy = await busyProcesses(cfg.busyProcesses);
  for (const b of busy) reasons.push(`${b} is running`);
  const mem = memoryPressure();
  if (mem.low) reasons.push(`low memory: ${mem.freeMb} MB free of ${mem.totalMb} MB`);
  return { ok: reasons.length === 0, reasons };
}
