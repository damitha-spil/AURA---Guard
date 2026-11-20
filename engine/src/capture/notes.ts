// Decisions and corrections from the editor become PROPOSED `choice` notes in THIS machine's
// vault inbox. Never in the repository being summarised. Same approach as sessions/to-notes.ts:
// neutral titles, dedupe by hash, masked, validated with validateMeta.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { maskOutgoing } from "../mask/mask.ts";
import { validateMeta } from "../vault/schema.ts";
import type { CaptureEvent } from "./spool.ts";

export function noteHash(eventId: string): string {
  return createHash("sha256").update(`capture|${eventId}`).digest("hex").slice(0, 12);
}

function existingHashes(inbox: string): Set<string> {
  const seen = new Set<string>();
  if (!existsSync(inbox)) return seen;
  for (const f of readdirSync(inbox)) {
    if (!f.endsWith(".md")) continue;
    const m = /<!--\s*session:\s*\S+\s+\S+\s+hash:([0-9a-f]+)\s*-->/.exec(readFileSync(join(inbox, f), "utf8"));
    if (m) seen.add(m[1] as string);
  }
  return seen;
}

const quote = (s: string): string => s.split("\n").map((l) => `> ${l}`).join("\n");

export interface NotesResult { written: string[]; skippedDuplicate: number; blocked: number }

export function proposeChoiceNotes(vaultDir: string, events: CaptureEvent[], today: string): NotesResult {
  const inbox = join(vaultDir, "inbox");
  const seen = existingHashes(inbox);
  const written: string[] = [];
  let skippedDuplicate = 0;
  let blocked = 0;
  for (const ev of events) {
    if (ev.kind !== "decision" && ev.kind !== "correction") continue;
    const h = noteHash(ev.id);
    if (seen.has(h)) { skippedDuplicate++; continue; }
    const said = maskOutgoing(ev.data.text);
    const where = ev.data.context ? maskOutgoing(`${ev.data.context.path}:${ev.data.context.line}`) : null;
    if (!said.ok || (where && !where.ok)) { blocked++; continue; }
    seen.add(h);
    const day = ev.ts.slice(0, 10);
    const title = `Developer ${ev.kind} on ${day} (${h.slice(0, 6)})`;
    const id = `choice-capture-${h}`;
    const meta = {
      id, type: "choice", status: "proposed", audience: ["internal_dev"],
      source: "session", title, created: today,
    };
    const v = validateMeta(meta, `inbox/${id}.md`);
    if (!v.meta) throw new Error(`generated note failed validation: ${v.problems[0]?.message}`);
    const body =
      `# ${title}\n\n## Context\n\n${quote(where ? where.text : "(none)")}\n\n` +
      `## What the developer ${ev.kind === "decision" ? "decided" : "corrected"}\n\n${quote(said.text)}\n\n` +
      `## Possible rule\n\n\n\n<!-- session: capture ${ev.ts} hash:${h} -->\n`;
    mkdirSync(inbox, { recursive: true });
    const file = join(inbox, `${id}.md`);
    writeFileSync(file, `---\n${stringify(meta, { lineWidth: 0 })}---\n\n${body}`, { flag: "wx" });
    written.push(file);
  }
  return { written, skippedDuplicate, blocked };
}
