import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { maskOutgoing } from "../mask/mask.ts";
import type { Identity } from "./azure.ts";

/** Per-install random salt, kept in data/prs/.salt (data/ is git-ignored). */
export function loadSalt(prsDir: string): string {
  const file = join(prsDir, ".salt");
  if (existsSync(file)) {
    const s = readFileSync(file, "utf8").trim();
    if (s.length >= 16) return s;
  }
  mkdirSync(dirname(file), { recursive: true });
  const salt = randomBytes(24).toString("hex");
  writeFileSync(file, salt + "\n", { mode: 0o600 });
  return salt;
}

/** A stable short stand-in for a person: p-<6 hex>. Names, emails and ids are never stored. */
export function personHash(salt: string, who: Identity | undefined): string {
  const key = who?.id ?? who?.uniqueName ?? who?.displayName ?? "unknown";
  return "p-" + createHash("sha256").update(`${salt}:${key}`).digest("hex").slice(0, 6);
}

export function sameIdentity(a: Identity | undefined, b: Identity | undefined): boolean {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  if (a.uniqueName && b.uniqueName) return a.uniqueName === b.uniqueName;
  return !!a.displayName && a.displayName === b.displayName;
}

const MIN_NAME_TOKEN = 4;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words that identify people seen in one PR (display names, name parts, sign-in names). */
export function nameTerms(people: (Identity | undefined)[]): string[] {
  const out = new Set<string>();
  for (const p of people) {
    if (!p) continue;
    for (const full of [p.displayName, p.uniqueName]) {
      if (!full) continue;
      if (full.length >= MIN_NAME_TOKEN) out.add(full);
      const local = full.split("@")[0] ?? "";
      if (local.length >= MIN_NAME_TOKEN) out.add(local);
      for (const t of full.split(/[\s.,@_\\-]+/)) if (t.length >= MIN_NAME_TOKEN) out.add(t);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export interface Cleaned {
  /** Masked, name-free text; undefined when a secret was found (drop the item). */
  text?: string;
  secret: boolean;
}

/** Masks text for storage: secrets drop the item, sensitive values become placeholders, people become [person]. */
export function cleanText(raw: string, names: string[]): Cleaned {
  const m = maskOutgoing(raw);
  if (!m.ok) return { secret: true };
  let t = m.text.replace(/@<[0-9a-f-]{36}>/gi, "@[person]");
  if (names.length) {
    const re = new RegExp(`(?<![A-Za-z0-9])(?:${names.map(escapeRe).join("|")})(?![A-Za-z0-9])`, "gi");
    t = t.replace(re, "[person]");
  }
  return { text: t, secret: false };
}

/** Branch names may start with a person's name; keep well-known prefixes, hash the rest. */
const COMMON_PREFIXES = new Set([
  "feature", "features", "fix", "bugfix", "hotfix", "release", "releases", "task", "tasks", "chore", "docs", "refactor",
  "test", "tests", "dev", "development", "main", "master", "users", "user", "topic", "wip",
]);

export function branchName(ref: string | undefined, salt: string): string {
  const name = (ref ?? "").replace(/^refs\/heads\//, "");
  const slash = name.indexOf("/");
  if (slash < 0) return name;
  const first = name.slice(0, slash);
  if (COMMON_PREFIXES.has(first.toLowerCase())) return name;
  return personHash(salt, { id: `branch:${first}` }).replace("p-", "u-") + name.slice(slash);
}
