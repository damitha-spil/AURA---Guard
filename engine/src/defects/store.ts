// SPIL REO — Persistent Defect Store & Branded PDF/HTML Report Exporter.
// Stores deduplicated defects with app, branch, tester, code review suggestions, and evidence snaps.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type DefectSeverity = "critical" | "high" | "medium" | "low";
export type DefectStatus = "open" | "triaged" | "notified" | "fixed" | "false_positive" | "resolved";

/** One line of a defect's history. History is only ever added to, never removed. */
export interface DefectHistoryEntry {
  at: string;
  event: "created" | "recurred" | "acknowledged" | "unacknowledged" | "resolved" | "reopened" | "status";
  note?: string;
}

export interface DefectRecord {
  id: string;
  fingerprint: string;
  appName: string;
  branch: string;
  commitSha: string;
  testedDate: string;
  testedBy: string;
  assignedTo: string;
  agentSource: "qa" | "review" | "security" | "api" | "qe";
  severity: DefectSeverity;
  status: DefectStatus;
  title: string;
  expected: string;
  actual: string;
  reproSteps: string[];
  codeSuggestion: string;
  fileRef?: string;
  evidencePaths: string[];
  sentTeamsAt?: string;
  /** Times this fingerprint has been seen. 1 on creation; each return adds 1. */
  recurrenceCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  /** Someone knows about it. Kept apart from status: acknowledging does not change status. */
  acknowledged?: boolean;
  acknowledgedAt?: string;
  resolvedAt?: string;
  /** True when made from a fixture or sample flag. Never counted in production digests or counts. */
  sample?: boolean;
  history?: DefectHistoryEntry[];
}

export const SEVERITY_ORDER: DefectSeverity[] = ["low", "medium", "high", "critical"];

/** One step up, capped at critical. */
export function raiseSeverity(s: DefectSeverity): DefectSeverity {
  const i = SEVERITY_ORDER.indexOf(s);
  return SEVERITY_ORDER[Math.min(SEVERITY_ORDER.length - 1, Math.max(0, i) + 1)] as DefectSeverity;
}

function storeFile(dataDir: string): string {
  const dir = join(dataDir, "defects");
  mkdirSync(dir, { recursive: true });
  return join(dir, "defects.json");
}

