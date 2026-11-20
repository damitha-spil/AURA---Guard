// Support writer: drafts a customer-safe procedure from INTERNAL notes. The draft is a PROPOSED
// note in vault/support/ (audience customer_support). It never writes into Aura.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { CompleteFn } from "../brain/client.ts";
import type { Db } from "../index/db.ts";
import { getDoc, search } from "../index/search.ts";
import { slugify } from "../vault/new.ts";
import { splitFrontmatter } from "../vault/frontmatter.ts";
import { validateMeta } from "../vault/schema.ts";
import { loadVault } from "../vault/load.ts";
import { localToday } from "../rules/util.ts";
import { describeReasons, leakCheck, loadForbiddenTerms } from "./leak.ts";
import type { LeakReason } from "./leak.ts";

/** Internal notes handed to the model. */
export const MAX_SOURCE_NOTES = 5;
/** Characters of one source note sent to the model (about 4 chars per token). */
export const MAX_SOURCE_CHARS = 2500;
export const DRAFT_MAX_TOKENS = 900;
/** One retry with the reasons, then give up. */
export const MAX_ATTEMPTS = 2;

export const SUPPORT_DIR = "support";

export const WRITER_RULES = [
  "You write short help text for the staff of a glass fabricator who use the Aura app. Use plain words.",
  "Use only the internal notes below. Do not add facts that are not in them.",
  "Write Markdown: a first line `# <title>`, then the sections `## What to do` (numbered steps), `## What to expect`, `## Known limits`, `## When to ask for help`.",
  "The reader is not a developer. NEVER include: code, file names or file paths, file extensions, commit ids,",
  "web addresses, IP addresses, server or computer names, tool or library names, bug history or",
  "how it was fixed, or any customer or staff name. If a step can only be explained with such detail, leave it out.",
  "If the notes do not cover something, say it is not covered and tell the reader to ask for help.",
].join("\n");

export interface DraftSource { id: string; title: string; text: string }

export function gatherSources(db: Db, topic: string, limit = MAX_SOURCE_NOTES): DraftSource[] {
  const out: DraftSource[] = [];
  for (const h of search(db, topic, { audience: "internal_dev", kinds: ["note"], limit })) {
    const d = getDoc(db, h.ref, "internal_dev");
    if (!d) continue;
    out.push({ id: h.ref, title: h.title, text: d.body.slice(0, MAX_SOURCE_CHARS) });
  }
  return out;
}

export function buildPrompt(topic: string, sources: DraftSource[], retryReasons?: string[]): { system: string[]; user: string } {
  const notes = sources.map((s) => `Note "${s.title}":\n${s.text}`).join("\n\n---\n\n");
  const retry = retryReasons?.length
    ? `\n\nYour last draft was rejected by an automatic check: ${retryReasons.join("; ")}. Write it again without those.`
    : "";
  return { system: [WRITER_RULES, "Internal notes:\n\n" + notes], user: `Topic: ${topic}${retry}` };
}

/** Pulls the title out of the draft and returns the text with a normal heading layout. */
export function parseDraft(text: string, topic: string): { title: string; body: string } {
  const t = text.trim().replace(/^```(?:markdown|md)?\s*\n/i, "").replace(/\n```\s*$/, "").trim();
  const m = /^#\s+(.+)$/m.exec(t);
  const title = m?.[1]?.trim() || topic;
  const body = t.replace(/^#\s+.+\r?\n?/m, "").trim();
  return { title, body };
}

export type DraftResult =
  | { ok: true; id: string; file: string; title: string; headings: string[]; attempts: number; sources: string[] }
  | { ok: false; reason: "no-sources" | "leak" | "empty"; reasons: string[]; attempts: number };

export interface DraftOptions { now?: Date; maxAttempts?: number }

export function headingsOf(md: string): string[] {
  return [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]!.trim());
}

