// Journey notes: a plain-language user journey in the vault (type "journey").
// Frontmatter holds id, status, audience and code_anchors. The body holds the sections below.

import type { CodeAnchor, GuardConfig, Note } from "../types.ts";
import { loadVault } from "../vault/load.ts";

export interface Journey {
  id: string;
  title: string;
  status: Note["meta"]["status"];
  area: string;
  steps: string[];
  expected: string[];
  dataNeeds: string[];
  forbidden: string[];
  anchors: CodeAnchor[];
  file: string;
}

/** Text under a "## Heading", up to the next "## " or the end. */
function section(body: string, heading: string): string {
  const re = new RegExp(`^##[ \\t]+${heading}[ \\t]*$([\\s\\S]*?)(?=^##[ \\t]|(?![\\s\\S]))`, "mi");
  return re.exec(body)?.[1]?.trim() ?? "";
}

const bullets = (t: string): string[] =>
  t.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim()).filter(Boolean);

export function parseJourney(n: Note): Journey {
  return {
    id: n.meta.id,
    title: n.meta.title ?? n.meta.id,
    status: n.meta.status,
    area: section(n.body, "Area").split(/\s+/)[0]?.toLowerCase() ?? "",
    steps: bullets(section(n.body, "Steps")),
    expected: bullets(section(n.body, "Expected results")),
    dataNeeds: bullets(section(n.body, "Data needs")),
    forbidden: bullets(section(n.body, "Forbidden")),
    anchors: n.meta.code_anchors ?? [],
    file: n.file,
  };
}

/** Problems that make a journey unusable for planning or generating. */
export function journeyProblems(j: Journey): string[] {
  const p: string[] = [];
  if (!j.area) p.push("no Area");
  if (j.steps.length === 0) p.push("no Steps");
  if (j.expected.length === 0) p.push("no Expected results");
  if (j.anchors.length === 0) p.push("no code_anchors");
  if (j.forbidden.length === 0) p.push("no Forbidden reminder");
  return p;
}

/** Every journey note that is not stale or deprecated. */
export function loadJourneys(cfg: GuardConfig): Journey[] {
  return loadVault(cfg.vaultDir).notes
    .filter((n) => n.meta.type === "journey" && n.meta.status !== "stale" && n.meta.status !== "deprecated")
    .map(parseJourney);
}

/** Find a journey by id, accepting the id without its "journey-" prefix. */
export function findJourney(cfg: GuardConfig, id: string): Journey | undefined {
  const all = loadJourneys(cfg);
  return all.find((j) => j.id === id) ?? all.find((j) => j.id === `journey-${id}`);
}
