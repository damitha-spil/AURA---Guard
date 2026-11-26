// Five zero-token deterministic oracles for SPIL Aura UI & protocol verification:
// 1. Responsive Layout (800 / 1100 / 1440 px overflow, squeezed panes, overlapping controls)
// 2. Console & Runtime (console.error, pageerror, React error boundary, failed local IPC/resources)
// 3. Form Semantics (<button> inside <form> missing explicit type attribute)
// 4. Protocol & Privacy Leaks (raw tool-call JSON, stray control tags, detected secrets)
// 5. Pure-JS PNG Visual Diff (IHDR dimension & byte/pixel-sample comparison)

import { detectSecrets } from "../mask/detectors.ts";

/** Minimum usable width for main/chat content panes at 800 px and above. */
export const MIN_MAIN_PANE_WIDTH_PX = 320;
/** Perceptual/byte diff ratio above which a visual change triggers a warning. */
export const VISUAL_DIFF_WARN_RATIO = 0.02;
/** Network request latency threshold above which a slow-response warning is emitted. */
export const MAX_NETWORK_LATENCY_MS = 3_000;
/** Minimum overlap pixels along both axes to count two interactive controls as colliding. */
const OVERLAP_TOLERANCE_PX = 2;

export type OracleName = "layout" | "console" | "form" | "protocol" | "visual";
export type OracleSeverity = "fail" | "warn";

export interface OracleFinding {
  oracle: OracleName;
  severity: OracleSeverity;
  code: string;
  message: string;
  detail?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
}

export interface LayoutMetrics {
  innerWidth: number;
  scrollWidth: number;
  panes?: { name: string; width: number; clipped?: boolean }[];
  interactiveRects?: Rect[];
}

export interface ConsoleEvent {
  level: "error" | "warn" | "pageerror" | "ipc_error" | "resource_error";
  text: string;
  source?: string;
}

export interface NetworkEvent {
  url: string;
  method: string;
  status: number;
  ms?: number;
  failed?: boolean;
  errorText?: string;
}

export interface FormButtonInfo {
  label: string;
  inForm: boolean;
  typeAttr: string | null;
}

export interface VisualDiffResult {
  comparable: boolean;
  identical: boolean;
  diffRatio: number;
  reason: string;
  baselineSize?: { width: number; height: number };
  currentSize?: { width: number; height: number };
}

export interface OracleReport {
  ok: boolean;
  passed: number;
  failed: number;
  warned: number;
  findings: OracleFinding[];
  byOracle: Record<OracleName, { status: "pass" | "warn" | "fail"; findingsCount: number }>;
  visualDiff?: VisualDiffResult;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapX > OVERLAP_TOLERANCE_PX && overlapY > OVERLAP_TOLERANCE_PX;
}

/** Oracle 1: Responsive layout overflow, squeezed main panes, and overlapping controls. */
export function checkResponsiveLayout(metrics: LayoutMetrics, width: number): OracleFinding[] {
  const out: OracleFinding[] = [];
  if (metrics.scrollWidth > metrics.innerWidth) {
    out.push({
      oracle: "layout",
      severity: "fail",
      code: "horizontal-overflow",
      message: `Horizontal overflow at ${width} px: scrollWidth (${metrics.scrollWidth}) > innerWidth (${metrics.innerWidth}).`,
    });
  }
  for (const pane of metrics.panes ?? []) {
    if (pane.clipped) {
      out.push({
        oracle: "layout",
        severity: "fail",
        code: "pane-clipped",
        message: `Pane "${pane.name}" is clipped off-screen at ${width} px.`,
      });
    }
    if (/main|chat|content/i.test(pane.name) && pane.width > 0 && pane.width < MIN_MAIN_PANE_WIDTH_PX) {
      out.push({
        oracle: "layout",
        severity: "fail",
        code: "pane-squeezed",
        message: `Pane "${pane.name}" squeezed to ${pane.width} px (< ${MIN_MAIN_PANE_WIDTH_PX} px) at ${width} px.`,
      });
    }
  }
  const rects = metrics.interactiveRects ?? [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (rectsOverlap(a, b)) {
        out.push({
          oracle: "layout",
          severity: "warn",
          code: "control-overlap",
          message: `Controls "${a.label ?? `#${i}`}" and "${b.label ?? `#${j}`}" overlap at ${width} px.`,
        });
      }
    }
  }
  return out;
}

const REACT_ERROR_BOUNDARY_RE = /something went wrong|error boundary|uncaught (type|reference|syntax)error/i;

