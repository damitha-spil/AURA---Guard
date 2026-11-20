// Refactor advisor: up to 3 small refactors for one file, each patch checked with `git apply --check`
// against a scratch copy. The checked-out repo is never touched.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { GuardConfig } from "../types.ts";
import type { Db } from "../index/db.ts";
import type { CompleteFn } from "../brain/client.ts";
import { coChanged } from "../index/cochange.ts";
import { gitTry, revParse } from "./git.ts";
import {
  blastFor, extractJson, formatNotes, limitOf, loadRoleFile, ModelReplyError, relevantNotes, resolveRepo, ruleTitles,
} from "./context.ts";

const FALLBACK_MAX_REFACTORS = 3;
const FALLBACK_MAX_TOKENS = 4000;
/** The file text sent to the model is cut here. The patch check still uses the whole file. */
const FALLBACK_MAX_FILE_CHARS = 40_000;
const FALLBACK_MAX_NOTES = 4;
const FALLBACK_NOTE_CHARS = 500;
/** Co-change partners shown to the model. */
const COCHANGE_SHOWN = 6;

const ItemSchema = z.object({
  title: z.string().min(1),
  why: z.string().default(""),
  risk: z.string().default(""),
  affected: z.array(z.string()).default([]),
  patch: z.string().default(""),
});
const ReplySchema = z.object({ refactors: z.array(z.unknown()) });

export interface Refactor {
  title: string;
  why: string;
  risk: string;
  affected: string[];
  patch: string;
  applies: boolean;
  applyError?: string;
}

export interface RefactorResult {
  repo: string;
  path: string;
  headSha: string;
  refactors: Refactor[];
  /** Callers from the code graph, as found (the model's own list is in each refactor). */
  callers: string[];
  fileTruncatedForPrompt: boolean;
  model: { used: boolean; error?: string };
  backend: string | null;
}

export interface RefactorDeps {
  complete?: CompleteFn;
  backendUsed?: () => string | null;
}

function cleanPatch(p: string): string {
  let t = p.replace(/\r\n/g, "\n").trim();
  t = t.replace(/^```[a-z]*\n/i, "").replace(/\n```$/, "");
  return t ? t + "\n" : "";
}

/** The files a patch says it changes (from its --- lines). */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const l of patch.split("\n")) {
    const m = /^--- (?:a\/)?(.+?)\s*$/.exec(l);
    if (m && m[1] !== "/dev/null" && !out.includes(m[1] as string)) out.push(m[1] as string);
  }
  return out;
}

/**
 * Checks patches against a scratch git repo that holds the files as committed at `ref`.
 * Returns, per patch, whether `git apply --check` accepts it. Nothing in the real repo is read or written
 * except `git show` for the files.
 */
