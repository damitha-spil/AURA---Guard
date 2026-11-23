// QA runner: runs one spec against an Aura the owner already started with a debugging port.
//
// HARD RULES: never launches Aura, never runs cargo, never writes into the Aura repo, never changes
// Aura's settings. A spec that fails qa/safety.ts (or carries the REJECTED header) is never run.
// Evidence goes to Guard's .artifacts/qa/<run>/ (git ignored).

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import type { Page } from "playwright-core";
import type { GuardConfig } from "../types.ts";
import { isRejectedSpec } from "./generate.ts";
import { findJourney } from "./journeys.ts";
import {
  attachAura, cdpHowTo, CDP_ENV, CdpUnreachable, DEFAULT_WIDTHS, guardPage, makeContext, probeCdp,
  registeredJourneys, StepFailed,
} from "./harness.ts";
import type { Attached, StepRecord } from "./harness.ts";
import { CuaClient, createMcpCuaTransport } from "./cua_client.ts";
import { createCuaStepContext, selectTargetWindow } from "./cua_harness.ts";
import type { CuaStepContext } from "./cua_harness.ts";
import { checkSpec, describeFindings, loadForbidden } from "./safety.ts";
import type { SafetyFinding } from "./safety.ts";

export type RunStatus = "passed" | "failed" | "blocked" | "rejected";

export interface Defect {
  journey: string;
  spec: string;
  width: number | null;
  step: string;
  expected: string;
  actual: string;
  screenshot: string | null;
}

export interface WidthRun {
  width: number | null;
  /** false when the WebView would not take the emulated size; the window's own size was used */
  applied: boolean;
  note?: string;
  steps: StepRecord[];
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  journey: string;
  spec: string;
  dir: string | null;
  blocker?: string;
  howTo?: string[];
  safety?: SafetyFinding[];
  widths: WidthRun[];
  defects: Defect[];
  videoNote: string;
  reportPath?: string;
  jsonPath?: string;
  notes: string[];
}

export interface RunOptions {
  cdpUrl?: string;
  widths?: number[];
  /** Also record the real window with Aura's own record-window.ps1 (needs ffmpeg; the window must be uncovered). */
  video?: boolean;
  /** Write a proposed incident note into vault/inbox for each defect. */
  note?: boolean;
  now?: () => Date;
  /** Which UI automation driver to use: "cdp" (default when AURA_CDP_URL is set) or "cua" (background UIA). */
  driver?: "cdp" | "cua";
  /** Optional window title/process substring when running with driver: "cua". */
  windowMatch?: string;
}

export interface RunDeps {
  /** For tests: replaces the real CDP attach. */
  attach?: (url: string) => Promise<Attached>;
  probe?: (url: string) => Promise<string>;
  /** For tests: injects a fake CuaClient instead of spawning cua-driver mcp. */
  cuaClient?: CuaClient;
}

/** Safety limit: the video recorder stops after this long if the run is still going. */
const VIDEO_MAX_SECONDS = 120;
/** Fallback window height when the WebView does not say its own. */
const FALLBACK_HEIGHT = 760;

/** Each load gets its own query, so a spec run twice in one second is evaluated twice. */
let loadCount = 0;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "step";

/** A spec path, or a journey id (with or without "journey-") that has a generated spec. */
export function resolveSpec(cfg: GuardConfig, target: string): string {
  if (/\.ts$/.test(target)) return target;
  const id = findJourney(cfg, target)?.id ?? target;
  return join(cfg.root, "qa", "generated", `${id}.spec.ts`);
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
}

