// Tier 0: fixed checks that need no model. They read only ADDED lines (plus the co-change history).
// Line rules are data in roles/review-rules.json (a company can extend them); the special checks are code.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../index/db.ts";
import { coChanged } from "../index/cochange.ts";
import { detectSecrets } from "../mask/detectors.ts";
import { activeChecksPath, loadActiveChecks, parseExported } from "../rules/checks.ts";
import type { ActiveCheck } from "../rules/checks.ts";
import type { GuardConfig } from "../types.ts";
import type { DiffFile, DiffResult } from "./diff.ts";
import { skipReason } from "./diff.ts";

export type Severity = "blocker" | "risk" | "suggestion";
/** defect: a likely bug (scored against later fixes). policy: one of Aura's written rules (reported as rule compliance). */
export type FindingClass = "defect" | "policy";

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  message: string;
  evidence: string;
  /** Missing means defect (model findings). */
  class?: FindingClass;
  /** 0 to 1: how likely this is a real problem. Used to rank, not to filter. */
  confidence?: number;
  /** Model findings only: why it matters, and an optional minimal unified diff. */
  why?: string;
  suggestion?: string;
}

/** A partner file must have changed with this file in at least this share of its commits... */
export const COCHANGE_MIN_RATIO = 0.6;
/** ...and at least this many times, so two lucky commits do not make a rule. */
export const COCHANGE_MIN_TOGETHER = 3;
/** Partners looked at per changed file. */
export const COCHANGE_PARTNER_LIMIT = 10;
/** At most this many missing-partner findings per review, so a big change is not buried. */
export const COCHANGE_MAX_FINDINGS = 8;
/** A nowrap class needs a width limit on the same line or within this many lines. */
export const NOWRAP_NEIGHBOUR_LINES = 2;
/** Evidence text is cut to this many characters. */
export const EVIDENCE_MAX_CHARS = 140;
/** A string literal in JSX needs at least this many words to count as screen text. */
export const COPY_MIN_WORDS = 2;

export interface LineRule {
  id: string;
  severity: Severity;
  message: string;
  pathMatch?: string;
  pathSkip?: string;
  pattern: string;
  patternFlags?: string;
  valueSkip?: string;
  lineSkip?: string;
  skipComments?: boolean;
  skipInRustTestModule?: boolean;
  class?: FindingClass;
  confidence?: number;
  /** Off unless roles/review-rules.local.json lists the id under "enable". */
  default_off?: boolean;
  disabled?: boolean;
}

/** Class and confidence of a rule that is code (not a line rule). */
export interface RuleMeta { class: FindingClass; confidence: number }

/** Files the Aura screen already has. Only an ADDED css file under pathMatch that is not allowed is reported. */
export interface NewCssRule { pathMatch: RegExp; allowed: RegExp[] }

export interface RuleSet {
  lineRules: LineRule[];
  cochangeIgnore: RegExp[];
  specialRules: Record<string, RuleMeta>;
  newCss: NewCssRule;
  /** A possible-secret (random-looking value) is not reported in files under these paths (eval data, fixtures, lock files). */
  possibleSecretPathSkip: RegExp | null;
}

interface RuleFile {
  /** Rules that are off by default (default_off) and listed here are switched on. Local file only. */
  enable?: string[];
  possible_secret_path_skip?: string;
  cochange_ignore?: string[];
  special_rules?: Record<string, RuleMeta>;
  new_css?: { path_match?: string; allowed?: string[] };
  line_rules?: (Partial<LineRule> & { id: string })[];
}

function readRuleFile(file: string): RuleFile | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RuleFile) : null;
}

