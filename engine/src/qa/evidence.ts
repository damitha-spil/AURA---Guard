// PR Evidence Packet builder (redacted, path-jailed inside .artifacts/qa/<runId>/).
// Collects 800/1100/1440 px screenshots, walkthrough video note, deterministic oracle summary,
// rubric/trajectory scores, and release gate verdict ready to paste into an Azure DevOps PR.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GuardConfig } from "../types.ts";
import { getQaRun, safeQaScreenshotPath } from "./harness_api.ts";
import type { QaRunDetail, ReleaseGate } from "./harness_api.ts";
import { appScope, classifyChange, evaluateEvidence, evidenceMarkdown } from "./evidence_scope.ts";
import type { EvidenceStatus, Proof, ProofSource } from "./evidence_scope.ts";
import { evaluateTrajectory, evaluateWithRubric } from "./judge.ts";
import type { JudgeEvaluation, TrajectoryEvaluation } from "./judge.ts";
import { maskDeep } from "./safe-out.ts";

/** The widths a UI change must be shown at. */
export const PROOF_WIDTHS = [800, 1100, 1440] as const;
/** A proof note bigger than this is not read. */
const MAX_PROOF_BYTES = 64 * 1024;
const NOT_REAL = /(preview|mock|sample|storybook|fixture)/i;
const PNG_MAGIC = "89504e470d0a1a0a";
const SOURCES: ProofSource[] = ["real-app", "real-service", "command-output", "attested", "preview", "mock", "sample", "test-count"];

const text = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const sourceOf = (v: unknown): ProofSource => SOURCES.find((s) => s === v) ?? "unknown";

/** A real, non-empty file inside the run folder (a link that leads out does not count). */
function fileInRun(runDir: string, rel: string): string | null {
  try {
    const full = realpathSync(resolve(runDir, rel));
    const inside = relative(realpathSync(runDir), full);
    if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(".." + sep)) return null;
    const st = statSync(full);
    return st.isFile() && st.size > 0 ? full : null;
  } catch {
    return null;
  }
}

function isPng(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(8);
    return readSync(fd, b, 0, 8, 0) === 8 && b.toString("hex") === PNG_MAGIC;
  } finally {
    closeSync(fd);
  }
}

/**
 * The proof status of one saved QA run. Proof comes from the run itself and from an optional
 * proof.json that a person puts in .artifacts/qa/<runId>/. REO cannot check what a person recorded
 * there, so those items say "recorded by a person".
 */
