// Turns co-change findings into PROPOSED pattern notes in vault/inbox/. Never approves anything.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import type { Db } from "../index/db.ts";
import { loadVault } from "../vault/load.ts";
import { validateMeta } from "../vault/schema.ts";
import type { Check } from "./checks.ts";
import { mineCoChange } from "./mine.ts";
import type { CoChangeFinding, MineOptions } from "./mine.ts";
import { localToday } from "./util.ts";

/** Max notes one `rules propose` run writes, so the owner is not flooded. */
export const DEFAULT_PROPOSE_MAX = 10;

export function checkFor(f: CoChangeFinding, repo: string): Check {
  const [first, ...others] = f.files;
  return {
    kind: "co-change",
    if_changed: [first!],
    then_changed: others,
    evidence: { commits: f.commits, ratio: f.ratio, repo },
  };
}

/** Hash of the check itself (not of its evidence), so a rerun does not propose the same rule twice. */
export function checkHash(c: Check): string {
  const key = JSON.stringify([c.kind, [...c.if_changed].sort(), [...c.then_changed].sort()]);
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

const MARK = /<!--\s*check:([0-9a-f]{12})\s*-->/;

/** Hashes of checks already in the vault in any status (a dismissed rule is not proposed again). */
export function knownCheckHashes(vaultDir: string): Set<string> {
  const seen = new Set<string>();
  for (const n of loadVault(vaultDir).notes) {
    const m = MARK.exec(n.body);
    if (m) seen.add(m[1]!);
  }
  return seen;
}

export function renderBody(c: Check, h: string): string {
  const names = (l: string[]): string => l.map((p) => `\`${p}\``).join(", ");
  const ratio = Math.round(c.evidence.ratio * 100);
  return [
    "## The check",
    "",
    "```json",
    JSON.stringify(c, null, 2),
    "```",
    "",
    "## In plain words",
    "",
    `When ${names(c.if_changed)} changes, ${names(c.then_changed)} usually changes in the same commit.`,
    `This held in ${c.evidence.commits} commits (about ${ratio}% of the time) in the ${c.evidence.repo} history.`,
    "A history that repeats is not yet a rule. Approve it only if you agree the files must change together.",
    "",
    `<!-- check:${h} -->`,
    "",
  ].join("\n");
}

export interface Proposal {
  id: string;
  file: string;
  title: string;
  check: Check;
}

export interface ProposeResult {
  proposals: Proposal[];
  candidates: number;
  duplicates: number;
  overMax: number;
  commitsUsed: number;
  commitsSkipped: number;
  dryRun: boolean;
}

export function proposeRules(
  db: Db,
  vaultDir: string,
  repo: string,
  opts: { dryRun?: boolean; max?: number; now?: Date } & MineOptions = {},
): ProposeResult {
  const max = opts.max ?? DEFAULT_PROPOSE_MAX;
  const mined = mineCoChange(db, repo, opts);
  const seen = knownCheckHashes(vaultDir);
  const inbox = join(vaultDir, "inbox");
  const created = localToday(opts.now);
  const proposals: Proposal[] = [];
  let duplicates = 0;
  let overMax = 0;
  for (const f of mined.findings) {
    const check = checkFor(f, repo);
    const h = checkHash(check);
    if (seen.has(h)) {
      duplicates++;
      continue;
    }
    if (proposals.length >= max) {
      overMax++;
      continue;
    }
    seen.add(h);
    const id = `pattern-cochange-${h}`;
    // Neutral title: file names only, no people and no commit wording.
    const names = f.files.map((p) => basename(p));
    const title = `Files that change together: ${names.join(", ")}`;
    const meta: Record<string, unknown> = {
      id,
      type: "pattern",
      status: "proposed",
      audience: ["internal_dev"],
      source: "commit",
      title,
      code_anchors: f.files.map((p, i) => ({ repo, path: p, ...(i === 0 ? { verified_sha: f.sha } : {}) })),
      created,
    };
    const v = validateMeta(meta, `inbox/${id}.md`);
    if (!v.meta) throw new Error(`generated note failed validation: ${v.problems[0]?.message}`);
    const file = join(inbox, `${id}.md`);
    if (!opts.dryRun) {
      mkdirSync(inbox, { recursive: true });
      writeFileSync(file, `---\n${stringify(meta, { lineWidth: 0 })}---\n\n# ${title}\n\n${renderBody(check, h)}`, { flag: "wx" });
    }
    proposals.push({ id, file, title, check });
  }
  return {
    proposals, candidates: mined.findings.length, duplicates, overMax,
    commitsUsed: mined.commitsUsed, commitsSkipped: mined.commitsSkipped, dryRun: opts.dryRun === true,
  };
}
