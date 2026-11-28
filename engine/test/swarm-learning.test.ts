import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_SELF_CREATED,
  createCompositeTool,
  createCustomAgent,
  createGeneratedSkill,
  designFromDescription,
  generatedSkillsDir,
  listCompositeTools,
  maybeSelfCreate,
  runCompositeTool,
} from "../src/agents/creations.ts";
import { postMissionMessage } from "../src/agents/mission-control.ts";
import { PREBUILT_AGENTS, routeIntentToAgents } from "../src/agents/registry.ts";
import { runAgenticMission } from "../src/agents/runner.ts";
import {
  loadLearningStore,
  recallLessons,
  recordFeedback,
  recordMissionOutcome,
  recordUserCorrection,
} from "../src/learning/self-learning.ts";
import { listMemory } from "../src/memory/qa-memory.ts";
import { listSkills } from "../src/roles/skills.ts";
import type { GuardConfig } from "../src/types.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function makeTempCfg(): { dir: string; cfg: GuardConfig } {
  const dir = mkdtempSync(join(tmpdir(), "reo-swarm-test-"));
  const dataDir = join(dir, "data");
  const vaultDir = join(dir, "vault");
  const repoDir = join(dir, "repo");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "index.ts"), `export function ok(n: number) { if (n <= 0) return 0; return n; }\n`);
  return {
    dir,
    cfg: {
      root: REPO_ROOT,
      dataDir,
      vaultDir,
      repos: [{ id: "tmp-repo", path: repoDir }],
      busyProcesses: [],
    },
  };
}

test("1. Extended prebuilt agents & learned routing weights", () => {
  const ids = new Set(PREBUILT_AGENTS.map((a) => a.id));
  for (const id of ["a11y", "perf", "release", "architect", "triage"] as const) {
    assert.ok(ids.has(id), `Expected prebuilt agent ${id}`);
  }
  const r1 = routeIntentToAgents("check wcag accessibility on http://127.0.0.1:4310");
  assert.ok(r1.agents.includes("a11y"));

  const r2 = routeIntentToAgents("inspect checkout module", {
    checkout: { triage: 1.4 },
  });
  assert.ok(r2.agents.includes("triage"), "Learned weight >= 1 should add triage");
});

