// Spec generator: the model writes a read-only Playwright spec for one journey.
//
// HARD RULES: the spec goes to Guard's qa/generated/ (status proposed), never into the Aura repo.
// Aura's files are only read (copy.ts, for the visible words used as selectors). Every spec passes
// qa/safety.ts before it can run. A spec that still fails after one retry is written with a REJECTED
// header and is never run.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { CompleteFn } from "../brain/client.ts";
import type { GuardConfig } from "../types.ts";
import { findJourney } from "./journeys.ts";
import type { Journey } from "./journeys.ts";
import { checkSpec, describeFindings, loadForbidden } from "./safety.ts";
import type { ForbiddenList, SafetyFinding } from "./safety.ts";

export const REJECTED_MARK = "// REJECTED by SPIL Quality Support Bot safety check";
export const PROPOSED_MARK = "// status: proposed";

/** Safety limit: at most this much of Aura's copy.ts goes into the prompt. */
const MAX_WORDS_CHARS = 14_000;
const FALLBACK_MAX_TOKENS = 3000;
/** One retry with the reasons, then the spec is written as REJECTED. */
export const MAX_SPEC_RETRIES = 1;

interface RoleCfg { limits?: { max_tokens?: number }; spec_rules?: string[]; safety?: string[] }

function loadRole(cfg: GuardConfig): RoleCfg {
  return parse(readFileSync(join(cfg.root, "roles", "qa-planner.yaml"), "utf8")) as RoleCfg;
}

/** Blocks of `export const name = {...}` from copy.ts, for the names given. */
export function copyBlocks(copyTs: string, names: string[]): string {
  const parts = copyTs.split(/^(?=export const \w+ = )/m);
  const want = new Set(names);
  const picked = parts.filter((p) => want.has(/^export const (\w+) =/.exec(p)?.[1] ?? ""));
  return picked.join("\n").slice(0, MAX_WORDS_CHARS);
}

/** Which copy.ts blocks hold the words for a journey's area. App-level facts, not company facts. */
const AREA_BLOCKS: Record<string, string[]> = {
  home: ["app", "nav", "home", "today"],
  shell: ["app", "nav"],
  orders: ["app", "nav", "orders", "order", "status"],
  helpers: ["app", "nav", "home"],
  settings: ["app", "nav", "settings"],
};

/** Read-only: Aura's visible words for this journey. Empty text when the repo is not readable. */
export function auraWords(cfg: GuardConfig, j: Journey): string {
  const repo = cfg.repos.find((r) => j.anchors.some((a) => a.repo === r.id));
  if (!repo) return "";
  const anchor = j.anchors.find((a) => a.path.endsWith("copy.ts"))?.path ?? "apps/aura-ui/src/copy.ts";
  try {
    const text = readFileSync(join(repo.path, anchor), "utf8");
    const blocks = copyBlocks(text, AREA_BLOCKS[j.area] ?? ["app", "nav"]);
    return blocks || text.slice(0, MAX_WORDS_CHARS);
  } catch {
    return "";
  }
}

/** What a spec may call. Shown to the model so it writes against the real helper. */
export const HELPER_API = `
import { journey } from "../helpers/aura.ts";

journey("<journey id>", async ({ page, step, visible, hasText, ok }) => {
  // page: guarded Playwright page. Use page.getByRole("link", { name: "Orders" }), page.getByText("Needs you").
  await step("Open Orders", async () => {
    await page.getByRole("link", { name: "Orders" }).click();
    await visible(page.getByText("Orders").first(), "the Orders title");
  }, "The Orders screen opens");
});
// step(title, fn, expected?)  visible(locator, what)  hasText(locator, stringOrRegex, what)  ok(condition, message)
`.trim();