export function runEvidence(cfg: GuardConfig, detail: QaRunDetail): EvidenceStatus {
  const r = detail.result;
  const runDir = resolve(join(cfg.root, ".artifacts", "qa", r.id));
  const paths = (r.context?.changedFiles ?? []).map((f) => f.path);
  const scope = paths.length ? classifyChange(paths) : r.evidence?.uiChange ? appScope() : classifyChange([]);

  const blockers: string[] = [];
  const journeys = r.run?.runs ?? [];
  if (r.run?.status === "blocked") blockers.push("The journey run was blocked.");
  for (const x of journeys) if (x.status === "blocked") blockers.push(`Journey ${x.journeyId} was blocked${x.blocker ? `: ${x.blocker}` : "."}`);

  let note: Record<string, unknown> = {};
  const noteFile = fileInRun(runDir, "proof.json");
  if (noteFile) {
    try {
      if (statSync(noteFile).size > MAX_PROOF_BYTES) throw new Error("too large");
      note = record(JSON.parse(readFileSync(noteFile, "utf8")));
    } catch {
      blockers.push("proof.json could not be read.");
    }
  }

  const proofs: Proof[] = [];
  const add = (requirement: Proof["requirement"], source: ProofSource, detailText: string): void => {
    proofs.push({ requirement, source, detail: detailText });
  };
  const by = "recorded by a person; REO did not verify it";

  const env = text(note["environment"], 80);
  if (env) add("environment", "attested", `${env}, ${by}`);

  const failed = r.run?.status === "failed" || (r.run?.defects?.length ?? 0) > 0 || journeys.some((x) => x.status !== "passed");
  if (journeys.length > 0 && !failed) add("app-interaction", "real-app", `${journeys.length} journey(s) passed against the attached app; REO cannot tell whether that app used mock data`);
  const flow = record(note["interaction"]);
  // A person's note never overrides a run that failed.
  if (text(flow["steps"]) && !failed) add("app-interaction", sourceOf(flow["source"]), `${text(flow["steps"], 200)}, ${by}`);

  const widths = new Set<number>();
  const shots = Array.isArray(note["screenshots"]) ? note["screenshots"].slice(0, 30) : [];
  for (const s of shots) {
    const o = record(s);
    const rel = text(o["path"]);
    const source = NOT_REAL.test(rel) ? "preview" : sourceOf(o["source"]);
    const file = fileInRun(runDir, rel);
    if (source !== "real-app") add("app-screenshots", source, rel);
    else if (file && isPng(file)) widths.add(Number(o["width"]));
  }
  if (PROOF_WIDTHS.every((w) => widths.has(w))) add("app-screenshots", "real-app", `PNG files for ${PROOF_WIDTHS.join(", ")} px, ${by}`);

  if (fileInRun(runDir, "walkthrough.mp4")) {
    const video = record(note["video"]);
    // A video counts when this run drove the app, or a person says what it shows.
    if (video["source"] !== undefined) add("app-video", sourceOf(video["source"]), `walkthrough.mp4, ${by}`);
    else if (journeys.length > 0) add("app-video", "real-app", "walkthrough.mp4 in the run folder; REO did not watch it");
  }

  const rb = record(note["serviceReadback"]);
  if (text(rb["request"]) && text(rb["result"]) && text(rb["readback"])) add("service-readback", sourceOf(rb["source"]), `request, result and readback in proof.json, ${by}`);
  const check = record(note["checkOutput"]);
  if (text(check["command"]) && text(check["output"])) add("check-output", "command-output", `${text(check["command"], 120)}, ${by}`);
  if (text(note["noAppPathReason"])) add("no-app-path-reason", "attested", `${text(note["noAppPathReason"], 200)}, ${by}`);

  return maskDeep(evaluateEvidence(scope, proofs, blockers));
}

export interface PrEvidencePacket {
  evidenceScope: EvidenceStatus;
  version: 1;
  runId: string;
  generatedAt: string;
  targetLabel: string;
  repos: string[];
  releaseGate: ReleaseGate;
  gateReason: string;
  environment: {
    databasePolicy: "test-db-only";
    erpWriteBlocked: true;
    deliveryMode: "background";
  };
  widthsCovered: number[];
  screenshots: { journey: string; step: string; width: number | null; path: string }[];
  videoPath: string | null;
  videoNote: string;
  evaluation: JudgeEvaluation;
  trajectory: TrajectoryEvaluation;
  defects: { journey: string; step: string; width: number | null; expected: string; actual: string }[];
}

export interface BuiltEvidencePacket {
  packet: PrEvidencePacket;
  markdown: string;
  markdownPath: string;
  jsonPath: string;
}

