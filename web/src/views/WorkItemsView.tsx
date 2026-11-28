import * as React from "react";
import { ClipboardList, ExternalLink, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Page, PageHeader, TableSkeleton } from "@/components/app/page";
import { openExternal } from "@/components/app/pull-list";
import { apiGet } from "@/lib/api";
import { ago, safeUrl } from "@/lib/pulls";
import { isWorkItemsReply, selectWorkItems, type Via, type WorkItemsReply } from "@/lib/workitems";

const ANY = "\u0000any";

export function WorkItemsView() {
  const [query, setQuery] = React.useState("");
  const [via, setVia] = React.useState<Via>("any");
  const [type, setType] = React.useState("");
  const [state, setState] = React.useState<"open" | "closed" | "all">("open");
  const [repoId, setRepoId] = React.useState("");
  const [request, setRequest] = React.useState({ n: 0, force: false });
  const [data, setData] = React.useState<{ key: string; reply?: WorkItemsReply; error?: string } | null>(null);
  const [busy, setBusy] = React.useState(true);
  const forced = React.useRef(0);
  const key = `${state}\0${repoId}`;

  React.useEffect(() => {
    let cancelled = false;
    setBusy(true);
    const force = request.force && forced.current !== request.n;
    forced.current = request.n;
    const q = new URLSearchParams({ state });
    if (repoId) q.set("repoId", repoId);
    if (force) q.set("refresh", "1");
    apiGet<WorkItemsReply>(`/api/workitems?${q}`).then((r) => {
      if (cancelled) return;
      setBusy(false);
      setData(r.ok && isWorkItemsReply(r.data) ? { key, reply: r.data } : { key, error: r.error || "The engine did not return work items. Restart the engine if it was just updated." });
    });
    return () => {
      cancelled = true;
    };
  }, [state, repoId, request, key]);

  const refresh = () => setRequest((r) => ({ n: r.n + 1, force: true }));
  const current = data?.key === key ? data : null;
  const reply = current?.reply;
  const types = [...new Set(reply?.items.map((w) => w.type) ?? [])].sort();
  const shown = reply ? selectWorkItems(reply.items, query, via, type) : [];
  const failed = reply?.sources.filter((s) => !s.ok) ?? [];
  const retry = (
    <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
      <RefreshCw />
      Retry
    </Button>
  );

  return (
    <Page>
      <PageHeader title="Work items" description="Azure DevOps work items linked to pull requests or assigned to you. Read only." />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by title, number, person or pull request" aria-label="Search work items" className="pl-9" />
        </div>
        <Select value={state} onValueChange={(v) => setState(v as typeof state)}>
          <SelectTrigger className="w-32" aria-label="State"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <Select value={via} onValueChange={(v) => setVia(v as Via)}>
          <SelectTrigger className="w-44" aria-label="Which work items"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Assigned or linked</SelectItem>
            <SelectItem value="assigned">Assigned to me</SelectItem>
            <SelectItem value="linked">Linked to pull requests</SelectItem>
          </SelectContent>
        </Select>
        <Select value={type || ANY} onValueChange={(v) => setType(v === ANY ? "" : v)}>
          <SelectTrigger className="w-36" aria-label="Type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any type</SelectItem>
            {[...new Set([...types, ...(type ? [type] : [])])].map((t) => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={repoId || ANY} onValueChange={(v) => setRepoId(v === ANY ? "" : v)}>
          <SelectTrigger className="w-44" aria-label="Repository"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All repositories</SelectItem>
            {[...new Set([...(reply?.sources.map((s) => s.repoId) ?? []), ...(repoId ? [repoId] : [])])].map((r) => (
              <SelectItem key={r} value={r}>{r}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" aria-label="Refresh" onClick={refresh} disabled={busy}>
          <RefreshCw className={busy ? "animate-spin" : undefined} />
        </Button>
      </div>

      {!current && (
        <div role="status" aria-label="Loading work items">
          <TableSkeleton rows={5} />
        </div>
      )}
      {current?.error && <EmptyState icon={ClipboardList} title="Could not load work items" description={current.error} action={retry} />}

      {reply && (
        <>
          {failed.length > 0 && (
            <div role="alert" className="border-destructive/50 rounded-2xl border p-3 text-xs">
              <p className="mb-1 font-medium">Some repositories could not be read.</p>
              <ul className="grid gap-1">
                {failed.map((s) => (
                  <li key={s.repoId} className="break-words"><span className="font-medium">{s.repoId}:</span> {s.error}</li>
                ))}
              </ul>
              <div className="mt-2">{retry}</div>
            </div>
          )}
          {shown.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title={reply.items.length === 0 ? "No work items" : "No work items match"}
              description={reply.items.length === 0 ? "Nothing is assigned to you or linked to a recent pull request here. Only Azure DevOps repositories are checked." : "Change the search or filters."}
              action={retry}
            />
          ) : (
            <ul className="divide-y overflow-hidden rounded-2xl border">
              {shown.map((w) => {
                const url = safeUrl(w.url);
                return (
                  <li key={`${w.repoId}#${w.id}`} className="flex items-start gap-3 p-3">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="min-w-0 text-sm font-medium break-words">{w.title}</span>
                        <Badge variant="outline">{w.type}</Badge>
                        <Badge variant="secondary">{w.state}</Badge>
                      </span>
                      <span className="text-muted-foreground mt-0.5 block text-xs break-words">
                        #{w.id} · {w.repoId} · {w.assignedTo || "unassigned"}
                        {w.pulls.length > 0 && ` · pull request ${w.pulls.map((p) => `#${p}`).join(", ")}`}
                        {w.via.includes("assigned") && " · assigned to me"}
                      </span>
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">{w.changedDate ? ago(w.changedDate) : ""}</span>
                    {url && (
                      <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`Open work item ${w.id} in the browser`} onClick={() => void openExternal(url)}>
                        <ExternalLink />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!Number.isNaN(Date.parse(reply.checkedAt)) && (
            <p className="text-muted-foreground text-xs">{shown.length} shown. Checked {new Date(reply.checkedAt).toLocaleString()}.</p>
          )}
        </>
      )}
    </Page>
  );
}
