// What proof a change needs, and whether the proof at hand is enough. Fixed rules only, no model.
// A status never says more than was seen: previews, mock data, sample screens and test counts are
// never proof that a user flow works.

export type ScopeKind = "app" | "service" | "docs-tool" | "unknown";
export type PacketStatus = "complete" | "incomplete" | "blocked";
export type ProofSource = "real-app" | "real-service" | "command-output" | "attested" | "preview" | "mock" | "sample" | "test-count" | "unknown";

export type RequirementId =
  | "environment" | "app-interaction" | "app-screenshots" | "app-video"
  | "service-readback" | "check-output" | "no-app-path-reason";

export interface Requirement { id: RequirementId; label: string; accepts: ProofSource[] }
export interface Proof { requirement: RequirementId; source: ProofSource; detail: string }

export interface EvidenceScope {
  /** The strictest kind found; a change can need both app and service proof. */
  kind: ScopeKind;
  kinds: ScopeKind[];
  requirements: Requirement[];
}

export interface EvidenceStatus extends EvidenceScope {
  status: PacketStatus;
  items: { id: RequirementId; label: string; state: "present" | "missing"; detail: string }[];
  /** Proof that was offered and not counted, with the reason. */
  rejected: string[];
  blockers: string[];
}

export const SCOPE_LABEL: Record<ScopeKind, string> = {
  app: "App or user flow", service: "Service only", "docs-tool": "Docs or developer tool", unknown: "Unknown",
};

const REQ: Record<RequirementId, Requirement> = {
  environment: { id: "environment", label: "Environment named (local or QA test)", accepts: ["attested"] },
  "app-interaction": { id: "app-interaction", label: "The changed user flow exercised in the real app", accepts: ["real-app"] },
  "app-screenshots": { id: "app-screenshots", label: "Real-app screenshots at 800, 1100 and 1440 px", accepts: ["real-app"] },
  "app-video": { id: "app-video", label: "Walkthrough video of the real app", accepts: ["real-app"] },
  "service-readback": { id: "service-readback", label: "Real request, result and readback", accepts: ["real-service"] },
  "check-output": { id: "check-output", label: "Output of the check that applies", accepts: ["command-output"] },
  "no-app-path-reason": { id: "no-app-path-reason", label: "Reason that no app path changed", accepts: ["attested"] },
};

const TEST_PATH = /(^|\/)(tests?|__tests__|__mocks__|fixtures|mocks)\/|\.(test|spec)\.[cm]?[tj]sx?$/i;
const DOC_PATH = /\.(md|mdx|rst|adoc)$|(^|\/)(LICENSE|NOTICE|CHANGELOG)$|^(docs|ai-log)\/.*\.(txt|png|jpe?g|gif|svg|webp|pdf)$/i;
const DEV_TOOL_PATH =
  /^(\.github|\.azure|\.vscode|\.claude|scripts|tools|tooling|evals)\/|(^|\/)(\.gitignore|\.gitattributes|\.editorconfig|\.eslintrc[^/]*|\.prettierrc[^/]*)$|(^|\/)(eslint|prettier|vitest|jest|playwright)\.config\.[^/]+$|(^|\/)azure-pipelines[^/]*\.ya?ml$/i;
const APP_PATH = /\.(tsx|jsx|vue|svelte|css|scss|less|html)$|(^|\/)(apps\/[^/]*ui[^/]*|web|ui|frontend|renderer|webview)\/(src|public)\/|(^|\/)src-tauri\/|^apps\/personal-agent\//i;

/** One file's kind. A file that cannot be placed counts as service code, so it still needs real proof. */
export function fileKind(path: string): Exclude<ScopeKind, "unknown"> {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (TEST_PATH.test(p) || DEV_TOOL_PATH.test(p) || DOC_PATH.test(p)) return "docs-tool";
  return APP_PATH.test(p) ? "app" : "service";
}

export function classifyChange(paths: string[]): EvidenceScope {
  if (paths.length === 0) return { kind: "unknown", kinds: ["unknown"], requirements: [] };
  const found = new Set(paths.map(fileKind));
  const kinds = (["app", "service", "docs-tool"] as const).filter((k) => found.has(k));
  const ids: RequirementId[] = [];
  if (found.has("app")) ids.push("environment", "app-interaction", "app-screenshots", "app-video");
  if (found.has("service")) ids.push("environment", "service-readback");
  if (!found.has("app") && !found.has("service")) ids.push("check-output", "no-app-path-reason");
  return { kind: kinds[0]!, kinds, requirements: [...new Set(ids)].map((id) => REQ[id]) };
}

/** An app change whose files are not known (a described feature) still needs app proof. */
export const appScope = (): EvidenceScope => {
  const ids: RequirementId[] = ["environment", "app-interaction", "app-screenshots", "app-video"];
  return { kind: "app", kinds: ["app"], requirements: ids.map((id) => REQ[id]) };
};

const NEVER: Partial<Record<ProofSource, string>> = {
  preview: "a preview is not the real app", mock: "mock data is not proof", sample: "a sample screen is not proof",
  "test-count": "a test count is not proof",
};

export function evaluateEvidence(scope: EvidenceScope, proofs: Proof[], blockers: string[] = []): EvidenceStatus {
  const all = [...blockers];
  if (scope.kind === "unknown") all.push("The changed files are not known, so the proof needed cannot be decided.");
  const rejected: string[] = [];
  const items = scope.requirements.map((r) => {
    let detail = "";
    for (const p of proofs.filter((x) => x.requirement === r.id)) {
      if (r.accepts.includes(p.source) && p.detail.trim()) detail ||= p.detail.trim();
      else rejected.push(`${r.label}: ${NEVER[p.source] ?? (p.detail.trim() ? `source "${p.source}" does not count` : "it was empty")}.`);
    }
    return { id: r.id, label: r.label, state: detail ? ("present" as const) : ("missing" as const), detail };
  });
  const status: PacketStatus = all.length ? "blocked" : items.some((i) => i.state === "missing") ? "incomplete" : "complete";
  return { ...scope, status, items, rejected: [...new Set(rejected)], blockers: all };
}

export function evidenceMarkdown(e: EvidenceStatus, heading = "##"): string[] {
  return [
    `${heading} Proof: ${e.status.toUpperCase()}`,
    "",
    `- **Change scope:** ${e.kinds.map((k) => SCOPE_LABEL[k]).join(" + ")}`,
    ...e.items.map((i) => `- [${i.state === "present" ? "x" : " "}] ${i.label}${i.detail ? ` (${i.detail})` : ""}`),
    ...e.blockers.map((b) => `- **Blocked:** ${b}`),
    ...e.rejected.map((r) => `- Not counted: ${r}`),
    "- Previews, mock data, sample screens and test counts never prove a user flow.",
    "",
  ];
}