export async function buildPrEvidencePacket(cfg: GuardConfig, runId: string): Promise<BuiltEvidencePacket | null> {
  const detail = getQaRun(cfg, runId);
  if (!detail) return null;

  const r = detail.result;
  const runDir = resolve(join(cfg.root, ".artifacts", "qa", r.id));
  const qaRoot = resolve(join(cfg.root, ".artifacts", "qa"));
  if (!runDir.startsWith(qaRoot + sep)) {
    throw new Error("Refusing to write PR evidence packet outside .artifacts/qa.");
  }

  const widthsSet = new Set<number>();
  const screenshots = detail.screenshots.filter((s) => safeQaScreenshotPath(cfg, s.path) !== null);
  for (const s of screenshots) {
    if (typeof s.width === "number") widthsSet.add(s.width);
  }
  for (const d of r.run?.defects ?? []) {
    if (typeof d.width === "number") widthsSet.add(d.width);
  }

  const videoCandidate = join(runDir, "walkthrough.mp4");
  const videoPath = existsSync(videoCandidate) ? videoCandidate : null;
  const videoNote = videoPath ? `Walkthrough video recorded: ${videoPath}` : "No walkthrough video attached for this run.";

  const stepItems = (r.run?.runs ?? []).map((x) => ({
    action: "journey",
    target: x.journeyId,
    status: x.status === "passed" ? ("passed" as const) : x.status === "blocked" ? ("blocked" as const) : ("failed" as const),
  }));
  const trajectory = evaluateTrajectory(stepItems);
  const evaluation = await evaluateWithRubric({
    journey: r.target?.label ?? r.id,
    summary: r.summary,
    safetyBlockedCount: Math.max(0, detail.scorecard.safetyChecked - detail.scorecard.safetyPassed),
  });

  const packet: PrEvidencePacket = maskDeep({
    version: 1,
    evidenceScope: runEvidence(cfg, detail),
    runId: r.id,
    generatedAt: new Date().toISOString(),
    targetLabel: r.target?.label ?? "Unknown target",
    repos: (r.target?.repos ?? []).map((x) => x.repo).filter(Boolean),
    releaseGate: detail.scorecard.releaseGate,
    gateReason: detail.scorecard.gateReason,
    environment: {
      databasePolicy: "test-db-only",
      erpWriteBlocked: true,
      deliveryMode: "background",
    },
    widthsCovered: [...widthsSet].sort((a, b) => a - b),
    screenshots,
    videoPath,
    videoNote,
    evaluation,
    trajectory,
    defects: (r.run?.defects ?? []).map((d) => ({
      journey: d.journeyId,
      step: d.step,
      width: d.width,
      expected: d.expected,
      actual: d.actual,
    })),
  });

  const mdLines = [
    `# PR Evidence Packet: \`${packet.runId}\``,
    "",
    `- **Target:** ${packet.targetLabel}`,
    `- **Release Gate:** **${packet.releaseGate.toUpperCase()}** — ${packet.gateReason}`,
    `- **Policy (this packet does not verify it):** test database only, ERP writes blocked, background delivery`,
    `- **Widths in this run's results:** ${packet.widthsCovered.length ? packet.widthsCovered.map((w) => `${w} px`).join(", ") : "None recorded"}`,
    `- **Rubric score:** ${packet.evaluation.overallScore}/5 (${packet.evaluation.verdict.toUpperCase()})`,
    `- **Trajectory:** ${packet.trajectory.summary}`,
    `- **Video:** ${packet.videoNote}`,
    "",
    ...evidenceMarkdown(packet.evidenceScope),
    "## Rubric Breakdown",
    ...packet.evaluation.rubrics.map((rb) => `- **${rb.label}:** ${rb.score}/5 — ${rb.evidence}`),
    "",
    "## Screenshots",
    ...(packet.screenshots.length
      ? packet.screenshots.map((s) => `- [${s.journey} / ${s.step}${s.width ? ` @ ${s.width} px` : ""}] \`${s.path}\``)
      : ["- No screenshots recorded."]),
    "",
    "## Defects",
    ...(packet.defects.length
      ? packet.defects.map((d) => `- **${d.journey} — ${d.step}** (${d.width ?? "window"} px): expected ${d.expected}; actual ${d.actual}`)
      : ["- None recorded."]),
    "",
  ];
  const markdown = maskDeep(mdLines.join("\n"));

  mkdirSync(runDir, { recursive: true });
  const markdownPath = join(runDir, "pr-evidence.md");
  const jsonPath = join(runDir, "pr-evidence.json");
  writeFileSync(markdownPath, markdown);
  writeFileSync(jsonPath, JSON.stringify(packet, null, 2) + "\n");

  return { packet, markdown, markdownPath, jsonPath };
}
