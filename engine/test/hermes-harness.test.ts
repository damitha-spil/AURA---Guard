import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { getEffectiveAgents, MAX_TIME_SECONDS_LIMIT, MAX_TOOL_CALLS_LIMIT, saveAgentProfile } from "../src/agents/profiles.ts";
import { addMemory, deleteMemory, listMemory, recallMemory, verifyMemory } from "../src/memory/qa-memory.ts";
import { deleteAutomationRule, evaluateQualityGate, listAutomationRules, listCheckpoints, recordCheckpoint, upsertAutomationRule } from "../src/automation/harness.ts";

test("agent profiles override, clamp budgets, and reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "reo-prof-"));
  try {
    const saved = saveAgentProfile(dir, "qa", {
      enabled: false,
      systemPrompt: "Custom QA prompt",
      modelOverride: "gemini-4-neon",
      maxToolCalls: 999,
      maxTimeSeconds: 9999,
    });
    assert.equal(saved.enabled, false);
    assert.equal(saved.systemPrompt, "Custom QA prompt");
    assert.equal(saved.modelOverride, "gemini-4-neon");
    assert.equal(saved.maxToolCalls, MAX_TOOL_CALLS_LIMIT);
    assert.equal(saved.maxTimeSeconds, MAX_TIME_SECONDS_LIMIT);

    const reset = saveAgentProfile(dir, "qa", { reset: true });
    assert.equal(reset.enabled, true);
    assert.equal(reset.modelOverride, null);
    assert.equal(getEffectiveAgents(dir).find((a) => a.id === "qa")?.enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("3-layer QA memory stores hypotheses separately, promotes to verified, and recalls relevant items", () => {
  const dir = mkdtempSync(join(tmpdir(), "reo-mem-"));
  try {
    const hyp = addMemory(dir, {
      layer: "execution",
      confidence: "hypothesis",
      title: "Checkout timeout on token refresh",
      content: "Observed occasional 401 when refresh races checkout POST.",
      tags: ["checkout", "auth"],
    });
    assert.equal(hyp.confidence, "hypothesis");
    assert.equal(hyp.verifiedAt, undefined);

    const verified = verifyMemory(dir, hyp.id);
    assert.ok(verified);
    assert.equal(verified.confidence, "verified");
    assert.ok(verified.verifiedAt);

    addMemory(dir, {
      layer: "procedural",
      confidence: "verified",
      title: "Playwright smoke checklist",
      content: "Check network 500s and console errors after login.",
      tags: ["playwright"],
    });

    assert.equal(listMemory(dir, { layer: "procedural" }).length, 1);
    const hits = recallMemory(dir, "checkout token refresh", 3);
    assert.equal(hits[0]?.id, hyp.id);
    assert.equal(deleteMemory(dir, hyp.id), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("automation triggers, checkpoints, and quality gate verdicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "reo-harness-"));
  try {
    const seeded = listAutomationRules(dir);
    assert.ok(seeded.length >= 3);

    const added = upsertAutomationRule(dir, {
      name: "PR Contract Gate",
      trigger: "on_pull_request",
      prompt: "@api verify OpenAPI contracts",
    });
    assert.equal(listAutomationRules(dir).some((r) => r.id === added.id), true);
    assert.equal(deleteAutomationRule(dir, added.id), true);

    assert.equal(evaluateQualityGate([]), "PASS");
    assert.equal(evaluateQualityGate([{ severity: "low" }]), "NEEDS_REVIEW");
    assert.equal(evaluateQualityGate([{ severity: "high" }]), "BLOCK_RELEASE");

    const cp = recordCheckpoint(dir, {
      missionId: "mission-1",
      stage: "completed",
      summary: "All checks green",
      agents: ["qa", "review"],
      defectCount: 0,
      verdict: "PASS",
    });
    assert.equal(listCheckpoints(dir)[0]?.id, cp.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