export function reportMarkdown(r: RunResult): string {
  const L: string[] = [`# QA run ${r.runId}`, "", `- Journey: \`${r.journey}\``, `- Spec: \`${r.spec}\``, `- Result: **${r.status}**`, `- Video: ${r.videoNote}`, ""];
  if (r.blocker) {
    L.push("## Blocker", "", r.blocker, "");
    if (r.howTo) for (const h of r.howTo) L.push(h);
  }
  if (r.safety?.length) { L.push("## Safety check failed, spec not run", ""); for (const s of describeFindings(r.safety)) L.push(`- ${s}`); L.push(""); }
  for (const w of r.widths) {
    L.push(`## ${w.width ? `${w.width} px wide` : "Window size"}${w.applied ? "" : " (size not applied)"}`, "");
    if (w.note) L.push(`Note: ${w.note}`, "");
    for (const s of w.steps) {
      L.push(`${s.n}. ${s.status === "passed" ? "PASS" : "FAIL"} ${s.title} (${s.ms} ms)${s.screenshot ? ` - \`${s.screenshot}\`` : ""}`);
      if (s.error) L.push(`   - Expected: ${s.expected}`, `   - Actual: ${s.error}`);
    }
    L.push("");
  }
  if (r.defects.length) {
    L.push("## Defects", "");
    for (const d of r.defects) L.push(`- **${d.step}** at ${d.width ?? "window"} px. Expected: ${d.expected}. Actual: ${d.actual}.${d.screenshot ? ` Screenshot: \`${d.screenshot}\`.` : ""}`);
    L.push("");
  }
  if (r.notes.length) { L.push("## Notes", ""); for (const n of r.notes) L.push(`- ${n}`); }
  return L.join("\n") + "\n";
}

function finish(cfg: GuardConfig, r: RunResult, opts: RunOptions): RunResult {
  if (r.dir) {
    mkdirSync(r.dir, { recursive: true });
    r.jsonPath = join(r.dir, "result.json");
    r.reportPath = join(r.dir, "report.md");
    writeFileSync(r.jsonPath, JSON.stringify(r, null, 2));
    writeFileSync(r.reportPath, reportMarkdown(r));
  }
  if (opts.note && r.defects.length) {
    for (const [n, d] of r.defects.entries()) writeDefectNote(cfg, r, d, n + 1, opts.now?.() ?? new Date());
  }
  return r;
}

/** A proposed incident note in vault/inbox/ for a failed step. Owner reviews it; Guard never makes it active. */
export function writeDefectNote(cfg: GuardConfig, r: RunResult, d: Defect, n: number, when: Date): string {
  const dir = join(cfg.vaultDir, "inbox");
  mkdirSync(dir, { recursive: true });
  const id = `incident-qa-${slug(r.journey.replace(/^journey-/, ""))}-${stamp(when).slice(0, 8)}-${n}`;
  const file = join(dir, `${id}.md`);
  const meta = {
    id, type: "incident", status: "proposed", audience: ["qa_internal", "internal_dev"], source: "evidence",
    created: when.toISOString().slice(0, 10), title: `QA defect: ${d.step}`,
  };
  const body = [
    `# QA defect: ${d.step}`, "", "## What happened", "",
    `Journey \`${r.journey}\`, step "${d.step}"${d.width ? ` at ${d.width} px width` : ""}.`, `Expected: ${d.expected}.`, `Actual: ${d.actual}.`, "",
    "## Evidence", "", d.screenshot ? `Screenshot: ${d.screenshot}` : "No screenshot was taken.", `Run: ${r.runId}`, "",
    "## Impact", "", "Not assessed yet. A person decides whether this is a real defect.", "",
  ].join("\n");
  writeFileSync(file, `---\n${stringify(meta, { lineWidth: 0 })}---\n\n${body}\n`, { flag: "wx" });
  return file;
}

function startVideo(cfg: GuardConfig, out: string): { done: Promise<string> } {
  const aura = cfg.repos.find((x) => x.id === "spil-aura") ?? cfg.repos[0];
  const script = aura ? join(aura.path, ".claude", "skills", "aura-evidence", "scripts", "record-window.ps1") : "";
  if (!script || !existsSync(script)) return { done: Promise.resolve("Video skipped: Aura's record-window.ps1 was not found (read-only lookup).") };
  // Runs Aura's own script from where it lives. It only reads the screen; it writes the mp4 to `out` in Guard.
  return {
    done: new Promise((res) => {
      execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Out", out, "-Seconds", String(VIDEO_MAX_SECONDS)],
        { windowsHide: true, timeout: (VIDEO_MAX_SECONDS + 30) * 1000 }, (err) => {
          res(err ? `Video failed: ${err.message.split("\n")[0]}` : `Video saved: ${out}. Check it with ffprobe before using it as proof.`);
        });
    }),
  };
}