export function computeDefectFingerprint(input: { appName: string; branch: string; title: string; fileRef?: string; sample?: boolean }): string {
  // Sample records get their own fingerprint space so they can never merge into a real defect.
  const raw = `${input.sample ? "sample|" : ""}${input.appName.toLowerCase()}|${input.branch.toLowerCase()}|${(input.fileRef || "").toLowerCase()}|${input.title.toLowerCase().trim()}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

export function listDefects(dataDir: string): DefectRecord[] {
  const file = storeFile(dataDir);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Real defects only: sample and fixture records are left out. Use this for counts and digests. */
export function listProductionDefects(dataDir: string): DefectRecord[] {
  return listDefects(dataDir).filter((d) => !d.sample);
}

export function saveDefects(dataDir: string, records: DefectRecord[]): void {
  const file = storeFile(dataDir);
  writeFileSync(file, JSON.stringify(records, null, 2), "utf8");
}

type UpsertInput = Omit<DefectRecord, "id" | "fingerprint" | "testedDate" | "status"> & {
  testedDate?: string;
  status?: DefectStatus;
  /** Either flag marks the record as sample data. */
  sample?: boolean;
  fixture?: boolean;
};

function addHistory(d: DefectRecord, event: DefectHistoryEntry["event"], note?: string, at = new Date().toISOString()): void {
  (d.history ??= []).push({ at, event, ...(note ? { note } : {}) });
}

export function upsertDefect(dataDir: string, input: UpsertInput): DefectRecord {
  const all = listDefects(dataDir);
  const isSample = input.sample === true || input.fixture === true;
  const fp = computeDefectFingerprint({ appName: input.appName, branch: input.branch, title: input.title, fileRef: input.fileRef, sample: isSample });
  const now = new Date().toISOString();
  const existing = all.find((d) => d.fingerprint === fp);
  if (existing) {
    // Same defect again: keep one record, count the return, raise severity one step.
    // Acknowledged and history are kept. The incoming severity and status do not lower anything.
    const { sample: _s, fixture: _f, severity: _sev, status: _st, ...rest } = input;
    Object.assign(existing, rest, { fingerprint: fp });
    existing.recurrenceCount = (existing.recurrenceCount ?? 1) + 1;
    existing.firstSeen ??= existing.testedDate;
    existing.lastSeen = now;
    existing.severity = raiseSeverity(existing.severity);
    if (existing.status === "resolved" || existing.status === "fixed") {
      existing.status = "open";
      delete existing.resolvedAt;
      addHistory(existing, "reopened", "Returned after it was marked fixed or resolved.", now);
    }
    addHistory(existing, "recurred", `Seen ${existing.recurrenceCount} times; severity is now ${existing.severity}.`, now);
    saveDefects(dataDir, all);
    return existing;
  }
  const rec: DefectRecord = {
    id: `DEF-${fp.slice(0, 6).toUpperCase()}`,
    fingerprint: fp,
    appName: input.appName || "SPIL AURA",
    branch: input.branch || "development",
    commitSha: input.commitSha || "",
    testedDate: input.testedDate || now.slice(0, 10),
    testedBy: input.testedBy || "QA Engineer",
    assignedTo: input.assignedTo || "",
    agentSource: input.agentSource || "qa",
    severity: input.severity || "medium",
    status: input.status || "open",
    title: input.title,
    expected: input.expected || "",
    actual: input.actual || "",
    reproSteps: Array.isArray(input.reproSteps) ? input.reproSteps : [],
    codeSuggestion: input.codeSuggestion || "",
    fileRef: input.fileRef || "",
    evidencePaths: Array.isArray(input.evidencePaths) ? input.evidencePaths : [],
    recurrenceCount: 1,
    firstSeen: now,
    lastSeen: now,
    acknowledged: false,
    ...(isSample ? { sample: true } : {}),
    history: [{ at: now, event: "created" }],
  };
  all.unshift(rec);
  saveDefects(dataDir, all);
  return rec;
}

export function updateDefectStatus(
  dataDir: string,
  id: string,
  patch: Partial<Pick<DefectRecord, "status" | "assignedTo" | "sentTeamsAt">> & { acknowledged?: boolean; resolved?: boolean },
): DefectRecord | null {
  const all = listDefects(dataDir);
  const found = all.find((d) => d.id === id);
  if (!found) return null;
  const now = new Date().toISOString();
  if (patch.status && patch.status !== found.status) {
    found.status = patch.status;
    addHistory(found, "status", patch.status, now);
  }
  if (patch.assignedTo !== undefined) found.assignedTo = patch.assignedTo;
  if (patch.sentTeamsAt !== undefined) found.sentTeamsAt = patch.sentTeamsAt;
  // Acknowledged is its own flag. It never changes status.
  if (patch.acknowledged !== undefined && patch.acknowledged !== !!found.acknowledged) {
    found.acknowledged = patch.acknowledged;
    if (patch.acknowledged) found.acknowledgedAt = now;
    else delete found.acknowledgedAt;
    addHistory(found, patch.acknowledged ? "acknowledged" : "unacknowledged", undefined, now);
  }
  if (patch.resolved === true && found.status !== "resolved") {
    found.status = "resolved";
    found.resolvedAt = now;
    addHistory(found, "resolved", undefined, now);
  }
  saveDefects(dataDir, all);
  return found;
}

/**
 * Plain text digest for one day: new, recurring and acknowledged defects.
 * Sample records are left out. `date` is YYYY-MM-DD (UTC, like the stored timestamps).
 */
export function buildDailyDigest(records: DefectRecord[], date: string): string {
  const real = records.filter((d) => !d.sample);
  const day = (iso?: string): string => (iso || "").slice(0, 10);
  const fresh = real.filter((d) => day(d.firstSeen || d.testedDate) === date);
  const recurring = real.filter((d) => (d.recurrenceCount ?? 1) > 1 && day(d.lastSeen) === date);
  const acked = real.filter((d) => d.acknowledged && d.status !== "resolved" && d.status !== "false_positive");
  const line = (d: DefectRecord): string =>
    `- ${d.id} [${d.severity}] ${d.title} (${d.appName}, ${d.branch})` +
    ((d.recurrenceCount ?? 1) > 1 ? ` - seen ${d.recurrenceCount} times` : "");
  const section = (title: string, list: DefectRecord[]): string[] => [
    `${title} (${list.length})`,
    ...(list.length ? list.map(line) : ["- none"]),
    "",
  ];
  return [
    `Defect digest for ${date}`,
    "",
    ...section("New", fresh),
    ...section("Recurring", recurring),
    ...section("Acknowledged and still open", acked),
    "Sample data is not counted.",
  ].join("\n");
}

function esc(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

/** Generates a print-ready, branded SPIL REO HTML report (printable directly to PDF). */
export function generateDefectReportHtml(defects: DefectRecord[], meta: { appName?: string; branch?: string; generatedBy?: string }): string {
  const date = new Date().toISOString().slice(0, 10);
  const counts = {
    critical: defects.filter((d) => d.severity === "critical").length,
    high: defects.filter((d) => d.severity === "high").length,
    medium: defects.filter((d) => d.severity === "medium").length,
    low: defects.filter((d) => d.severity === "low").length,
  };
  const cards = defects.map((d) => `
    <section class="card">
      <div class="card-head">
        <div>
          <span class="sev sev-${esc(d.severity)}">${esc(d.severity.toUpperCase())}</span>
          <strong>${esc(d.id)} — ${esc(d.title)}</strong>
        </div>
        <span class="meta">${esc(d.appName)} · ${esc(d.branch)} · ${esc(d.testedDate)}</span>
      </div>
      <div class="grid">
        <div><strong>Tested By:</strong> ${esc(d.testedBy)}</div>
        <div><strong>Assigned To:</strong> ${esc(d.assignedTo || "Unassigned")}</div>
        <div><strong>Agent:</strong> ${esc(d.agentSource.toUpperCase())}</div>
        <div><strong>Status:</strong> ${esc(d.status)}</div>
      </div>
      <p><strong>Expected:</strong> ${esc(d.expected)}</p>
      <p><strong>Actual:</strong> ${esc(d.actual)}</p>
      ${d.reproSteps.length ? `<p><strong>Steps:</strong></p><ol>${d.reproSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
      ${d.codeSuggestion ? `<p><strong>Code Review Suggestion${d.fileRef ? ` (${esc(d.fileRef)})` : ""}:</strong></p><pre>${esc(d.codeSuggestion)}</pre>` : ""}
      ${d.evidencePaths.length ? `<p><strong>Evidence Artifacts:</strong> ${d.evidencePaths.map((p) => `<code>${esc(p)}</code>`).join(", ")}</p>` : ""}
    </section>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SPIL REO Defect Report — ${esc(date)}</title>
<style>
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #0f172a; margin: 32px; line-height: 1.5; }
  header { border-bottom: 2px solid #059669; padding-bottom: 14px; margin-bottom: 22px; display: flex; justify-content: space-between; align-items: flex-end; }
  h1 { margin: 0; font-size: 24px; }
  .motto { font-size: 11px; letter-spacing: .1em; color: #059669; font-weight: 700; }
  .summary { display: flex; gap: 16px; margin-bottom: 22px; }
  .kpi { flex: 1; padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; }
  .kpi b { font-size: 22px; display: block; }
  .card { border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin-bottom: 16px; page-break-inside: avoid; }
  .card-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .meta { font-size: 12px; color: #64748b; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; font-size: 12.5px; background: #f8fafc; padding: 8px 10px; border-radius: 6px; margin-bottom: 10px; }
  .sev { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 700; margin-right: 8px; }
  .sev-critical, .sev-high { background: #fee2e2; color: #b91c1c; }
  .sev-medium { background: #fef3c7; color: #b45309; }
  .sev-low { background: #e0f2fe; color: #0369a1; }
  pre { background: #0f172a; color: #f8fafc; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
  footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11.5px; color: #64748b; display: flex; justify-content: space-between; }
</style>
</head>
<body>
  <header>
    <div>
      <div class="motto">SPIL REO · A Multi-Agent Quality Engineering &amp; Software Assurance Platform.</div>
      <h1>Quality &amp; Defect Assurance Report</h1>
    </div>
    <div class="meta">App: ${esc(meta.appName || "All")} · Branch: ${esc(meta.branch || "All")} · Date: ${esc(date)}</div>
  </header>
  <div class="summary">
    <div class="kpi"><b>${defects.length}</b>Total Defects</div>
    <div class="kpi"><b>${counts.critical}</b>Critical</div>
    <div class="kpi"><b>${counts.high}</b>High</div>
    <div class="kpi"><b>${counts.medium}</b>Medium</div>
    <div class="kpi"><b>${counts.low}</b>Low</div>
  </div>
  ${cards || "<p>No defects recorded for this filter.</p>"}
  <footer>
    <span>POWERED BY SPIL LABS — Autonomous Engineering Intelligence</span>
    <span>Generated by ${esc(meta.generatedBy || "SPIL REO")} on ${esc(date)}</span>
  </footer>
</body>
</html>`;
}

export function saveDefectReportHtml(rootDir: string, html: string, slug = "report"): string {
  const reportsDir = resolve(join(rootDir, ".artifacts", "reports"));
  mkdirSync(reportsDir, { recursive: true });
  const safeSlug = slug.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "report";
  const out = resolve(join(reportsDir, `SPIL-REO-${safeSlug}-${Date.now()}.html`));
  if (!out.startsWith(reportsDir + sep)) throw new Error("Refusing to write report outside .artifacts/reports.");
  writeFileSync(out, html, "utf8");
  return out;
}
