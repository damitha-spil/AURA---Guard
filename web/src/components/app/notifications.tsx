import * as React from "react";
import { Check, Inbox, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet, apiPost } from "@/lib/api";
import { inboxItems, type InboxItem, type InboxReply } from "@/lib/inbox";
import { EmptyState } from "@/components/app/page";

export function NotificationsPopover({
  count,
  onCount,
  onOpenInbox,
}: {
  count: number;
  onCount: (n: number) => void;
  onOpenInbox: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<InboxItem[] | null>(null);

  const load = React.useCallback(async () => {
    const r = await apiGet<InboxReply>("/api/inbox");
    if (r.ok) {
      const list = inboxItems(r.data);
      setItems(list);
      onCount(list.length);
    } else setItems([]);
  }, [onCount]);

  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function decide(item: InboxItem, to: "active" | "deprecated") {
    const r = await apiPost(`/api/notes/${encodeURIComponent(item.id)}/status`, { to });
    if (r.ok) toast.success(to === "active" ? "Rule approved" : "Item dismissed");
    else toast.error(r.error || "Update failed");
    load();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Notifications">
          <Inbox />
          <Badge variant={count > 0 ? "default" : "secondary"}>{count}</Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Inbox</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(false);
              onOpenInbox();
            }}
          >
            Open Knowledge
          </Button>
        </div>
        <ScrollArea className="max-h-80">
          <div className="space-y-2 p-2">
            {items === null && <Skeleton className="h-14 w-full" />}
            {items?.length === 0 && <EmptyState icon={Inbox} title="All caught up" description="No proposed items are waiting." />}
            {items?.map((it) => (
              <div key={it.id} className="rounded-2xl border p-2 text-sm">
                <div className="truncate font-medium">{it.title || it.id}</div>
                <div className="text-muted-foreground line-clamp-2 text-xs">{it.preview || it.type}</div>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" className="h-7" onClick={() => decide(it, "active")}>
                    <Check />
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" className="h-7" onClick={() => decide(it, "deprecated")}>
                    <X />
                    Dismiss
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