async function setWidth(page: Page, width: number): Promise<{ applied: boolean; note?: string }> {
  try {
    const h = (await page.evaluate("window.innerHeight").catch(() => FALLBACK_HEIGHT)) as number;
    await page.setViewportSize({ width, height: h || FALLBACK_HEIGHT });
    return { applied: true };
  } catch (e) {
    return { applied: false, note: `The WebView would not take a ${width} px width (${(e as Error).message.split("\n")[0]}). The window's own size was used.` };
  }
}

async function clearWidth(page: Page): Promise<void> {
  try {
    const s = await page.context().newCDPSession(page);
    await s.send("Emulation.clearDeviceMetricsOverride");
  } catch { /* nothing to clear */ }
}

export async function runSpec(cfg: GuardConfig, target: string, opts: RunOptions = {}, deps: RunDeps = {}): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const spec = resolveSpec(cfg, target);
  const journeyName = /\.spec\.ts$/.test(spec) ? (spec.split(/[\\/]/).pop() as string).replace(/\.spec\.ts$/, "") : target;
  const runId = `${stamp(now())}-${slug(journeyName)}`;
  const base: RunResult = { runId, status: "blocked", journey: journeyName, spec, dir: null, widths: [], defects: [], videoNote: "No video.", notes: [] };

  // 1. The spec must exist, not be REJECTED, and pass the safety check. Otherwise nothing runs.
  if (!existsSync(spec)) return { ...base, blocker: `Spec not found: ${spec}. Run \`qa generate ${journeyName}\` first.` };
  const source = readFileSync(spec, "utf8");
  if (isRejectedSpec(source)) {
    return { ...base, status: "rejected", blocker: "This spec carries the REJECTED header from generation and is never run. Read why at the top of the file." };
  }
  const safety = checkSpec(source, loadForbidden(cfg.root));
  if (!safety.ok) return { ...base, status: "rejected", safety: safety.findings, blocker: "The spec failed the safety check and was not run." };

  // 2. Aura must already be running with a debugging port. We never start it.
  const url = opts.cdpUrl ?? process.env[CDP_ENV];
  if (!url) {
    return { ...base, blocker: `${CDP_ENV} is not set, so there is no Aura to attach to.`, howTo: cdpHowTo() };
  }
  try {
    await (deps.probe ?? probeCdp)(url);
  } catch (e) {
    return { ...base, blocker: (e as Error).message + ` Aura must already be running with a debugging port at ${url}.`, howTo: cdpHowTo(url) };
  }

  // 3. Register the journey(s) from the spec.
  const reg = registeredJourneys();
  reg.clear();
  try {
    await import(pathToFileURL(spec).href + `?run=${runId}-${++loadCount}`);
  } catch (e) {
    return { ...base, status: "failed", blocker: `The spec could not be loaded: ${(e as Error).message.split("\n")[0]}` };
  }
  if (reg.size === 0) return { ...base, status: "failed", blocker: "The spec did not register a journey." };

  const dir = join(cfg.root, ".artifacts", "qa", runId);
  mkdirSync(dir, { recursive: true });
  const result: RunResult = { ...base, dir, status: "passed" };
  const list = loadForbidden(cfg.root);

  let attached: Attached;
  try {
    attached = await (deps.attach ?? attachAura)(url);
  } catch (e) {
    const msg = e instanceof CdpUnreachable ? e.message : `Could not attach: ${(e as Error).message.split("\n")[0]}`;
    return finish(cfg, { ...result, status: "blocked", blocker: msg, howTo: cdpHowTo(url) }, opts);
  }

  const video = opts.video ? startVideo(cfg, join(dir, "walkthrough.mp4")) : null;
  const widths: (number | null)[] = opts.widths && opts.widths.length ? opts.widths : DEFAULT_WIDTHS;
  try {
    for (const [id, fn] of reg) {
      for (const width of widths) {
        const wr: WidthRun = { width, applied: true, steps: [] };
        result.widths.push(wr);
        if (width !== null) {
          const w = await setWidth(attached.page, width);
          wr.applied = w.applied;
          if (w.note) { wr.note = w.note; result.notes.push(w.note); }
        }
        const shotDir = join(dir, width ? String(width) : "window");
        mkdirSync(shotDir, { recursive: true });
        const ctx = makeContext(guardPage(attached.page, list), {
          width,
          record: (s) => wr.steps.push(s),
          shot: async (label) => {
            const file = join(shotDir, `${slug(label)}.png`);
            try { await attached.page.screenshot({ path: file }); return file; } catch { return undefined; }
          },
        });
        try {
          await fn(ctx);
        } catch (e) {
          if (!(e instanceof StepFailed)) {
            // A failure outside a step (e.g. a guard refusal while setting up): record it as a failed step.
            wr.steps.push({ n: wr.steps.length + 1, width, title: "(outside a step)", expected: "The journey runs", status: "failed", ms: 0, error: (e as Error).message.split("\n")[0] as string });
          }
        }
        for (const s of wr.steps) {
          if (s.status === "failed") {
            result.status = "failed";
            result.defects.push({ journey: id, spec, width, step: s.title, expected: s.expected, actual: s.error ?? "failed", screenshot: s.screenshot ?? null });
          }
        }
      }
    }
  } finally {
    await clearWidth(attached.page);
    await attached.detach().catch(() => undefined);
  }
  if (video) result.videoNote = await video.done;
  else result.videoNote = "No video: Playwright cannot record a WebView it only attached to. Use --video (Aura's record-window.ps1) or record by hand.";
  return finish(cfg, result, opts);
}

