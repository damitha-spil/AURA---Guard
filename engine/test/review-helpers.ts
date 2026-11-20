// Shared helpers for the review tests: synthetic git repos, a Guard root with the role files, fake model.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GUARD_ROOT } from "../src/config.ts";
import type { GuardConfig } from "../src/types.ts";
import type { CompleteFn } from "../src/brain/client.ts";
import type { DiffFile } from "../src/review/diff.ts";

export function git(cwd: string, args: string[], when?: string): string {
  const env = { ...process.env, ...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {}) };
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export interface Fixture {
  root: string;
  repo: string;
  cfg: GuardConfig;
  commit: (files: Record<string, string | null>, subject: string) => string;
  cleanup: () => void;
}

/** A temp Guard root (with the real role files) and a temp repo in a folder with a space in its name. */
export function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "guard-review-"));
  mkdirSync(join(root, "roles"));
  for (const f of ["reviewer.yaml", "refactor.yaml", "review-rules.json"]) {
    cpSync(join(GUARD_ROOT, "roles", f), join(root, "roles", f));
  }
  const repo = join(root, "my repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@example.org"]);
  git(repo, ["config", "user.name", "T"]);
  let n = 0;
  const cfg: GuardConfig = {
    dataDir: join(root, "data"), vaultDir: join(root, "vault"),
    repos: [{ id: "demo", path: repo }], busyProcesses: [], root,
  };
  return {
    root, repo, cfg,
    commit(files, subject) {
      for (const [p, text] of Object.entries(files)) {
        const full = join(repo, p);
        if (text === null) { rmSync(full, { force: true }); continue; }
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
      git(repo, ["add", "-A"]);
      const when = `2026-03-${String(10 + n++).padStart(2, "0")}T10:00:00`;
      git(repo, ["commit", "-q", "-m", subject], when);
      return git(repo, ["rev-parse", "HEAD"]).trim();
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A DiffFile with every line added, for the fixed-check tests. */
export function fakeFile(path: string, lines: string[], status: DiffFile["status"] = "modified", startLine = 1): DiffFile {
  const addedLines = lines.map((text, i) => ({ line: startLine + i, text }));
  return {
    path, oldPath: null, status, added: addedLines.map((l) => l.line), removed: [], addedLines,
    hunks: [{ oldStart: startLine, oldLines: 0, newStart: startLine, newLines: lines.length, header: "" }],
    patch: lines.map((l) => `+${l}`).join("\n"), patchTruncated: false,
  };
}

export const fakeModel = (text: string, seen?: { user?: string; system?: string[] }): CompleteFn => async (r) => {
  if (seen) { seen.user = r.user; seen.system = r.system; }
  return { text, usage: { input_tokens: 10, output_tokens: 5 } };
};
