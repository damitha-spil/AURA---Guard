import { AuthBlockedError, AzureError, createClient } from "../prs/azure.ts";
import type { PrStatus } from "../prs/azure.ts";
import { writeDataset } from "../prs/dataset.ts";
import { minePrs } from "../prs/mine.ts";
import { repoCtxFromPath } from "../prs/remote.ts";
import { storedStatus, syncPrs } from "../prs/store.ts";
import type { CommandContext } from "./main.ts";

const copy = {
  usage: "Usage: prs <sync|mine|dataset|status> [repo] [--limit N] [--status completed|active|all] [--min-score N] [--max N] [--dry-run]",
  noRepo: (id: string) => `No repository "${id}" in the configuration.`,
  noRemote: (id: string) => `Repository "${id}" has no Azure DevOps origin remote that Guard understands.`,
  blocked: (m: string) => `Blocked: ${m}`,
  failed: (m: string) => `Pull request read failed: ${m}`,
  status: (code: number, last: string, prs: number, threads: number) =>
    `Server answered HTTP ${code}${code === 200 ? " (sign-in works)" : ""}. Last sync: ${last}. Stored: ${prs} pull requests, ${threads} threads.`,
  synced: (r: { listed: number; fetched: number; skipped: number; threads: number; comments: number; secretsDropped: number }) =>
    `Listed ${r.listed} PRs: fetched ${r.fetched}, skipped ${r.skipped} unchanged. Stored ${r.threads} threads, ${r.comments} comments. Dropped ${r.secretsDropped} comments with secrets.`,
  mined: (r: { prs: number; threads: number; comments: number; candidates: number; blockedBySecret: number; skippedDuplicate: number }, written: number, dry: boolean) =>
    `Read ${r.prs} PRs, ${r.threads} threads, ${r.comments} comments. ${r.candidates} candidates.` +
    ` ${dry ? "Dry run: nothing written." : `Wrote ${written} notes to the inbox.`} Duplicates skipped: ${r.skippedDuplicate}. Blocked by secret: ${r.blockedBySecret}.`,
  bands: (b: Record<string, number>) => "Score bands: " + (Object.entries(b).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"),
  areas: (a: { area: string; comments: number }[]) =>
    a.length ? "Most reviewed areas: " + a.map((x) => `${x.area} (${x.comments})`).join(", ") : "No reviewed areas yet.",
  dataset: (file: string, prs: number, comments: number) => `Wrote ${prs} merged PRs with ${comments} reviewer comments to ${file}.`,
};

const STATUSES = new Set(["completed", "active", "all"]);

async function run({ rest, flags, out, cfg }: CommandContext): Promise<number> {
  const sub = rest[0];
  if (!sub || !["sync", "mine", "dataset", "status"].includes(sub)) {
    out(copy.usage);
    return 2;
  }
  // "--status" may arrive as a bare flag with its value left in rest.
  const bareStatus = rest.slice(1).find((r) => STATUSES.has(r));
  const repoArg = rest.slice(1).find((r) => !STATUSES.has(r));
  const repo = repoArg ? cfg.repos.find((r) => r.id === repoArg) : cfg.repos[0];
  if (!repo) {
    out(copy.noRepo(repoArg ?? ""));
    return 2;
  }
  const statusRaw = typeof flags["status"] === "string" ? flags["status"] : bareStatus;
  const status: PrStatus = statusRaw && STATUSES.has(statusRaw) ? (statusRaw as PrStatus) : "completed";
  const num = (v: string | true | undefined): number | undefined => (typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : undefined);

  try {
    if (sub === "mine") {
      const r = minePrs(cfg, repo.id, {
        minScore: num(flags["min-score"]) ?? 0.6,
        max: num(flags["max"]) ?? 20,
        dryRun: flags["dry-run"] === true,
      });
      out(copy.mined(r, r.written.length, flags["dry-run"] === true));
      out(copy.bands(r.bands));
      out(copy.areas(r.areas));
      return 0;
    }
    if (sub === "dataset") {
      const r = writeDataset(cfg, repo.id);
      out(copy.dataset(r.file, r.prs, r.comments));
      return 0;
    }
    const ctx = repoCtxFromPath(repo.path);
    if (!ctx) {
      out(copy.noRemote(repo.id));
      return 1;
    }
    const client = createClient(ctx);
    if (sub === "status") {
      const code = await client.probe();
      const s = storedStatus(cfg, repo.id);
      out(copy.status(code, s.lastSync ?? "never", s.prs, s.threads));
      return code === 200 ? 0 : 1;
    }
    const limit = num(flags["limit"]) ?? 50;
    const since = typeof flags["since"] === "string" ? flags["since"] : undefined;
    out(copy.synced(await syncPrs(cfg, client, repo.id, { limit, status, ...(since ? { since } : {}) })));
    return 0;
  } catch (e) {
    if (e instanceof AuthBlockedError) {
      out(copy.blocked(e.message));
      return 1;
    }
    if (e instanceof AzureError) {
      out(copy.failed(e.message));
      return 1;
    }
    throw e;
  }
}

export const prCommands: Record<string, (ctx: CommandContext) => Promise<number> | number> = { prs: run };
