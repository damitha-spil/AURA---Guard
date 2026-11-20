// QA target resolution: what exactly should be QA'd? From the message, the chat so far and the
// the project's own git sources. READ-ONLY: only `git rev-parse`, `merge-base`, `log` and `cat-file`
// run, and only in the repos of this project's cfg.
// When nothing can be resolved the answer is `needsInput`, never a guess, and nothing runs.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatTurn } from "../chat/answer.ts";
import { detectIntent, stripSlash } from "../chat/intent.ts";
import { defaultBase } from "../review/diff.ts";
import { gitTry, pathExistsAt, revParse } from "../review/git.ts";
import type { StoredPr } from "../prs/store.ts";
import { repoDir } from "../prs/store.ts";
import type { GuardConfig, RepoConfig } from "../types.ts";

/** Without origin/development, "the latest change" is the last N commits of HEAD. */
export const LATEST_FALLBACK_COMMITS = 1;
/** "last 50 commits" is cut to this many. */
export const MAX_LAST_COMMITS = 20;
/** At most this many repos are compared for one request. */
export const MAX_TARGET_REPOS = 4;
/** Commit subjects listed per repo. */
export const MAX_COMMIT_LINES = 20;
/** How many earlier chat turns are searched for what "it" means. */
export const HISTORY_LOOKBACK = 10;
/** Paths taken from one message. */
export const MAX_TARGET_PATHS = 12;
/** A pasted description is cut here before it is stored or sent. */
export const MAX_DESCRIPTION_CHARS = 3000;

export type TargetKind = "pr" | "branch" | "range" | "commits" | "paths" | "feature" | "latest";

export interface TargetCommit { sha: string; subject: string }

export interface TargetRepo {
  repo: string;
  path: string;
  /** Full SHAs of the compared range; null when only file names are known (a path or stored PR). */
  baseSha: string | null;
  headSha: string | null;
  /** Human text of the range, e.g. "origin/development..HEAD". */
  rangeLabel: string;
  commits: TargetCommit[];
  /** File names known without reading the diff (paths mentioned, or a stored PR's file list). */
  files: string[];
}

export interface Target {
  kind: TargetKind;
  /** One line that names what is being QA'd. */
  label: string;
  /** Said in the result whenever the request did not name the target itself. Null when it was explicit. */
  assumption: string | null;
  /** How to correct the guess, shown with the assumption. */
  correction: string | null;
  fromConversation: boolean;
  /** The requirement text, for a feature or pasted description. */
  description: string | null;
  pr: { id: number; title: string; status: string; repo: string } | null;
  repos: TargetRepo[];
  /** Repos that could not be compared, with the reason. */
  skipped: string[];
}

export interface NeedsInputOption { id: string; label: string; value: string }
export type TargetResult =
  | { ok: true; target: Target }
  | { ok: false; question: string; options: NeedsInputOption[] };

// ---------- text helpers (pure) ----------

const STOP = new Set([
  "it", "this", "that", "these", "those", "them", "the", "a", "an", "my", "our", "your", "change", "changes", "latest", "last", "recent",
  "newest", "new", "current", "work", "code", "commit", "commits", "project", "here", "in", "of", "for", "on", "please", "pls", "thanks",
  "thank", "you", "one", "everything", "all", "now", "again", "pr", "pull", "request", "branch", "and", "to", "so", "just", "i", "we", "me", "can",
  "could", "would", "it?", "it.", "it!", "stuff", "thing", "things", "something", "again?", "too", "also", "yet", "ok", "okay", "yes", "go", "ahead",
]);

/** The request without the polite opening and the QA verb: "what should I test for the checkout" -> "the checkout". */
export function subjectOf(message: string): string {
  let s = stripSlash(message).replace(/\s+/g, " ").trim();
  const strip = (re: RegExp): void => { s = s.replace(re, "").trim(); };
  strip(/^(?:hey|hi|ok|okay|so|and|now|then)[ ,]+/i);
  strip(/^(?:(?:please|pls|can you|could you|would you|will you|can we|could we|let'?s|i want you to|i need you to|i'd like you to|help me|help us|go ahead and|just|kindly)\b[ ,]*)+/i);
  strip(/^(?:what|which|how)\b.{0,40}?\b(?:test|verify|qa|check|retest)\b[ ,]*/i);
  strip(/^(?:(?:do|run|start|perform|give me|get me|write|draft|create|make|generate|prepare|list)\b )?(?:(?:an?|the|some|me) )?(?:qa|uat|testing|test|retest|re-test|verify|sanity[- ]?check|smoke[- ]?test|regression[- ]?test|validate|acceptance[- ]?test|test[- ]?cases?|test[- ]?plans?|test[- ]?scenarios?|regression|acceptance)(?: (?:pass|plan|cases?|checklist|scenarios?))?\b[ ,]*/i);
  strip(/^(?:(?:for|on|of|about|in|if|whether|that|against)\b[ ,]*)/i);
  return s;
}