test("2. Parallel swarm execution emits agent lifecycle events concurrently", async () => {
  const { dir, cfg } = makeTempCfg();
  try {
    const events: Array<{ type: string; agent?: string; status?: string }> = [];
    const res = await runAgenticMission(cfg, "@qe @architect check boundaries", (ev) => {
      events.push({
        type: ev.type,
        ...(ev.type === "agent" ? { agent: ev.agent, status: ev.status } : {}),
      });
    });

    assert.ok(res.agents.includes("qe"));
    assert.ok(res.agents.includes("architect"));

    const runningIndices = events
      .map((e, i) => (e.type === "agent" && e.status === "running" ? i : -1))
      .filter((i) => i >= 0);
    const doneIndices = events
      .map((e, i) => (e.type === "agent" && e.status === "done" ? i : -1))
      .filter((i) => i >= 0);

    assert.equal(runningIndices.length, 2);
    assert.equal(doneIndices.length, 2);
    // Bounded concurrency starts both queued agents before or alongside completion
    assert.ok(runningIndices[1]! <= doneIndices[0]! + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("3. Live mission-control steering, stop, and secret blocking", async () => {
  const { dir, cfg } = makeTempCfg();
  try {
    // Unknown mission rejected
    assert.equal(postMissionMessage("mission-missing", "hello").accepted, false);

    const mid = "mission-stoptest1";
    let stoppedSent = false;
    let sawSecretRejected = false;
    const statuses: string[] = [];

    const res = await runAgenticMission(
      cfg,
      "@qe @architect @release check all",
      (ev) => {
        if (ev.type === "agent") {
          statuses.push(`${ev.agent}:${ev.status}`);
          if (ev.status === "running" && !stoppedSent) {
            stoppedSent = true;
            const secretAttempt = postMissionMessage(mid, "token is sk-ant-api03-Qx9mK2pL8vW4zR7nT5yB");
            sawSecretRejected = secretAttempt.accepted === false;
            const stopRes = postMissionMessage(mid, "stop");
            assert.equal(stopRes.accepted, true);
            assert.equal(stopRes.action, "stop");
          }
        }
      },
      { missionId: mid },
    );

    assert.equal(sawSecretRejected, true);
    assert.ok(res.steps.some((s) => s.status === "skipped"), "Stopping should mark queued steps skipped");
    assert.ok(statuses.length >= 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("4. REO creations: custom agents, composite tools, and generated skills", async () => {
  const { dir, cfg } = makeTempCfg();
  try {
    const design = designFromDescription(REPO_ROOT, "agent", "audit accessibility and performance of local pages");
    assert.ok(design.allowedTools.some((t) => t.startsWith("qa_")));

    const ag = createCustomAgent(cfg.dataDir, REPO_ROOT, {
      description: "audit accessibility and performance of local pages",
      createdBy: "reo",
      origin: "chat",
    });
    assert.ok(ag.id.startsWith("custom-"));
    assert.equal(ag.createdBy, "reo");
    assert.notEqual(ag.riskTier, "external_notify");

    const comp = createCompositeTool(cfg.dataDir, REPO_ROOT, {
      name: "Tier0 Combo",
      description: "Run AST grep and arch boundaries together",
      steps: [
        { tool: "review_ast_grep", args: {} },
        { tool: "qe_arch_boundaries", args: {} },
      ],
      createdBy: "reo",
      origin: "chat",
    });
    const compRes = await runCompositeTool(cfg, comp.id, {});
    assert.equal(compRes.status, "ok");
    assert.equal(compRes.steps.length, 2);

    const sk = createGeneratedSkill(cfg.dataDir, REPO_ROOT, {
      name: "qa-custom-a11y-check",
      description: "Generated A11y check",
      body: "# Custom A11y\n\n1. Run qa_axe_audit.",
      origin: "chat",
    });
    assert.equal(sk.createdBy, "reo");
    const discovered = listSkills(REPO_ROOT, undefined, generatedSkillsDir(cfg.dataDir));
    const found = discovered.find((s) => s.name === "qa-custom-a11y-check");
    assert.equal(found?.createdBy, "reo");

    assert.throws(() =>
      createGeneratedSkill(cfg.dataDir, REPO_ROOT, { name: "BAD NAME!", description: "x", body: "y" }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("5. Self-learning weights, feedback, lesson promotion, and bounded auto-creation", () => {
  const { dir, cfg } = makeTempCfg();
  try {
    const opts = {
      prompt: "audit payment gateway latency",
      agents: ["perf", "security"],
      tools: [
        { id: "qa_k6_smoke_load", ms: 40, ok: true },
        { id: "sec_semgrep_scan", ms: 60, ok: true },
      ],
      verdict: "PASS" as const,
      successfulAgents: ["perf", "security"],
    };

    for (let i = 0; i < 3; i++) {
      recordMissionOutcome(cfg.dataDir, { missionId: `mission-l${i}`, ...opts });
    }

    const before = loadLearningStore(cfg.dataDir).routing["payment"]?.["perf"] ?? 0;
    assert.ok(before > 0.5);

    recordFeedback(cfg.dataDir, "mission-l2", "down");
    const afterDown = loadLearningStore(cfg.dataDir).routing["payment"]?.["perf"] ?? 0;
    assert.ok(afterDown < before);

    // User correction twice promotes to verified procedural memory
    const les1 = recordUserCorrection(cfg.dataDir, "Always run payment latency checks on localhost first", "mission-l2");
    assert.equal(les1?.promoted, false);
    const les2 = recordUserCorrection(cfg.dataDir, "Always run payment latency checks on localhost first", "mission-l2");
    assert.equal(les2?.promoted, true);
    assert.ok(recallLessons(cfg.dataDir, "payment latency").length >= 1);
    assert.ok(listMemory(cfg.dataDir, { layer: "procedural", confidence: "verified" }).length >= 1);

    // maybeSelfCreate synthesizes 1 composite tool on >=3 repeated runs
    const created = maybeSelfCreate(cfg, { agents: ["perf", "security"], tools: ["qa_k6_smoke_load", "sec_semgrep_scan"] });
    assert.equal(created?.kind, "tool");
    assert.equal(listCompositeTools(cfg.dataDir).filter((t) => t.origin === "self-learning").length, 1);

    // Cap enforcement check: MAX_SELF_CREATED stops additional creations once reached
    for (let i = 0; i < MAX_SELF_CREATED; i++) {
      createCustomAgent(cfg.dataDir, REPO_ROOT, {
        name: `Cap Agent ${i}`,
        description: `Cap test ${i}`,
        createdBy: "reo",
        origin: "self-learning",
      });
    }
    assert.equal(maybeSelfCreate(cfg, { agents: ["perf"], tools: [] }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
