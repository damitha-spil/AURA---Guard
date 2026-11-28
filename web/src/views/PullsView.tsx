import * as React from "react";
import {
  ArrowUpDown,
  Bookmark,
  GitPullRequest,
  ListFilter,
  Plug,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Page, PageHeader, TableSkeleton } from "@/components/app/page";
import { PullList, PullSheet, SourceErrors } from "@/components/app/pull-list";
import { apiGet } from "@/lib/api";
import {
  BUILT_IN,
  DEFAULT_SET,
  SORTS,
  readViews,
  selectPulls,
  writeViews,
  type Pull,
  type PullsReply,
  type SavedView,
  type Sort,
  type ViewSet,
} from "@/lib/pulls";

// Radix Select does not allow an empty value, so "any" needs its own marker.
const ANY = "\u0000any";

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      <Select value={value || ANY} onValueChange={(v) => onChange(v === ANY ? "" : v)}>
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, text]) => (
            <SelectItem key={v || ANY} value={v || ANY}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** "any" plus the values present, keeping a chosen value even when nothing has it now. */
function anyOf(values: string[], chosen: string, anyLabel: string): [string, string][] {
  const all = new Set([...values, ...(chosen ? [chosen] : [])].filter(Boolean));
  return [["", anyLabel], ...[...all].sort().map((v): [string, string] => [v, v])];
}

function ViewsMenu({ current, onApply }: { current: ViewSet; onApply: (s: ViewSet) => void }) {
  const [open, setOpen] = React.useState(false);
  const [saved, setSaved] = React.useState<SavedView[]>(readViews);
  const [name, setName] = React.useState("");

  function store(next: SavedView[]) {
    setSaved(next);
    if (!writeViews(next)) toast.error("This browser did not keep the view. It lasts until the page closes.");
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    store([...saved.filter((v) => v.name !== n), { name: n, set: current }]);
    setName("");
  }

  const row = (v: SavedView) => (
    <button
      type="button"
      onClick={() => {
        onApply(v.set);
        setOpen(false);
      }}
      className="hover:bg-muted focus-visible:ring-ring/50 min-w-0 flex-1 truncate rounded-xl px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-[3px]"
    >
      {v.name}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Bookmark />
          Views
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-64 gap-1 p-2">
        {BUILT_IN.map((v) => (
          <div key={v.name} className="flex">
            {row(v)}
          </div>
        ))}
        {saved.map((v) => (
          <div key={`saved-${v.name}`} className="flex items-center gap-1">
            {row(v)}
            <Button variant="ghost" size="icon" className="size-7" aria-label={`Delete view ${v.name}`} onClick={() => store(saved.filter((x) => x !== v))}>
              <Trash2 />
            </Button>
          </div>
        ))}
        <form onSubmit={save} className="mt-1 flex gap-1 border-t pt-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Name this view" aria-label="View name" className="h-8" />
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Save
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function PullsView({ initialSource = "" }: { initialSource?: string }) {
  const [set, setSet] = React.useState<ViewSet>(DEFAULT_SET);
  const [source, setSource] = React.useState(initialSource);
  const [request, setRequest] = React.useState({ n: 0, force: false });
  const [data, setData] = React.useState<{ state: string; reply?: PullsReply; error?: string } | null>(null);
  const [busy, setBusy] = React.useState(true);
  const [open, setOpen] = React.useState<Pull | null>(null);
  const state = set.state;
  const forced = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    setBusy(true);
    // Ask the engine to skip its cache only once for each press of refresh.
    const force = request.force && forced.current !== request.n;
    forced.current = request.n;
    apiGet<PullsReply>(`/api/pulls?state=${state}${force ? "&refresh=1" : ""}`).then((r) => {
      if (cancelled) return;
      setBusy(false);
      if (!r.ok || !Array.isArray(r.data.pulls) || !Array.isArray(r.data.sources)) {
        setData({ state, error: r.error || "The engine did not return pull requests." });
      } else setData({ state, reply: r.data });
    });
    return () => {
      cancelled = true;
    };
  }, [state, request]);

  const refresh = () => setRequest((r) => ({ n: r.n + 1, force: true }));
  // A list fetched for another state must not appear under the new filter.
  const current = data?.state === state ? data : null;
  const reply = current?.reply;
  const sources = reply?.sources ?? [];
  const failed = sources.filter((s) => !s.ok && (!source || s.repoId === source));
  const inScope = sources.filter((s) => !source || s.repoId === source);
  const shown = reply ? selectPulls(reply.pulls, set, source) : [];
  const allFailed = reply !== undefined && failed.length > 0 && failed.length === inScope.length && !reply.pulls.some((p) => !source || p.repoId === source);
  const patch = (p: Partial<ViewSet>) => setSet((s) => ({ ...s, ...p }));
  const filterCount = [set.state !== "open", set.draft !== "any", set.author !== "", set.target !== ""].filter(Boolean).length;

  const retry = (
    <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
      <RefreshCw />
      Retry
    </Button>
  );

  return (
    <Page>
      <PageHeader title="Pull requests" description="A read-only list from your configured repositories." />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4" />
          <Input
            value={set.query}
            onChange={(e) => patch({ query: e.target.value })}
            placeholder="Search pull requests, or label:bug"
            aria-label="Search pull requests"
            className="pl-9"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" title={SORTS.find(([v]) => v === set.sort)?.[1]}>
              <ArrowUpDown />
              Sort
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuRadioGroup value={set.sort} onValueChange={(v) => patch({ sort: v as Sort })}>
              {SORTS.map(([v, label]) => (
                <DropdownMenuRadioItem key={v} value={v}>
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <ListFilter />
              Filters
              {filterCount > 0 && <Badge variant="secondary">{filterCount}</Badge>}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="grid w-64 gap-3">
            <Choice label="State" value={set.state} options={[["open", "Open"], ["merged", "Merged"], ["closed", "Closed"], ["all", "All"]]} onChange={(v) => patch({ state: v as ViewSet["state"] })} />
            <Choice label="Drafts" value={set.draft} options={[["any", "Include drafts"], ["only", "Only drafts"], ["hide", "Hide drafts"]]} onChange={(v) => patch({ draft: v as ViewSet["draft"] })} />
            <Choice label="Author" value={set.author} options={anyOf(reply?.pulls.map((p) => p.author) ?? [], set.author, "Anyone")} onChange={(author) => patch({ author })} />
            <Choice label="Target branch" value={set.target} options={anyOf(reply?.pulls.map((p) => p.targetBranch) ?? [], set.target, "Any branch")} onChange={(target) => patch({ target })} />
            <Button variant="ghost" size="sm" onClick={() => setSet((s) => ({ ...DEFAULT_SET, query: s.query, sort: s.sort }))}>
              Clear filters
            </Button>
          </PopoverContent>
        </Popover>
        <ViewsMenu current={set} onApply={setSet} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="max-w-48" aria-label="Source repository">
              <Plug />
              <span className="truncate">{source || "All"}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuRadioGroup value={source || ANY} onValueChange={(v) => setSource(v === ANY ? "" : v)}>
              <DropdownMenuRadioItem value={ANY}>All repositories</DropdownMenuRadioItem>
              {sources.map((s) => (
                <DropdownMenuRadioItem key={s.repoId} value={s.repoId}>
                  {s.repoId}
                  {!s.ok && " (error)"}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="icon" aria-label="Refresh" onClick={refresh} disabled={busy}>
          <RefreshCw className={busy ? "animate-spin" : undefined} />
        </Button>
      </div>

      {!current && (
        <div role="status" aria-label="Loading pull requests">
          <TableSkeleton rows={5} />
        </div>
      )}

      {current?.error && <EmptyState icon={GitPullRequest} title="Could not load pull requests" description={current.error} action={retry} />}

      {allFailed && (
        <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
          <span className="bg-muted flex size-10 items-center justify-center rounded-2xl border">
            <GitPullRequest className="size-5" />
          </span>
          <h2 className="text-lg font-semibold">Could not load pull requests</h2>
          <div className="text-muted-foreground max-w-md text-sm">
            <SourceErrors sources={failed} />
          </div>
          {retry}
        </div>
      )}

      {reply && !allFailed && (
        <>
          {failed.length > 0 && (
            <div role="alert" className="border-destructive/50 flex flex-wrap items-start gap-3 rounded-2xl border p-3 text-xs">
              <TriangleAlert className="text-destructive size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="mb-1 font-medium">Some repositories could not be read. The list below leaves them out.</p>
                <SourceErrors sources={failed} />
              </div>
              {retry}
            </div>
          )}
          {shown.length === 0 ? (
            <EmptyState
              icon={GitPullRequest}
              title={sources.length === 0 ? "No repositories to check" : reply.pulls.length === 0 ? "No pull requests" : "No pull requests match"}
              description={
                sources.length === 0
                  ? "The engine did not list any repository."
                  : reply.pulls.length === 0
                    ? "Nothing was returned for this state."
                    : "Change the search, filters or source."
              }
              action={retry}
            />
          ) : (
            <PullList pulls={shown} onShow={setOpen} />
          )}
          {!Number.isNaN(Date.parse(reply.checkedAt)) && (
            <p className="text-muted-foreground text-xs">
              {shown.length} shown. Checked {new Date(reply.checkedAt).toLocaleString()}.
            </p>
          )}
        </>
      )}

      <PullSheet pull={open} onClose={() => setOpen(null)} />
    </Page>
  );
}
