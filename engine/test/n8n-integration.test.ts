import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { SecretBackend } from "../src/brain/keystore.ts";
import {
  buildN8nQaEventPayload,
  getN8nStatus,
  n8nListExecutions,
  n8nListWorkflows,
  n8nTriggerWebhook,
  validateN8nEndpoint,
} from "../src/plugins/n8n.ts";
import { listPlugins, updatePlugin } from "../src/plugins/store.ts";
import { BUILTIN_TOOLS } from "../src/tools/registry.ts";
import { parseToolLine } from "../src/tools/native/chat.ts";
import { getSkill } from "../src/roles/skills.ts";

function memoryBackend(initial: string | null = null): SecretBackend {
  let stored = initial;
  return {
    name: "memory",
    available: async () => true,
    exists: async () => stored !== null,
    set: async (s) => { stored = s; },
    get: async () => stored,
    remove: async () => { stored = null; },
  };
}

test("validateN8nEndpoint accepts http/https bases and rejects credentials or invalid schemes", () => {
  assert.equal(validateN8nEndpoint("http://localhost:5678/"), "http://localhost:5678");
  assert.equal(validateN8nEndpoint("https://n8n.example.com/sub/"), "https://n8n.example.com/sub");
  assert.throws(() => validateN8nEndpoint("ftp://n8n.example.com"));
  assert.throws(() => validateN8nEndpoint("https://user:pass@n8n.example.com"));
});

test("n8n workflows, executions, and masked webhook trigger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reo-n8n-"));
  try {
    assert.ok(listPlugins(dir).some((p) => p.id === "n8n"));
    assert.ok(BUILTIN_TOOLS.some((t) => t.id === "n8n_list_workflows"));
    assert.ok(BUILTIN_TOOLS.some((t) => t.id === "n8n_list_executions"));
    assert.ok(BUILTIN_TOOLS.some((t) => t.id === "n8n_trigger_webhook"));

    updatePlugin(dir, "n8n", { enabled: true, endpoint: "http://127.0.0.1:5678/" });
    const secrets = memoryBackend("n8n_api_test_secret_1234567890");
    const st = await getN8nStatus(dir, { secrets, env: {} });
    assert.equal(st.enabled, true);
    assert.equal(st.endpoint, "http://127.0.0.1:5678");
    assert.equal(st.keySource, "stored");

    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.includes("/api/v1/workflows")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "wf-1",
                name: "QA Release Gate",
                active: true,
                updatedAt: "2026-11-28T10:00:00Z",
                tags: [{ name: "qa" }],
                nodes: [{ type: "n8n-nodes-base.webhook", parameters: { path: "reo-qa-gate" } }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/v1/executions")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "ex-9", workflowId: "wf-1", status: "success", startedAt: "2026-11-28T10:01:00Z", mode: "webhook" }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }) as typeof fetch;

    const workflows = await n8nListWorkflows(dir, { secrets, env: {}, fetchFn: fakeFetch });
    assert.equal(workflows.length, 1);
    assert.equal(workflows[0]?.name, "QA Release Gate");
    assert.deepEqual(workflows[0]?.webhookPaths, ["reo-qa-gate"]);

    const executions = await n8nListExecutions(dir, "wf-1", { secrets, env: {}, fetchFn: fakeFetch });
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.status, "success");

    const payload = buildN8nQaEventPayload({ event: "qa_gate", verdict: "PASS", summary: "All checks green" });
    const trig = await n8nTriggerWebhook(dir, { pathOrUrl: "reo-qa-gate", payload }, { secrets, env: {}, fetchFn: fakeFetch });
    assert.equal(trig.ok, true);
    assert.equal(trig.url, "http://127.0.0.1:5678/webhook/reo-qa-gate");

    // Masking gate must block any planted secret before fetchFn is ever called
    const countBefore = calls.length;
    await assert.rejects(
      () =>
        n8nTriggerWebhook(
          dir,
          { pathOrUrl: "reo-qa-gate", payload: { leak: "sk-ant-api03-Qx9mK2pL8vW4zR7nT5yB" } },
          { secrets, env: {}, fetchFn: fakeFetch },
        ),
      /Blocked n8n webhook trigger/,
    );
    assert.equal(calls.length, countBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/n8n native command parses cleanly and n8n skills are discoverable", () => {
  assert.deepEqual(parseToolLine("/n8n workflows"), { name: "/n8n", arg: "workflows" });
  assert.deepEqual(parseToolLine('/n8n trigger reo-qa {"verdict":"PASS"}'), {
    name: "/n8n",
    arg: 'trigger reo-qa {"verdict":"PASS"}',
  });

  const root = resolve(import.meta.dirname, "..", "..");
  const qaSkill = getSkill(root, "qa-n8n-automation");
  const qeSkill = getSkill(root, "qe-n8n-triage");
  assert.ok(qaSkill, "qa-n8n-automation skill should be discoverable");
  assert.ok(qeSkill, "qe-n8n-triage skill should be discoverable");
});