const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9_./#-]+/g, " ").split(" ").filter(Boolean);

/** Meaningful words of the subject, with filler and the repo ids removed. */
export function meaningfulWords(subject: string, repoIds: string[] = []): string[] {
  const ids = new Set(repoIds.map((r) => r.toLowerCase()));
  return words(subject).filter((w) => !STOP.has(w) && !ids.has(w));
}

/** "it", "this", "the latest change", or nothing: no target is named. */
export function isDeictic(message: string, repoIds: string[] = []): boolean {
  return meaningfulWords(subjectOf(message), repoIds).length === 0;
}

/** The message names the latest change itself ("the latest change", "last commit"), so the chat is not searched. */
export function asksLatest(message: string): boolean {
  return /\b(?:latest|newest|most recent|recent|current)\b[^.?!\n]{0,20}\b(?:change|changes|commit|commits|work|code|push|pr)\b|\blast (?:change|commit)\b/i.test(message);
}

export function extractPr(text: string): number | null {
  const m = /(?:\bpr\b|\bpull[- ]request\b|\bmerge request\b)\s*[#:]?\s*(\d{1,7})\b|(?:^|[\s(])#(\d{1,7})\b/i.exec(text);
  const n = m?.[1] ?? m?.[2];
  return n ? Number(n) : null;
}

export function extractRange(text: string): { a: string; b: string } | null {
  const m = /(?:^|[\s`(])([A-Za-z0-9][\w./-]{1,100}?)\.\.\.?([A-Za-z0-9][\w./-]{1,100})(?=$|[\s`),.;:?!])/.exec(text);
  return m ? { a: m[1] as string, b: m[2] as string } : null;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
export function extractLastN(text: string): number | null {
  const m = /\blast\s+(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s+commits?\b/i.exec(text);
  if (!m) return null;
  const raw = (m[1] as string).toLowerCase();
  const n = NUMBER_WORDS[raw] ?? Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LAST_COMMITS) : null;
}

/** Tokens that may be a branch name: contain a slash, or follow the word "branch". */
export function extractBranchCandidates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bbranch(?:es)?\s+[`"']?([A-Za-z0-9][\w./-]{0,100})/gi)) {
    const t = (m[1] as string).replace(/[.,;:]+$/, "");
    if (!["is", "has", "was", "named", "called", "of", "for", "to", "and", "the", "a", "that", "which", "with"].includes(t.toLowerCase())) out.push(t);
  }
  for (const m of text.matchAll(/(?:^|[\s`"'(])([A-Za-z0-9][\w.-]*(?:\/[\w.-]+)+)(?=$|[\s`"'),;:?!]|\.(?:\s|$))/g)) out.push((m[1] as string).replace(/\.+$/, ""));
  return [...new Set(out)].slice(0, 6);
}

/** Tokens that look like file paths: a slash or a short extension. */
export function extractPathCandidates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\s`"'(])((?:[\w@.-]+[\\/])*[\w@.-]+\.[A-Za-z0-9]{1,6})(?=$|[\s`"'),;:?!])/g)) {
    const t = (m[1] as string).replace(/\\/g, "/").replace(/^\.\//, "");
    if (/^\d+\.\d+/.test(t) || /^v?\d+(\.\d+)+$/.test(t)) continue; // a version number
    out.push(t);
  }
  return [...new Set(out)].slice(0, MAX_TARGET_PATHS);
}

/** Repo ids from this project that the message names. */
export function mentionedRepos(cfg: GuardConfig, text: string): RepoConfig[] {
  const low = text.toLowerCase();
  return cfg.repos.filter((r) => new RegExp(String.raw`(?:^|[^a-z0-9_-])${r.id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9_-])`).test(low));
}

// ---------- git (read-only) ----------

const sha8 = (s: string): string => s.slice(0, 8);