/** Runs a background UI journey using cua-driver (UIA + PrintWindow) with full qa/safety.ts guards. */
export async function runJourneyWithCua(
  cfg: GuardConfig,
  journeyId: string,
  fn: (ctx: CuaStepContext) => Promise<void>,
  opts: RunOptions = {},
  deps: RunDeps = {},
): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const runId = `${stamp(now())}-${slug(journeyId)}-cua`;
  const dir = join(cfg.root, ".artifacts", "qa", runId);
  mkdirSync(dir, { recursive: true });
  const result: RunResult = {
    runId,
    status: "passed",
    journey: journeyId,
    spec: `cua://${journeyId}`,
    dir,
    widths: [],
    defects: [],
    videoNote: "Background UIA mode (cua-driver): window-scoped screenshots captured without focus theft.",
    notes: [],
  };
  const ownsClient = !deps.cuaClient;
  let client: CuaClient;
  try {
    client = deps.cuaClient ?? new CuaClient(await createMcpCuaTransport(cfg));
  } catch (e) {
    return finish(cfg, { ...result, status: "blocked", blocker: `Could not start cua-driver: ${(e as Error).message.split("\n")[0]}` }, opts);
  }
  const wr: WidthRun = { width: null, applied: true, steps: [] };
  result.widths.push(wr);
  try {
    const windows = await client.listWindows();
    const win = selectTargetWindow(windows, cfg, opts.windowMatch);
    const ctx = createCuaStepContext({
      client,
      window: win,
      forbidden: loadForbidden(cfg.root),
      shotDir: join(dir, "background"),
      record: (s) => wr.steps.push(s),
    });
    await fn(ctx);
  } catch (e) {
    if (wr.steps.every((s) => s.status !== "failed")) {
      wr.steps.push({
        n: wr.steps.length + 1,
        width: null,
        title: "(cua-driver step)",
        expected: "The background journey runs",
        status: "failed",
        ms: 0,
        error: (e as Error).message.split("\n")[0] ?? "failed",
      });
    }
  } finally {
    if (ownsClient) await client.close().catch(() => undefined);
  }
  for (const s of wr.steps) {
    if (s.status === "failed") {
      result.status = "failed";
      result.defects.push({
        journey: journeyId,
        spec: result.spec,
        width: null,
        step: s.title,
        expected: s.expected,
        actual: s.error ?? "failed",
        screenshot: s.screenshot ?? null,
      });
    }
  }
  return finish(cfg, result, opts);
}
