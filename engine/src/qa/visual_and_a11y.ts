// Wave 1 & 2 QA Suite: Accessibility Tree Snapshot (Playwright-MCP style), Vision Screen Grounder (OmniParser style),
// Visual Regression Diff (Argos/reg-suit style), WCAG 2.1/2.2 Axe Audit, and Core Web Vitals Lighthouse Budget Gate.
// All HTTP fetches enforce isLocalUrl(url, loadForbidden(cfg.root)) and mask all outputs via maskDeep.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PROJECT_NAME } from "../brand.ts";
import { upsertDefect } from "../defects/store.ts";
import type { GuardConfig } from "../types.ts";
import { maskDeep } from "./safe-out.ts";
import { isLocalUrl, loadForbidden } from "./safety.ts";

/** Bounded local fetch timeout for UI / A11y / CWV checks. */
export const VISUAL_FETCH_TIMEOUT_MS = 6_000;
/** Default visual regression pixel/byte diff threshold (%). */
export const DEFAULT_VISUAL_DIFF_THRESHOLD_PCT = 1.5;
/** Maximum historical Lighthouse CWV records stored locally. */
export const MAX_CWV_HISTORY = 50;
/** Maximum HTML bytes inspected per snapshot/audit (512 KB). */
export const MAX_INSPECT_HTML_BYTES = 512 * 1024;

export interface A11yNode {
  ref: string;
  role: string;
  tag: string;
  name: string;
  labeled: boolean;
  disabled: boolean;
  level?: number;
}

export interface A11ySnapshotReport {
  generatedAt: string;
  source: string;
  title: string;
  nodeCount: number;
  unlabeledCount: number;
  nodes: A11yNode[];
  markdownTree: string;
}

export interface GroundedElement {
  id: string;
  label: string;
  controlType: string;
  bboxNormalized: [number, number, number, number];
  interactable: boolean;
  confidence: number;
  actionHint: string;
}

export interface VisionGroundReport {
  generatedAt: string;
  engine: string;
  windowTitle: string;
  imageMeta: { path: string; bytes: number; width: number | null; height: number | null; sha256: string } | null;
  elementCount: number;
  elements: GroundedElement[];
}

export interface VisualDiffReport {
  generatedAt: string;
  engine: string;
  status: "match" | "diff" | "dimension_mismatch";
  diffRatioPct: number;
  thresholdPct: number;
  passed: boolean;
  baselineMeta: { path: string; bytes: number; width: number | null; height: number | null; sha256: string };
  currentMeta: { path: string; bytes: number; width: number | null; height: number | null; sha256: string };
  summary: string;
  reportPath: string;
}

export interface AxeViolation {
  id: string;
  wcag: string;
  impact: "critical" | "serious" | "moderate" | "minor";
  description: string;
  selector: string;
  snippet: string;
}

export interface AxeAuditReport {
  generatedAt: string;
  engine: string;
  target: string;
  passed: boolean;
  score: number;
  violations: AxeViolation[];
  defectsRecorded: number;
}

export interface LighthouseBudgetReport {
  generatedAt: string;
  engine: string;
  url: string;
  httpStatus: number;
  budgetsPassed: boolean;
  metrics: {
    ttfbMs: number;
    htmlKb: number;
    renderBlockingScripts: number;
    unsizedImages: number;
    hasViewport: boolean;
  };
  scores: {
    performance: number;
    accessibility: number;
    bestPractices: number;
  };
  violations: string[];
}

function assertLocalTarget(cfg: GuardConfig, url: string): string {
  const trimmed = url.trim();
  const forbidden = loadForbidden(cfg.root);
  if (!isLocalUrl(trimmed, forbidden)) {
    throw new Error(`Blocked non-local target URL: ${trimmed}. Only localhost/127.0.0.1 targets are permitted.`);
  }
  return trimmed;
}

