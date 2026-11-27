// SPIL REO — Plugins Hub (Composio, MS Teams, Azure DevOps, GitHub, MCP) & Team Directory Store.
// Secrets are never stored in plain JSON; only non-secret config & status live here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PluginId = "composio" | "ms-teams" | "azure-devops" | "github" | "mcp-hub";

export interface PluginConfig {
  id: PluginId;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  status: "connected" | "disconnected" | "configured";
  scope: "read_only" | "notify";
  endpoint?: string;
  hasCredential: boolean;
  updatedAt?: string;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  gitAlias: string;
  role: string;
  teamsWebhookOrId: string;
}

const DEFAULT_PLUGINS: PluginConfig[] = [
  { id: "composio", name: "Composio", category: "Agent Toolkits", description: "Connect 100+ OAuth-managed toolkits (Jira, Linear, Slack, GitHub, Notion) into SPIL REO's Tool Library.", enabled: false, status: "disconnected", scope: "read_only", hasCredential: false },
  { id: "ms-teams", name: "Microsoft Teams", category: "Team Dispatch", description: "Send branded SPIL REO defect reports and adaptive cards directly to mapped engineers or channels.", enabled: false, status: "disconnected", scope: "notify", hasCredential: false },
  { id: "azure-devops", name: "Azure DevOps", category: "Source & PRs", description: "Read-only PR diff sync, thread mining, and work-item draft export for SPIL repositories.", enabled: false, status: "disconnected", scope: "read_only", hasCredential: false },
  { id: "github", name: "GitHub", category: "Source & PRs", description: "Read-only pull request diffs, issue drafts, and repository metadata.", enabled: false, status: "disconnected", scope: "read_only", hasCredential: false },
  { id: "mcp-hub", name: "MCP Server Hub", category: "Protocol Bridge", description: "Connect external MCP servers or expose SPIL REO's 21+ tools to Claude Code, VS Code, and Cursor.", enabled: true, status: "connected", scope: "read_only", hasCredential: false },
];

function pluginsFile(dataDir: string): string {
  const dir = join(dataDir, "plugins");
  mkdirSync(dir, { recursive: true });
  return join(dir, "plugins.json");
}

function teamFile(dataDir: string): string {
  const dir = join(dataDir, "plugins");
  mkdirSync(dir, { recursive: true });
  return join(dir, "team.json");
}

export function listPlugins(dataDir: string): PluginConfig[] {
  const file = pluginsFile(dataDir);
  if (!existsSync(file)) return DEFAULT_PLUGINS.map((p) => ({ ...p }));
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as PluginConfig[];
    const byId = new Map(saved.map((p) => [p.id, p]));
    return DEFAULT_PLUGINS.map((def) => ({ ...def, ...(byId.get(def.id) || {}) }));
  } catch {
    return DEFAULT_PLUGINS.map((p) => ({ ...p }));
  }
}

export function updatePlugin(
  dataDir: string,
  id: PluginId,
  patch: Partial<Pick<PluginConfig, "enabled" | "endpoint" | "scope" | "status" | "hasCredential">>,
): PluginConfig | null {
  const all = listPlugins(dataDir);
  const found = all.find((p) => p.id === id);
  if (!found) return null;
  Object.assign(found, patch, { updatedAt: new Date().toISOString() });
  if (found.enabled && found.endpoint) found.status = "configured";
  if (!found.enabled && found.id !== "mcp-hub") found.status = "disconnected";
  writeFileSync(pluginsFile(dataDir), JSON.stringify(all, null, 2), "utf8");
  return found;
}

export function listTeamMembers(dataDir: string): TeamMember[] {
  const file = teamFile(dataDir);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function upsertTeamMember(dataDir: string, input: Omit<TeamMember, "id"> & { id?: string }): TeamMember {
  const all = listTeamMembers(dataDir);
  const id = input.id || `tm-${Date.now().toString(36)}`;
  const existing = all.find((m) => m.id === id);
  if (existing) {
    Object.assign(existing, input, { id });
    writeFileSync(teamFile(dataDir), JSON.stringify(all, null, 2), "utf8");
    return existing;
  }
  const rec: TeamMember = {
    id,
    name: input.name.trim(),
    email: (input.email || "").trim(),
    gitAlias: (input.gitAlias || "").trim(),
    role: (input.role || "Engineer").trim(),
    teamsWebhookOrId: (input.teamsWebhookOrId || "").trim(),
  };
  all.push(rec);
  writeFileSync(teamFile(dataDir), JSON.stringify(all, null, 2), "utf8");
  return rec;
}

export function removeTeamMember(dataDir: string, id: string): boolean {
  const all = listTeamMembers(dataDir);
  const next = all.filter((m) => m.id !== id);
  if (next.length === all.length) return false;
  writeFileSync(teamFile(dataDir), JSON.stringify(next, null, 2), "utf8");
  return true;
}

/** Builds a Microsoft Teams Adaptive Card / MessageCard payload for a defect report. */
export function buildTeamsDefectPayload(opts: {
  recipientName: string;
  note: string;
  defects: Array<{ id: string; title: string; severity: string; appName: string; branch: string; codeSuggestion?: string }>;
}): Record<string, unknown> {
  return {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: "059669",
    summary: `SPIL REO Defect Report (${opts.defects.length} item${opts.defects.length === 1 ? "" : "s"})`,
    sections: [
      {
        activityTitle: `SPIL REO · Defect Report for ${opts.recipientName}`,
        activitySubtitle: "REVIEW · EVALUATE · OPTIMIZE — Powered by SPIL Labs",
        text: opts.note || "Please review the defects and code suggestions below.",
        facts: opts.defects.slice(0, 10).map((d) => ({
          name: `[${d.severity.toUpperCase()}] ${d.id} (${d.appName} / ${d.branch})`,
          value: d.title + (d.codeSuggestion ? " — Suggested fix included" : ""),
        })),
      },
    ],
  };
}
