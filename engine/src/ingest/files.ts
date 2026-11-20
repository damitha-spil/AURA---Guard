import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { git } from "./git.ts";

// Large generated docs are noise and slow the index down.
const MAX_FILE_BYTES = 256 * 1024;
const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".artifacts"]);
const SPECIAL_NAMES = new Set(["desk.json", "AGENTS.md", "CLAUDE.md"]);

export interface RepoDoc { path: string; text: string; hash: string }

function wanted(path: string): boolean {
  const segs = path.split("/");
  if (segs.slice(0, -1).some((s) => SKIP_DIRS.has(s))) return false;
  const name = segs[segs.length - 1]!;
  if (/\.(md|markdown)$/i.test(name)) return true;
  if (SPECIAL_NAMES.has(name)) return true;
  return name === "SKILL.md" && segs.includes(".claude") && segs.includes("skills");
}

export function readRepoDocs(repoPath: string, _repoId: string): RepoDoc[] {
  const listed = git(repoPath, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const docs: RepoDoc[] = [];
  for (const path of listed) {
    if (!wanted(path)) continue;
    const full = join(repoPath, path);
    try {
      if (statSync(full).size > MAX_FILE_BYTES) continue;
      const text = readFileSync(full, "utf8");
      docs.push({ path, text, hash: createHash("sha256").update(text).digest("hex") });
    } catch {
      // tracked but missing from the working tree: skip
    }
  }
  return docs;
}
