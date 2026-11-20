// `aura-guard capture ...` and `aura-guard answer ...`: the commands the VS Code extension calls.
// With --json, stdout is exactly one JSON object; errors are {"ok":false,"error":"..."} with exit 1.
// Nothing here prints a secret: the spool is already masked and every model call goes through the brain.

import { existsSync } from "node:fs";
import { dbPath } from "../config.ts";
import { answer } from "../chat/answer.ts";
import { openDb } from "../index/db.ts";
import { ApiError, BlockedError, MissingKeyError } from "../brain/client.ts";
import { CliError } from "../brain/backends.ts";
import { createBrain, NoBackendError } from "../brain/select.ts";
import { CaptureError, requireConsent, summarizeDay } from "../capture/summarize.ts";
import {
  isAbsoluteWorkspacePath, isRealDate, loadCaptureConfig, localDate, pruneRetention, readConsent, readDay,
  removeAll, removeBefore, removeRepo, repoKeyFor, repoStatuses, spoolDir,
} from "../capture/spool.ts";
import type { CommandContext } from "./main.ts";

const copy = {
  usage: "Use: capture status | show --repo <path> | summarize --repo <path> | purge --repo <path> --before <date> | purge --all --yes",
  needRepo: "Give the workspace folder with --repo <absolute path>.",
  badRepo: "--repo must be the full path of the workspace folder.",
  badDate: "The date must look like 2026-11-20.",
  noConsent: "Capture is not switched on for this workspace. Turn it on in the editor first.",
  purgeNeedsScope: "Say what to delete: --before <date> or --all.",
  purgeNeedsYes: "Deleting everything, including your consent, needs --yes.",
  noIndex: "The knowledge index is not built yet. Run: aura-guard index",
  noQuestion: "Give a question, for example: aura-guard answer \"Why ...?\" --json",
  failed: (why: string) => `Failed: ${why}`,
  statusLine: (k: string, days: number, events: number, a: string, b: string) => `${k}: ${days} days, ${events} events (${a} to ${b})`,
  statusConsent: (yes: boolean, dev: string | null) => (yes ? `Consent given by ${dev ?? "unknown"}.` : "No consent given yet."),
  removed: (n: number) => `Removed ${n} files.`,
  draftReady: (n: number, file: string) => `Draft with ${n} entries for ${file}:`,
  nothingNew: "Nothing new to add to the log.",
};

type Fn = (ctx: CommandContext) => Promise<number> | number;

