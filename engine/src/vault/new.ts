import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { Audience, CodeAnchor, NoteSource, NoteType } from "../types.ts";

const FOLDERS: Record<NoteType, string> = {
  rule: "rules",
  adr: "adr",
  pattern: "patterns",
  domain: "domain",
  diary: "diary",
  choice: "choices",
  incident: "incidents",
};

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "note";
}

/** Write a `proposed` note and return its file path. Never overwrites. */
export function newNote(
  vaultDir: string,
  partial: {
    type: NoteType;
    title: string;
    body: string;
    audience?: Audience[];
    source?: NoteSource;
    code_anchors?: CodeAnchor[];
  },
): string {
  const dir = join(vaultDir, FOLDERS[partial.type]);
  mkdirSync(dir, { recursive: true });
  const baseId = `${partial.type}-${slugify(partial.title)}`;
  let id = baseId;
  let file = join(dir, `${id}.md`);
  for (let n = 2; existsSync(file); n++) {
    id = `${baseId}-${n}`;
    file = join(dir, `${id}.md`);
  }
  const meta: Record<string, unknown> = {
    id,
    type: partial.type,
    status: "proposed",
    audience: partial.audience ?? ["internal_dev"],
    department: "dev",
    source: partial.source ?? "session",
    title: partial.title,
  };
  if (partial.code_anchors?.length) meta.code_anchors = partial.code_anchors;
  meta.created = new Date().toISOString().slice(0, 10);
  const text = `---\n${stringify(meta, { lineWidth: 0 })}---\n\n# ${partial.title}\n\n${partial.body.trim()}\n`;
  writeFileSync(file, text, { flag: "wx" });
  return file;
}