/** Oracle 2: Browser console errors, page errors, React error boundaries, and failed local IPC/resources. */
export function checkConsoleAndRuntime(events: ConsoleEvent[], visibleText = ""): OracleFinding[] {
  const out: OracleFinding[] = [];
  for (const ev of events) {
    if (ev.level === "error" || ev.level === "pageerror" || ev.level === "ipc_error" || ev.level === "resource_error") {
      out.push({
        oracle: "console",
        severity: "fail",
        code: `runtime-${ev.level}`,
        message: `${ev.level}: ${ev.text.slice(0, 180)}`,
        ...(ev.source ? { detail: ev.source } : {}),
      });
    }
  }
  if (visibleText && REACT_ERROR_BOUNDARY_RE.test(visibleText)) {
    out.push({
      oracle: "console",
      severity: "fail",
      code: "react-error-boundary",
      message: "Visible UI contains an error boundary or uncaught runtime error message.",
    });
  }
  return out;
}

/** Checks captured XHR/Fetch/network events for 4xx/5xx responses, failed requests, and slow calls. */
export function checkNetworkTraffic(events: NetworkEvent[]): OracleFinding[] {
  const out: OracleFinding[] = [];
  for (const ev of events) {
    if (ev.failed || ev.status >= 500) {
      out.push({
        oracle: "console",
        severity: "fail",
        code: ev.failed ? "network-request-failed" : "network-5xx",
        message: `${ev.method} ${ev.url.slice(0, 120)} failed (${ev.failed ? (ev.errorText ?? "network error") : `HTTP ${ev.status}`}).`,
      });
    } else if (ev.status >= 400) {
      out.push({
        oracle: "console",
        severity: "warn",
        code: "network-4xx",
        message: `${ev.method} ${ev.url.slice(0, 120)} returned HTTP ${ev.status}.`,
      });
    } else if (ev.ms !== undefined && ev.ms > MAX_NETWORK_LATENCY_MS) {
      out.push({
        oracle: "console",
        severity: "warn",
        code: "network-slow",
        message: `${ev.method} ${ev.url.slice(0, 120)} took ${ev.ms} ms (> ${MAX_NETWORK_LATENCY_MS} ms).`,
      });
    }
  }
  return out;
}

/** Oracle 3: Every <button> inside a <form> must declare explicit type="button|submit|reset". */
export function checkFormSemantics(buttons: FormButtonInfo[]): OracleFinding[] {
  const out: OracleFinding[] = [];
  for (const b of buttons) {
    if (!b.inForm) continue;
    const t = b.typeAttr?.trim().toLowerCase() ?? "";
    if (t !== "button" && t !== "submit" && t !== "reset") {
      out.push({
        oracle: "form",
        severity: "fail",
        code: "form-button-missing-type",
        message: `Button "${b.label || "(unlabelled)"}" inside a <form> is missing an explicit type attribute (defaults to submit).`,
      });
    }
  }
  return out;
}

