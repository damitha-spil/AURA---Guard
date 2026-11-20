import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { maskOutgoing } from "../mask/mask.ts";
import type { GuardConfig } from "../types.ts";
import { validateMeta } from "../vault/schema.ts";
import { loadStoredPrs, repoDir } from "./store.ts";
import type { StoredPr, StoredThread } from "./store.ts";

export type Outcome = "accepted" | "disputed" | "unknown";

export interface PrCandidate {
  pr: number;
  thread: number;
  hash: string;
  date: string;
  file?: string;
  line?: number;
  said: string; // masked reviewer text
  authorReply?: string; // masked, first reply by the PR author
  outcome: Outcome;
  score: number; // 0..1
}

const MIN_TEXT = 20; // shorter comments ("ok", "nit") carry no rule
const MAX_TEXT = 1500; // longer ones are pastes or essays
const QUOTE_MAX = 600;

/** Nothing to learn from these. */
const PRAISE = /^\s*(lgtm|looks good( to me)?|nice( work| one)?|thanks?( you)?|done|ok(ay)?|great|good (catch|job)|\+1|approved?)\W*$/i;

interface Rule {
  re: RegExp;
  weight: number;
}
// Each matching rule adds its weight; the text score is capped at 1.
const RULES: Rule[] = [
  { re: /\b(please|pls)\b/i, weight: 0.2 },
  { re: /\b(should(n'?t)?|must|needs? to|has to|have to)\b/i, weight: 0.35 },
  { re: /\b(don'?t|do not|never|avoid)\b/i, weight: 0.35 },
  { re: /\binstead\b|\brather than\b/i, weight: 0.35 },
  { re: /\buse\s+\S+(\s+\S+){0,3}\s+(not|instead of|rather than)\s+\S+/i, weight: 0.4 },
  { re: /\b(remove|delete|drop)\b/i, weight: 0.25 },
  { re: /\b(move|rename|extract|split|inline)\b/i, weight: 0.25 },
  { re: /\b(missing|add|needs?)\s+(a\s+|some\s+)?(unit\s+)?(tests?|checks?|validation|error handling)\b/i, weight: 0.4 },
  { re: /\bwhy\b[^?]*\?/i, weight: 0.25 },
  { re: /\b(because|otherwise|so that)\b/i, weight: 0.15 },
  { re: /\b(convention|rule|policy|always|standard)\b/i, weight: 0.3 },
];

/** How the thread ended, as the reviewer's request being taken up (accepted) or turned down (disputed). */
export function outcomeOf(status: string): Outcome {
  if (status === "fixed" || status === "closed") return "accepted";
  if (status === "wontFix" || status === "byDesign") return "disputed";
  return "unknown";
}

// Outcome and reply adjustments to the text score (documented so they can be tuned).
const ACCEPTED_BONUS = 0.2; // the author fixed it: the request was right
const DISPUTED_PENALTY = 0.25; // turned down: not a rule yet
const REPLY_BONUS = 0.1; // the author answered: a real exchange
const FILE_BONUS = 0.05; // tied to a line of code

/** Text-only score, 0..1, or undefined when the comment is too short, long or only praise. */
export function scoreText(text: string): number | undefined {
  const t = text.trim();
  if (t.length < MIN_TEXT || PRAISE.test(t)) return undefined;
  let s = 0;
  for (const r of RULES) if (r.re.test(t)) s += r.weight;
  if (t.length > MAX_TEXT) s -= 0.2;
  s = Math.max(0, Math.min(1, s));
  return s >= 0.2 ? s : undefined;
}

export function scoreThread(t: StoredThread): { score: number; best: number; outcome: Outcome } | undefined {
  let best = -1;
  let bestText = 0;
  t.comments.forEach((c, i) => {
    if (c.isAuthor) return;
    const s = scoreText(c.text);
    if (s !== undefined && s > bestText) {
      bestText = s;
      best = i;
    }
  });
  if (best < 0) return undefined;
  const outcome = outcomeOf(t.status);
  let score = bestText;
  if (outcome === "accepted") score += ACCEPTED_BONUS;
  if (outcome === "disputed") score -= DISPUTED_PENALTY;
  if (t.comments.slice(best + 1).some((c) => c.isAuthor)) score += REPLY_BONUS;
  if (t.file) score += FILE_BONUS;
  return { score: Math.round(Math.max(0, Math.min(1, score)) * 100) / 100, best, outcome };
}

export function candidateHash(repoId: string, pr: number, thread: number): string {
  return createHash("sha256").update(`${repoId}|${pr}|${thread}`).digest("hex").slice(0, 12);
}

export function findCandidates(repoId: string, prs: StoredPr[]): PrCandidate[] {
  const out: PrCandidate[] = [];
  for (const pr of prs) {
    for (const t of pr.threads) {
      const s = scoreThread(t);
      if (!s) continue;
      const c = t.comments[s.best]!;
      const reply = t.comments.slice(s.best + 1).find((x) => x.isAuthor);
      out.push({
        pr: pr.id,
        thread: t.id,
        hash: candidateHash(repoId, pr.id, t.id),
        date: (c.date || pr.closed || pr.created || "").slice(0, 10),
        ...(t.file ? { file: t.file } : {}),
        ...(t.line !== undefined ? { line: t.line } : {}),
        said: c.text,
        ...(reply ? { authorReply: reply.text } : {}),
        outcome: s.outcome,
        score: s.score,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The folders that get the most review comments (first three path parts). */
export function recurringAreas(prs: StoredPr[], top = 8): { area: string; comments: number }[] {
  const counts = new Map<string, number>();
  for (const pr of prs) {
    for (const t of pr.threads) {
      if (!t.file) continue;
      const n = t.comments.filter((c) => !c.isAuthor).length;
      if (!n) continue;
      const parts = t.file.split("/");
      const area = parts.slice(0, Math.min(3, Math.max(1, parts.length - 1))).join("/");
      counts.set(area, (counts.get(area) ?? 0) + n);
    }
  }
  return [...counts.entries()].map(([area, comments]) => ({ area, comments })).sort((a, b) => b.comments - a.comments).slice(0, top);
}

function bandOf(s: number): string {
  return s >= 0.8 ? "0.8-1.0" : s >= 0.6 ? "0.6-0.8" : s >= 0.4 ? "0.4-0.6" : "below 0.4";
}

function quote(s: string): string {
  return s.slice(0, QUOTE_MAX).split("\n").map((l) => `> ${l}`).join("\n");
}

function seenHashes(cfg: GuardConfig, repoId: string): Set<string> {
  const seen = new Set<string>();
  const inbox = join(cfg.vaultDir, "inbox");
  if (existsSync(inbox)) {
    for (const f of readdirSync(inbox)) {
      if (!f.endsWith(".md")) continue;
      const m = /<!--\s*pr:\s*\d+\s+thread:\s*\d+\s+hash:\s*([0-9a-f]+)\s*-->/.exec(readFileSync(join(inbox, f), "utf8"));
      if (m) seen.add(m[1]!);
    }
  }
  // Also remember what was written once, in case the owner moved the note out of the inbox.
  try {
    for (const h of JSON.parse(readFileSync(join(repoDir(cfg, repoId), "mined.json"), "utf8")) as string[]) seen.add(h);
  } catch {
    // no record yet
  }
  return seen;
}

export interface PrMineResult {
  prs: number;
  threads: number;
  comments: number;
  candidates: number;
  bands: Record<string, number>;
  blockedBySecret: number;
  written: string[];
  skippedDuplicate: number;
  areas: { area: string; comments: number }[];
}

export function minePrs(
  cfg: GuardConfig,
  repoId: string,
  o: { minScore?: number; max?: number; dryRun?: boolean } = {},
): PrMineResult {
  const minScore = o.minScore ?? 0.6;
  const max = o.max ?? 20;
  const prs = loadStoredPrs(cfg, repoId);
  const cands = findCandidates(repoId, prs);
  const bands: Record<string, number> = {};
  for (const c of cands) bands[bandOf(c.score)] = (bands[bandOf(c.score)] ?? 0) + 1;
  const res: PrMineResult = {
    prs: prs.length,
    threads: prs.reduce((n, p) => n + p.threads.length, 0),
    comments: prs.reduce((n, p) => n + p.threads.reduce((m, t) => m + t.comments.length, 0), 0),
    candidates: cands.length,
    bands,
    blockedBySecret: 0,
    written: [],
    skippedDuplicate: 0,
    areas: recurringAreas(prs),
  };
  if (!o.dryRun) {
    mkdirSync(repoDir(cfg, repoId), { recursive: true });
    writeFileSync(join(repoDir(cfg, repoId), "themes.json"), JSON.stringify(res.areas, null, 2));
  }
  if (o.dryRun) return res;

  const inbox = join(cfg.vaultDir, "inbox");
  const seen = seenHashes(cfg, repoId);
  for (const c of cands) {
    if (c.score < minScore) break;
    if (res.written.length >= max) break;
    if (seen.has(c.hash)) {
      res.skippedDuplicate++;
      continue;
    }
    // Masked once when stored, and again here before anything goes into the vault.
    const a = maskOutgoing(c.said);
    const b = c.authorReply ? maskOutgoing(c.authorReply) : undefined;
    if (!a.ok || (b && !b.ok)) {
      res.blockedBySecret++;
      continue;
    }
    const title = `PR review comment on ${c.date || "unknown date"} (${c.hash.slice(0, 6)})`;
    const id = `choice-pr-${c.hash}`;
    const meta = {
      id,
      type: "choice",
      status: "proposed",
      audience: ["internal_dev"],
      source: "pr-comment",
      title,
      created: new Date().toISOString().slice(0, 10),
    };
    const v = validateMeta(meta, `inbox/${id}.md`);
    if (!v.meta) throw new Error(`generated note failed validation: ${v.problems[0]?.message}`);
    const where = c.file ? `File: ${c.file}${c.line !== undefined ? ` (line ${c.line})` : ""}` : "No file: a general comment.";
    const body =
      `# ${title}\n\n## Context\n\n${where}\n\n${b ? `The author replied:\n\n${quote(b.text)}\n\n` : ""}` +
      `## What the reviewer said\n\n${quote(a.text)}\n\n## Outcome\n\n${c.outcome}\n\n## Possible rule\n\n\n\n` +
      `<!-- pr: ${c.pr} thread: ${c.thread} hash: ${c.hash} -->\n`;
    mkdirSync(inbox, { recursive: true });
    const file = join(inbox, `${id}.md`);
    writeFileSync(file, `---\n${stringify(meta, { lineWidth: 0 })}---\n\n${body}`, { flag: "wx" });
    res.written.push(file);
    seen.add(c.hash);
  }
  if (res.written.length) {
    writeFileSync(join(repoDir(cfg, repoId), "mined.json"), JSON.stringify([...seen], null, 2));
  }
  return res;
}