function commitsBetween(repoPath: string, baseSha: string, headSha: string): TargetCommit[] {
  const out = gitTry(repoPath, ["log", "--no-color", `--format=%h%x09%s`, "-n", String(MAX_COMMIT_LINES), `${baseSha}..${headSha}`]);
  if (!out) return [];
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const t = l.indexOf("\t");
    return { sha: l.slice(0, t), subject: l.slice(t + 1) };
  });
}

function repoRange(r: RepoConfig, baseSha: string, headSha: string, label: string): TargetRepo {
  return { repo: r.id, path: r.path, baseSha, headSha, rangeLabel: label, commits: commitsBetween(r.path, baseSha, headSha), files: [] };
}

/** HEAD (or `head`) against the merge-base with origin/development; else head~N. Never empty when a parent exists. */
export function latestRange(r: RepoConfig, headRef = "HEAD"): TargetRepo | null {
  const headSha = revParse(r.path, headRef);
  if (!headSha) return null;
  const hasDev = revParse(r.path, "origin/development") !== null;
  let base = defaultBase(r.path, headRef);
  let baseSha = revParse(r.path, base);
  let label = hasDev && base !== `${headRef}~1` ? `origin/development..${headRef}` : `${headRef}~${LATEST_FALLBACK_COMMITS}..${headRef}`;
  if (!baseSha || baseSha === headSha) {
    base = `${headRef}~${LATEST_FALLBACK_COMMITS}`;
    baseSha = revParse(r.path, base);
    label = `${base}..${headRef}`;
  }
  if (!baseSha) return null; // a repo with one commit has nothing to compare
  return repoRange(r, baseSha, headSha, label);
}

function lastNRange(r: RepoConfig, n: number): TargetRepo | null {
  const headSha = revParse(r.path, "HEAD");
  const baseSha = revParse(r.path, `HEAD~${n}`);
  return headSha && baseSha ? repoRange(r, baseSha, headSha, `HEAD~${n}..HEAD`) : null;
}

function prFromStore(cfg: GuardConfig, id: number): { repo: RepoConfig; pr: StoredPr } | null {
  for (const r of cfg.repos) {
    const f = join(repoDir(cfg, r.id), `${id}.json`);
    if (!existsSync(f)) continue;
    try {
      return { repo: r, pr: JSON.parse(readFileSync(f, "utf8")) as StoredPr };
    } catch { /* a damaged file is skipped */ }
  }
  return null;
}

/** A merge commit "Merged PR 123: ..." in a repo's history. */
function prFromHistory(r: RepoConfig, id: number): string | null {
  const out = gitTry(r.path, ["log", "-n", "1", "--format=%H", "--extended-regexp", "-i", `--grep=(^|[^0-9])PR ${id}([^0-9]|$)`]);
  return out?.trim() || null;
}

function mergeRange(r: RepoConfig, commit: string, label: string): TargetRepo | null {
  const parent = revParse(r.path, `${commit}^1`) ?? revParse(r.path, `${commit}~1`);
  const head = revParse(r.path, commit);
  return parent && head ? repoRange(r, parent, head, label) : null;
}

function resolveRefIn(r: RepoConfig, name: string): string | null {
  return revParse(r.path, `origin/${name}`) ?? revParse(r.path, name) ?? revParse(r.path, `refs/remotes/${name}`);
}

// ---------- the resolver ----------

export function needsInput(cfg: GuardConfig, why: string): Extract<TargetResult, { ok: false }> {
  const repo = cfg.repos[0]?.id;
  const options: NeedsInputOption[] = [];
  if (repo) options.push({ id: "latest", label: `Latest change in ${repo}`, value: `QA the latest change in ${repo}` });
  options.push({ id: "pr", label: "A pull request number", value: "QA PR " });
  options.push({ id: "feature", label: "Describe a feature", value: "QA this feature: " });
  options.push({ id: "branch", label: "A branch or commit range", value: "QA branch " });
  return { ok: false, question: why, options };
}

interface Explicit {
  kind: Exclude<TargetKind, "latest" | "feature">;
  target: Target;
}

function baseTarget(kind: TargetKind, label: string): Target {
  return { kind, label, assumption: null, correction: null, fromConversation: false, description: null, pr: null, repos: [], skipped: [] };
}