export function checkPatches(
  repoPath: string, ref: string, mainPath: string, patches: string[],
): { applies: boolean; error?: string }[] {
  const dir = mkdtempSync(join(tmpdir(), "guard-patch-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    const needed = new Set<string>([mainPath]);
    for (const p of patches) for (const f of patchPaths(p)) needed.add(f);
    for (const f of needed) {
      const text = gitTry(repoPath, ["show", `${ref}:${f}`]);
      if (text === null) continue;
      if (f.includes("..") || /^[a-zA-Z]:|^\//.test(f)) continue;
      const target = join(dir, f);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return patches.map((p) => {
      if (!p.trim()) return { applies: false, error: "no patch was given" };
      try {
        execFileSync("git", ["apply", "--check", "--recount", "-"], {
          cwd: dir, input: p, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8",
        });
        return { applies: true };
      } catch (e) {
        const msg = (e as { stderr?: string }).stderr ?? (e instanceof Error ? e.message : String(e));
        return { applies: false, error: msg.trim().split("\n")[0] ?? "git apply refused the patch" };
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function suggestRefactor(
  cfg: GuardConfig, db: Db | null, req: { repo: string; path: string }, deps: RefactorDeps = {},
): Promise<RefactorResult> {
  const repo = resolveRepo(cfg, req.repo);
  const path = req.path.replace(/\\/g, "/");
  const headSha = revParse(repo.path, "HEAD");
  if (!headSha) throw new Error("The repo has no HEAD commit.");
  const text = gitTry(repo.path, ["show", `HEAD:${path}`]);
  if (text === null) throw new Error(`"${path}" is not in the repo at HEAD.`);

  const role = loadRoleFile(cfg, "refactor");
  const maxRefactors = limitOf(role, "max_refactors", FALLBACK_MAX_REFACTORS);
  const maxFile = limitOf(role, "max_file_chars", FALLBACK_MAX_FILE_CHARS);
  const callers = blastFor(db, repo.id, path, 20);
  const result: RefactorResult = {
    repo: repo.id, path, headSha, refactors: [], callers,
    fileTruncatedForPrompt: text.length > maxFile, model: { used: false }, backend: null,
  };
  if (!deps.complete) return result;

  let partners: { path: string; together: number; ratio: number }[] = [];
  if (db) { try { partners = coChanged(db, repo.id, path, COCHANGE_SHOWN); } catch { partners = []; } }
  const notes = relevantNotes(db, [path], limitOf(role, "max_context_notes", FALLBACK_MAX_NOTES), limitOf(role, "note_chars", FALLBACK_NOTE_CHARS));
  const rules = (role.rules ?? []).map((r) => `- ${r}`).join("\n");
  const stable =
    `You are the Refactor advisor for SPIL AURA QA Bot. You suggest small, safe refactors for one file.\n\nRules:\n${rules}\n\n` +
    `Reply with JSON: {"refactors": [{"title": string, "why": string, "risk": string, "affected": string[], "patch": string}]}. ` +
    `At most ${maxRefactors} refactors. Use {"refactors": []} when the file is fine. The patch is a unified diff with a/${path} and b/${path} headers.`;
  const titles = ruleTitles(cfg).join("\n");
  const user = [
    `File: ${path}${result.fileTruncatedForPrompt ? " (cut: the file is long, only the start is shown)" : ""}`,
    "\nWhat uses it (code graph):", callers.length ? callers.map((c) => `- ${c}`).join("\n") : "(no graph data)",
    "\nFiles that usually change with it:",
    partners.length ? partners.map((p) => `- ${p.path} (${Math.round(p.ratio * 100)}%)`).join("\n") : "(no history)",
    "\nRelated notes:", formatNotes(notes),
    "\nThe file at HEAD:", "```", text.slice(0, maxFile), "```",
  ].join("\n");
  const res = await deps.complete({
    role: "refactor", system: [stable, `Rules of the team (for context):\n${titles || "(none)"}`],
    user, maxTokens: limitOf(role, "max_tokens", FALLBACK_MAX_TOKENS),
  });
  result.model = { used: true };
  result.backend = deps.backendUsed?.() ?? null;
  try {
    const reply = ReplySchema.parse(extractJson(res.text, "Refactor"));
    const items = reply.refactors.flatMap((r) => {
      const p = ItemSchema.safeParse(r);
      return p.success ? [p.data] : [];
    }).slice(0, maxRefactors);
    const patches = items.map((i) => cleanPatch(i.patch));
    const checks = checkPatches(repo.path, headSha, path, patches);
    result.refactors = items.map((i, n) => {
      const c = checks[n] ?? { applies: false, error: "not checked" };
      const r: Refactor = { title: i.title, why: i.why, risk: i.risk, affected: i.affected, patch: patches[n] ?? "", applies: c.applies };
      if (c.error) r.applyError = c.error;
      return r;
    });
  } catch (e) {
    if (!(e instanceof ModelReplyError) && !(e instanceof z.ZodError)) throw e;
    result.model = { used: true, error: e.message };
  }
  return result;
}

