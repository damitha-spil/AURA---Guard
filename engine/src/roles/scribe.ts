import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { GuardConfig } from "../types.ts";
import type { CompleteFn } from "../brain/client.ts";
import { loadVault } from "../vault/load.ts";
import { newNote } from "../vault/new.ts";
import { gatherDay } from "./scribe-input.ts";
import type { DayInput } from "./scribe-input.ts";

const ReplySchema = z.object({
  summary: z.string(),
  built: z.array(z.string()),
  decisions: z.array(z.object({ what: z.string(), why: z.string() })),
  questions: z.array(z.string()),
});
export type DiaryReply = z.infer<typeof ReplySchema>;

/** Used if the yaml omits the limit. The architecture says at most 3 a day. */
const FALLBACK_MAX_QUESTIONS = 3;
const FALLBACK_MAX_TOKENS = 2000;

interface ScribeConfig { limits?: { max_questions_per_day?: number; max_tokens?: number }; rules?: string[] }

function loadRole(cfg: GuardConfig): ScribeConfig {
  return parse(readFileSync(join(cfg.root, "roles", "scribe.yaml"), "utf8")) as ScribeConfig;
}

export function buildDiaryPrompt(
  cfg: GuardConfig, day: DayInput,
): { system: string[]; user: string; maxQuestions: number; maxTokens: number } {
  const role = loadRole(cfg);
  const maxQuestions = role.limits?.max_questions_per_day ?? FALLBACK_MAX_QUESTIONS;
  const rules = (role.rules ?? []).map((r) => `- ${r}`).join("\n");
  const stable =
    `You are Scribe for AURA Guard. You write a short engineering diary for one day.\n\nRules:\n${rules}\n\n` +
    `Reply with JSON: {"summary": string, "built": string[], "decisions": [{"what": string, "why": string}], ` +
    `"questions": string[]}. At most ${maxQuestions} questions.`;
  const { notes } = loadVault(cfg.vaultDir);
  const titles = notes
    .filter((n) => n.meta.type === "rule" && (n.meta.status === "active" || n.meta.status === "proposed"))
    .map((n) => `- ${n.meta.title}`)
    .join("\n");
  const rulesBlock = `Known rules of the team (for context only):\n${titles || "(none)"}`;

  const lines: string[] = [`Date: ${day.date}`];
  for (const r of day.repos) {
    lines.push(`\n## Repo ${r.repo}`, "Commits:");
    for (const c of r.commits) lines.push(`- ${c.subject}${c.body ? `\n  ${c.body.replace(/\n/g, "\n  ")}` : ""}`);
    lines.push("Changed files (added/removed):");
    for (const f of r.files) lines.push(`- ${f.path} +${f.added} -${f.removed}`);
    if (r.handoffDiff) lines.push("AI_HANDOFF.md diff:", r.handoffDiff);
  }
  return {
    system: [stable, rulesBlock],
    user: lines.join("\n"),
    maxQuestions,
    maxTokens: role.limits?.max_tokens ?? FALLBACK_MAX_TOKENS,
  };
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Scribe: the model reply had no JSON object.");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("Scribe: the model reply was not valid JSON.");
  }
}

/** Writes one proposed diary note and returns its path; null when no commits that day. */
export async function draftDiary(
  cfg: GuardConfig, date: string, deps: { complete: CompleteFn },
): Promise<string | null> {
  const day = gatherDay(cfg, date);
  if (day.repos.length === 0) return null;
  const p = buildDiaryPrompt(cfg, day);
  const res = await deps.complete({ role: "scribe", system: p.system, user: p.user, maxTokens: p.maxTokens });
  const parsed = ReplySchema.safeParse(extractJson(res.text));
  if (!parsed.success) {
    throw new Error(
      "Scribe: the model reply did not match the expected shape: " +
        parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "),
    );
  }
  const d = parsed.data;
  const questions = d.questions.slice(0, p.maxQuestions);
  const body = [
    d.summary.trim(),
    "## What was built",
    d.built.length ? d.built.map((b) => `- ${b}`).join("\n") : "- Nothing listed.",
    "## Decisions",
    d.decisions.length ? d.decisions.map((x) => `- ${x.what}: ${x.why}`).join("\n") : "- None noted.",
    "## Questions for the owner",
    questions.length ? questions.map((q) => `- ${q}`).join("\n") : "- None today.",
  ].join("\n\n");
  return newNote(cfg.vaultDir, {
    type: "diary", title: `Diary ${date}`, body, audience: ["internal_dev"], source: "commit",
  });
}