/** A target the text names itself (PR, range, last N commits, branch, paths). Null when it names none. */
function explicitTarget(cfg: GuardConfig, text: string, scope: RepoConfig[]): Explicit | TargetResult | null {
  const repos = scope.slice(0, MAX_TARGET_REPOS);

  const prId = extractPr(text);
  if (prId !== null) {
    const t = baseTarget("pr", `Pull request ${prId}`);
    const stored = prFromStore(cfg, prId);
    if (stored) {
      const { repo, pr } = stored;
      t.pr = { id: pr.id, title: pr.title, status: pr.status, repo: repo.id };
      t.label = `Pull request ${pr.id}: ${pr.title}`;
      let tr: TargetRepo | null = null;
      if (pr.mergeCommit) tr = mergeRange(repo, pr.mergeCommit, `merge of PR ${pr.id}`);
      if (!tr) {
        const head = resolveRefIn(repo, pr.source);
        const target = resolveRefIn(repo, pr.target) ?? resolveRefIn(repo, "development");
        const mb = head && target ? gitTry(repo.path, ["merge-base", head, target])?.trim() : null;
        if (head && mb && mb !== head) tr = repoRange(repo, mb, head, `${pr.target}..${pr.source}`);
      }
      if (!tr) {
        tr = { repo: repo.id, path: repo.path, baseSha: null, headSha: null, rangeLabel: "stored file list", commits: [], files: pr.files };
        t.skipped.push(`${repo.id}: the PR's commits are not in the local clone, so only its stored file list is used`);
      }
      t.repos.push(tr);
      return { kind: "pr", target: t };
    }
    for (const r of repos) {
      const c = prFromHistory(r, prId);
      const tr = c ? mergeRange(r, c, `merge of PR ${prId}`) : null;
      if (tr) { t.repos.push(tr); return { kind: "pr", target: t }; }
    }
    return needsInput(cfg, `I have no stored data for pull request ${prId} in this project's repositories, and no merge commit that names it. Which change do you mean?`);
  }

  const range = extractRange(text);
  if (range) {
    const t = baseTarget("range", `Commit range ${range.a}..${range.b}`);
    for (const r of repos) {
      const a = resolveRefIn(r, range.a);
      const b = resolveRefIn(r, range.b);
      if (a && b) t.repos.push(repoRange(r, a, b, `${range.a}..${range.b}`));
    }
    if (t.repos.length) return { kind: "range", target: t };
  }

  const n = extractLastN(text);
  if (n !== null) {
    const t = baseTarget("commits", `The last ${n} ${n === 1 ? "commit" : "commits"}`);
    for (const r of repos) {
      const tr = lastNRange(r, n);
      if (tr) t.repos.push(tr); else t.skipped.push(`${r.id}: fewer than ${n} commits`);
    }
    if (t.repos.length) return { kind: "commits", target: t };
  }

  for (const name of extractBranchCandidates(text)) {
    for (const r of repos) {
      const head = resolveRefIn(r, name);
      if (!head) continue;
      const rng = latestRange(r, revParse(r.path, `origin/${name}`) ? `origin/${name}` : name);
      if (!rng) continue;
      const t = baseTarget("branch", `Branch ${name} in ${r.id}`);
      t.repos.push({ ...rng, rangeLabel: rng.rangeLabel });
      return { kind: "branch", target: t };
    }
  }

  const found: { repo: RepoConfig; path: string }[] = [];
  for (const p of extractPathCandidates(text)) {
    for (const r of repos) {
      if (pathExistsAt(r.path, "HEAD", p)) { found.push({ repo: r, path: p }); break; }
    }
  }
  if (found.length) {
    const t = baseTarget("paths", `Files: ${found.map((f) => f.path).slice(0, 4).join(", ")}${found.length > 4 ? ` and ${found.length - 4} more` : ""}`);
    for (const r of repos) {
      const files = found.filter((f) => f.repo.id === r.id).map((f) => f.path);
      if (files.length) {
        const headSha = revParse(r.path, "HEAD");
        t.repos.push({ repo: r.id, path: r.path, baseSha: null, headSha, rangeLabel: "named files", commits: [], files });
      }
    }
    return { kind: "paths", target: t };
  }
  return null;
}

function isTargetResult(x: Explicit | TargetResult): x is TargetResult {
  return "ok" in x;
}