function freeId(supportDir: string, base: string): string {
  let id = base;
  for (let n = 2; existsSync(join(supportDir, `${id}.md`)); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Writes the draft as a proposed note after validating its frontmatter. Refuses a draft that
 * fails the leak check; this is the only function that writes a support note.
 */
export function writeSupportNote(
  vaultDir: string, title: string, body: string, sourceIds: string[], now?: Date,
): { ok: true; id: string; file: string } | { ok: false; reasons: LeakReason[] } {
  const supportDir = join(vaultDir, SUPPORT_DIR);
  const forbidden = loadForbiddenTerms(supportDir);
  const check = leakCheck(`# ${title}\n\n${body}`, forbidden);
  if (!check.ok) return { ok: false, reasons: check.reasons };
  mkdirSync(supportDir, { recursive: true });
  const id = freeId(supportDir, `domain-support-${slugify(title).replace(/^support-/, "")}`);
  const meta = {
    id,
    type: "domain",
    status: "proposed",
    audience: ["customer_support"],
    source: "evidence",
    title,
    created: localToday(now),
  };
  const v = validateMeta(meta, `${SUPPORT_DIR}/${id}.md`);
  if (!v.meta) throw new Error(`generated note failed validation: ${v.problems[0]?.message}`);
  // The provenance sits in a comment that export removes, so internal note ids never reach customers.
  const text =
    `---\n${stringify(meta, { lineWidth: 0 })}---\n\n# ${title}\n\n${body.trim()}\n\n` +
    `<!-- drafted from internal notes: ${sourceIds.join(", ")} -->\n`;
  const file = join(supportDir, `${id}.md`);
  writeFileSync(file, text, { flag: "wx" });
  return { ok: true, id, file };
}

export async function draftSupport(
  db: Db, vaultDir: string, topic: string, complete: CompleteFn, opts: DraftOptions = {},
): Promise<DraftResult> {
  const sources = gatherSources(db, topic);
  if (sources.length === 0) return { ok: false, reason: "no-sources", reasons: ["no internal note covers this topic"], attempts: 0 };
  const forbidden = loadForbiddenTerms(join(vaultDir, SUPPORT_DIR));
  const max = opts.maxAttempts ?? MAX_ATTEMPTS;
  let reasons: string[] = [];
  let attempts = 0;
  while (attempts < max) {
    attempts++;
    const p = buildPrompt(topic, sources, attempts > 1 ? reasons : undefined);
    const r = await complete({ role: "support", system: p.system, user: p.user, maxTokens: DRAFT_MAX_TOKENS });
    const { title, body } = parseDraft(r.text, topic);
    if (!body) {
      reasons = ["the draft was empty"];
      continue;
    }
    const check = leakCheck(`# ${title}\n\n${body}`, forbidden);
    if (!check.ok) {
      reasons = describeReasons(check.reasons);
      continue;
    }
    const w = writeSupportNote(vaultDir, title, body, sources.map((s) => s.id), opts.now);
    if (!w.ok) {
      reasons = describeReasons(w.reasons);
      continue;
    }
    return { ok: true, id: w.id, file: w.file, title, headings: headingsOf(body), attempts, sources: sources.map((s) => s.id) };
  }
  return { ok: false, reason: reasons[0] === "the draft was empty" ? "empty" : "leak", reasons, attempts };
}

/** Support notes in the vault (any audience list that includes customer_support). */
export function supportNotes(vaultDir: string): { id: string; status: string; title: string; file: string }[] {
  return loadVault(vaultDir).notes
    .filter((n) => n.meta.audience.includes("customer_support"))
    .map((n) => ({ id: n.meta.id, status: n.meta.status, title: n.meta.title ?? n.meta.id, file: n.file }));
}

export type ExportResult =
  | { ok: true; file: string; status: string }
  | { ok: false; reason: string; reasons?: string[] };

/** Customer-facing Markdown: frontmatter and comments removed. Writes only under data/support-export/. */
export function exportSupport(vaultDir: string, dataDir: string, id: string): ExportResult {
  const note = loadVault(vaultDir).notes.find((n) => n.meta.id === id);
  if (!note || !note.meta.audience.includes("customer_support")) {
    return { ok: false, reason: `no customer support note with id "${id}"` };
  }
  const sp = splitFrontmatter(readFileSync(join(vaultDir, note.file), "utf8"));
  const md = sp.body.replace(/<!--[\s\S]*?-->/g, "").trim() + "\n";
  const check = leakCheck(md, loadForbiddenTerms(join(vaultDir, SUPPORT_DIR)));
  if (!check.ok) return { ok: false, reason: "the note fails the leak check", reasons: describeReasons(check.reasons) };
  const dir = join(dataDir, "support-export");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.md`);
  writeFileSync(file, md);
  return { ok: true, file, status: note.meta.status };
}
