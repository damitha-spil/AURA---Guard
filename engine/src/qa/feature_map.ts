// Lauren Poteto Rules 3, 5 & 7:
// - Feature Map loader & coverage checker (connects features -> entry points -> code -> journeys)
// - Evidence-to-Claim verifier (appearance -> screenshot; interaction -> sequence; perf -> traces)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";

export interface FeatureEntry {
  id: string;
  title: string;
  entryPoint: string;
  prerequisites: string[];
  navigationSteps: string[];
  codeAnchors: string[];
  expectedResult: string;
  journeyId?: string;
}

export function loadFeatureMap(cfg: GuardConfig): FeatureEntry[] {
  const file = join(cfg.root, "qa", "feature-map.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { features?: FeatureEntry[] };
    return Array.isArray(parsed.features) ? parsed.features : [];
  } catch {
    return [];
  }
}

export function findFeatureEntry(cfg: GuardConfig, query: string): FeatureEntry[] {
  const q = query.trim().toLowerCase();
  const all = loadFeatureMap(cfg);
  if (!q) return all;
  return all.filter((f) =>
    `${f.id} ${f.title} ${f.entryPoint} ${f.codeAnchors.join(" ")}`.toLowerCase().includes(q),
  );
}

export type ClaimKind = "appearance" | "interaction" | "performance" | "api";

export interface ClaimEvidenceInput {
  claim: ClaimKind;
  hasScreenshot?: boolean;
  exercisedStepsCount?: number;
  hasTimingTrace?: boolean;
  hasRequestReadback?: boolean;
}

export function verifyClaimEvidence(input: ClaimEvidenceInput): { ok: boolean; missing: string | null } {
  if (input.claim === "appearance" && !input.hasScreenshot) {
    return { ok: false, missing: "Appearance claims require at least one captured screenshot." };
  }
  if (input.claim === "interaction" && (input.exercisedStepsCount ?? 0) < 1) {
    return { ok: false, missing: "Interaction claims require an exercised step sequence, not just a build or static screenshot." };
  }
  if (input.claim === "performance" && !input.hasTimingTrace) {
    return { ok: false, missing: "Performance claims require comparable timing traces or measurements." };
  }
  if (input.claim === "api" && !input.hasRequestReadback) {
    return { ok: false, missing: "API/service claims require a real request, result, and readback." };
  }
  return { ok: true, missing: null };
}