export function resolveTarget(cfg: GuardConfig, input: { message: string; history?: ChatTurn[] }): TargetResult {
  const message = stripSlash(input.message);
  const history = input.history ?? [];
  const ids = cfg.repos.map((r) => r.id);
  const named = mentionedRepos(cfg, message);
  const scope = named.length ? named : cfg.repos;

  // 1. What the message itself names.
  const ex = explicitTarget(cfg, message, scope);
  if (ex) {
    if (isTargetResult(ex)) return ex;
    return { ok: true, target: ex.target };
  }

  const deictic = isDeictic(message, ids);
  const subject = subjectOf(message);

  // 2. A feature or requirement in the message (including pasted text).
  if (!deictic) {
    const description = subject.length >= 2 ? subject : message;
    const t = baseTarget("feature", `Feature or requirement: ${description.slice(0, 120).replace(/\s+/g, " ")}${description.length > 120 ? "..." : ""}`);
    t.description = description.slice(0, MAX_DESCRIPTION_CHARS);
    t.assumption = cfg.repos.length
      ? "I treated your words as a description of what to test, not as a change in a repository."
      : "This project has no repository, so I planned from your description only.";
    t.correction = 'If you meant a specific change, say "QA PR 123", a branch, or "the latest change".';
    return { ok: true, target: t };
  }

  // 3. "it", "this", or nothing: look back in the conversation, unless the message says "latest".
  if (!asksLatest(message)) {
    const earlier = [...history].slice(-HISTORY_LOOKBACK).reverse();
    for (const turn of earlier) {
      const text = turn.text.slice(0, 4000);
      const hit = explicitTarget(cfg, text, scope);
      if (hit && !isTargetResult(hit)) {
        hit.target.fromConversation = true;
        hit.target.assumption = `I took "${hit.target.label}" from earlier in this chat.`;
        hit.target.correction = 'Say what you meant instead, for example "QA PR 123" or "QA the latest change".';
        return { ok: true, target: hit.target };
      }
      if (turn.role === "user" && detectIntent(turn.text).intent === "qa" && !isDeictic(turn.text, ids) && !/^QA /.test(turn.text.slice(0, 3))) {
        const sub = subjectOf(turn.text);
        if (sub.length >= 2) {
          const t = baseTarget("feature", `Feature or requirement: ${sub.slice(0, 120)}`);
          t.description = sub.slice(0, MAX_DESCRIPTION_CHARS);
          t.fromConversation = true;
          t.assumption = `I took "${sub.slice(0, 80)}" from your earlier message.`;
          t.correction = 'Say what you meant instead, for example "QA PR 123" or "QA the latest change".';
          return { ok: true, target: t };
        }
      }
    }
  }

  // 4. The latest change in each git source of the project.
  if (scope.length === 0) {
    return needsInput(cfg, "This project has no code repository to look at, and your message does not say what to test. What should I plan QA for?");
  }
  const t = baseTarget("latest", "The latest change");
  for (const r of scope.slice(0, MAX_TARGET_REPOS)) {
    const tr = latestRange(r);
    if (tr) t.repos.push(tr); else t.skipped.push(`${r.id}: no commit to compare (empty or not a git clone)`);
  }
  if (t.repos.length === 0) {
    return needsInput(cfg, `I could not read the latest change in ${scope.map((r) => r.id).join(", ")} (${t.skipped.join("; ")}). Which change should I QA?`);
  }
  const lines = t.repos.map((r) => `${r.repo}: ${r.commits[0] ? `"${r.commits[0].subject}" (${r.commits[0].sha})` : `${sha8(r.headSha ?? "")}`}${r.commits.length > 1 ? ` and ${r.commits.length - 1} more commit${r.commits.length === 2 ? "" : "s"}` : ""}`);
  t.label = `The latest change in ${t.repos.map((r) => r.repo).join(", ")}`;
  t.assumption = `I assumed the latest change in ${t.repos.map((r) => r.repo).join(", ")} (${t.repos.map((r) => r.rangeLabel).join("; ")}). ${lines.join("; ")}.`;
  t.correction = 'If you meant something else, say "QA PR 123", a branch name, a commit range such as abc123..def456, or describe the feature.';
  return { ok: true, target: t };
}

/** Used by tests and by the context step: the merge base of two refs, or null. */
export function mergeBase(repoPath: string, a: string, b: string): string | null {
  const out = gitTry(repoPath, ["merge-base", a, b]);
  return out ? out.trim() : null;
}
