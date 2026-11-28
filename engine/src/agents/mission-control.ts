// SPIL REO — Live Mission Control Inbox (chat-while-running steering, stop, skip, add-agent).
// Stores active mission controllers in memory and masks every incoming message cleanly.

import { maskOutgoing } from "../mask/mask.ts";
import { PREBUILT_AGENTS } from "./registry.ts";

export type MissionControlAction = "stop" | "skip" | "add_agent" | "note";

export interface MissionInboxMessage {
  text: string;
  action: MissionControlAction;
  target?: string;
  at: string;
}

interface ActiveMissionEntry {
  id: string;
  startedAt: string;
  abort: AbortController;
  inbox: MissionInboxMessage[];
  skip: Set<string>;
}

const activeMissions = new Map<string, ActiveMissionEntry>();

export function registerMission(id: string, externalSignal?: AbortSignal): AbortController {
  const abort = new AbortController();
  if (externalSignal) {
    if (externalSignal.aborted) abort.abort();
    else externalSignal.addEventListener("abort", () => abort.abort(), { once: true });
  }
  activeMissions.set(id, {
    id,
    startedAt: new Date().toISOString(),
    abort,
    inbox: [],
    skip: new Set<string>(),
  });
  return abort;
}

export function finishMission(id: string): void {
  activeMissions.delete(id);
}

export function isMissionActive(id: string): boolean {
  return activeMissions.has(id);
}

export function listActiveMissions(): Array<{ id: string; startedAt: string; queuedMessages: number }> {
  return [...activeMissions.values()].map((m) => ({
    id: m.id,
    startedAt: m.startedAt,
    queuedMessages: m.inbox.length,
  }));
}

export function abortMission(id: string): boolean {
  const entry = activeMissions.get(id);
  if (!entry) return false;
  entry.abort.abort();
  entry.inbox.push({ text: "stop", action: "stop", at: new Date().toISOString() });
  return true;
}

export function isAgentSkipped(id: string, agentOrStep: string): boolean {
  return activeMissions.get(id)?.skip.has(agentOrStep.toLowerCase()) ?? false;
}

/** Post a live steering message or note into an active running swarm mission. */
export function postMissionMessage(
  id: string,
  rawText: string,
): { accepted: boolean; action: MissionControlAction; target?: string; text?: string; reason?: string } {
  const entry = activeMissions.get(id);
  if (!entry) {
    return { accepted: false, action: "note", reason: "Mission is not active." };
  }
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { accepted: false, action: "note", reason: "Message is empty." };
  }
  const masked = maskOutgoing(trimmed);
  if (!masked.ok) {
    return {
      accepted: false,
      action: "note",
      reason: `Blocked by secret masking gate (${masked.blocked.map((b) => b.kind).join(", ")}).`,
    };
  }
  const safeText = masked.text.slice(0, 1000);
  const at = new Date().toISOString();

  if (/^(stop|cancel|abort)\b/i.test(safeText)) {
    entry.abort.abort();
    entry.inbox.push({ text: safeText, action: "stop", at });
    return { accepted: true, action: "stop", text: safeText };
  }

  const skipMatch = /^skip\s+([a-z0-9_-]+)/i.exec(safeText);
  if (skipMatch) {
    const target = skipMatch[1]!.replace(/^@/, "").toLowerCase();
    entry.skip.add(target);
    entry.inbox.push({ text: safeText, action: "skip", target, at });
    return { accepted: true, action: "skip", target, text: safeText };
  }

  const mentionMatch = /@([a-z0-9_-]+)/i.exec(safeText);
  if (mentionMatch) {
    const mentioned = mentionMatch[1]!.toLowerCase();
    const isKnown = PREBUILT_AGENTS.some((a) => a.id === mentioned) || mentioned.startsWith("custom-");
    if (isKnown) {
      entry.inbox.push({ text: safeText, action: "add_agent", target: mentioned, at });
      return { accepted: true, action: "add_agent", target: mentioned, text: safeText };
    }
  }

  entry.inbox.push({ text: safeText, action: "note", at });
  return { accepted: true, action: "note", text: safeText };
}

export function drainInbox(id: string): MissionInboxMessage[] {
  const entry = activeMissions.get(id);
  if (!entry || entry.inbox.length === 0) return [];
  return entry.inbox.splice(0, entry.inbox.length);
}
