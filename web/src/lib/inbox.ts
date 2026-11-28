// GET /api/inbox answers { total, groups: [{ type, items }] }. This makes it one flat list.

export interface InboxItem {
  id: string;
  title?: string;
  type?: string;
  status?: string;
  preview?: string;
}

export interface InboxReply {
  groups?: { items: InboxItem[] }[];
}

export const inboxItems = (data: InboxReply): InboxItem[] => (data.groups ?? []).flatMap((g) => g.items);
