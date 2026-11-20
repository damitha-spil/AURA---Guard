// The Markdown form of a QA result. It is the file written to data/qa/runs/ and the readable
// `answer` text old chat clients show. The first line is the head the chat router looks for.

import { QA_NEEDS_INPUT_HEAD, QA_RESULT_HEAD } from "../chat/intent.ts";
import type { QaResult } from "./agent.ts";

const bullet = (xs: string[], pre = "- "): string[] => xs.map((x) => `${pre}${x}`);

export function qaMarkdown(r: QaResult): string {
  const L: string[] = [];
  L.push(`# ${QA_RESULT_HEAD}: ${r.target.label}`, "");
  L.push(`Project: ${r.department.name} | Made: ${r.generatedAt} | Status: proposed. Guard suggests; people decide. Nothing was saved, created, sent or deleted.`, "");
  if (r.assumption) {
    L.push(`> **Assumption.** ${r.assumption}`);
    if (r.correction) L.push(`> ${r.correction}`);
    L.push("");
  }
  L.push(r.summary, "");
  L.push(`**How this plan was made:** ${r.modelNote}${r.modelUsed ? ` (${r.backend ?? "model"}, ${r.timings.designSeconds.toFixed(1)} s)` : ""}`, "");
  L.push(`## Risk: ${r.risk.level}`, "", ...bullet(r.risk.reasons), "");
  if (r.target.repos.length) {
    L.push("## What was compared", "");
    for (const t of r.target.repos) L.push(`- ${t.repo}: ${t.range}${t.firstCommit ? `, latest commit "${t.firstCommit}"` : ""}${t.commits > 1 ? ` (${t.commits} commits)` : ""}`);
    for (const s of r.target.skipped) L.push(`- Skipped: ${s}`);
    L.push("");
  }
  if (r.areas.length) {
    L.push("## Areas", "");
    for (const a of r.areas) L.push(`- **${a.name}** (${a.risk}): ${a.why}`);
    L.push("");
  }
  L.push(`## Test cases (${r.cases.length})`, "");
  for (const c of r.cases) {
    L.push(`### ${c.id} [${c.priority}, ${c.type}] ${c.title}`, "");
    L.push(`Because of: ${c.cites.map((x) => `\`${x}\``).join(", ")}${c.automatable ? " | automatable" : ""}${c.journeyId ? ` | journey \`${c.journeyId}\`` : ""}`);
    if (c.preconditions.length) L.push("", "Before:", ...bullet(c.preconditions));
    L.push("", "Steps:", ...c.steps.map((s, i) => `${i + 1}. ${s}`), "", "Expected:", ...bullet(c.expected));
    if (c.data) L.push("", `Data: ${c.data}`);
    L.push("");
  }
  if (r.regressionChecklist.length) L.push("## Regression checklist", "", ...bullet(r.regressionChecklist, "- [ ] "), "");
  L.push("## Evidence to keep", "", ...bullet(r.evidence.needed), "");
  if (r.checkCommands.length) {
    L.push("## Commands for a developer to run (Guard does not run them)", "");
    for (const c of r.checkCommands) L.push(`- \`${c.command}\` (from note ${c.source}${c.approved ? "" : ", proposed, not approved"})`);
    L.push("");
  } else {
    L.push("## Commands for a developer to run", "", "No check commands are recorded in this project's rules notes. Ask the owner to add them; Guard never runs a repository's builds or tests.", "");
  }
  if (r.journeys.available > 0 || r.journeys.offer.note) {
    L.push("## Automated journeys", "");
    L.push(r.journeys.offer.note || `${r.journeys.available} journey note(s) exist for this project; none is linked to this change.`);
    for (const b of r.journeys.offer.blocked) L.push(`- ${b.journeyId}: ${b.reason}`);
    L.push("");
  }
  if (r.run) {
    L.push(`## Journey run: ${r.run.status}`, "");
    for (const x of r.run.runs) L.push(`- ${x.journeyId}: ${x.status}${x.blocker ? ` (${x.blocker})` : ""}${x.reportPath ? `, report \`${x.reportPath}\`` : ""}`);
    for (const d of r.run.defects) L.push(`- Defect in ${d.journeyId}, "${d.step}"${d.width ? ` at ${d.width} px` : ""}: expected ${d.expected}; actual ${d.actual}`);
    if (r.run.proposedIncidents) L.push(`- ${r.run.proposedIncidents} incident note(s) proposed in this project's vault inbox, waiting for a person.`);
    L.push("");
  }
  if (r.notCovered.length) L.push("## Not covered", "", ...bullet(r.notCovered), "");
  if (r.questions.length) L.push("## Questions", "", ...bullet(r.questions), "");
  L.push(`Context read: ${r.context.files} files, ${r.context.areas} areas, ${r.context.commits} commits, ${r.context.dependents} dependents, ${r.context.coChange} co-change gaps, ${r.context.notes} notes, ${r.context.journeys} journeys.`);
  return L.join("\n") + "\n";
}

/** The chat text for a question the agent needs answered. */
export function needsInputMarkdown(question: string, options: { label: string }[]): string {
  return [QA_NEEDS_INPUT_HEAD, "", question, "", ...options.map((o) => `- ${o.label}`)].join("\n");
}