async function resolveHtmlInput(
  cfg: GuardConfig,
  opts: { url?: string; html?: string; fetchFn?: typeof fetch },
): Promise<{ source: string; html: string; ttfbMs: number; httpStatus: number }> {
  if (typeof opts.html === "string" && opts.html.trim()) {
    return {
      source: opts.url?.trim() || "inline-html",
      html: opts.html.slice(0, MAX_INSPECT_HTML_BYTES),
      ttfbMs: 0,
      httpStatus: 200,
    };
  }
  const url = assertLocalTarget(cfg, opts.url || "");
  const doFetch = opts.fetchFn ?? fetch;
  const started = performance.now();
  const res = await doFetch(url, { signal: AbortSignal.timeout(VISUAL_FETCH_TIMEOUT_MS) });
  const raw = await res.text();
  const ttfbMs = Math.max(1, Math.round(performance.now() - started));
  return {
    source: url,
    html: raw.slice(0, MAX_INSPECT_HTML_BYTES),
    ttfbMs,
    httpStatus: res.status,
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " "));
}

function attrOf(attrs: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(attrs);
  return decodeEntities(m?.[1] ?? m?.[2] ?? m?.[3] ?? "");
}

function hasAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|$)`, "i").test(attrs);
}

function collectLabelForMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const forId = attrOf(m[1] ?? "", "for");
    const labelText = stripTags(m[2] ?? "");
    if (forId && labelText) map.set(forId, labelText);
  }
  return map;
}

function extractTitle(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripTags(m[1] ?? "") : "";
}

/** 1. Playwright MCP style semantic ARIA accessibility tree snapshot. */
export async function qaA11yTreeSnapshot(
  cfg: GuardConfig,
  opts: { url?: string; html?: string; fetchFn?: typeof fetch },
): Promise<A11ySnapshotReport> {
  const { source, html } = await resolveHtmlInput(cfg, opts);
  const labelMap = collectLabelForMap(html);
  const nodes: A11yNode[] = [];
  let refIdx = 1;

  const pushNode = (node: Omit<A11yNode, "ref">) => {
    nodes.push({ ref: `e${refIdx++}`, ...node });
  };

  // Headings
  const headingRe = /<(h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html)) !== null && nodes.length < 120) {
    const tag = (m[1] ?? "h1").toLowerCase();
    const attrs = m[2] ?? "";
    const text = attrOf(attrs, "aria-label") || stripTags(m[3] ?? "");
    pushNode({
      role: "heading",
      tag,
      name: text,
      labeled: text.length > 0,
      disabled: false,
      level: Number(tag.slice(1)),
    });
  }

  // Paired interactive tags
  const pairedRe = /<(button|a|select|textarea)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  while ((m = pairedRe.exec(html)) !== null && nodes.length < 150) {
    const tag = (m[1] ?? "").toLowerCase();
    const attrs = m[2] ?? "";
    const inner = stripTags(m[3] ?? "");
    const aria = attrOf(attrs, "aria-label") || attrOf(attrs, "title");
    const roleAttr = attrOf(attrs, "role");
    const role = roleAttr || (tag === "a" ? "link" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" : "button");
    const name = aria || inner;
    pushNode({
      role,
      tag,
      name,
      labeled: name.length > 0,
      disabled: hasAttr(attrs, "disabled") || attrOf(attrs, "aria-disabled") === "true",
    });
  }

  // Self-closing / void interactive controls
  const inputRe = /<(input)\b([^>]*)>/gi;
  while ((m = inputRe.exec(html)) !== null && nodes.length < 180) {
    const attrs = m[2] ?? "";
    const type = (attrOf(attrs, "type") || "text").toLowerCase();
    if (type === "hidden") continue;
    const id = attrOf(attrs, "id");
    const name =
      attrOf(attrs, "aria-label") ||
      (id ? labelMap.get(id) ?? "" : "") ||
      attrOf(attrs, "placeholder") ||
      attrOf(attrs, "value");
    const role = type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : type === "submit" || type === "button" ? "button" : "textbox";
    pushNode({
      role,
      tag: "input",
      name,
      labeled: name.length > 0,
      disabled: hasAttr(attrs, "disabled"),
    });
  }

  const unlabeledCount = nodes.filter((n) => !n.labeled).length;
  const markdownTree = nodes
    .map((n) => `- [${n.ref}] ${n.role}${n.level ? `(level=${n.level})` : ""} "${n.name || "<unlabeled>"}"${n.disabled ? " (disabled)" : ""}`)
    .join("\n");

  return maskDeep({
    generatedAt: new Date().toISOString(),
    source,
    title: extractTitle(html),
    nodeCount: nodes.length,
    unlabeledCount,
    nodes,
    markdownTree,
  });
}

function assertAllowedLocalFile(cfg: GuardConfig, rawPath: string): string {
  const text = rawPath.trim();
  if (!text) throw new Error("Local file path is required.");
  const resolved = resolve(text);
  const allowedRoots = [resolve(cfg.dataDir), resolve(cfg.root), resolve(tmpdir())];
  const inside = allowedRoots.some((r) => resolved === r || resolved.startsWith(r + sep));
  if (!inside) {
    throw new Error(`Refused file path outside workspace/dataDir: ${rawPath}`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`File does not exist: ${resolved}`);
  }
  return resolved;
}

function readImageMeta(filePath: string): { path: string; bytes: number; width: number | null; height: number | null; sha256: string } {
  const buf = readFileSync(filePath);
  const sha256 = createHash("sha256").update(buf).digest("hex").slice(0, 16);
  let width: number | null = null;
  let height: number | null = null;
  // Parse PNG IHDR width/height safely from bytes 16..24
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    width = buf.readUInt32BE(16);
    height = buf.readUInt32BE(20);
  }
  return { path: filePath, bytes: buf.length, width, height, sha256 };
}

/** 2. OmniParser-style UI bounding-box & interactable element grounder. */
export async function qaVisionGroundScreen(
  cfg: GuardConfig,
  opts: { imagePath?: string; html?: string; windowTitle?: string },
): Promise<VisionGroundReport> {
  const imageMeta = opts.imagePath ? readImageMeta(assertAllowedLocalFile(cfg, opts.imagePath)) : null;
  const elements: GroundedElement[] = [];

  if (opts.html && opts.html.trim()) {
    const snap = await qaA11yTreeSnapshot(cfg, { html: opts.html });
    const total = Math.max(1, snap.nodes.length);
    snap.nodes.forEach((n, idx) => {
      const y1 = Number(((idx / total) * 0.85 + 0.05).toFixed(3));
      const y2 = Number(Math.min(0.98, y1 + 0.06).toFixed(3));
      elements.push({
        id: `box-${idx + 1}`,
        label: n.name || `${n.role} (${n.tag})`,
        controlType: n.role,
        bboxNormalized: [0.05, y1, 0.45, y2],
        interactable: n.role === "button" || n.role === "link" || n.role === "textbox" || n.role === "checkbox" || n.role === "combobox",
        confidence: n.labeled ? 0.96 : 0.72,
        actionHint: n.role === "textbox" ? "type" : "click",
      });
    });
  } else if (imageMeta) {
    elements.push({
      id: "box-1",
      label: opts.windowTitle?.trim() || "Captured screen canvas",
      controlType: "canvas_region",
      bboxNormalized: [0.02, 0.02, 0.98, 0.98],
      interactable: true,
      confidence: 0.85,
      actionHint: "inspect",
    });
  }

  return maskDeep({
    generatedAt: new Date().toISOString(),
    engine: "omniparser-local-grounder",
    windowTitle: opts.windowTitle?.trim() || "SPIL AURA Screen",
    imageMeta,
    elementCount: elements.length,
    elements,
  });
}

/** 3. Argos / reg-suit style local visual regression diff comparator. */
export function qaVisualDiff(
  cfg: GuardConfig,
  opts: { baselinePath: string; currentPath: string; thresholdPct?: number },
): VisualDiffReport {
  const basePath = assertAllowedLocalFile(cfg, opts.baselinePath);
  const currPath = assertAllowedLocalFile(cfg, opts.currentPath);
  const thresholdPct = typeof opts.thresholdPct === "number" && opts.thresholdPct >= 0 ? opts.thresholdPct : DEFAULT_VISUAL_DIFF_THRESHOLD_PCT;

  const baseBuf = readFileSync(basePath);
  const currBuf = readFileSync(currPath);
  const baselineMeta = readImageMeta(basePath);
  const currentMeta = readImageMeta(currPath);

  const dimsDiffer =
    baselineMeta.width !== null &&
    currentMeta.width !== null &&
    (baselineMeta.width !== currentMeta.width || baselineMeta.height !== currentMeta.height);

  let diffRatioPct = 0;
  if (!baseBuf.equals(currBuf)) {
    const maxLen = Math.max(baseBuf.length, currBuf.length, 1);
    const minLen = Math.min(baseBuf.length, currBuf.length);
    let diffBytes = Math.abs(baseBuf.length - currBuf.length);
    for (let i = 0; i < minLen; i++) {
      if (baseBuf[i] !== currBuf[i]) diffBytes++;
    }
    diffRatioPct = Number(((diffBytes / maxLen) * 100).toFixed(2));
  }

  const status: VisualDiffReport["status"] = dimsDiffer
    ? "dimension_mismatch"
    : diffRatioPct > thresholdPct
      ? "diff"
      : "match";
  const passed = status === "match";
  const summary =
    status === "match"
      ? `Screenshots match (${diffRatioPct}% delta <= ${thresholdPct}% threshold).`
      : status === "dimension_mismatch"
        ? `Viewport or image dimensions changed (${baselineMeta.width}x${baselineMeta.height} -> ${currentMeta.width}x${currentMeta.height}).`
        : `Visual regression detected: ${diffRatioPct}% byte/pixel delta exceeds ${thresholdPct}% threshold.`;

  const outDir = join(cfg.dataDir, "visual-diffs");
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `diff-${Date.now().toString(36)}.json`);
  const report: VisualDiffReport = maskDeep({
    generatedAt: new Date().toISOString(),
    engine: "reg-local-diff",
    status,
    diffRatioPct,
    thresholdPct,
    passed,
    baselineMeta,
    currentMeta,
    summary,
    reportPath,
  });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  return report;
}

/** 4. @axe-core style WCAG 2.1/2.2 DOM Accessibility Gate with SHA-256 defect ingestion. */
export async function qaAxeAudit(
  cfg: GuardConfig,
  opts: { url?: string; html?: string; recordDefects?: boolean; fetchFn?: typeof fetch },
): Promise<AxeAuditReport> {
  const { source, html } = await resolveHtmlInput(cfg, opts);
  const violations: AxeViolation[] = [];

  const htmlTag = /<html\b([^>]*)>/i.exec(html);
  if (htmlTag && !attrOf(htmlTag[1] ?? "", "lang")) {
    violations.push({
      id: "html-has-lang",
      wcag: "WCAG 3.1.1",
      impact: "serious",
      description: "<html> element must have a valid lang attribute.",
      selector: "html",
      snippet: htmlTag[0].slice(0, 100),
    });
  }

  if (/<html\b/i.test(html) && !extractTitle(html)) {
    violations.push({
      id: "document-title",
      wcag: "WCAG 2.4.2",
      impact: "serious",
      description: "Document must contain a non-empty <title> element.",
      selector: "head > title",
      snippet: "<head>...</head>",
    });
  }

  const imgRe = /<img\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  let imgIdx = 0;
  while ((m = imgRe.exec(html)) !== null && violations.length < 40) {
    imgIdx++;
    const attrs = m[1] ?? "";
    if (!hasAttr(attrs, "alt")) {
      violations.push({
        id: "image-alt",
        wcag: "WCAG 1.1.1",
        impact: "critical",
        description: "Images must have alternate text (alt attribute).",
        selector: `img:nth-of-type(${imgIdx})`,
        snippet: m[0].slice(0, 120),
      });
    }
  }

  const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let btnIdx = 0;
  while ((m = btnRe.exec(html)) !== null && violations.length < 40) {
    btnIdx++;
    const attrs = m[1] ?? "";
    const text = stripTags(m[2] ?? "");
    const label = attrOf(attrs, "aria-label") || attrOf(attrs, "title") || text;
    if (!label) {
      violations.push({
        id: "button-name",
        wcag: "WCAG 4.1.2",
        impact: "critical",
        description: "Buttons must have discernible text or aria-label.",
        selector: `button:nth-of-type(${btnIdx})`,
        snippet: m[0].slice(0, 120),
      });
    }
  }

  const labelMap = collectLabelForMap(html);
  const inputRe = /<input\b([^>]*)>/gi;
  let inIdx = 0;
  while ((m = inputRe.exec(html)) !== null && violations.length < 40) {
    inIdx++;
    const attrs = m[1] ?? "";
    const type = (attrOf(attrs, "type") || "text").toLowerCase();
    if (type === "hidden" || type === "submit" || type === "button" || type === "reset") continue;
    const id = attrOf(attrs, "id");
    const label = attrOf(attrs, "aria-label") || (id ? labelMap.get(id) ?? "" : "") || attrOf(attrs, "placeholder");
    if (!label) {
      violations.push({
        id: "input-label",
        wcag: "WCAG 1.3.1",
        impact: "serious",
        description: "Form input lacks an accessible <label>, aria-label, or placeholder.",
        selector: id ? `#${id}` : `input:nth-of-type(${inIdx})`,
        snippet: m[0].slice(0, 120),
      });
    }
  }

  // Heading level skip detection
  const headingLevels = [...html.matchAll(/<h([1-6])\b/gi)].map((x) => Number(x[1]));
  for (let i = 1; i < headingLevels.length; i++) {
    if ((headingLevels[i] ?? 1) - (headingLevels[i - 1] ?? 1) > 1) {
      violations.push({
        id: "heading-order",
        wcag: "WCAG 1.3.1",
        impact: "moderate",
        description: `Heading level skipped from h${headingLevels[i - 1]} to h${headingLevels[i]}.`,
        selector: `h${headingLevels[i]}`,
        snippet: `<h${headingLevels[i]}>`,
      });
      break;
    }
  }

  let defectsRecorded = 0;
  if (opts.recordDefects !== false && violations.length > 0) {
    for (const v of violations.filter((x) => x.impact === "critical" || x.impact === "serious").slice(0, 10)) {
      upsertDefect(cfg.dataDir, {
        appName: PROJECT_NAME,
        branch: "current",
        commitSha: "",
        testedBy: "SPIL REO A11y Gate",
        assignedTo: "",
        agentSource: "qa",
        severity: v.impact === "critical" ? "high" : "medium",
        title: `WCAG ${v.id}: ${v.selector}`,
        expected: v.description,
        actual: `${v.wcag} violation on ${source}: ${v.snippet}`,
        reproSteps: [`Open ${source}`, `Inspect ${v.selector}`],
        codeSuggestion: `Fix ${v.id} (${v.wcag}) on ${v.selector}`,
        fileRef: source,
        evidencePaths: [],
      });
      defectsRecorded++;
    }
  }

  const penalty = violations.reduce((sum, v) => sum + (v.impact === "critical" ? 18 : v.impact === "serious" ? 12 : 6), 0);
  const score = Math.max(0, 100 - penalty);

  return maskDeep({
    generatedAt: new Date().toISOString(),
    engine: "axe-wcag-gate",
    target: source,
    passed: violations.length === 0,
    score,
    violations,
    defectsRecorded,
  });
}

