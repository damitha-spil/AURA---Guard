// `aura-guard health`: the same checks as GET /api/health.

import { runHealth } from "../health/health.ts";
import type { CommandContext } from "./main.ts";

export const healthCommands: Record<string, (ctx: CommandContext) => Promise<number> | number> = {
  health: async ({ flags, out, cfg }) => {
    const report = await runHealth(cfg);
    if (flags["json"] === true) out(JSON.stringify(report, null, 2));
    else {
      for (const r of report.rows) {
        out(`[${r.status.toUpperCase()}] ${r.label}: ${r.detail}`);
        if (r.fix) out(`    How to fix: ${r.fix}`);
      }
      out(`Overall: ${report.status}`);
    }
    return report.rows.some((r) => r.status === "fail") ? 1 : 0;
  },
};
