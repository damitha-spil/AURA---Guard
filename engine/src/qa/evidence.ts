// PR Evidence Packet builder (redacted, path-jailed inside .artifacts/qa/<runId>/).
// Collects 800/1100/1440 px screenshots, walkthrough video note, deterministic oracle summary,
// rubric/trajectory scores, and release gate verdict ready to paste into an Azure DevOps PR.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { GuardConfig } from "../types.ts";
import { getQaRun, safeQaScreenshotPath } from "./harness_api.ts";
import type { ReleaseGate } from "./harness_api.ts";
import { evaluateTrajectory, evaluateWithRubric } from "./judge.ts";
import type { JudgeEvaluation, TrajectoryEvaluation } from "./judge.ts";
import { maskDeep } from "./safe-out.ts";

export interface PrEvidencePacket {
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
    `- **Environment:** Test DB only · ERP writes blocked · Background delivery`,
    `- **Widths verified:** ${packet.widthsCovered.length ? packet.widthsCovered.map((w) => `${w} px`).join(", ") : "None recorded"}`,
    `- **Rubric score:** ${packet.evaluation.overallScore}/5 (${packet.evaluation.verdict.toUpperCase()})`,
    `- **Trajectory:** ${packet.trajectory.summary}`,
    `- **Video:** ${packet.videoNote}`,
    "",
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
