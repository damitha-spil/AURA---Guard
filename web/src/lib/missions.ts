// Types and small helpers for approval cards, background missions and items REO created from a chat.
// Mirrors engine/src/chat/{approvals,missions,follow-through}.ts.

export interface ApprovalInfo {
  id: string;
  chatId: string | null;
  kind: "open_attachment" | "open_link";
  title: string;
  detail: string;
  state: "pending" | "approved" | "declined" | "expired";
  created: string;
}

export interface CreatedInfo {
  kind: "followup" | "task" | "note" | "defect";
  id: string;
  label: string;
}

export interface MissionStepInfo { id: string; label: string; status: string; detail?: string }

export interface MissionInfo {
  id: string;
  chatId: string;
  title: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string;
  steps: MissionStepInfo[];
  created: CreatedInfo[];
  summary?: string;
  approvals: ApprovalInfo[];
}

/** Mirrors MAX_MISSIONS_RUNNING in the engine. */
export const MAX_MISSIONS_RUNNING = 2;

const KIND_LABEL: Record<CreatedInfo["kind"], string> = { followup: "Follow-up", task: "Task", note: "Proposed note", defect: "Defect draft" };
export const createdKindLabel = (k: CreatedInfo["kind"]): string => KIND_LABEL[k] ?? k;

/** The page where a created item can be seen: follow-ups and tasks, the Knowledge inbox, or Defects. */
export function createdView(k: CreatedInfo["kind"]): "followups" | "knowledge" | "defects" {
  return k === "note" ? "knowledge" : k === "defect" ? "defects" : "followups";
}

export const upsertById = <T extends { id: string }>(list: T[], item: T): T[] => {
  const at = list.findIndex((x) => x.id === item.id);
  return at < 0 ? [...list, item] : list.map((x, i) => (i === at ? item : x));
};
