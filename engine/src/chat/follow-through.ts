// Follow-through: the only things chat's agent mode may CREATE, and only in REO's own data:
//   follow-ups and per-chat tasks (data/followups), proposed vault notes (status: proposed, through
//   vault/new.ts, so the owner decides in the Inbox), and defect drafts (data/defects).
// Nothing here touches another repository, git, a shell, the ERP or the desktop. Every text is checked
// with the mask first (a flagged secret is refused, nothing is stored), and one message may create only a
// few items, so a runaway model cannot fill the owner's lists.

import { maskOutgoing } from "../mask/mask.ts";
import { ToolError } from "../tools/native/common.ts";
import { addFollowup, addTask } from "../followups/store.ts";
import { upsertDefect } from "../defects/store.ts";
import type { DefectSeverity } from "../defects/store.ts";
import { newNote } from "../vault/new.ts";
import type { GuardConfig, NoteType } from "../types.ts";

/** Items one message (or one mission) may create, in total and for the heavier kinds. */
export const MAX_CREATED_PER_MESSAGE = 5;
export const MAX_NOTES_PER_MESSAGE = 2;
export const MAX_DEFECTS_PER_MESSAGE = 2;
/** Notes the model may propose are limited to these types; rules, ADRs and diaries are the owner's. */
export const PROPOSABLE_NOTE_TYPES: readonly NoteType[] = ["pattern", "domain", "choice", "incident"];
export const MAX_NOTE_BODY_CHARS = 4000;
export const MAX_NOTE_TITLE_CHARS = 100;
export const MAX_DEFECT_FIELD_CHARS = 600;

export type CreatedKind = "followup" | "task" | "note" | "defect";
/** What the screen shows as a link: kind decides the page, id and label the text. */
export interface CreatedItem { kind: CreatedKind; id: string; label: string }

/** The list of what one message created. Shared by the loop and the answer text. */
export class CreationLog {
  readonly items: CreatedItem[] = [];
  count(kind?: CreatedKind): number {
    return kind ? this.items.filter((i) => i.kind === kind).length : this.items.length;
  }
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\r/g, "").trim().slice(0, max) : "");
const one = (v: unknown, max: number): string => str(v, max).replace(/\s+/g, " ");

function refuseSecret(text: string, what: string): void {
  const m = maskOutgoing(text);
  if (!m.ok) throw new ToolError(`The ${what} looks like it holds a secret (${m.blocked.map((b) => b.kind).join(", ")}), so nothing was created. Leave the secret out.`, true);
}

function cap(log: CreationLog, kind: CreatedKind): void {
  if (log.count() >= MAX_CREATED_PER_MESSAGE) throw new ToolError(`At most ${MAX_CREATED_PER_MESSAGE} items may be created per message.`);
  if (kind === "note" && log.count("note") >= MAX_NOTES_PER_MESSAGE) throw new ToolError(`At most ${MAX_NOTES_PER_MESSAGE} proposed notes per message.`);
  if (kind === "defect" && log.count("defect") >= MAX_DEFECTS_PER_MESSAGE) throw new ToolError(`At most ${MAX_DEFECTS_PER_MESSAGE} defect drafts per message.`);
}

export interface CreateContext { cfg: GuardConfig; chatId: string | null; log: CreationLog }

export const CREATE_TOOLS = ["create_followup", "create_task", "propose_note", "draft_defect"] as const;
export type CreateToolName = (typeof CREATE_TOOLS)[number];
export const isCreateTool = (n: string): n is CreateToolName => (CREATE_TOOLS as readonly string[]).includes(n);

