#!/usr/bin/env node
// Starts SPIL Quality Support Bot's read-only MCP server from the developer's own Guard clone.
// The plugin itself runs from Claude Code's cached copy, which has no
// node_modules and no index, so it points at the clone given by the plugin's
// `guard_home` setting (or the AURA_GUARD_HOME environment variable).
// stdout is the MCP protocol channel: only the server may write there.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const home = process.env.AURA_GUARD_HOME || process.argv[2] || "";
const server = home && join(home, "engine", "src", "mcp", "server.ts");

if (!server || !existsSync(server)) {
  process.stderr.write(
    "SPIL Quality Support Bot: Guard folder not found. Clone the SPIL Quality Support Bot repo, run `npm install` and " +
      "`npm run guard -- index` there, then set it with `claude plugin configure aura-guard` " +
      "(guard_home) or the AURA_GUARD_HOME environment variable.\n",
  );
  process.exit(1);
}

const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", server], {
  cwd: home,
  stdio: "inherit",
  env: { ...process.env, AURA_GUARD_SCOPE: process.env.AURA_GUARD_SCOPE || "dev" },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
