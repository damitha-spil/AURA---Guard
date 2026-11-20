import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { maskOutgoing } from "../mask/mask.ts";
import { validateMeta } from "../vault/schema.ts";
import type { Candidate } from "./corrections.ts";

export function candidateHash(c: Pick<Candidate, "session" | "ts">): string {
  return createHash("sha256").update(`${c.session}|${c.ts}`).digest("hex").slice(0, 12);
}

/** Masks a candidate's text. Returns undefined when a secret is found: the candidate must be dropped. */
export function maskCandidate(c: Candidate): Candidate | undefined {
  const a = maskOutgoing(c.context);
  const b = maskOutgoing(c.owner);
  if (!a.ok || !b.ok) return undefined;
  return { ...c, context: a.text, owner: b.text };
}

function existingHashes(inbox: string): Set<string> {
  const seen = new Set<string>();
  if (!existsSync(inbox)) return seen;
  for (const f of readdirSync(inbox)) {
    if (!f.endsWith(".md")) continue;
    const m = /<!--\s*session:\s*\S+\s+\S+\s+hash:([0-9a-f]+)\s*-->/.exec(readFileSync(join(inbox, f), "utf8"));
    if (m) seen.add(m[1]!);
  }
  return seen;
}

function quote(s: string): string {
  return s.split("\n").map((l) => `> ${l}`).join("\n");
}

/**
 * Writes proposed `choice` notes into vault/inbox/ (newNote forces the type
 * folder, so this is a small writer with the same frontmatter fields).
 * Text is masked again here; a candidate with a secret is dropped and counted.
 */
export function writeCandidates(
  vaultDir: string,
  candidates: Candidate[],
  opts: { minScore?: number; max?: number } = {},
): { written: string[]; skippedDuplicate: number; blocked: number } {
  const minScore = opts.minScore ?? 0.6;
  const max = opts.max ?? 30;
  const inbox = join(vaultDir, "inbox");
  const seen = existingHashes(inbox);
  const written: string[] = [];
  let skippedDuplicate = 0;
  let blocked = 0;
  const ranked = candidates.filter((c) => c.score >= minScore).sort((a, b) => b.score - a.score);
  for (const c of ranked) {
    if (written.length >= max) break;
    const h = candidateHash(c);
    if (seen.has(h)) {
      skippedDuplicate++;
      continue;
    }
    const m = maskCandidate(c);
    if (!m) {
      blocked++;
      continue;
    }
    seen.add(h);
    // Titles and ids stay neutral; the owner's own words live only in the body.
    const day = String(m.ts).slice(0, 10);
    const title = `Owner ${m.kind} on ${day} (${h.slice(0, 6)})`;
    const id = `choice-session-${h}`;
    const meta = {
      id,
      type: "choice",
      status: "proposed",
      audience: ["internal_dev"],
      source: "session",
      title,
      created: new Date().toISOString().slice(0, 10),
    };
    const v = validateMeta(meta, `inbox/${id}.md`);
    if (!v.meta) throw new Error(`generated note failed validation: ${v.problems[0]?.message}`);
    const body =
      `# ${title}\n\n## Context\n\n${quote(m.context)}\n\n## What the owner said\n\n${quote(m.owner)}\n\n` +
      `## Possible rule\n\n\n\n<!-- session: ${m.session} ${m.ts} hash:${h} -->\n`;
    mkdirSync(inbox, { recursive: true });
    const file = join(inbox, `${id}.md`);
    writeFileSync(file, `---\n${stringify(meta, { lineWidth: 0 })}---\n\n${body}`, { flag: "wx" });
    written.push(file);
  }
  return { written, skippedDuplicate, blocked };
}