/** Runs one creation tool. Returns the plain result the model sees. Throws ToolError for a refusal. */
export function runCreateTool(name: CreateToolName, args: Record<string, unknown>, c: CreateContext): string {
  const kind: CreatedKind = name === "create_followup" ? "followup" : name === "create_task" ? "task" : name === "propose_note" ? "note" : "defect";
  cap(c.log, kind);
  try {
    switch (name) {
      case "create_followup": {
        const text = one(args["text"], 500);
        refuseSecret(text, "text");
        const f = addFollowup(c.cfg.dataDir, { text, ...(typeof args["due"] === "string" ? { due: args["due"] } : {}) });
        c.log.items.push({ kind, id: f.id, label: f.text.slice(0, 80) });
        return `Created follow-up ${f.id}: ${f.text}`;
      }
      case "create_task": {
        if (!c.chatId) throw new ToolError("Tasks belong to a chat, and there is no chat here.");
        const text = one(args["text"], 500);
        refuseSecret(text, "text");
        const t = addTask(c.cfg.dataDir, c.chatId, text);
        c.log.items.push({ kind, id: t.id, label: t.text.slice(0, 80) });
        return `Created task ${t.id}: ${t.text}`;
      }
      case "propose_note": {
        const type = str(args["type"], 20) as NoteType;
        if (!PROPOSABLE_NOTE_TYPES.includes(type)) throw new ToolError(`A proposed note must be one of: ${PROPOSABLE_NOTE_TYPES.join(", ")}.`);
        const title = one(args["title"], MAX_NOTE_TITLE_CHARS);
        const body = str(args["body"], MAX_NOTE_BODY_CHARS);
        if (!title || !body) throw new ToolError("A proposed note needs a title and a body.");
        refuseSecret(`${title}\n${body}`, "note");
        const file = newNote(c.cfg.vaultDir, { type, title, body: `${body}\n\n_Proposed by REO from a chat. It is unapproved until the owner accepts it in the Inbox._`, source: "session" });
        const id = file.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/, "");
        c.log.items.push({ kind, id, label: title.slice(0, 80) });
        return `Proposed note ${id} (status proposed, waiting in the Inbox for the owner).`;
      }
      case "draft_defect": {
        const severity = (["low", "medium", "high", "critical"] as const).includes(str(args["severity"], 10) as DefectSeverity) ? (str(args["severity"], 10) as DefectSeverity) : "medium";
        const title = one(args["title"], 140);
        if (!title) throw new ToolError("A defect draft needs a title.");
        const expected = str(args["expected"], MAX_DEFECT_FIELD_CHARS);
        const actual = str(args["actual"], MAX_DEFECT_FIELD_CHARS);
        const steps = Array.isArray(args["steps"]) ? (args["steps"] as unknown[]).map((s) => one(s, 200)).filter(Boolean).slice(0, 8) : [];
        const fileRef = one(args["fileRef"], 200);
        refuseSecret([title, expected, actual, fileRef, ...steps].join("\n"), "defect text");
        const d = upsertDefect(c.cfg.dataDir, {
          appName: "", branch: "", commitSha: "", testedBy: "REO chat (draft: not verified)", assignedTo: "", agentSource: "qa", severity, title,
          expected, actual, reproSteps: steps, codeSuggestion: "", ...(fileRef ? { fileRef } : {}), evidencePaths: [],
        });
        c.log.items.push({ kind, id: d.id, label: title.slice(0, 80) });
        return `Recorded defect draft ${d.id} (${d.severity}, open, not verified). The owner reviews it under Defects.`;
      }
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    // The stores throw plain Errors with a sentence meant for people (a bad date, a full list).
    throw new ToolError(e instanceof Error ? e.message.slice(0, 200) : "Could not create that.");
  }
}

const KIND_WORD: Record<CreatedKind, [string, string]> = {
  followup: ["follow-up", "follow-ups"], task: ["task", "tasks"], note: ["proposed note", "proposed notes"], defect: ["defect draft", "defect drafts"],
};

/** One plain sentence for the end of an answer: what was created. Empty when nothing was. */
export function describeCreated(items: CreatedItem[]): string {
  if (!items.length) return "";
  const parts: string[] = [];
  for (const k of Object.keys(KIND_WORD) as CreatedKind[]) {
    const n = items.filter((i) => i.kind === k).length;
    if (n) parts.push(`${n} ${KIND_WORD[k][n === 1 ? 0 : 1]}`);
  }
  const lines = items.map((i) => `- ${KIND_WORD[i.kind][0]} ${i.id}: ${i.label}`);
  return `Created in REO: ${parts.join(", ")}.\n${lines.join("\n")}`;
}