/** 5. Lighthouse CI style localhost Core Web Vitals & asset budget gate. */
export async function qaLighthouseBudget(
  cfg: GuardConfig,
  opts: { url: string; maxTtfbMs?: number; maxHtmlKb?: number; fetchFn?: typeof fetch },
): Promise<LighthouseBudgetReport> {
  const { source, html, ttfbMs, httpStatus } = await resolveHtmlInput(cfg, opts);
  const maxTtfbMs = opts.maxTtfbMs ?? 800;
  const maxHtmlKb = opts.maxHtmlKb ?? 250;
  const htmlKb = Number((Buffer.byteLength(html, "utf8") / 1024).toFixed(2));

  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const headHtml = headMatch?.[1] ?? "";
  const scriptTags = [...headHtml.matchAll(/<script\b([^>]*)>/gi)];
  const renderBlockingScripts = scriptTags.filter((m) => {
    const attrs = m[1] ?? "";
    const type = attrOf(attrs, "type").toLowerCase();
    return hasAttr(attrs, "src") && !hasAttr(attrs, "defer") && !hasAttr(attrs, "async") && type !== "module";
  }).length;

  const imgTags = [...html.matchAll(/<img\b([^>]*)>/gi)];
  const unsizedImages = imgTags.filter((m) => {
    const attrs = m[1] ?? "";
    return !attrOf(attrs, "width") || !attrOf(attrs, "height");
  }).length;

  const hasViewport = /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(html);
  const axe = await qaAxeAudit(cfg, { html, recordDefects: false });

  const violations: string[] = [];
  if (httpStatus >= 400) violations.push(`HTTP status ${httpStatus} returned by target.`);
  if (ttfbMs > maxTtfbMs) violations.push(`TTFB ${ttfbMs}ms exceeds ${maxTtfbMs}ms budget.`);
  if (htmlKb > maxHtmlKb) violations.push(`HTML size ${htmlKb} KB exceeds ${maxHtmlKb} KB budget.`);
  if (renderBlockingScripts > 0) violations.push(`${renderBlockingScripts} render-blocking <script> in <head> (add defer or type="module").`);
  if (unsizedImages > 0) violations.push(`${unsizedImages} <img> tag(s) missing width/height (CLS layout shift risk).`);
  if (!hasViewport) violations.push("Missing <meta name=\"viewport\"> tag.");

  const perfPenalty =
    (ttfbMs > maxTtfbMs ? 20 : 0) +
    (htmlKb > maxHtmlKb ? 15 : 0) +
    renderBlockingScripts * 12 +
    unsizedImages * 5;
  const performance = Math.max(0, 100 - perfPenalty);
  const bestPractices = Math.max(0, 100 - (hasViewport ? 0 : 15) - (httpStatus >= 400 ? 35 : 0));

  const report: LighthouseBudgetReport = maskDeep({
    generatedAt: new Date().toISOString(),
    engine: "lighthouse-local-budget",
    url: source,
    httpStatus,
    budgetsPassed: violations.length === 0,
    metrics: { ttfbMs, htmlKb, renderBlockingScripts, unsizedImages, hasViewport },
    scores: { performance, accessibility: axe.score, bestPractices },
    violations,
  });

  const histFile = join(cfg.dataDir, "cwv-history.json");
  let prev: LighthouseBudgetReport[] = [];
  if (existsSync(histFile)) {
    try {
      const raw = JSON.parse(readFileSync(histFile, "utf8")) as unknown;
      if (Array.isArray(raw)) prev = raw as LighthouseBudgetReport[];
    } catch {
      /* ignore corrupt history */
    }
  }
  mkdirSync(cfg.dataDir, { recursive: true });
  writeFileSync(histFile, JSON.stringify([report, ...prev].slice(0, MAX_CWV_HISTORY), null, 2), "utf8");

  return report;
}
