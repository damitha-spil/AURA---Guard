import { join, resolve, sep } from "node:path";

// ai-log/<YYYY>/<MM>/<YYYY-MM-DD>-<name>.md, the only place a draft may go.
const TARGET = /^ai-log\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

/** Absolute path of the ai-log file inside the repo, or null if `file` is not a valid ai-log path. */
export function resolveAiLogTarget(repoRoot: string, file: string): { rel: string; abs: string } | null {
  const rel = file.replace(/\\/g, "/");
  if (!TARGET.test(rel)) return null;
  const root = resolve(repoRoot);
  const abs = resolve(join(root, ...rel.split("/")));
  if (!abs.startsWith(root + sep)) return null;
  return { rel, abs };
}

/** Existing text plus the draft, separated by one blank line. */
export function appendDraft(existing: string | null, draft: string): string {
  const d = draft.replace(/^\s*\n/, "");
  if (!existing) return d.endsWith("\n") ? d : d + "\n";
  const sep2 = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep2 + (d.endsWith("\n") ? d : d + "\n");
}
