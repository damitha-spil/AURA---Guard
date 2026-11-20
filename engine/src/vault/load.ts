import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Note, NoteProblem } from "../types.ts";
import { splitFrontmatter } from "./frontmatter.ts";
import { validateMeta } from "./schema.ts";

function walk(dir: string, rel: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      // _templates holds Obsidian note templates, which are not real notes.
      if (e.name === ".obsidian" || e.name === ".git" || e.name === "_templates") continue;
      walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, out);
    } else if (e.isFile() && e.name.endsWith(".md") && e.name.toLowerCase() !== "readme.md") {
      out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
}

export function loadVault(vaultDir: string): { notes: Note[]; problems: NoteProblem[] } {
  const notes: Note[] = [];
  const problems: NoteProblem[] = [];
  if (!existsSync(vaultDir)) return { notes, problems };
  const files: string[] = [];
  walk(vaultDir, "", files);
  files.sort();
  const seen = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(join(vaultDir, file), "utf8");
    const sp = splitFrontmatter(text);
    if (sp.error) {
      problems.push({ file, message: sp.error });
      continue;
    }
    const v = validateMeta(sp.data, file);
    if (!v.meta) {
      problems.push(...v.problems);
      continue;
    }
    const first = seen.get(v.meta.id);
    if (first) {
      problems.push({ file, message: `duplicate id "${v.meta.id}" (also in ${first})` });
      continue;
    }
    seen.set(v.meta.id, file);
    const body = sp.body.trim();
    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    const meta = { ...v.meta, title: v.meta.title || heading || v.meta.id };
    notes.push({ meta, body, file, hash: createHash("sha256").update(text).digest("hex") });
  }
  return { notes, problems };
}
