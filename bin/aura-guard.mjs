#!/usr/bin/env node
// Launcher: runs the TypeScript CLI under this Node with type stripping on.
// Arguments are forwarded as an array, so no shell re-quotes them.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "engine", "src", "cli", "main.ts");
const r = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", entry, ...process.argv.slice(2)],
  { stdio: "inherit", windowsHide: true },
);
process.exit(r.status ?? 1);
