// The chat history in the sidebar: search titles and message text, pin, rename, copy and delete.
import * as React from "react";
import { Copy, MoreHorizontal, Pencil, Pin, PinOff, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarGroup, SidebarGroupLabel } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface ChatSummary {
  id: string;
  title?: string;
  updated?: string;
  pinned?: boolean;
}

export interface ChatHit extends ChatSummary {
  snippet: string;
  matches: number;
}

export const chatTitle = (t?: string): string => (t || "").trim() || "New chat";

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function dayGroup(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "Older";
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startToday.getTime() - t) / 86400000) + 1;
  if (t >= startToday.getTime()) return "Today";
  if (days <= 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  return "Older";
}

const GROUP_ORDER = ["Pinned", "Today", "Yesterday", "Previous 7 days", "Older"];
/** Shorter searches only filter titles, so each key press does not read every chat. */
const MIN_TEXT_SEARCH = 2;

export function ChatList({
  chats,
  loaded,
  activeId,
  onOpen,
  onPin,
  onRename,
  onCopy,
  onDelete,
}: {
  chats: ChatSummary[];
  loaded: boolean;
  activeId: string | null;
  onOpen: (id: string, find?: string) => void;
  onPin: (c: ChatSummary) => void;
  onRename: (id: string, title: string) => void;
  onCopy: (c: ChatSummary) => void;
  onDelete: (c: ChatSummary) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<{ q: string; rows: ChatHit[] } | null>(null);
  const [editing, setEditing] = React.useState<{ id: string; title: string } | null>(null);
  const q = query.trim();

  React.useEffect(() => {
    if (q.length < MIN_TEXT_SEARCH) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const r = await apiGet<{ hits?: ChatHit[] }>(`/api/chats/search?q=${encodeURIComponent(q)}`);
      if (!cancelled && r.ok && Array.isArray(r.data.hits)) setHits({ q, rows: r.data.hits });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q, chats]);

  // Until the engine answers (or if it cannot), the titles already here are filtered.
  const found = q.length >= MIN_TEXT_SEARCH && hits?.q === q ? hits.rows : null;

  const groups = React.useMemo(() => {
    const map = new Map<string, ChatSummary[]>();
    for (const c of chats) {
      if (q && !chatTitle(c.title).toLowerCase().includes(q.toLowerCase())) continue;
      const g = c.pinned ? "Pinned" : dayGroup(c.updated);
      map.set(g, [...(map.get(g) || []), c]);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [chats, q]);

  // The box can report a blur while it is being removed; only the first finish counts.
  const finished = React.useRef(false);

  function finishRename(save: boolean) {
    if (finished.current) return;
    finished.current = true;
    const e = editing;
    setEditing(null);
    if (save && e && e.title.trim() && e.title.trim() !== chatTitle(chats.find((c) => c.id === e.id)?.title)) {
      onRename(e.id, e.title.trim());
    }
  }

  const row = (c: ChatSummary, snippet?: string) => (
    <div
      key={c.id}
      className={cn(
        "group/chat flex items-center gap-1 rounded-xl text-sm",
        activeId === c.id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
      )}
    >
      {editing?.id === c.id ? (
        <Input
          autoFocus
          value={editing.title}
          maxLength={60}
          aria-label="Chat name"
          className="h-8"
          onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") finishRename(true);
            if (e.key === "Escape") finishRename(false);
          }}
          onBlur={() => finishRename(true)}
        />
      ) : (
        <>
          <button type="button" onClick={() => onOpen(c.id, snippet ? q : undefined)} className="min-w-0 flex-1 px-2 py-1.5 text-left" title={chatTitle(c.title)}>
            <span className="block truncate">{chatTitle(c.title)}</span>
            {snippet && <span className="text-muted-foreground block truncate text-xs">{snippet}</span>}
          </button>
          {c.updated && <span className="text-muted-foreground shrink-0 text-[11px] group-hover/chat:hidden">{relTime(c.updated)}</span>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="mr-1 size-6 shrink-0 opacity-0 group-focus-within/chat:opacity-100 group-hover/chat:opacity-100 data-[state=open]:opacity-100"
                aria-label={`Options for ${chatTitle(c.title)}`}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            {/* Focus must not jump back to the button: that would end a rename as soon as it began. */}
            <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuItem onSelect={() => onPin(c)}>
                {c.pinned ? <PinOff /> : <Pin />}
                {c.pinned ? "Unpin" : "Pin to top"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  finished.current = false;
                  setEditing({ id: c.id, title: chatTitle(c.title) });
                }}
              >
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onCopy(c)}>
                <Copy />
                Copy as Markdown
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(c)}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );

  return (
    <SidebarGroup className="min-h-0 flex-1 group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Chats</SidebarGroupLabel>
      <div className="relative mb-2 px-2">
        <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-4 size-4" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats and messages..." className="h-9 pl-8" aria-label="Search chats and messages" />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-2 pb-2">
          {!loaded && <Skeleton className="h-8 w-full" />}
          {found ? (
            <div className="space-y-0.5">
              <div className="text-muted-foreground px-2 pb-1 text-[11px] font-medium">{found.length} found</div>
              {found.map((h) => row({ ...h, ...chats.find((c) => c.id === h.id) }, h.snippet))}
              {found.length === 0 && <p className="text-muted-foreground p-2 text-xs">No chat holds that text.</p>}
            </div>
          ) : (
            <>
              {loaded && groups.length === 0 && <p className="text-muted-foreground p-2 text-xs">{q ? "No chat title matches." : "No chats yet."}</p>}
              {groups.map(([name, items]) => (
                <div key={name} className="space-y-0.5">
                  <div className="text-muted-foreground px-2 pb-1 text-[11px] font-medium">{name}</div>
                  {items.map((c) => row(c))}
                </div>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
    </SidebarGroup>
  );
}
