// list / show / approve / dismiss for rule-like notes. Approve is the human gate:
// it edits only `status` and `reviewed` in the frontmatter and nothing else.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Note, NoteStatus } from "../types.ts";
import { splitFrontmatter } from "../vault/frontmatter.ts";
import { loadVault } from "../vault/load.ts";
import { validateMeta } from "../vault/schema.ts";
import { parseCheckBlock } from "./checks.ts";
import { localToday } from "./util.ts";

const RULE_TYPES = new Set(["pattern", "rule"]);

export function ruleNotes(vaultDir: string, status?: string): Note[] {
  return loadVault(vaultDir).notes.filter((n) => RULE_TYPES.has(n.meta.type) && (!status || n.meta.status === status));
}

export interface FieldChange { field: string; from: string; to: string }

export interface EditResult {
  ok: boolean;
  reason?: string;
  changes: FieldChange[];
}

const FM = /^(﻿?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;

/**
 * Sets `status` (and optionally `reviewed`) in the frontmatter text and returns the new full text.
 * Every other byte, including the line endings and the body, is kept as it was.
 */
export function setFrontmatterFields(
  text: string,
  fields: { status: NoteStatus; reviewed?: string },
): { text: string; changes: FieldChange[] } | { error: string } {
  const m = FM.exec(text);
  if (!m) return { error: "no frontmatter" };
  const eol = m[1]!.includes("\r\n") ? "\r\n" : "\n";
  const lines = m[2]!.split(/\r?\n/);
  const changes: FieldChange[] = [];

  const setLine = (key: string, value: string, insertAfter?: string): boolean => {
    const i = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
    if (i >= 0) {
      const old = lines[i]!.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
      if (old === value) return true;
      lines[i] = `${key}: ${value}`;
      changes.push({ field: key, from: old || "(empty)", to: value });
      return true;
    }
    if (insertAfter === undefined) return false;
    const at = lines.findIndex((l) => new RegExp(`^${insertAfter}:`).test(l));
    lines.splice(at >= 0 ? at + 1 : lines.length, 0, `${key}: ${value}`);
    changes.push({ field: key, from: "(none)", to: value });
    return true;
  };

  if (!setLine("status", fields.status)) return { error: "no status line in the frontmatter" };
  if (fields.reviewed !== undefined) setLine("reviewed", fields.reviewed, "created");
  const head = text.slice(0, m.index) + m[1];
  const out = head + lines.join(eol) + m[3] + text.slice(m[0].length);
  return { text: out, changes };
}

function findNote(vaultDir: string, id: string): Note | undefined {
  return loadVault(vaultDir).notes.find((n) => n.meta.id === id);
}

export type EditCode = "not-found" | "wrong-type" | "transition" | "invalid";

export interface EditOutcome extends EditResult {
  code?: EditCode;
  from?: NoteStatus;
  to?: NoteStatus;
  /** Present after a successful change that wrote the file; lets the caller undo it byte for byte. */
  snapshot?: StatusSnapshot;
}

/** The file text before and after one status change. Held only in memory, by the caller. */
export interface StatusSnapshot {
  id: string;
  file: string;
  from: NoteStatus;
  to: NoteStatus;
  before: string;
  after: string;
}

export interface StatusOptions {
  /** Refuse unless the note currently has this status (guards against a stale screen). */
  from?: NoteStatus;
  /** Where the audit line says the change came from. */
  via?: "chat" | "cli";
  /** Date for `reviewed`; `false` leaves `reviewed` alone. Default: today. */
  reviewed?: string | false;
  now?: Date;
  /** Limit the change to these note types (the CLI rule commands use pattern and rule). */
  onlyTypes?: ReadonlySet<string>;
}

export type StatusDirs = { vaultDir: string; dataDir?: string | undefined };

export const AUDIT_FILE = "approvals.jsonl";

/** Appends one line of ids and statuses to data/approvals.jsonl. Never any note text. */
export function writeAudit(dataDir: string, e: { id: string; from: string; to: string; via: string; undo?: boolean }): void {
  mkdirSync(dataDir, { recursive: true });
  const line = { ts: new Date().toISOString(), id: e.id, from: e.from, to: e.to, via: e.via, ...(e.undo ? { undo: true } : {}) };
  appendFileSync(join(dataDir, AUDIT_FILE), JSON.stringify(line) + "\n");
}

const fail = (code: EditCode, reason: string): EditOutcome => ({ ok: false, code, reason, changes: [] });

/**
 * The human gate for ANY note type. Allowed: proposed/shadow -> active|deprecated, and
 * active -> deprecated. Edits only the `status:` and `reviewed:` lines; the body, the other
 * fields and the line endings stay byte for byte. Re-indexing is the caller's job (it owns the db).
 */
export function setNoteStatus(cfg: StatusDirs, id: string, to: "active" | "deprecated", opts: StatusOptions = {}): EditOutcome {
  if (to !== "active" && to !== "deprecated") return fail("invalid", `cannot set status to "${String(to)}"`);
  const note = findNote(cfg.vaultDir, id);
  if (!note) return fail("not-found", `no valid note with id "${id}" (a note that fails validation cannot be changed here)`);
  if (opts.onlyTypes && !opts.onlyTypes.has(note.meta.type)) {
    return fail("wrong-type", `"${id}" is a ${note.meta.type} note, not a pattern or rule`);
  }
  const from = note.meta.status;
  if (opts.from !== undefined && opts.from !== from) return fail("transition", `"${id}" is ${from} now, not ${opts.from}`);
  if (to === "active" && from !== "proposed" && from !== "shadow") {
    return fail("transition", `"${id}" is ${from}; only proposed or shadow notes can be approved`);
  }
  if (to === "deprecated" && from === "deprecated") return fail("transition", `"${id}" is already deprecated`);
  if (to === "deprecated" && from !== "proposed" && from !== "shadow" && from !== "active") {
    return fail("transition", `"${id}" is ${from}; it cannot be dismissed from here`);
  }
  if (to === "active" && RULE_TYPES.has(note.meta.type)) {
    const c = parseCheckBlock(note.body);
    if (c.state === "invalid") return fail("invalid", c.reason);
  }
  const path = join(cfg.vaultDir, note.file);
  const text = readFileSync(path, "utf8");
  const reviewed = opts.reviewed === false ? undefined : (opts.reviewed ?? localToday(opts.now));
  const edited = setFrontmatterFields(text, reviewed ? { status: to, reviewed } : { status: to });
  if ("error" in edited) return fail("invalid", edited.error);
  // The edited note must still pass the same validation the vault loader uses.
  const sp = splitFrontmatter(edited.text);
  const v = validateMeta(sp.data, note.file);
  if (!v.meta) return fail("invalid", `the edited note would fail validation: ${v.problems[0]?.message}`);
  if (edited.changes.length === 0) return { ok: true, changes: [], from, to };
  writeFileSync(path, edited.text);
  if (cfg.dataDir) writeAudit(cfg.dataDir, { id, from, to, via: opts.via ?? "cli" });
  return { ok: true, changes: edited.changes, from, to, snapshot: { id, file: note.file, from, to, before: text, after: edited.text } };
}

/** Puts a note back exactly as it was, but only if the file still holds what the change wrote. */
export function revertNoteStatus(cfg: StatusDirs, snap: StatusSnapshot, via: "chat" | "cli" = "chat"): { ok: boolean; reason?: string } {
  const note = findNote(cfg.vaultDir, snap.id);
  if (!note || note.file !== snap.file) return { ok: false, reason: "that note is no longer there" };
  const path = join(cfg.vaultDir, snap.file);
  if (readFileSync(path, "utf8") !== snap.after) return { ok: false, reason: "the note was changed since, so it was not put back" };
  writeFileSync(path, snap.before);
  if (cfg.dataDir) writeAudit(cfg.dataDir, { id: snap.id, from: snap.to, to: snap.from, via, undo: true });
  return { ok: true };
}

/** The human gate for pattern and rule notes: status -> active, reviewed -> today. Nothing else changes. */
export function approveRule(vaultDir: string, id: string, now?: Date, dataDir?: string): EditResult {
  const r = setNoteStatus({ vaultDir, dataDir }, id, "active", { via: "cli", ...(now ? { now } : {}), onlyTypes: RULE_TYPES });
  return { ok: r.ok, ...(r.reason ? { reason: r.reason } : {}), changes: r.changes };
}

/** Status -> deprecated. Nothing else changes. */
export function dismissRule(vaultDir: string, id: string, dataDir?: string): EditResult {
  const r = setNoteStatus({ vaultDir, dataDir }, id, "deprecated", { via: "cli", reviewed: false, onlyTypes: RULE_TYPES });
  return { ok: r.ok, ...(r.reason ? { reason: r.reason } : {}), changes: r.changes };
}