/** Built-in rules plus the company's roles/review-rules.local.json (same id replaces, disabled removes). */
export function loadRules(root: string): RuleSet {
  const base = readRuleFile(join(root, "roles", "review-rules.json")) ?? {};
  const local = readRuleFile(join(root, "roles", "review-rules.local.json")) ?? {};
  const byId = new Map<string, LineRule>();
  const enabled = new Set(local.enable ?? []);
  for (const r of [...(base.line_rules ?? []), ...(local.line_rules ?? [])]) {
    if (r.disabled) { byId.delete(r.id); continue; }
    if (r.default_off && !enabled.has(r.id) && !(local.line_rules ?? []).includes(r)) continue;
    byId.set(r.id, r as LineRule);
  }
  const ignore = [...(base.cochange_ignore ?? []), ...(local.cochange_ignore ?? [])].map((s) => new RegExp(s));
  const special = { ...(base.special_rules ?? {}), ...(local.special_rules ?? {}) };
  const css = [base.new_css, local.new_css];
  const newCss: NewCssRule = {
    pathMatch: new RegExp(local.new_css?.path_match ?? base.new_css?.path_match ?? "^apps/aura-ui/"),
    allowed: css.flatMap((c) => c?.allowed ?? []).map((s) => new RegExp(s)),
  };
  const skipSrc = local.possible_secret_path_skip ?? base.possible_secret_path_skip;
  return {
    lineRules: [...byId.values()], cochangeIgnore: ignore, specialRules: special, newCss,
    possibleSecretPathSkip: skipSrc ? new RegExp(skipSrc) : null,
  };
}

// ---------- helpers ----------

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$|_tests?\.rs$/i.test(path);
}

