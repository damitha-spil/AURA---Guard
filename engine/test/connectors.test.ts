import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composioExecuteAction,
  composioListConnections,
  getComposioStatus,
  validateComposioEndpoint,
} from "../src/plugins/composio.ts";
import {
  callExternalMcpTool,
  deleteExternalMcpServer,
  listDiscoveredMcpTools,
  listExternalMcpServers,
  probeExternalMcpServer,
  upsertExternalMcpServer,
} from "../src/plugins/mcp-hub.ts";
import { updatePlugin } from "../src/plugins/store.ts";

test("Composio connector: validates endpoint, blocks secrets, lists connections and executes actions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reo-composio-test-"));
  try {
    assert.equal(validateComposioEndpoint(""), "https://backend.composio.dev/api/v2");
    assert.throws(() => validateComposioEndpoint("https://user:pass@backend.composio.dev"));

    updatePlugin(dir, "composio", { enabled: true });
    const env = { COMPOSIO_API_KEY: "comp-test-key-xyz" };
    const st = await getComposioStatus(dir, { env });
    assert.equal(st.enabled, true);
    assert.equal(st.keySource, "env");

    const conns = await composioListConnections(dir, {
      env,
      fetchFn: async () => new Response(JSON.stringify({ items: [{ id: "c1", appName: "jira", status: "ACTIVE" }] }), { status: 200 }),
    });
    assert.equal(conns.length, 1);
    assert.equal(conns[0]!.appName, "jira");

    // Secret-like parameter is blocked before sending externally
    await assert.rejects(
      () =>
        composioExecuteAction(
          dir,
          { actionName: "JIRA_CREATE_ISSUE", params: { token: "sk-ant-api03-Qx9mK2pL8vW4zR7nT5yB" } },
          { env, fetchFn: async () => new Response("{}", { status: 200 }) },
        ),
      /Blocked Composio call/,
    );

    const execRes = await composioExecuteAction(
      dir,
      { actionName: "SLACK_SEND_MESSAGE", params: { channel: "#qa", text: "Build green" } },
      {
        env,
        fetchFn: async (_url, init) => {
          assert.equal((init?.headers as Record<string, string>)["X-API-Key"], "comp-test-key-xyz");
          return new Response(JSON.stringify({ successful: true }), { status: 200 });
        },
      },
    );
    assert.equal(execRes.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("External MCP Hub: blocks shell commands, discovers tools, exposes ToolEntry, and masks calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reo-mcphub-test-"));
  try {
    // Reject shell binaries
    assert.throws(
      () => upsertExternalMcpServer(dir, { name: "Bad", transport: "stdio", command: "powershell.exe", args: ["-c", "echo"] }),
      /Refused shell binary/,
    );

    const srv = upsertExternalMcpServer(dir, {
      name: "GitHub MCP",
      transport: "http",
      url: "https://mcp.example.com/github",
    });
    assert.equal(listExternalMcpServers(dir).length, 1);

    const probed = await probeExternalMcpServer(dir, srv.id, async () => ({
      listTools: async () => ({
        tools: [{ name: "list_issues", description: "List GitHub issues" }],
      }),
      callTool: async () => ({}),
      close: async () => {},
    }));
    assert.equal(probed.discoveredTools.length, 1);
    assert.equal(probed.discoveredTools[0]!.name, "list_issues");

    const entries = listDiscoveredMcpTools(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.id, `mcp__${srv.id}__list_issues`);

    // Secret in args blocked before calling external MCP
    await assert.rejects(
      () =>
        callExternalMcpTool(dir, srv.id, "list_issues", { apiKey: "sk-ant-api03-Qx9mK2pL8vW4zR7nT5yB" }, async () => ({
          listTools: async () => ({ tools: [] }),
          callTool: async () => ({ ok: true }),
          close: async () => {},
        })),
      /Blocked external MCP call/,
    );

    const out = await callExternalMcpTool(dir, srv.id, "list_issues", { repo: "spil/aura" }, async () => ({
      listTools: async () => ({ tools: [] }),
      callTool: async (req) => ({ ok: true, called: req.name, args: req.arguments }),
      close: async () => {},
    })) as { ok: boolean; called: string };
    assert.equal(out.ok, true);
    assert.equal(out.called, "list_issues");

    assert.equal(deleteExternalMcpServer(dir, srv.id), true);
    assert.equal(listExternalMcpServers(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
