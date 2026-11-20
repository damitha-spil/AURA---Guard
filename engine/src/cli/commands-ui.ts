// The `ui` command: the local chat window. Merge `uiCommands` into EXTRA_COMMANDS in main.ts.

import type { CommandContext } from "./main.ts";

const copy = {
  usage: "Usage: aura-guard ui [--port N] [--no-open]",
  badPort: "The port must be a number from 0 to 65535 (0 picks a free port).",
};

/** main.ts reads a flag value only for known flags, so `--port 8080` may arrive as rest[0]. */
export function parsePort(ctx: Pick<CommandContext, "rest" | "flags">): number | null {
  const f = ctx.flags["port"];
  const raw = typeof f === "string" ? f : f === true ? ctx.rest[0] : undefined;
  if (raw === undefined) return 0;
  if (!/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 65535 ? n : null;
}

export const uiCommands: Record<string, (ctx: CommandContext) => Promise<number> | number> = {
  ui: async (ctx) => {
    const port = parsePort(ctx);
    if (port === null) {
      ctx.out(copy.badPort);
      ctx.out(copy.usage);
      return 2;
    }
    const { runUi } = await import("../server/launch.ts");
    // The server picks the department per request, so it needs the machine config the registry hangs on.
    return runUi(ctx.base ?? ctx.cfg, { port, open: ctx.flags["no-open"] !== true, out: ctx.out });
  },
};
