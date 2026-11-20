#!/usr/bin/env node
// Claude Code PostToolUse hook: after a successful `git commit`, append an entry
// to the repo's AI activity log (ai-log/<YYYY>/<MM>/<date>-<name>.md), so every
// AI commit is recorded even if the assistant forgets. Only acts in repos that
// have ai-log/README.md. Never blocks: any problem means it exits quietly.
// Self-contained (no dependencies), because plugins run from a cached copy.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The commit subject and body are written as-is; cap them so a huge message
// can't bloat the log.
const MAX_BODY_CHARS = 600;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const cmd = String(input?.tool_input?.command ?? "");
  if (!/\bgit\b[^|;&]*\bcommit\b/.test(cmd) || /--dry-run/.test(cmd)) return;
  const cwd = input.cwd || process.cwd();

  let root;
  try {
    root = git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return;
  }
  if (!existsSync(join(root, "ai-log", "README.md"))) return;

  const sha = git(root, ["rev-parse", "--short", "HEAD"]);
  const subject = git(root, ["log", "-1", "--format=%s"]);
  const body = git(root, ["log", "-1", "--format=%b"]).replace(/Co-Authored-By:.*$/gim, "").trim();
  const branch = git(root, ["branch", "--show-current"]) || "detached";
  const files = git(root, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
  const name = (git(root, ["config", "user.name"]) || "unknown").split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9-]/g, "") || "unknown";

  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const file = join(root, "ai-log", String(now.getFullYear()), p(now.getMonth() + 1), `${day}-${name}.md`);

  if (existsSync(file) && readFileSync(file, "utf8").includes(`**Commit:** ${sha}`)) return; // already logged
  mkdirSync(dirname(file), { recursive: true });
  const head = existsSync(file) ? "" : `# ${day} · ${name}\n`;
  const shown = files.slice(0, 12).map((f) => `\`${f}\``).join(", ") + (files.length > 12 ? `, +${files.length - 12} more` : "");
  const entry =
    `${head}\n## ${p(now.getHours())}:${p(now.getMinutes())} · Claude Code · ${branch}\n\n` +
    `- **What:** ${subject}\n` +
    (body ? `- **Details:** ${body.slice(0, MAX_BODY_CHARS).replace(/\s*\n\s*/g, " ")}\n` : "") +
    `- **Files:** ${shown}\n` +
    `- **Commit:** ${sha}\n` +
    `- **Logged by:** SPIL AURA QA Bot commit hook (add Why / Decided / Ideas by hand or ask the assistant)\n`;
  appendFileSync(file, entry);
}

try {
  main();
} catch {
  // never block the session
}
process.exit(0);