const RAW_TOOL_JSON_RE = /\{\s*"say"\s*:\s*"[\s\S]*?"tool_calls"\s*:/;
const STRAY_CONTROL_TAG_RE = /<\/?(?:reasoning_effort|thinking|tool_call|function_calls|antml:[a-z_]+)>/i;

/** Oracle 4: Raw tool-call JSON, stray LLM control tags, or secret-like values rendered in the UI. */
export function checkProtocolAndPrivacyLeaks(visibleText: string): OracleFinding[] {
  const out: OracleFinding[] = [];
  if (!visibleText) return out;
  if (RAW_TOOL_JSON_RE.test(visibleText)) {
    out.push({
      oracle: "protocol",
      severity: "fail",
      code: "raw-tool-json-leak",
      message: "Visible UI rendered raw model tool-call JSON instead of parsed output.",
    });
  }
  const tag = STRAY_CONTROL_TAG_RE.exec(visibleText);
  if (tag) {
    out.push({
      oracle: "protocol",
      severity: "fail",
      code: "stray-control-tag",
      message: `Visible UI contains stray model control tag ${tag[0]}.`,
    });
  }
  const secrets = detectSecrets(visibleText);
  if (secrets.length > 0) {
    const kinds = [...new Set(secrets.map((s) => s.kind))].join(", ");
    out.push({
      oracle: "protocol",
      severity: "fail",
      code: "secret-rendered",
      message: `Visible UI contains secret-like value(s) (${kinds}). Value redacted.`,
    });
  }
  return out;
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

/** Oracle 5: Pure-JS PNG buffer comparison (zero native image dependencies). */
export function comparePngBuffers(baseline: Buffer, current: Buffer): VisualDiffResult {
  if (baseline.equals(current)) {
    const size = readPngDimensions(baseline);
    return {
      comparable: true,
      identical: true,
      diffRatio: 0,
      reason: "Buffers are byte-identical.",
      ...(size ? { baselineSize: size, currentSize: size } : {}),
    };
  }
  const baseSize = readPngDimensions(baseline);
  const curSize = readPngDimensions(current);
  if (!baseSize || !curSize) {
    return {
      comparable: false,
      identical: false,
      diffRatio: 1,
      reason: "One or both images are not valid PNG buffers with an IHDR header.",
    };
  }
  if (baseSize.width !== curSize.width || baseSize.height !== curSize.height) {
    return {
      comparable: true,
      identical: false,
      diffRatio: 1,
      reason: `Image dimensions changed (${baseSize.width}x${baseSize.height} -> ${curSize.width}x${curSize.height}).`,
      baselineSize: baseSize,
      currentSize: curSize,
    };
  }
  const maxLen = Math.max(baseline.length, current.length);
  const minLen = Math.min(baseline.length, current.length);
  // Sample bytes after header (offset 33+) for fast, low-memory perceptual change estimate.
  const start = Math.min(33, minLen);
  let changed = Math.abs(baseline.length - current.length);
  const total = Math.max(1, maxLen - start);
  for (let i = start; i < minLen; i++) {
    if (baseline[i] !== current[i]) changed++;
  }
  const diffRatio = Number((changed / total).toFixed(4));
  return {
    comparable: true,
    identical: changed === 0,
    diffRatio,
    reason: diffRatio > VISUAL_DIFF_WARN_RATIO
      ? `Visual delta ${Math.round(diffRatio * 100)}% exceeds ${Math.round(VISUAL_DIFF_WARN_RATIO * 100)}% threshold.`
      : `Visual delta ${Math.round(diffRatio * 100)}% is within threshold.`,
    baselineSize: baseSize,
    currentSize: curSize,
  };
}

export interface RunAllOraclesInput {
  width: number;
  layout?: LayoutMetrics;
  consoleEvents?: ConsoleEvent[];
  networkEvents?: NetworkEvent[];
  formButtons?: FormButtonInfo[];
  visibleText?: string;
  baselinePng?: Buffer;
  currentPng?: Buffer;
}

/** Runs all 5 deterministic oracles and summarizes pass/warn/fail counts. */
export function runAllOracles(input: RunAllOraclesInput): OracleReport {
  const findings: OracleFinding[] = [];
  if (input.layout) findings.push(...checkResponsiveLayout(input.layout, input.width));
  if (input.consoleEvents || input.visibleText) {
    findings.push(...checkConsoleAndRuntime(input.consoleEvents ?? [], input.visibleText ?? ""));
  }
  if (input.networkEvents?.length) {
    findings.push(...checkNetworkTraffic(input.networkEvents));
  }
  if (input.formButtons) findings.push(...checkFormSemantics(input.formButtons));
  if (input.visibleText) findings.push(...checkProtocolAndPrivacyLeaks(input.visibleText));

  let visualDiff: VisualDiffResult | undefined;
  if (input.baselinePng && input.currentPng) {
    visualDiff = comparePngBuffers(input.baselinePng, input.currentPng);
    if (!visualDiff.comparable || (!visualDiff.identical && visualDiff.diffRatio > VISUAL_DIFF_WARN_RATIO)) {
      findings.push({
        oracle: "visual",
        severity: "warn",
        code: visualDiff.comparable ? "visual-regression-delta" : "visual-uncomparable",
        message: visualDiff.reason,
      });
    }
  }

  const byOracle: OracleReport["byOracle"] = {
    layout: { status: "pass", findingsCount: 0 },
    console: { status: "pass", findingsCount: 0 },
    form: { status: "pass", findingsCount: 0 },
    protocol: { status: "pass", findingsCount: 0 },
    visual: { status: "pass", findingsCount: 0 },
  };
  for (const f of findings) {
    const slot = byOracle[f.oracle];
    slot.findingsCount++;
    if (f.severity === "fail") slot.status = "fail";
    else if (slot.status !== "fail") slot.status = "warn";
  }

  const failed = findings.filter((f) => f.severity === "fail").length;
  const warned = findings.filter((f) => f.severity === "warn").length;
  const passed = Object.values(byOracle).filter((s) => s.status === "pass").length;

  return {
    ok: failed === 0,
    passed,
    failed,
    warned,
    findings,
    byOracle,
    ...(visualDiff ? { visualDiff } : {}),
  };
}