function isCommentLine(text: string): boolean {
  return /^\s*(\/\/|\/\*|\*|#|<!--)/.test(text);
}

function firstAdded(f: DiffFile): number {
  return f.added[0] ?? f.hunks[0]?.newStart ?? 1;
}

/** Evidence is the line, cut short. A line that holds a secret-like value is never printed. */
export function evidenceFor(text: string): string {
  const t = text.trim();
  if (detectSecrets(t).length > 0) return "(line not shown: it holds a secret-like value)";
  return t.length > EVIDENCE_MAX_CHARS ? t.slice(0, EVIDENCE_MAX_CHARS) + "..." : t;
}

function inRustTestModule(f: DiffFile, line: number): boolean {
  if (f.patch.includes("#[cfg(test)]")) return true;
  return f.hunks.some((h) => /mod tests|cfg\(test\)/.test(h.header) && line >= h.newStart && line < h.newStart + Math.max(h.newLines, 1));
}

// ---------- checks (each is small and returns findings) ----------

export function checkLineRules(f: DiffFile, rules: LineRule[]): Finding[] {
  const out: Finding[] = [];
  for (const r of rules) {
    if (r.pathMatch && !new RegExp(r.pathMatch).test(f.path)) continue;
    if (r.pathSkip && new RegExp(r.pathSkip).test(f.path)) continue;
    const re = new RegExp(r.pattern, (r.patternFlags ?? "") + "g");
    const valueSkip = r.valueSkip ? new RegExp(r.valueSkip, "i") : null;
    const lineSkip = r.lineSkip ? new RegExp(r.lineSkip, "i") : null;
    for (const l of f.addedLines) {
      if (r.skipComments && isCommentLine(l.text)) continue;
      if (lineSkip?.test(l.text)) continue;
      if (r.skipInRustTestModule && inRustTestModule(f, l.line)) continue;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let hit = false;
      while ((m = re.exec(l.text)) !== null) {
        if (m[0] === "") { re.lastIndex++; continue; }
        if (valueSkip?.test(m[0])) continue;
        hit = true;
        break;
      }
      if (hit) out.push({
        rule: r.id, severity: r.severity, file: f.path, line: l.line, message: r.message, evidence: evidenceFor(l.text),
        class: r.class ?? "policy", confidence: r.confidence ?? 0.5,
      });
    }
  }
  return out;
}

/** A path or branch name (a/b/c) is long and mixed-case but is not a key. */
const PATH_LIKE = /^[\w.-]+(?:\/[\w.-]+)+\/?$/;
/** A hash or digest: only hex digits, at a usual digest length. */
const HEX_DIGEST = /^[0-9a-f]{32,128}$/i;
const SNAKE_CASE = /^(?:[a-z][a-z0-9]*|[A-Z][A-Z0-9]*)(?:_(?:[a-z0-9]+|[A-Z0-9]+))+$/;
/** A long word-like token must have words at least this long on average to count as an identifier. */
const IDENT_MIN_AVG_WORD = 3;
const IDENT_MAX_DIGITS = 3;

/**
 * True when a token reads like code, not like a key: snake_case, camelCase or PascalCase words,
 * a Rust path (a::b), or a hex digest. Random keys have short random "words" and many digits.
 */
export function looksLikeIdentifier(tok: string, around = ""): boolean {
  if (tok.includes("::") || /::/.test(around)) return true;
  if (HEX_DIGEST.test(tok) || SNAKE_CASE.test(tok)) return true;
  if (!/^[A-Za-z0-9]+$/.test(tok)) return false;
  const digits = (tok.match(/\d/g) ?? []).length;
  if (digits > IDENT_MAX_DIGITS) return false;
  const words = tok.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [];
  if (words.length < 2) return false;
  const letters = words.filter((w) => !/^\d/.test(w));
  return letters.length > 0 && letters.join("").length / letters.length >= IDENT_MIN_AVG_WORD;
}
/** Prose files: a branch name or a hash in a note looks random but is not a secret. */
const PROSE_FILE = /\.(md|mdx|txt)$/i;

/**
 * Secret-like values on added lines. Reports the kind only, never the value.
 * A named kind (a token with a known prefix, a password assignment) is a blocker. A value that only
 * looks random (HIGH_ENTROPY) is a risk, and is ignored in prose files.
 */
export function checkSecrets(f: DiffFile, possibleSkip?: RegExp | null): Finding[] {
  const out: Finding[] = [];
  const noRandom = possibleSkip?.test(f.path) ?? false;
  for (const l of f.addedLines) {
    const spans = detectSecrets(l.text).filter((s) => {
      if (s.kind !== "HIGH_ENTROPY") return true;
      const tok = l.text.slice(s.start, s.end);
      const around = l.text.slice(Math.max(0, s.start - 2), s.end + 2);
      return !PATH_LIKE.test(tok) && !looksLikeIdentifier(tok, around);
    });
    let kinds = [...new Set(spans.map((s) => s.kind))];
    if (PROSE_FILE.test(f.path) || noRandom) kinds = kinds.filter((k) => k !== "HIGH_ENTROPY");
    if (kinds.length === 0) continue;
    const named = kinds.some((k) => k !== "HIGH_ENTROPY");
    out.push({
      rule: named ? "secret-in-code" : "possible-secret-in-code", severity: named ? "blocker" : "risk",
      file: f.path, line: l.line,
      message: named
        ? "A secret-like value was added. Secrets belong in the encrypted secret store."
        : "A long random-looking value was added. If it is a key or token, it belongs in the encrypted secret store.",
      evidence: `kind: ${kinds.join(", ")} (value not shown)`,
      class: "defect", confidence: named ? 0.95 : 0.3,
    });
  }
  return out;
}

export function checkPlicoEdit(f: DiffFile): Finding[] {
  if (!/^apps\/aura-ui\/src\/components\/plico\//.test(f.path)) return [];
  return [{
    rule: "plico-file-edited", severity: "blocker", file: f.path, line: firstAdded(f),
    message: "An installed plico-ui file was changed. These files are never edited by hand; use scripts/plico-changes/<name>.mjs or fix plico-ui itself.",
    evidence: `${f.status} ${f.path}`,
  }];
}

export function checkNewCss(f: DiffFile, cfg?: NewCssRule): Finding[] {
  const scope = cfg?.pathMatch ?? /^apps\/aura-ui\//;
  if (f.status !== "added" || !scope.test(f.path) || !/\.css$/.test(f.path)) return [];
  if (cfg?.allowed.some((re) => re.test(f.path))) return [];
  return [{
    rule: "new-css-file", severity: "risk", file: f.path, line: 1,
    message: "A new CSS file in the Aura screen. The screen uses Tailwind utilities and theme tokens; palettes live in styles/palettes.css.",
    evidence: `new file ${f.path}`,
  }];
}

const WIDTH_LIMIT = /\b(max-w-|w-\d|w-\[|w-(full|screen|fit|min|max)\b|truncate|text-ellipsis|min-w-0|line-clamp|overflow-)/;

export function checkNowrap(f: DiffFile): Finding[] {
  if (!/\.(tsx|jsx|html)$/.test(f.path) || !f.path.startsWith("apps/aura-ui/")) return [];
  const out: Finding[] = [];
  for (const l of f.addedLines) {
    if (!/\bwhitespace-nowrap\b/.test(l.text)) continue;
    const near = f.addedLines.filter((o) => Math.abs(o.line - l.line) <= NOWRAP_NEIGHBOUR_LINES).map((o) => o.text).join("\n");
    if (WIDTH_LIMIT.test(near)) continue;
    out.push({
      rule: "nowrap-without-limit", severity: "risk", file: f.path, line: l.line,
      message: "whitespace-nowrap without a width limit nearby. The window can be 800 px wide; give it max-w-* and truncate.",
      evidence: evidenceFor(l.text),
    });
  }
  return out;
}

const COPY_ATTR = /\b(placeholder|title|aria-label|alt|label)\s*=\s*"([^"{}]*[A-Za-z]{2,}[^"{}]*)"/;
const COPY_TEXT = />\s*([A-Z][A-Za-z'.,!?-]*(?:\s+[A-Za-z'.,!?-]+)+)\s*<\//;

/** Heuristic, suggestion only: words on screens live in copy.ts files. */
export function checkCopyText(f: DiffFile): Finding[] {
  if (!/^apps\/aura-ui\/.*\.tsx$/.test(f.path) || /copy\.ts$/.test(f.path) || isTestPath(f.path)) return [];
  if (f.path.includes("/components/plico/") || f.path.includes("/src/test/")) return [];
  const out: Finding[] = [];
  for (const l of f.addedLines) {
    if (isCommentLine(l.text)) continue;
    const a = COPY_ATTR.exec(l.text);
    const t = COPY_TEXT.exec(l.text);
    const text = a?.[2] ?? t?.[1];
    if (!text) continue;
    if (text.trim().split(/\s+/).length < COPY_MIN_WORDS) continue;
    if (/^[\w-]+(\s[\w-]+)*$/.test(text) && /\b(flex|grid|px|py|bg|text|border|rounded|gap|items|justify|w|h)-/.test(text)) continue;
    out.push({
      rule: "screen-text-not-in-copy", severity: "suggestion", file: f.path, line: l.line,
      message: "Words for the screen are written in the component. Aura keeps them in copy.ts files.",
      evidence: evidenceFor(l.text),
    });
  }
  return out;
}

const TOOL_NAME = /["'`]([A-Za-z0-9_.:-]*(?:create|insert|save|update)[A-Za-z0-9_.:-]*)["'`]/i;
const ERP_WORD = /erp|order|batch/i;

/** Heuristic: a new tool name that can write to the ERP, shown to the AI. */
export function checkErpWriteTool(f: DiffFile): Finding[] {
  if (isTestPath(f.path) || !/\.(ts|tsx|js|mjs|rs|json|py|cs)$/.test(f.path)) return [];
  const pathHints = /(^|\/)(mcp|tools?)(\/|[._-])/i.test(f.path) || /bundled-agents\//.test(f.path);
  const out: Finding[] = [];
  for (const l of f.addedLines) {
    if (isCommentLine(l.text)) continue;
    const m = TOOL_NAME.exec(l.text);
    if (!m) continue;
    const name = m[1] as string;
    const toolish = /\btools?\b|\bname\s*[:=]|"name"\s*:|register|schema/i.test(l.text) || pathHints;
    if (!toolish || !ERP_WORD.test(name + " " + f.path)) continue;
    if (name.length > 60) continue;
    out.push({
      rule: "erp-write-tool-for-ai", severity: "risk", file: f.path, line: l.line,
      message: "A tool that looks like an ERP write is being added. The AI gets no create tool: the backend checks and saves, and a write tool alone grants no authority.",
      evidence: evidenceFor(l.text),
    });
  }
  return out;
}

/** Files that changed together with a changed file in most of its history, but are not in this diff. */
export function checkCoChange(
  diff: DiffResult, db: Db, repoId: string, rules: RuleSet,
  exists: (path: string) => boolean,
): Finding[] {
  const changed = new Set<string>([...diff.files.map((f) => f.path), ...diff.skipped.map((s) => s.path)]);
  for (const f of diff.files) if (f.oldPath) changed.add(f.oldPath);
  const best = new Map<string, { from: DiffFile; together: number; ratio: number }>();
  for (const f of diff.files) {
    if (f.status === "deleted") continue;
    let partners: { path: string; together: number; ratio: number }[] = [];
    try { partners = coChanged(db, repoId, f.path, COCHANGE_PARTNER_LIMIT); } catch { partners = []; }
    for (const p of partners) {
      if (p.ratio < COCHANGE_MIN_RATIO || p.together < COCHANGE_MIN_TOGETHER) continue;
      if (changed.has(p.path) || skipReason(p.path)) continue;
      if (rules.cochangeIgnore.some((re) => re.test(p.path))) continue;
      if (!exists(p.path)) continue;
      const cur = best.get(p.path);
      if (!cur || p.ratio > cur.ratio) best.set(p.path, { from: f, together: p.together, ratio: p.ratio });
    }
  }
  return [...best.entries()]
    .sort((a, b) => b[1].ratio - a[1].ratio || a[0].localeCompare(b[0]))
    .slice(0, COCHANGE_MAX_FINDINGS)
    .map(([partner, v]) => ({
      rule: "cochange-partner-missing", severity: "risk" as const, file: v.from.path, line: firstAdded(v.from),
      message: `${partner} usually changes with this file but is not in this change. Check whether it needs an update.`,
      evidence: `History: changed together ${v.together} times, ${Math.round(v.ratio * 100)}% of this file's commits.`,
      class: "defect" as const, confidence: Math.min(0.7, v.ratio * 0.75),
    }));
}

const ORDER: Record<Severity, number> = { blocker: 0, risk: 1, suggestion: 2 };

export function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
}

export interface Tier0Options {
  rules: RuleSet;
  db?: Db | null;
  repoId?: string;
  /** Whether a path exists at the reviewed head. Needed for the co-change check. */
  exists?: (path: string) => boolean;
  skipCochange?: boolean;
  /** The file as committed at the reviewed head. Lets Rust checks skip the #[cfg(test)] part of a file. */
  readFile?: (path: string) => string | null;
  /** Approved co-change/pattern rules from vault or data/tier0/active-checks.json. */
  activeChecks?: ActiveCheck[];
}

function globToRegex(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.+/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${esc}$`, "i");
}

/** Evaluates approved pattern/co-change rules exported from active vault notes. */
export function checkActivePatternRules(diff: DiffResult, activeChecks: ActiveCheck[], repoId?: string): Finding[] {
  if (!activeChecks.length || !diff.files.length) return [];
  const changedPaths = [...diff.files.map((f) => f.path), ...diff.skipped.map((s) => s.path)];
  const out: Finding[] = [];
  for (const ac of activeChecks) {
    if (repoId && ac.check.evidence.repo && ac.check.evidence.repo !== repoId) continue;
    const ifRes = ac.check.if_changed.map(globToRegex);
    const thenRes = ac.check.then_changed.map(globToRegex);
    const triggerFile = diff.files.find((f) => ifRes.some((re) => re.test(f.path)));
    if (!triggerFile) continue;
    const partnerTouched = changedPaths.some((p) => thenRes.some((re) => re.test(p)));
    if (partnerTouched) continue;
    out.push({
      rule: `approved-pattern-${ac.id}`,
      severity: "risk",
      file: triggerFile.path,
      line: firstAdded(triggerFile),
      message: `Approved rule "${ac.title}": changes matching ${ac.check.if_changed.join(", ")} usually also update ${ac.check.then_changed.join(", ")}.`,
      evidence: `Active pattern rule (${ac.check.evidence.commits} commits, ${Math.round(ac.check.evidence.ratio * 100)}% co-change).`,
      class: "defect",
      confidence: Math.min(0.85, Math.max(0.5, ac.check.evidence.ratio)),
    });
  }
  return out;
}

/** Loads active checks from exported tier0 file first, falling back to active vault notes. */
export function loadTier0ActiveChecks(cfg: GuardConfig): ActiveCheck[] {
  const file = activeChecksPath(cfg);
  if (existsSync(file)) {
    try {
      return parseExported(readFileSync(file, "utf8"));
    } catch {
      /* fall back to vault */
    }
  }
  return loadActiveChecks(cfg);
}

/** Line where a Rust file starts its test module (tests sit at the bottom by convention), or null. */
export function rustTestStart(text: string): number | null {
  const i = text.split("\n").findIndex((l) => /^\s*#\[cfg\(test\)\]/.test(l));
  return i < 0 ? null : i + 1;
}

export function runTier0(diff: DiffResult, opts: Tier0Options): Finding[] {
  const out: Finding[] = [];
  for (const f of diff.files) {
    if (f.status === "deleted") { out.push(...checkPlicoEdit(f)); continue; }
    out.push(
      ...checkSecrets(f, opts.rules.possibleSecretPathSkip), ...checkPlicoEdit(f), ...checkNewCss(f, opts.rules.newCss), ...checkNowrap(f),
      ...checkCopyText(f), ...checkErpWriteTool(f),
    );
    let lineFindings = checkLineRules(f, opts.rules.lineRules);
    if (f.path.endsWith(".rs") && opts.readFile) {
      const text = opts.readFile(f.path);
      const start = text === null ? null : rustTestStart(text);
      const testOnly = new Set(opts.rules.lineRules.filter((r) => r.skipInRustTestModule).map((r) => r.id));
      testOnly.add("erp-write-tool-for-ai"); // a tool list inside #[cfg(test)] is test data
      if (start !== null) {
        lineFindings = lineFindings.filter((x) => !(testOnly.has(x.rule) && x.line >= start));
        for (let i = out.length - 1; i >= 0; i--) {
          const x = out[i] as Finding;
          if (x.file === f.path && x.rule === "erp-write-tool-for-ai" && x.line >= start) out.splice(i, 1);
        }
      }
    }
    out.push(...lineFindings);
  }
  if (!opts.skipCochange && opts.db && opts.repoId && opts.exists) {
    out.push(...checkCoChange(diff, opts.db, opts.repoId, opts.rules, opts.exists));
  }
  if (opts.activeChecks?.length) {
    out.push(...checkActivePatternRules(diff, opts.activeChecks, opts.repoId));
  }
  return sortFindings(annotate(out, opts.rules));
}

/** Fill in class and confidence from the rule data for checks that are code. Unknown rules count as policy. */
export function annotate(list: Finding[], rules: RuleSet): Finding[] {
  return list.map((f) => {
    if (f.class !== undefined && f.confidence !== undefined) return f;
    const meta = rules.specialRules[f.rule];
    return { ...f, class: f.class ?? meta?.class ?? "policy", confidence: f.confidence ?? meta?.confidence ?? 0.5 };
  });
}
