// system_info, list_processes and get_time. No host name, user name or command lines.

import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { arch, cpus, freemem, release, totalmem, uptime, version } from "node:os";
import { join, parse } from "node:path";
import type { GuardConfig } from "../../types.ts";
import { ToolError, truncate } from "./common.ts";

export const MAX_PROCESSES = 50;
const PROCESS_TIMEOUT_MS = 15_000;
const GB = 1024 ** 3;

export function systemInfo(cfg: GuardConfig): string {
  const cpu = cpus();
  const lines = [
    `System: ${version()} (${process.platform} ${release()}, ${arch()})`,
    `Processor: ${cpu[0]?.model.trim() ?? "unknown"} (${cpu.length} logical)`,
    `Memory: ${(freemem() / GB).toFixed(1)} GB free of ${(totalmem() / GB).toFixed(1)} GB`,
    `Up for: ${Math.floor(uptime() / 3600)} h ${Math.floor((uptime() % 3600) / 60)} min`,
    `Node: ${process.versions.node}`,
  ];
  const drives = new Set([cfg.root, ...cfg.repos.map((r) => r.path)].map((p) => parse(p).root.toUpperCase()).filter(Boolean));
  for (const d of drives) {
    try {
      const s = statfsSync(join(d, "."));
      lines.push(`Disk ${d}: ${((s.bavail * s.bsize) / GB).toFixed(1)} GB free of ${((s.blocks * s.bsize) / GB).toFixed(1)} GB`);
    } catch { /* drive not present */ }
  }
  return lines.join("\n");
}

export type RunTaskList = () => Promise<string>;

const defaultTaskList: RunTaskList = () =>
  new Promise((resolve, reject) => {
    const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe");
    execFile(exe, ["/FO", "CSV", "/NH"], { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (e, stdout) =>
      e ? reject(new ToolError("Could not list processes.")) : resolve(stdout));
  });

/** Reads `tasklist /FO CSV`: name, pid, session name, session number, memory. */
export function parseTaskList(csv: string): { name: string; pid: number; kb: number }[] {
  return csv.split(/\r?\n/).flatMap((line) => {
    const f = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1] as string);
    if (f.length < 5) return [];
    return [{ name: f[0] as string, pid: Number(f[1]), kb: Number((f[4] as string).replace(/\D/g, "")) }];
  });
}

export async function listProcesses(run?: RunTaskList, platform: string = process.platform): Promise<string> {
  if (!run && platform !== "win32") throw new ToolError("Listing processes works on Windows only.");
  const all = parseTaskList(await (run ?? defaultTaskList)()).sort((a, b) => b.kb - a.kb);
  const rows = all.slice(0, MAX_PROCESSES).map((p) => `${p.name.padEnd(40)} ${String(p.pid).padStart(7)} ${(p.kb / 1024).toFixed(0).padStart(7)} MB`);
  return truncate([`${all.length} processes; the ${rows.length} using the most memory:`, ...rows].join("\n"));
}

export function getTime(now: Date = new Date()): string {
  return [
    `Local: ${now.toString()}`,
    `Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `UTC: ${now.toISOString()}`,
  ].join("\n");
}