export function buildSpecPrompt(
  cfg: GuardConfig, j: Journey, words: string, retryReasons?: string[],
): { system: string[]; user: string; maxTokens: number } {
  const role = loadRole(cfg);
  const rules = (role.spec_rules ?? []).map((r) => `- ${r}`).join("\n");
  const safety = (role.safety ?? []).map((r) => `- ${r}`).join("\n");
  const stable =
    `You are the QA Planner for SPIL Quality Support Bot. You write one read-only Playwright spec for a user journey of a desktop app.\n\n` +
    `Safety rules (a static check rejects any breach; the spec is then never run):\n${safety}\n\nSpec rules:\n${rules}\n\n` +
    `The helper you may use:\n${HELPER_API}\n\nReply with the TypeScript file only, in one code block.`;
  const forbidden = loadForbidden(cfg.root).names.join(", ");
  const lines = [
    `Journey id: ${j.id}`, `Title: ${j.title}`, `Area: ${j.area}`, "", "Steps:",
    ...j.steps.map((s, i) => `${i + 1}. ${s}`), "", "Expected results:", ...j.expected.map((s) => `- ${s}`), "",
    "Never click, fill or press anything whose name or text contains: " + forbidden, "",
    "Aura's visible words (use these exact words as selector names):", words || "(not available; use the words from the steps)",
  ];
  if (retryReasons?.length) {
    lines.push("", "Your last attempt was rejected by the safety check. Fix every point and write the whole file again:", ...retryReasons.map((r) => `- ${r}`));
  }
  return { system: [stable], user: lines.join("\n"), maxTokens: role.limits?.max_tokens ?? FALLBACK_MAX_TOKENS };
}

/** The TypeScript out of a model reply: the first code block, else the whole text. */
export function extractCode(text: string): string {
  const m = /```(?:ts|typescript)?\s*\n([\s\S]*?)```/i.exec(text);
  return (m ? (m[1] as string) : text).trim() + "\n";
}

export interface GenerateResult {
  file: string;
  journey: string;
  rejected: boolean;
  findings: SafetyFinding[];
  attempts: number;
}

export interface GenerateDeps {
  complete: CompleteFn;
  forbidden?: ForbiddenList;
  now?: () => Date;
}

export async function generateSpec(cfg: GuardConfig, journeyId: string, deps: GenerateDeps): Promise<GenerateResult> {
  const j = findJourney(cfg, journeyId);
  if (!j) throw new Error(`No journey "${journeyId}". Run \`qa status\` to list them.`);
  const list = deps.forbidden ?? loadForbidden(cfg.root);
  const words = auraWords(cfg, j);
  let reasons: string[] | undefined;
  let code = "";
  let findings: SafetyFinding[] = [];
  let attempts = 0;
  for (let n = 0; n <= MAX_SPEC_RETRIES; n++) {
    attempts++;
    const p = buildSpecPrompt(cfg, j, words, reasons);
    const res = await deps.complete({ role: "qa-planner", system: p.system, user: p.user, maxTokens: p.maxTokens });
    code = extractCode(res.text);
    findings = checkSpec(code, list).findings;
    if (findings.length === 0) break;
    reasons = describeFindings(findings);
  }
  const rejected = findings.length > 0;
  const when = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const header = rejected
    ? [
        `${REJECTED_MARK}. This spec is NEVER run. Why:`,
        ...describeFindings(findings).map((f) => `//  - ${f}`),
        `// Journey: ${j.id}. Written ${when}.`,
      ]
    : [`${PROPOSED_MARK}. Generated by SPIL Quality Support Bot for journey ${j.id} on ${when}.`, "// Read-only: it opens screens and reads. The owner reviews it before use. Guard never writes into the Aura repo."];
  const dir = join(cfg.root, "qa", "generated");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${j.id}.spec.ts`);
  writeFileSync(file, header.join("\n") + "\n\n" + code);
  return { file, journey: j.id, rejected, findings, attempts };
}

/** True when a spec file carries the REJECTED header. The runner refuses these before anything else. */
export function isRejectedSpec(source: string): boolean {
  return source.trimStart().startsWith(REJECTED_MARK);
}
