// Search over docs_fts. User text never reaches MATCH unescaped.

import type { Db } from "./db.ts";
import type { Audience, DocKind, NoteStatus, SearchHit, SearchOptions } from "../types.ts";

// Notes are written by people and checked, so they win over a commit or file
// whose score is close. The boost is small on purpose.
const NOTE_BOOST = 1.15;
// A title match counts ten times a body match.
const TITLE_WEIGHT = 10;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
const FTS_OPERATORS = new Set(["and", "or", "not", "near"]);

/** Turns free text into a safe FTS5 query, or "" when nothing searchable is left. */
// Common English words carry no meaning in a question and, OR-joined, let long
// files outrank the note that actually answers it. Dropped unless nothing else is left.
const STOP_WORDS = new Set(
  ("a an and are as at be but by can do does did for from has have how i if in is it its " +
    "of on or so that the their then there this to was we what when where which who why " +
    "will with you").split(" "),
);

export function toFtsQuery(text: string): string {
  const all = (text.match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => !FTS_OPERATORS.has(t.toLowerCase()));
  const meaningful = all.filter((t) => !STOP_WORDS.has(t.toLowerCase()));
  const tokens = meaningful.length > 0 ? meaningful : all;
  if (tokens.length === 0) return "";
  return tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? "*" : ""}`).join(" OR ");
}

function allowed(kind: string, audienceList: string, audience: Audience | undefined): boolean {
  if (!audience) return true;
  if (kind !== "note") return audience === "internal_dev";
  return audienceList.split(",").map((s) => s.trim()).includes(audience);
}

interface Row {
  kind: DocKind;
  ref: string;
  title: string;
  snippet: string;
  rank: number;
  status: string | null;
  audience: string;
}

export function search(db: Db, query: string, opts: SearchOptions = {}): SearchHit[] {
  const q = toFtsQuery(query);
  if (!q) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  // Over-fetch, then filter in code, so the audience rule lives in one place.
  const rows = db
    .prepare(
      `SELECT d.kind AS kind, d.ref AS ref, d.title AS title, d.status AS status, d.audience AS audience,
              snippet(docs_fts, 1, '[', ']', '...', 24) AS snippet,
              bm25(docs_fts, ${TITLE_WEIGHT}, 1) AS rank
       FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
       WHERE docs_fts MATCH ?
       ORDER BY rank LIMIT ?`,
    )
    .all(q, limit * 10 + 50) as unknown as Row[];
  const hits: SearchHit[] = [];
  for (const r of rows) {
    if (opts.kinds && !opts.kinds.includes(r.kind)) continue;
    if (!allowed(r.kind, r.audience, opts.audience)) continue;
    if (!opts.includeStale && (r.status === "stale" || r.status === "deprecated")) continue;
    const base = -r.rank; // bm25 is negative, lower is better
    const hit: SearchHit = {
      kind: r.kind,
      ref: r.ref,
      title: r.title,
      snippet: r.snippet,
      score: r.kind === "note" ? base * NOTE_BOOST : base,
    };
    if (r.status) hit.status = r.status as NoteStatus;
    hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export interface DocFull {
  kind: DocKind;
  ref: string;
  title: string;
  body: string;
  status?: NoteStatus;
}

export function getDoc(db: Db, ref: string, audience?: Audience): DocFull | null {
  const r = db.prepare("SELECT kind, ref, title, body, status, audience FROM docs WHERE ref=?").get(ref) as
    | { kind: DocKind; ref: string; title: string; body: string; status: string | null; audience: string }
    | undefined;
  if (!r || !allowed(r.kind, r.audience, audience)) return null;
  const out: DocFull = { kind: r.kind, ref: r.ref, title: r.title, body: r.body };
  if (r.status) out.status = r.status as NoteStatus;
  return out;
}
