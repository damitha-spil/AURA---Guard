import { parse } from "yaml";

export interface Split {
  data: unknown; // parsed frontmatter, or undefined when there is none
  body: string;
  error?: string;
}

/** Split Markdown into YAML frontmatter and body. Handles CRLF and a BOM. */
export function splitFrontmatter(text: string): Split {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { data: undefined, body: src };
  const body = src.slice(m[0].length);
  try {
    return { data: parse(m[1]!), body };
  } catch (e) {
    return { data: undefined, body, error: `invalid YAML: ${(e as Error).message.split("\n")[0]}` };
  }
}
