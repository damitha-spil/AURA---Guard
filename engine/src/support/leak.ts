// Deterministic LEAK CHECK for customer-facing drafts. No model is involved.
// A draft is rejected when it contains code or infrastructure detail a fabricator's staff must not see.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { maskOutgoing } from "../mask/mask.ts";

export interface LeakReason { kind: string; sample: string }
export interface LeakResult { ok: boolean; reasons: LeakReason[] }

/** Where companies keep their own extra forbidden words (customer names, host names, staff names). */
export const FORBIDDEN_TERMS_FILE = "forbidden-terms.json";

// Shown samples are clipped so a reason can be sent back to the model without repeating a long secret.
const SAMPLE_LEN = 40;

// Product defaults: internal jargon that never belongs in customer help. Companies add to this in
// vault/support/forbidden-terms.json ({"terms": [...]}); the file is merged with this list.
export const DEFAULT_FORBIDDEN_TERMS: readonly string[] = [
  "commit", "commits", "pull request", "branch", "merge conflict", "hotfix", "regression", "stack trace",
  "localhost", "tauri", "cargo", "repository", "github", "azure devops", "mcp", "jira", "handoff",
];

const RULES: { kind: string; re: RegExp }[] = [
  // C:\x, D:/x, \\server\share, ../x, ~/x, a/b/c, a\b\c
  { kind: "path", re: /(?:\b[A-Za-z]:[\\/]|\\\\[\w.$-]+\\|(?:^|[\s("'`])(?:\.{1,2}|~)\/|[\w.@-]+\/[\w.@-]+\/[\w.@-]+|[\w.@-]+\\[\w.@-]+)/gm },
  { kind: "file-extension", re: /(?:^|[\s\w`"'(/\\-])\.(?:rs|tsx?|jsx?|mjs|cjs|json|toml|ya?ml|md|py|cs|sql|css|html|lock|ps1|bat|exe|dll|env|cfg|ini|log)\b/gim },
  { kind: "commit-id", re: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi },
  { kind: "url", re: /\b(?:https?:\/\/|ftp:\/\/|www\.)\S+/gi },
  { kind: "ip-address", re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g },
  { kind: "host-name", re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|local|lan|internal|corp)\b/gi },
  { kind: "ticket-reference", re: /\b(?:PR|issue|bug|ticket)\s*#\s*\d+|#\d{2,}\b/gi },
];

const clip = (s: string): string => (s.length > SAMPLE_LEN ? s.slice(0, SAMPLE_LEN) + "..." : s);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Default terms plus the company's file in `supportDir` (a bad file is ignored, the defaults stay). */
export function loadForbiddenTerms(supportDir: string): string[] {
  const terms = new Set(DEFAULT_FORBIDDEN_TERMS.map((t) => t.toLowerCase()));
  const file = join(supportDir, FORBIDDEN_TERMS_FILE);
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { terms?: unknown };
      if (Array.isArray(raw.terms)) {
        for (const t of raw.terms) if (typeof t === "string" && t.trim()) terms.add(t.trim().toLowerCase());
      }
    } catch { /* keep the defaults */ }
  }
  return [...terms];
}

export function leakCheck(text: string, forbidden: readonly string[] = DEFAULT_FORBIDDEN_TERMS): LeakResult {
  const reasons: LeakReason[] = [];
  for (const { kind, re } of RULES) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) reasons.push({ kind, sample: clip(m[0].trim()) });
  }
  for (const term of forbidden) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "iu");
    const m = re.exec(text);
    if (m) reasons.push({ kind: "forbidden-term", sample: clip(m[0]) });
  }
  const masked = maskOutgoing(text);
  // Only the detector kinds are named: the matched secret itself is never repeated.
  for (const b of masked.blocked) reasons.push({ kind: "secret-detector", sample: b.kind });
  for (const r of masked.replaced) reasons.push({ kind: "sensitive-detector", sample: r.kind });
  return { ok: reasons.length === 0, reasons };
}

export function describeReasons(reasons: LeakReason[]): string[] {
  return reasons.map((r) =>
    r.kind === "secret-detector" || r.kind === "sensitive-detector"
      ? `${r.kind}: ${r.sample}`
      : `${r.kind}: "${r.sample}"`,
  );
}