class UserError extends Error {
  kind: string | undefined;
  constructor(message: string, kind?: string) {
    super(message);
    this.name = "UserError";
    this.kind = kind;
  }
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function repoArg(ctx: CommandContext): string {
  const r = str(ctx.flags.repo);
  if (!r) throw new UserError(copy.needRepo);
  if (!isAbsoluteWorkspacePath(r)) throw new UserError(copy.badRepo);
  return r;
}

function dateArg(ctx: CommandContext, key: string): string | undefined {
  const d = str(ctx.flags[key]);
  if (d === undefined) return undefined;
  if (!isRealDate(d)) throw new UserError(copy.badDate);
  return d;
}

/** Runs one command body; prints one JSON object (or plain words) and returns the exit code. */
async function respond(ctx: CommandContext, body: () => Promise<{ json: Record<string, unknown>; text: string[] }>): Promise<number> {
  const asJson = ctx.flags.json === true;
  try {
    const r = await body();
    if (asJson) ctx.out(JSON.stringify({ ok: true, ...r.json }));
    else for (const l of r.text) ctx.out(l);
    return 0;
  } catch (e) {
    let message: string;
    let kind: string | undefined;
    if (e instanceof UserError || e instanceof CaptureError) message = e.message;
    else if (e instanceof BlockedError) { message = e.message; kind = "blocked"; }
    else if (e instanceof MissingKeyError) { message = e.message; kind = "no-key"; }
    else if (e instanceof NoBackendError) { message = e.message; kind = "no-backend"; }
    else if (e instanceof ApiError) { message = e.message; kind = "api"; }
    else if (e instanceof CliError) { message = e.message; kind = "cli"; }
    else message = "Something went wrong inside Guard. Nothing was changed.";
    if (e instanceof UserError && e.kind) kind = e.kind;
    if (asJson) ctx.out(JSON.stringify({ ok: false, error: message, ...(kind ? { kind } : {}) }));
    else ctx.out(copy.failed(message));
    return 1;
  }
}

function status(ctx: CommandContext): Promise<number> {
  return respond(ctx, async () => {
    const dir = spoolDir();
    const cfg = loadCaptureConfig(ctx.cfg.root);
    pruneRetention(dir, cfg);
    const consent = readConsent(dir);
    const repos = repoStatuses(dir, cfg);
    return {
      json: { spoolDir: dir, consent: { accepted: consent !== null, developer: consent?.developer ?? null }, repos },
      text: [copy.statusConsent(consent !== null, consent?.developer ?? null), ...repos.map((r) => copy.statusLine(r.repoKey, r.days, r.events, r.oldest, r.newest))],
    };
  });
}

function show(ctx: CommandContext): Promise<number> {
  return respond(ctx, async () => {
    const repo = repoArg(ctx);
    const date = dateArg(ctx, "date") ?? localDate();
    const dir = spoolDir();
    const cfg = loadCaptureConfig(ctx.cfg.root);
    pruneRetention(dir, cfg);
    const { repoKey } = requireConsent(dir, repo);
    const day = readDay(dir, repoKey, date, cfg);
    return {
      json: { date, events: day.events, skipped: day.skipped },
      text: day.events.map((e) => `${e.ts} ${e.kind} ${JSON.stringify(e.data)}`),
    };
  });
}

function summarize(ctx: CommandContext): Promise<number> {
  return respond(ctx, async () => {
    const repo = repoArg(ctx);
    const date = dateArg(ctx, "date");
    const noModel = ctx.flags["no-model"] === true;
    const brain = noModel ? null : createBrain(ctx.cfg);
    const r = await summarizeDay(
      ctx.cfg,
      { repoPath: repo, ...(date ? { date } : {}), noModel },
      brain ? { complete: brain.complete, backendUsed: brain.backendUsed } : {},
    );
    return {
      json: { ...r },
      text: r.entries ? [copy.draftReady(r.entries, r.file), r.draft] : [copy.nothingNew],
    };
  });
}

function purge(ctx: CommandContext): Promise<number> {
  return respond(ctx, async () => {
    const dir = spoolDir();
    const repo = str(ctx.flags.repo);
    const before = dateArg(ctx, "before");
    const all = ctx.flags.all === true;
    let removed = 0;
    if (repo) {
      if (!isAbsoluteWorkspacePath(repo)) throw new UserError(copy.badRepo);
      const key = repoKeyFor(repo);
      if (before) removed = removeBefore(dir, key, before);
      else if (all) removed = removeRepo(dir, key);
      else throw new UserError(copy.purgeNeedsScope);
    } else {
      if (!all) throw new UserError(copy.purgeNeedsScope);
      if (ctx.flags.yes !== true) throw new UserError(copy.purgeNeedsYes);
      removed = removeAll(dir);
    }
    return { json: { removed }, text: [copy.removed(removed)] };
  });
}

const captureSubs: Record<string, (ctx: CommandContext) => Promise<number>> = { status, show, summarize, purge };

export const captureCommands: Record<string, Fn> = {
  capture: async (ctx) => {
    const sub = ctx.rest[0] ?? "";
    const fn = captureSubs[sub];
    if (fn) return fn(ctx);
    return respond(ctx, async () => { throw new UserError(copy.usage); });
  },
  answer: (ctx) =>
    respond(ctx, async () => {
      const question = ctx.rest.join(" ").trim();
      if (!question) throw new UserError(copy.noQuestion);
      const file = dbPath(ctx.cfg);
      if (!existsSync(file)) throw new UserError(copy.noIndex, "no-index");
      const brain = createBrain(ctx.cfg);
      const db = openDb(file);
      try {
        const r = await answer(ctx.cfg, db, { history: [], question, notesOnly: ctx.flags["notes-only"] === true }, { complete: brain.complete });
        if (!r.ok) throw new UserError(r.text, r.error);
        return {
          json: {
            text: r.text,
            sources: r.sources.map((s) => ({ ref: s.ref, kind: s.kind, title: s.title, status: s.status })),
            backend: brain.backendUsed() ?? "none",
          },
          text: [r.text],
        };
      } finally {
        db.close();
      }
    }),
};

