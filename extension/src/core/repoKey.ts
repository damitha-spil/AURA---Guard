import { createHash } from "node:crypto";

/**
 * Must match Guard's `normalizeWorkspacePath` / `repoKeyFor` exactly
 * (engine/src/capture/spool.ts; test vectors in docs/capture-events.md):
 * lower-case, forward slashes, no trailing slash (a bare drive root "c:/" keeps its slash).
 */
export function normalizeWorkspacePath(p: string): string {
  let s = p.replace(/\\/g, "/").toLowerCase();
  while (s.length > 1 && s.endsWith("/") && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** `<sanitized-basename>-<first 6 hex of sha256(normalized path)>`; runs of non-alphanumerics become one dash. */
export function repoKey(workspacePath: string): string {
  const norm = normalizeWorkspacePath(workspacePath);
  const base = norm.split("/").filter(Boolean).pop() ?? "";
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  const h = createHash("sha256").update(norm).digest("hex").slice(0, 6);
  return `${slug}-${h}`;
}

/** Local calendar date, YYYY-MM-DD. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
