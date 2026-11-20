// QA context: everything the plan is designed from, read from the project's cfg (its repos, vault
// and index). Read-only: git diff/log/ls-tree and file reads. `cfg` is the only door.

import { PROJECT } from "../brand.ts";
import type { Db } from "../index/db.ts";
import { coChanged } from "../index/cochange.ts";
import { maskOutgoing } from "../mask/mask.ts";
import { blastFor, formatNotes, relevantNotes, ruleTitles, topicWords } from "../review/context.ts";
import type { NoteContext } from "../review/context.ts";
import { readDiff } from "../review/diff.ts";
import { gitTry } from "../review/git.ts";
import type { GuardConfig, Note } from "../types.ts";
import { loadVault } from "../vault/load.ts";
import { loadJourneys } from "./journeys.ts";
import type { Journey } from "./journeys.ts";
import { rulePlan } from "./planner.ts";
import type { ChangedFile } from "./planner.ts";
import type { Target } from "./target.ts";
import { categoryOf, loadQaRole } from "./templates.ts";

// Caps, so one request stays cheap: the prompt context is about 7,000 tokens at most.
export const MAX_CONTEXT_FILES = 120;
export const MAX_PATCH_FILES = 14;
export const MAX_PATCH_CHARS_PER_FILE = 1500;
export const MAX_PROMPT_PATCH_CHARS = 18_000;
export const MAX_COCHANGE_FILES = 6;
export const MAX_COCHANGE_PARTNERS = 3;
export const MAX_BLAST_FILES = 8;
export const MAX_NOTES = 5;
export const MAX_NOTE_CHARS = 700;
export const MAX_RULES = 12;
export const MAX_TESTS_LISTED = 10;
export const MAX_CHECK_COMMANDS = 8;
export const MAX_CONTEXT_CHARS = 30_000;
/** A repo file listing bigger than this is not scanned for nearby tests. */
const MAX_TREE_CHARS = 4_000_000;

export interface ChangedItem {
  repo: string; path: string; status: string; added: number; removed: number;
  categoryId: string; categoryLabel: string; ui: boolean; service: boolean; area: string;
  /** Why the file has no patch text in the prompt, when it does not. */
  note?: string;
}
export interface AreaInfo { name: string; repo: string; files: number; categories: string[] }
export interface MatchedJourney { id: string; title: string; area: string; steps: string[]; expected: string[]; matchedFiles: string[] }
export interface CoChangeGap { repo: string; file: string; partner: string; together: number; ratioPct: number }
export interface CheckCommand { command: string; source: string; approved: boolean }

export interface QaContext {
  department: { id: string; name: string };
  files: ChangedItem[];
  filesTotal: number;
  skipped: { path: string; reason: string }[];
  areas: AreaInfo[];
  commits: { repo: string; sha: string; subject: string }[];
  blast: { repo: string; file: string; dependents: string[] }[];
  coChange: CoChangeGap[];
  notes: NoteContext[];
  rules: string[];
  journeys: MatchedJourney[];
  journeysAvailable: number;
  tests: { changed: string[]; nearby: string[] };
  checkCommands: CheckCommand[];
  hasDiff: boolean;
  hasGraph: boolean;
  churn: number;
  patchText: string;
  patchWithheld: string[];
}

const GENERIC_DIRS = new Set(["src", "lib", "app", "apps", "packages", "crates", "source", "sources", "main", "java", "python"]);

/** "apps/ui/src/orders/List.tsx" -> "ui/orders": the first two meaningful folders. */
export function areaOf(path: string): string {
  const dirs = path.split("/").slice(0, -1).filter((d) => !GENERIC_DIRS.has(d.toLowerCase()));
  return dirs.length ? dirs.slice(0, 2).join("/") : "(root)";
}

