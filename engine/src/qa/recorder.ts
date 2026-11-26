// Record & Teach Journey Builder:
// Converts recorded manual UI events (click, type, press, resize) into a safe declarative
// JourneyDsl + proposed Markdown journey note with automatic assert_oracles & capture steps.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { GuardConfig } from "../types.ts";
import type { DslStep, JourneyDsl } from "./dsl.ts";
import { maskDeep } from "./safe-out.ts";

export interface RecordedEvent {
  action: "click" | "type" | "press" | "resize";
  target?: string;
  text?: string;
  key?: string;
  width?: number;
  height?: number;
  label?: string;
}

export interface DraftJourneyResult {
  id: string;
  dsl: JourneyDsl;
  markdown: string;
  proposedPath?: string;
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "recorded";

export function draftJourneyFromRecording(
  cfg: GuardConfig,
  input: {
    id: string;
    title: string;
    area: string;
    tier?: 0 | 1;
    widths?: number[];
    screenContext?: string;
    events: RecordedEvent[];
    writeProposal?: boolean;
    now?: Date;
  },
): DraftJourneyResult {
  const id = input.id.startsWith("journey-") ? input.id : `journey-${slug(input.id)}`;
  const steps: DslStep[] = [];

  for (const ev of input.events) {
    if (ev.action === "resize") {
      steps.push({ action: "resize", ...(ev.width ? { width: ev.width } : {}), ...(ev.height ? { height: ev.height } : {}), label: ev.label ?? `Resize to ${ev.width ?? 1100}px` });
    } else if (ev.action === "click") {
      steps.push({ action: "click", target: ev.target ?? "", ...(ev.label ? { label: ev.label } : {}) });
    } else if (ev.action === "type") {
      steps.push({ action: "type", target: ev.target ?? "", text: ev.text ?? "", ...(ev.label ? { label: ev.label } : {}) });
    } else if (ev.action === "press") {
      steps.push({ action: "press", key: ev.key ?? "", ...(ev.target ? { target: ev.target } : {}), ...(ev.label ? { label: ev.label } : {}) });
    }
    steps.push({ action: "assert_oracles" });
  }
  steps.push({ action: "capture", label: "final-state" });

  const dsl: JourneyDsl = maskDeep({
    id,
    title: input.title,
    tier: input.tier ?? 0,
    widths: input.widths?.length ? input.widths : [800, 1100, 1440],
    ...(input.screenContext ? { screenContext: input.screenContext } : {}),
    steps,
  });

  const now = input.now ?? new Date();
  const meta = maskDeep({
    id,
    type: "journey",
    status: "proposed",
    audience: ["qa_internal"],
    source: "evidence",
    created: now.toISOString().slice(0, 10),
    title: dsl.title,
  });

  const humanSteps = input.events.map((ev, idx) => `${idx + 1}. ${ev.action}${ev.target ? ` "${ev.target}"` : ""}${ev.width ? ` (${ev.width} px)` : ""}`);
  const body = [
    `# ${dsl.title}`,
    "",
    "## Area",
    input.area || "ui",
    "",
    "## Steps",
    ...(humanSteps.length ? humanSteps : ["1. Verify initial screen layout and runtime oracles."]),
    "",
    "## Expected results",
    "- Zero horizontal overflow or squeezed panes at 800, 1100, and 1440 px.",
    "- Zero console errors, missing form button types, or protocol/secret leaks.",
    "",
    "## Data needs",
    "- Test environment only (Cobalt database).",
    "",
    "## Forbidden",
    "- Never click save, create, submit, delete, or external send controls.",
    "",
    "## Executable steps",
    "```qa-steps",
    JSON.stringify(dsl, null, 2),
    "```",
  ].join("\n");

  const markdown = `---\n${stringify(meta, { lineWidth: 0 })}---\n\n${maskDeep(body)}\n`;
  let proposedPath: string | undefined;
  if (input.writeProposal) {
    const inboxDir = join(cfg.vaultDir, "inbox");
    mkdirSync(inboxDir, { recursive: true });
    proposedPath = join(inboxDir, `${id}.md`);
    writeFileSync(proposedPath, markdown);
  }

  return { id, dsl, markdown, ...(proposedPath ? { proposedPath } : {}) };
}
