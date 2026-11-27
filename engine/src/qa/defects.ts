// QA Pillar 4: Defect Fingerprinting, Structured Bug Sheets & Developer Ticket Exporter.
// Deduplicates rerun failures via deterministic SHA-256 fingerprints, exports JSON/Markdown/CSV
// Bug Sheets under .artifacts/qa/<runId>/, and drafts actionable developer tickets + PR warnings.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { GuardConfig } from "../types.ts";
import { getQaRun } from "./harness_api.ts";
import { maskDeep } from "./safe-out.ts";

export interface DefectInput {
  journey: string;
  step: string;
  actual: string;
  expected?: string;
  width?: number | null;
  screenshot?: string | null;
}

export interface FingerprintedBug {
  fingerprint: string;
  title: string;
  severity: "P0" | "P1" | "P2";
  journey: string;
  step: string;
  occurrences: number;
  widths: number[];
  expected: string;
  actual: string;
  screenshots: string[];
  ticketMarkdown: string;
}

export interface BugSheetReport {
  runId: string;
  generatedAt: string;
  totalRawDefects: number;
  uniqueBugs: number;
  bugs: FingerprintedBug[];
  prWarningMarkdown: string;
  markdown: string;
  csv: string;
  paths: { jsonPath: string; markdownPath: string; csvPath: string };
}

function normalizeForFingerprint(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\d{4,}\b/g, "<num>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hex>")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprintDefect(d: { journey: string; step: string; actual: string }): string {
  const canonical = [
    normalizeForFingerprint(d.journey),
    normalizeForFingerprint(d.step),
    normalizeForFingerprint(d.actual),
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

function csvCell(v: string): string {
  const s = v.replace(/"/g, '""');
  return `"${s}"`;
}

export function buildBugSheet(cfg: GuardConfig, runId: string): BugSheetReport | null {
  const detail = getQaRun(cfg, runId);
  if (!detail) return null;

  const rawDefects = detail.result.run?.defects ?? [];
  const grouped = new Map<string, FingerprintedBug>();

  for (const d of rawDefects) {
    const fp = fingerprintDefect({ journey: d.journeyId, step: d.step, actual: d.actual });
    const existing = grouped.get(fp);
    if (existing) {
      existing.occurrences++;
      if (typeof d.width === "number" && !existing.widths.includes(d.width)) existing.widths.push(d.width);
      if (d.screenshot && !existing.screenshots.includes(d.screenshot)) existing.screenshots.push(d.screenshot);
      continue;
    }
    const severity: FingerprintedBug["severity"] =
      /overflow|ipc|error|secret|crash|blocked/i.test(d.actual) ? "P0" : "P1";
    const widths = typeof d.width === "number" ? [d.width] : [];
    const screenshots = d.screenshot ? [d.screenshot] : [];
    const bug: FingerprintedBug = {
      fingerprint: fp,
      title: `[${severity}] ${d.journeyId}: ${d.step}`,
      severity,
      journey: d.journeyId,
      step: d.step,
      occurrences: 1,
      widths,
      expected: d.expected,
      actual: d.actual,
      screenshots,
      ticketMarkdown: "",
    };
    grouped.set(fp, bug);
  }

  const bugs = [...grouped.values()].map((b) => ({
    ...b,
    widths: [...b.widths].sort((a, x) => a - x),
    ticketMarkdown: [
      `### ${b.title} (\`${b.fingerprint}\`)`,
      `- **Severity:** ${b.severity} · **Occurrences:** ${b.occurrences}`,
      `- **Widths:** ${b.widths.length ? b.widths.map((w) => `${w} px`).join(", ") : "default window"}`,
      `- **Expected:** ${b.expected}`,
      `- **Actual:** ${b.actual}`,
      `- **Evidence:** ${b.screenshots.length ? b.screenshots.join(", ") : "none"}`,
      `- **Run:** \`${runId}\``,
    ].join("\n"),
  }));

  const mdLines = [
    `# Bug Sheet: \`${runId}\``,
    "",
    `- **Raw defects:** ${rawDefects.length} · **Unique fingerprinted bugs:** ${bugs.length}`,
    `- **Release Gate:** **${detail.scorecard.releaseGate.toUpperCase()}**`,
    "",
    ...(bugs.length ? bugs.map((b) => b.ticketMarkdown + "\n") : ["No defects recorded in this run."]),
  ];

  const csvHeader = "fingerprint,severity,journey,step,occurrences,widths,expected,actual,screenshots";
  const csvRows = bugs.map((b) =>
    [
      csvCell(b.fingerprint),
      csvCell(b.severity),
      csvCell(b.journey),
      csvCell(b.step),
      String(b.occurrences),
      csvCell(b.widths.join(";")),
      csvCell(b.expected),
      csvCell(b.actual),
      csvCell(b.screenshots.join(";")),
    ].join(","),
  );
  const csv = [csvHeader, ...csvRows].join("\n") + "\n";

  const prWarningMarkdown = bugs.length > 0
    ? `> **SPIL REO PR Warning (${bugs.length} unique bug${bugs.length === 1 ? "" : "s"}):**\n` +
      bugs.slice(0, 5).map((b) => `> - \`${b.fingerprint}\` **${b.title}** — ${b.actual}`).join("\n")
    : `> **SPIL REO:** 0 defects recorded in run \`${runId}\`.`;

  const qaRoot = resolve(join(cfg.root, ".artifacts", "qa"));
  const runDir = resolve(join(qaRoot, detail.result.id));
  if (!runDir.startsWith(qaRoot + sep)) {
    throw new Error("Refusing to write bug sheet outside .artifacts/qa.");
  }
  mkdirSync(runDir, { recursive: true });
  const jsonPath = join(runDir, "bug-sheet.json");
  const markdownPath = join(runDir, "bug-sheet.md");
  const csvPath = join(runDir, "bug-sheet.csv");

  const masked = maskDeep({
    runId: detail.result.id,
    generatedAt: new Date().toISOString(),
    totalRawDefects: rawDefects.length,
    uniqueBugs: bugs.length,
    bugs,
    prWarningMarkdown,
    markdown: mdLines.join("\n"),
    csv,
  });

  const report: BugSheetReport = {
    ...masked,
    paths: { jsonPath, markdownPath, csvPath },
  };

  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(markdownPath, report.markdown);
  writeFileSync(csvPath, report.csv);

  return report;
}