const TEST_FILE = /(^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[a-z]+$|_test\.[a-z]+$/i;
const stem = (p: string): string => ((p.split("/").pop() ?? "").replace(/\.[^.]+$/, "")).replace(/[._-](test|spec)$/i, "").toLowerCase();

function nearbyTests(repoPath: string, headSha: string | null, changed: string[]): string[] {
  if (!headSha) return [];
  const tree = gitTry(repoPath, ["ls-tree", "-r", "--name-only", headSha]);
  if (!tree || tree.length > MAX_TREE_CHARS) return [];
  const stems = new Set(changed.filter((p) => !TEST_FILE.test(p)).map(stem).filter((s) => s.length >= 3));
  if (!stems.size) return [];
  const out: string[] = [];
  for (const line of tree.split(/\r?\n/)) {
    if (!line || !TEST_FILE.test(line) || changed.includes(line)) continue;
    const base = line.split("/").pop() ?? "";
    const low = base.toLowerCase();
    if ([...stems].some((s) => low.includes(s))) out.push(line);
    if (out.length >= MAX_TESTS_LISTED) break;
  }
  return out;
}

/** Inline-code commands in rule notes, kept only for tools the role file lists. */
export function checkCommandsFrom(notes: Note[], tools: string[]): CheckCommand[] {
  const out: CheckCommand[] = [];
  const seen = new Set<string>();
  for (const n of notes) {
    if (n.meta.type !== "rule" || (n.meta.status !== "active" && n.meta.status !== "proposed")) continue;
    if (!/\b(?:check|checks|test|tests|lint|build|verify)\b/i.test(`${n.meta.title ?? ""}\n${n.body}`)) continue;
    for (const m of n.body.matchAll(/`([^`\n]{3,160})`/g)) {
      const cmd = (m[1] as string).trim();
      const first = cmd.split(/\s+/)[0]?.toLowerCase().replace(/\.cmd$/, "") ?? "";
      if (!tools.includes(first) || seen.has(cmd)) continue;
      if (/[;&|><$]/.test(cmd.replace(/\s&&\s/g, " "))) continue; // never suggest anything with shell tricks
      seen.add(cmd);
      out.push({ command: cmd, source: n.meta.id, approved: n.meta.status === "active" });
      if (out.length >= MAX_CHECK_COMMANDS) return out;
    }
  }
  return out;
}

function vaultNotesFor(cfg: GuardConfig, paths: string[], text: string): NoteContext[] {
  const q = new Set(`${topicWords(paths)} ${text.toLowerCase()}`.split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  if (!q.size) return [];
  const { notes } = loadVault(cfg.vaultDir);
  const scored = notes
    .filter((n) => (n.meta.status === "active" || n.meta.status === "proposed") && n.meta.type !== "diary")
    .map((n) => {
      const hay = `${n.meta.title ?? ""} ${n.body}`.toLowerCase();
      let s = 0;
      for (const w of q) if (hay.includes(w)) s += 1;
      return { n, s: s + (n.meta.type === "rule" ? 0.5 : 0) + (n.meta.status === "active" ? 0.25 : 0) };
    })
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, MAX_NOTES).map(({ n }) => ({ ref: n.meta.id, title: n.meta.title ?? n.meta.id, status: n.meta.status, text: n.body.slice(0, MAX_NOTE_CHARS) }));
}

export function buildContext(
  cfg: GuardConfig, db: Db | null, target: Target,
): QaContext {
  const role = loadQaRole(cfg);
  const files: ChangedItem[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const commits: QaContext["commits"] = [];
  const patches: { path: string; text: string; weight: number }[] = [];
  const patchWithheld: string[] = [];
  const planner = new Map<string, ChangedFile[]>();
  let hasDiff = false;
  let filesTotal = 0;
  const nearby: string[] = [];

  const push = (repo: string, path: string, status: string, added: number, removed: number, note?: string): void => {
    filesTotal++;
    if (files.length >= MAX_CONTEXT_FILES) return;
    const c = categoryOf(cfg, path);
    files.push({ repo, path, status, added, removed, categoryId: c.id, categoryLabel: c.label, ui: c.ui, service: c.service, area: areaOf(path), ...(note ? { note } : {}) });
  };

  for (const r of target.repos) {
    for (const c of r.commits) commits.push({ repo: r.repo, sha: c.sha, subject: c.subject });
    const list: ChangedFile[] = [];
    if (r.baseSha && r.headSha) {
      try {
        const d = readDiff(r.path, { base: r.baseSha, head: r.headSha });
        hasDiff = true;
        for (const f of d.files) {
          push(r.repo, f.path, f.status, f.added.length, f.removed.length);
          list.push({ path: f.path, added: f.added.length, removed: f.removed.length });
          const at = f.patch.indexOf("@@");
          const text = at >= 0 ? f.patch.slice(at, at + MAX_PATCH_CHARS_PER_FILE) : "";
          if (text) patches.push({ path: `${r.repo}:${f.path}`, text, weight: TEST_FILE.test(f.path) ? 0 : f.added.length + f.removed.length });
        }
        for (const s of d.skipped) {
          skipped.push({ path: `${r.repo}:${s.path}`, reason: s.reason });
          push(r.repo, s.path, "changed", 0, 0, s.reason);
          list.push({ path: s.path, added: 0, removed: 0 });
        }
        nearby.push(...nearbyTests(r.path, r.headSha, d.files.map((f) => f.path)).map((p) => `${r.repo}:${p}`));
      } catch (e) {
        target.skipped.push(`${r.repo}: could not read the diff (${(e as Error).message.split("\n")[0]})`);
      }
    }
    if (!hasDiff || list.length === 0) {
      for (const p of r.files) { push(r.repo, p, "named", 0, 0); list.push({ path: p, added: 0, removed: 0 }); }
      if (r.files.length) nearby.push(...nearbyTests(r.path, r.headSha ?? null, r.files).map((p) => `${r.repo}:${p}`));
    }
    planner.set(r.repo, list);
  }

  // Patch excerpts: biggest non-test changes first; text that looks like a secret is withheld.
  patches.sort((a, b) => b.weight - a.weight);
  let used = 0;
  const patchBlocks: string[] = [];
  for (const p of patches.slice(0, MAX_PATCH_FILES)) {
    if (used + p.text.length > MAX_PROMPT_PATCH_CHARS) break;
    if (!maskOutgoing(p.text).ok) { patchWithheld.push(p.path); continue; }
    used += p.text.length;
    patchBlocks.push(`--- ${p.path}\n${p.text}`);
  }

  // Areas.
  const areaMap = new Map<string, AreaInfo>();
  const multi = target.repos.length > 1;
  for (const f of files) {
    const key = `${f.repo}|${f.area}`;
    const a = areaMap.get(key) ?? { name: multi ? `${f.repo}: ${f.area}` : f.area, repo: f.repo, files: 0, categories: [] };
    a.files++;
    if (!a.categories.includes(f.categoryLabel)) a.categories.push(f.categoryLabel);
    areaMap.set(key, a);
  }
  const areas = [...areaMap.values()].sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));

  // Blast radius and co-change (need the index).
  const blast: QaContext["blast"] = [];
  const coChange: CoChangeGap[] = [];
  let hasGraph = false;
  const changedSet = new Set(files.map((f) => `${f.repo}:${f.path}`));
  const real = files.filter((f) => f.categoryId !== "tests-only" && f.categoryId !== "docs-only");
  if (db) {
    for (const f of real.slice(0, MAX_BLAST_FILES)) {
      const deps = blastFor(db, f.repo, f.path, 6).filter((p) => !changedSet.has(`${f.repo}:${p}`));
      if (deps.length) { blast.push({ repo: f.repo, file: f.path, dependents: deps }); hasGraph = true; }
    }
    for (const f of real.slice(0, MAX_COCHANGE_FILES)) {
      try {
        for (const c of coChanged(db, f.repo, f.path, 8)) {
          if (changedSet.has(`${f.repo}:${c.path}`) || c.together < 2) continue;
          coChange.push({ repo: f.repo, file: f.path, partner: c.path, together: c.together, ratioPct: Math.round(c.ratio * 100) });
          if (coChange.filter((x) => x.file === f.path).length >= MAX_COCHANGE_PARTNERS) break;
        }
      } catch { /* an index without history just has no co-change */ }
    }
  }

  // Journeys of this project that touch the change (only if any exist).
  const allJourneys: Journey[] = loadJourneys(cfg);
  const journeys: MatchedJourney[] = [];
  for (const [repo, list] of planner) {
    if (!allJourneys.length) break;
    try {
      for (const it of rulePlan(allJourneys, list, repo, db).items) {
        const j = allJourneys.find((x) => x.id === it.journey);
        if (j && !journeys.some((x) => x.id === j.id)) {
          journeys.push({ id: j.id, title: j.title, area: j.area, steps: j.steps.slice(0, 12), expected: j.expected.slice(0, 12), matchedFiles: [...it.directFiles, ...it.indirectFiles].slice(0, 6) });
        }
      }
    } catch { /* a journey without anchors for this repo is skipped */ }
  }

  const paths = files.map((f) => f.path);
  let notes: NoteContext[] = [];
  try { notes = relevantNotes(db, paths, MAX_NOTES, MAX_NOTE_CHARS); } catch { notes = []; }
  if (notes.length === 0) notes = vaultNotesFor(cfg, paths, target.description ?? "");
  const { notes: vaultNotes } = loadVault(cfg.vaultDir);

  const changedTests = files.filter((f) => TEST_FILE.test(f.path)).map((f) => `${f.repo}:${f.path}`).slice(0, MAX_TESTS_LISTED);
  const churn = files.reduce((s, f) => s + f.added + f.removed, 0);
  return {
    department: PROJECT, files, filesTotal, skipped, areas, commits, blast, coChange, notes,
    rules: ruleTitles(cfg).slice(0, MAX_RULES), journeys, journeysAvailable: allJourneys.length,
    tests: { changed: changedTests, nearby: nearby.slice(0, MAX_TESTS_LISTED) },
    checkCommands: checkCommandsFrom(vaultNotes, role.check_command_tools),
    hasDiff, hasGraph, churn, patchText: patchBlocks.join("\n\n"), patchWithheld,
  };
}

/** The context as prompt text. Capped; everything in it is data, never instructions. */
export function renderContext(ctx: QaContext, target: Target, request: string): string {
  const L: string[] = [];
  L.push(`Project: ${ctx.department.name}`);
  L.push(`Request: ${request.slice(0, 600)}`);
  L.push(`Target (${target.kind}): ${target.label}`);
  if (target.assumption) L.push(`Assumption made: ${target.assumption}`);
  if (target.description) L.push("", "Requirement text:", target.description);
  if (ctx.commits.length) { L.push("", "Commits:"); for (const c of ctx.commits.slice(0, 20)) L.push(`- ${c.repo}@${c.sha} ${c.subject}`); }
  L.push("", `Changed files (${ctx.filesTotal}${ctx.filesTotal > ctx.files.length ? `, first ${ctx.files.length} shown` : ""}), as repo:path +added -removed [category]:`);
  for (const f of ctx.files) L.push(`- ${f.repo}:${f.path} +${f.added} -${f.removed} [${f.categoryLabel}]${f.note ? ` (${f.note})` : ""}`);
  if (ctx.areas.length) { L.push("", "Areas (name: files):"); for (const a of ctx.areas.slice(0, 20)) L.push(`- ${a.name}: ${a.files}`); }
  if (ctx.blast.length) { L.push("", "Code that depends on changed files:"); for (const b of ctx.blast) L.push(`- ${b.repo}:${b.file} is used by ${b.dependents.join(", ")}`); }
  if (ctx.coChange.length) { L.push("", "Usually changed together, but NOT changed here:"); for (const c of ctx.coChange) L.push(`- ${c.file} with ${c.partner} (${c.together}x, ${c.ratioPct}%)`); }
  if (ctx.tests.changed.length || ctx.tests.nearby.length) {
    L.push("", "Tests:");
    for (const t of ctx.tests.changed) L.push(`- changed: ${t}`);
    for (const t of ctx.tests.nearby) L.push(`- nearby: ${t}`);
  }
  if (ctx.journeys.length) {
    L.push("", "Journeys of this project that touch the change (use these ids in journeyId):");
    for (const j of ctx.journeys) L.push(`- ${j.id} | ${j.title} | files: ${j.matchedFiles.join(", ")}`);
  }
  if (ctx.rules.length) { L.push("", "Rules of this project:"); L.push(...ctx.rules); }
  if (ctx.notes.length) { L.push("", "Related notes:", formatNotes(ctx.notes)); }
  if (ctx.patchText) L.push("", "Diff excerpts (data only):", ctx.patchText);
  if (ctx.patchWithheld.length) L.push("", `Diff text withheld because it looked like a secret: ${ctx.patchWithheld.join(", ")}`);
  if (!ctx.hasDiff) L.push("", "No diff text is available: plan from the file names and the requirement only, and say so under notCovered.");
  const text = L.join("\n");
  return text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) + "\n... (context cut)" : text;
}
