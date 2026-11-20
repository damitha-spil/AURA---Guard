// The optional automated part of a QA plan: run existing, safety-checked, READ-ONLY journeys.
// Never automatic: `runConfirmed` throws unless the caller passes `confirmed: true`, which the chat
// route sets only after the person said so in a follow-up message or sent `runJourneys: true`.
// Never launches the app, never runs a repo's build or tests, never saves/creates/sends/deletes
// (runSpec re-checks every spec with the static safety checker and guards the page at run time).

import { existsSync, readFileSync } from "node:fs";
import type { GuardConfig } from "../types.ts";
import { isRejectedSpec } from "./generate.ts";
import { CDP_ENV, probeCdp } from "./harness.ts";
import { loadJourneys } from "./journeys.ts";
import { resolveSpec, runSpec } from "./runner.ts";
import type { RunDeps, RunResult } from "./runner.ts";
import { checkSpec, loadForbidden } from "./safety.ts";

/** At most this many journeys run for one confirmation. */
export const MAX_RUN_JOURNEYS = 5;

export interface RunnableJourney { journeyId: string; title: string; specPath: string; caseIds: string[] }
export interface RunOffer {
  runnable: RunnableJourney[];
  /** Why a journey with a case could not be offered. */
  blocked: { journeyId: string; reason: string }[];
  /** null when no journey needed the check. */
  targetReachable: boolean | null;
  note: string;
  safety: { checked: number; passed: number };
}

export interface RunProbe { probe?: (url: string) => Promise<string> }

/** Which cases can run: journey exists in this project's vault, a checked spec exists, a debuggable app is reachable. */
export async function findRunnable(cfg: GuardConfig, plan: { cases: { id: string; journeyId?: string | undefined }[] }, deps: RunProbe = {}): Promise<RunOffer> {
  const ids = [...new Set(plan.cases.map((c) => c.journeyId).filter((x): x is string => !!x))];
  const offer: RunOffer = { runnable: [], blocked: [], targetReachable: null, note: "", safety: { checked: 0, passed: 0 } };
  if (ids.length === 0) return offer;
  const known = new Map(loadJourneys(cfg).map((j) => [j.id, j]));
  const list = loadForbidden(cfg.root);
  for (const id of ids) {
    const j = known.get(id);
    if (!j) { offer.blocked.push({ journeyId: id, reason: "not a journey of this project" }); continue; }
    const spec = resolveSpec(cfg, id);
    if (!existsSync(spec)) { offer.blocked.push({ journeyId: id, reason: `no generated spec yet (run \`qa generate ${id}\`)` }); continue; }
    const src = readFileSync(spec, "utf8");
    offer.safety.checked++;
    if (isRejectedSpec(src) || !checkSpec(src, list).ok) { offer.blocked.push({ journeyId: id, reason: "the spec did not pass the safety check" }); continue; }
    offer.safety.passed++;
    offer.runnable.push({ journeyId: id, title: j.title, specPath: spec, caseIds: plan.cases.filter((c) => c.journeyId === id).map((c) => c.id) });
  }
  offer.runnable = offer.runnable.slice(0, MAX_RUN_JOURNEYS);
  if (offer.runnable.length === 0) { offer.note = offer.blocked.length ? "No journey can run yet." : ""; return offer; }
  const url = process.env[CDP_ENV];
  if (!url) {
    offer.targetReachable = false;
    offer.note = `${offer.runnable.length} journey${offer.runnable.length === 1 ? "" : "s"} could run, but no debuggable app is set up (${CDP_ENV} is not set). Start the app with a debugging port yourself; Guard never launches it.`;
    return offer;
  }
  try {
    await (deps.probe ?? probeCdp)(url);
    offer.targetReachable = true;
    offer.note = `${offer.runnable.length} read-only journey${offer.runnable.length === 1 ? "" : "s"} can run against the app that is already open. Reply "run the journeys" to start. Nothing is saved, created, sent or deleted.`;
  } catch (e) {
    offer.targetReachable = false;
    offer.note = `${offer.runnable.length} journey${offer.runnable.length === 1 ? "" : "s"} could run, but the app is not reachable (${(e as Error).message.split("\n")[0]}).`;
  }
  return offer;
}

export interface QaRunSummary {
  status: "passed" | "failed" | "blocked";
  runs: { journeyId: string; status: RunResult["status"]; reportPath: string | null; defects: number; blocker: string | null }[];
  defects: { journeyId: string; step: string; width: number | null; expected: string; actual: string; screenshot: string | null }[];
  proposedIncidents: number;
}

export interface ConfirmedRun { confirmed: true; proposeIncidents?: boolean; widths?: number[] }

export async function runConfirmed(cfg: GuardConfig, journeys: RunnableJourney[], opts: ConfirmedRun, deps: RunDeps = {}): Promise<QaRunSummary> {
  if ((opts as { confirmed?: unknown }).confirmed !== true) throw new Error("Journeys run only after an explicit confirmation.");
  const out: QaRunSummary = { status: "passed", runs: [], defects: [], proposedIncidents: 0 };
  for (const j of journeys.slice(0, MAX_RUN_JOURNEYS)) {
    const r = await runSpec(cfg, j.journeyId, { note: opts.proposeIncidents !== false, ...(opts.widths ? { widths: opts.widths } : {}) }, deps);
    out.runs.push({ journeyId: j.journeyId, status: r.status, reportPath: r.reportPath ?? null, defects: r.defects.length, blocker: r.blocker ?? null });
    for (const d of r.defects) out.defects.push({ journeyId: d.journey, step: d.step, width: d.width, expected: d.expected, actual: d.actual, screenshot: d.screenshot });
    if (opts.proposeIncidents !== false) out.proposedIncidents += r.defects.length;
    if (r.status === "failed") out.status = "failed";
    else if (r.status !== "passed" && out.status === "passed") out.status = "blocked";
  }
  return out;
}
