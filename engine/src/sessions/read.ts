import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Turn {
  session: string;
  ts: string;
  role: "user" | "assistant";
  text: string;
}

/** Claude Code folder name for a repo path: drive letter lowercased; ":", "\", "/", spaces and dots become "-". */
export function sessionFolderName(repoPath: string): string {
  return repoPath.replace(/^([A-Za-z]):/, (_m, d: string) => d.toLowerCase() + ":").replace(/[:\\/ .]/g, "-");
}

export function projectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/** Finds the session folder for a repo, checked against the real listing (case-insensitive). */
export function findSessionDir(repoPath: string, root: string = projectsRoot()): string | undefined {
  if (!existsSync(root)) return undefined;
  const want = sessionFolderName(repoPath).toLowerCase();
  const hit = readdirSync(root).find((n) => n.toLowerCase() === want);
  return hit ? join(root, hit) : undefined;
}

export function listSessionFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .sort();
}

// Blocks that are not the owner's own words. Removed from user text.
const STRIP_BLOCKS: RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-(?:name|message|args|contents)>[\s\S]*?<\/command-(?:name|message|args|contents)>/g,
  /<local-command-(?:stdout|stderr|caveat)>[\s\S]*?<\/local-command-(?:stdout|stderr|caveat)>/g,
  /<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /<(?:user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)>[\s\S]*?<\/(?:user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)>/g,
  /\[Pasted text[^\]]*\]/g,
  /\[Image[^\]]*\]/g,
  /\[Request interrupted[^\]]*\]/g,
];

/** Keeps only the owner's own words: strips reminders, command/IDE blocks, pasted content, skill expansions. */
export function cleanUserText(text: string): string {
  let t = text.replace(/<(pasted[_-]?(?:content|text))[^>]*>[\s\S]*?<\/\1>/gi, "");
  for (const re of STRIP_BLOCKS) t = t.replace(re, "");
  // A skill/command expansion or caveat is generated text, not the owner's words.
  if (/^\s*(Base directory for this skill:|Caveat: The messages below)/.test(t)) return "";
  return t.replace(/[ \t]+\n/g, "\n").trim();
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b === null || typeof b !== "object") continue;
    const blk = b as { type?: unknown; text?: unknown };
    // tool_result, tool_use, thinking and image blocks are skipped on purpose.
    if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
  }
  return parts.join("\n");
}

/** Parse one session file. Unknown line shapes and bad JSON are skipped. Read-only. */
export function readSessionFile(file: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (o.isSidechain === true || o.isMeta === true) continue;
    const msg = o.message as { content?: unknown } | undefined;
    if (!msg || typeof o.sessionId !== "string") continue;
    const role = o.type;
    const raw = textOf(msg.content);
    const text = role === "user" ? cleanUserText(raw) : raw.trim();
    if (!text) continue;
    turns.push({ session: o.sessionId, ts: typeof o.timestamp === "string" ? o.timestamp : "", role, text });
  }
  return turns;
}

/** Read all sessions of a folder, optionally only turns since a date. */
export function readSessions(dir: string, opts: { since?: string } = {}): { files: number; turns: Turn[] } {
  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  const turns: Turn[] = [];
  let files = 0;
  for (const f of listSessionFiles(dir)) {
    if (!Number.isNaN(sinceMs) && statSync(f).mtimeMs < sinceMs) continue;
    files++;
    for (const t of readSessionFile(f)) {
      if (!Number.isNaN(sinceMs) && t.ts && Date.parse(t.ts) < sinceMs) continue;
      turns.push(t);
    }
  }
  return { files, turns };
}
