// Shapes and filtering for GET /api/workitems and GET /api/pulls/:repo/:number/workitems. Read-only.

export interface WorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  assignedTo: string;
  url: string;
  changedDate: string;
  repoId: string;
  via: ("assigned" | "linked")[];
  pulls: number[];
}

export interface WorkItemSource {
  repoId: string;
  ok: boolean;
  error: string | null;
}

export interface WorkItemsReply {
  checkedAt: string;
  sources: WorkItemSource[];
  items: WorkItem[];
}

export const isWorkItemsReply = (d: unknown): d is WorkItemsReply =>
  !!d && Array.isArray((d as WorkItemsReply).items) && Array.isArray((d as WorkItemsReply).sources);

export type Via = "any" | "assigned" | "linked";

/** Search matches id, title, type, state, person and pull request number, all words together. */
export function selectWorkItems(items: WorkItem[], query: string, via: Via, type: string): WorkItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((w) => {
    if (via !== "any" && !w.via.includes(via)) return false;
    if (type && w.type !== type) return false;
    const hay = `${w.id} ${w.title} ${w.type} ${w.state} ${w.assignedTo} ${w.pulls.map((p) => `pr${p} #${p}`).join(" ")}`.toLowerCase();
    return words.every((x) => hay.includes(x));
  });
}
