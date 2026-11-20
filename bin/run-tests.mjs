// Runs every engine/test/*.test.ts with node:test. Globs are expanded here so
// the same command works in Git Bash, PowerShell and cmd.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "engine", "test");
const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => join(dir, f));
console.log(`Running ${files.length} test files`);
const r = spawnSync(process.execPath, ["--test", "--experimental-strip-types", ...files], { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
