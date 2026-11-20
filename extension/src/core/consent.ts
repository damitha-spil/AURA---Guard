import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Consent {
  version: 1;
  acceptedAt: string;
  developer: string;
  repos: Record<string, boolean>;
}

export function readConsent(spoolDir: string): Consent | null {
  try {
    const j = JSON.parse(readFileSync(join(spoolDir, "consent.json"), "utf8")) as Partial<Consent>;
    if (j.version !== 1 || typeof j.developer !== "string" || !j.repos || typeof j.repos !== "object") return null;
    return { version: 1, acceptedAt: String(j.acceptedAt ?? ""), developer: j.developer, repos: j.repos };
  } catch {
    return null;
  }
}

/** Adds one workspace to the consent file (written to a temp file, then renamed). */
export function grantConsent(spoolDir: string, developer: string, repo: string, now: Date): Consent {
  const old = readConsent(spoolDir);
  const next: Consent = {
    version: 1,
    acceptedAt: old?.acceptedAt || now.toISOString(),
    developer,
    repos: { ...(old?.repos ?? {}), [repo]: true },
  };
  mkdirSync(spoolDir, { recursive: true });
  const tmp = join(spoolDir, `consent.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, join(spoolDir, "consent.json"));
  return next;
}

export function hasConsent(c: Consent | null, repo: string): boolean {
  return !!c && c.repos[repo] === true;
}
