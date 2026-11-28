import * as React from "react";
import { ArrowLeft, Check, ChevronRight, ChevronsUpDown, Code, FolderGit2, FolderOpen, GitBranch, GitPullRequest, Plus, RefreshCw, SearchCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AddRepo } from "@/components/app/add-repo";
import { DiffView } from "@/components/app/diff-view";
import { ProofPanel } from "@/components/app/proof-panel";
import { ReportViews } from "@/components/app/report-view";
import { EmptyState, Page, PageHeader, TableSkeleton } from "@/components/app/page";
import { PullList, PullSheet, SourceErrors } from "@/components/app/pull-list";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { useDiffPrefs } from "@/lib/diff-prefs";
import { ago, type Pull, type PullsReply } from "@/lib/pulls";
import { WORKTREE, byWhoActs, refLabel, type Branch, type Commit, type Repo, type RepoDiff, type Review } from "@/lib/repos";

const api = (id: string, rest = "") => `/api/repos/${encodeURIComponent(id)}${rest}`;

/**
 * Loads a URL, and forgets the old answer as soon as the URL changes so it is never shown
 * under a new heading. A null URL loads nothing.
 */
function useLoad<T>(url: string | null, check: (data: T) => boolean, reload = 0) {
  const [state, setState] = React.useState<{ key: string; data?: T; error?: string } | null>(null);
  const key = `${url}#${reload}`;
  const checkRef = React.useRef(check);
  checkRef.current = check;
  React.useEffect(() => {
    if (!url) return;
    let cancelled = false;
    apiGet<T>(url).then((r) => {
      if (cancelled) return;
      setState(r.ok && checkRef.current(r.data) ? { key, data: r.data } : { key, error: r.error || "The engine did not return this." });
    });
    return () => {
      cancelled = true;
    };
  }, [url, key]);
  return state?.key === key ? { data: state.data, error: state.error, loading: false } : { data: undefined, error: undefined, loading: url !== null };
}

const retryButton = (onClick: () => void) => (
  <Button variant="outline" size="sm" onClick={onClick}>
    <RefreshCw />
    Retry
  </Button>
);

function Status({ repo }: { repo: Repo }) {
  if (!repo.exists) return <Badge variant="destructive">Folder not found</Badge>;
  if (!repo.isGit) return <Badge variant="destructive">Not a git repository</Badge>;
  return (
    <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="flex min-w-0 items-center gap-1">
        <GitBranch className="size-3 shrink-0" />
        <span className="break-all">{repo.branch ?? "no branch"}</span>
      </span>
      <span>{repo.dirtyFiles === null ? "changes unknown" : `${repo.dirtyFiles} changed`}</span>
      <span>{repo.ahead === null || repo.behind === null ? "ahead/behind unknown" : `${repo.ahead} ahead, ${repo.behind} behind`}</span>
      {repo.host && <span>{repo.host}</span>}
    </span>
  );
}

function RefPicker({ label, value, branches, withWorktree, onPick }: { label: string; value: string; branches: Branch[]; withWorktree?: boolean; onPick: (ref: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const pick = (ref: string) => {
    setOpen(false);
    onPick(ref);
  };
  const item = (ref: string, text: string, detail?: string) => (
    <CommandItem key={ref} value={ref} onSelect={() => pick(ref)}>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{text}</span>
        {detail && <span className="text-muted-foreground block truncate text-xs">{detail}</span>}
      </span>
      {ref === value && <Check className="size-4" />}
    </CommandItem>
  );
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" role="combobox" aria-expanded={open} aria-label={`${label} branch`} className="w-60 max-w-full justify-between">
            <GitBranch />
            <span className="min-w-0 flex-1 truncate text-left">{refLabel(value)}</span>
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search branches..." />
            <CommandList className="max-h-72">
              <CommandEmpty>No branch found.</CommandEmpty>
              {withWorktree && <CommandGroup>{item(WORKTREE, "Working changes")}</CommandGroup>}
              {[false, true].map((remote) => {
                const list = branches.filter((b) => b.remote === remote);
                return list.length ? (
                  <CommandGroup key={String(remote)} heading={remote ? "Remote" : "Local"}>
                    {list.map((b) => item(b.name, b.name, b.subject))}
                  </CommandGroup>
                ) : null;
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ReviewPanel({ repoId, base, head, onFile }: { repoId: string; base: string; head: string; onFile: (path: string) => void }) {
  const [ai, setAi] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<Review | null>(null);
  const [error, setError] = React.useState("");

  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    const r = await apiPost<Review>(api(repoId, "/review"), { base, head, ai });
    setBusy(false);
    if (!r.ok || !Array.isArray(r.data.findings)) setError(r.error || "The review did not run.");
    else setResult(r.data);
  }

  return (
    <section className="grid gap-3 rounded-2xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label className="flex items-center gap-2">
          <Switch checked={ai} onCheckedChange={setAi} disabled={busy} />
          Use AI model
        </Label>
        <Button size="sm" onClick={run} disabled={busy}>
          <SearchCheck />
          {busy ? "Reviewing..." : "Review"}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {ai ? "The diff is sent to the selected model after secrets are masked." : "No model is used and the diff is not sent to one."}
      </p>
      {error && (
        <p role="alert" className="text-destructive text-sm break-words">
          {error}
        </p>
      )}
      {result && (
        <div className="grid gap-3">
          <p className="text-sm break-words whitespace-pre-wrap">{result.summary}</p>
          {result.round && (
            <p className="text-muted-foreground text-xs">
              Review round {result.round.n} of {result.round.max}.
              {result.round.capped && ` The round limit is reached: only blockers are listed (left out: ${result.round.hidden}). Decide with the owner before another round.`}
            </p>
          )}
          {result.note && <p className="bg-muted rounded-2xl p-3 text-xs break-words whitespace-pre-wrap">{result.note}</p>}
          {result.evidence && <ProofPanel evidence={result.evidence} note="A code review is not proof." />}
          {result.findings.length === 0 && !result.round?.capped && <p className="text-muted-foreground text-sm">No findings. This does not prove the change is safe.</p>}
          {byWhoActs(result.findings).map(({ title, list }) => (
            <div key={title} className="grid gap-2">
              <h3 className="text-xs font-semibold uppercase">
                {title} ({list.length})
              </h3>
              {list.map((f, i) => (
                <div key={i} className="rounded-2xl border p-3 text-sm">
                  <Badge variant={f.severity === "blocker" ? "destructive" : "secondary"}>{f.severity}</Badge>
                  <div className="mt-1 font-medium break-words">{f.title}</div>
                  <p className="text-muted-foreground mt-1 text-xs break-words whitespace-pre-wrap">{f.detail}</p>
                  {f.file && (
                    <button type="button" onClick={() => onFile(f.file!)} className="text-primary focus-visible:ring-ring/50 mt-1 rounded-md font-mono text-xs break-all underline outline-none focus-visible:ring-[3px]">
                      {f.file}
                      {f.line ? `:${f.line}` : ""}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
          {result.reportViews && <ReportViews reports={result.reportViews} />}
        </div>
      )}
    </section>
  );
}

function RepoPulls({ repoId, onOpenPulls }: { repoId: string; onOpenPulls: (repoId: string) => void }) {
  const [reload, setReload] = React.useState(0);
  const [open, setOpen] = React.useState<Pull | null>(null);
  const { data, error, loading } = useLoad<PullsReply>("/api/pulls?state=open", (d) => Array.isArray(d.pulls) && Array.isArray(d.sources), reload);
  const mine = data?.pulls.filter((p) => p.repoId === repoId) ?? [];
  const failed = data?.sources.filter((s) => s.repoId === repoId && !s.ok) ?? [];
  return (
    <div className="grid gap-3">
      <Button variant="outline" size="sm" className="justify-self-start" onClick={() => onOpenPulls(repoId)}>
        <GitPullRequest />
        Open in Pull requests
      </Button>
      {loading && <TableSkeleton rows={3} />}
      {error && <EmptyState icon={GitPullRequest} title="Could not load pull requests" description={error} action={retryButton(() => setReload((n) => n + 1))} />}
      {failed.length > 0 && (
        <div role="alert" className="border-destructive/50 rounded-2xl border p-3 text-xs">
          <SourceErrors sources={failed} />
        </div>
      )}
      {data && failed.length === 0 && mine.length === 0 && <EmptyState icon={GitPullRequest} title="No open pull requests" />}
      {mine.length > 0 && <PullList pulls={mine} onShow={setOpen} />}
      <PullSheet pull={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function Detail({ repo, onBack, onOpenPulls }: { repo: Repo; onBack: () => void; onOpenPulls: (repoId: string) => void }) {
  const [reload, setReload] = React.useState(0);
  const [base, setBase] = React.useState(repo.branch ?? "HEAD");
  const [head, setHead] = React.useState(WORKTREE);
  const [focus, setFocus] = React.useState<{ path: string; n: number } | null>(null);
  const [tab, setTab] = React.useState("changes");
  const { hideWhitespace } = useDiffPrefs();
  const branches = useLoad<{ current: string | null; branches: Branch[] }>(api(repo.id, "/branches"), (d) => Array.isArray(d.branches), reload);
  const diffUrl = api(repo.id, `/diff?${new URLSearchParams({ base, head, ...(hideWhitespace ? { ignoreWhitespace: "1" } : {}) })}`);
  const diff = useLoad<RepoDiff>(diffUrl, (d) => Array.isArray(d.files), reload);
  const commitRef = head === WORKTREE ? (branches.data?.current ?? repo.branch ?? "HEAD") : head;
  const commits = useLoad<{ commits: Commit[] }>(
    tab === "commits" ? api(repo.id, `/commits?${new URLSearchParams({ ref: commitRef, limit: "50" })}`) : null,
    (d) => Array.isArray(d.commits),
    reload,
  );
  const list = branches.data?.branches ?? [];

  async function openIn(app: "vscode" | "explorer") {
    const r = await apiPost(api(repo.id, "/open"), { app });
    if (!r.ok) toast.error(r.error || "Could not open the folder.");
  }

  return (
    <Page>
      <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={onBack}>
        <ArrowLeft />
        All repositories
      </Button>
      <PageHeader
        title={repo.id}
        description={repo.path}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => openIn("vscode")}>
              <Code />
              Open in VS Code
            </Button>
            <Button variant="outline" size="sm" onClick={() => openIn("explorer")}>
              <FolderOpen />
              Open in Explorer
            </Button>
            <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setReload((n) => n + 1)}>
              <RefreshCw />
            </Button>
          </>
        }
      />
      <Status repo={repo} />
      <div className="flex flex-wrap items-end gap-3">
        <RefPicker label="Base" value={base} branches={list} onPick={setBase} />
        <RefPicker label="Compare" value={head} branches={list} withWorktree onPick={setHead} />
      </div>
      {branches.error && (
        <p role="alert" className="text-destructive text-xs">
          Could not list branches: {branches.error}
        </p>
      )}
      <p className="text-muted-foreground text-xs">Choosing a branch here only changes what is shown. REO does not switch your checkout.</p>

      <Tabs value={tab} onValueChange={setTab} className="min-w-0 gap-4">
        <TabsList>
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="commits">Commits</TabsTrigger>
          <TabsTrigger value="pulls">Pull requests</TabsTrigger>
        </TabsList>
        {/* Kept mounted so a finished review is still there after looking at another tab. */}
        <TabsContent value="changes" forceMount className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 data-[state=inactive]:hidden">
          <ReviewPanel
            key={`${base}\n${head}\n${reload}`}
            repoId={repo.id}
            base={base}
            head={head}
            onFile={(path) => setFocus((f) => ({ path, n: (f?.n ?? 0) + 1 }))}
          />
          {diff.loading && <TableSkeleton rows={4} />}
          {diff.error && <EmptyState title="Could not load the diff" description={diff.error} action={retryButton(() => setReload((n) => n + 1))} />}
          {diff.data && <DiffView diff={diff.data} focus={focus} />}
        </TabsContent>
        <TabsContent value="commits">
          <p className="text-muted-foreground mb-2 text-xs break-all">Latest commits on {commitRef}</p>
          {commits.loading && <TableSkeleton rows={4} />}
          {commits.error && <EmptyState title="Could not load commits" description={commits.error} action={retryButton(() => setReload((n) => n + 1))} />}
          {commits.data && commits.data.commits.length === 0 && <EmptyState title="No commits" />}
          {commits.data && commits.data.commits.length > 0 && (
            <ul className="divide-y rounded-2xl border">
              {commits.data.commits.map((c) => (
                <li key={c.sha} className="flex flex-wrap items-baseline gap-x-3 p-3">
                  <code className="text-muted-foreground font-mono text-xs">{c.sha.slice(0, 8)}</code>
                  <span className="min-w-0 flex-1 text-sm break-words">{c.subject}</span>
                  <span className="text-muted-foreground text-xs">
                    {c.author} · {ago(c.date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="pulls">
          <RepoPulls repoId={repo.id} onOpenPulls={onOpenPulls} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

export function ReposView({ onOpenPulls }: { onOpenPulls: (repoId: string) => void }) {
  const [reload, setReload] = React.useState(0);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<Repo | null>(null);
  const { data, error, loading } = useLoad<{ repos: Repo[] }>("/api/repos", (d) => Array.isArray(d.repos), reload);
  const again = () => setReload((n) => n + 1);
  const repo = data?.repos.find((r) => r.id === selected);

  async function remove(id: string) {
    const r = await apiDelete(api(id));
    if (r.ok) toast.success("Removed from REO. No files were deleted.");
    else toast.error(r.error || "Could not remove the repository.");
    again();
  }

  if (repo) return <Detail key={repo.id} repo={repo} onBack={() => setSelected(null)} onOpenPulls={onOpenPulls} />;

  return (
    <Page>
      <PageHeader
        title="Repositories"
        description="The git folders REO reads. REO does not commit, push or switch branches."
        actions={
          <>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus />
              Add repository
            </Button>
            <Button variant="outline" size="icon" aria-label="Refresh" onClick={again}>
              <RefreshCw />
            </Button>
          </>
        }
      />
      {loading && <TableSkeleton rows={3} />}
      {error && <EmptyState icon={FolderGit2} title="Could not load repositories" description={error} action={retryButton(again)} />}
      {data && data.repos.length === 0 && (
        <EmptyState
          icon={FolderGit2}
          title="No repositories yet"
          description="Add a git folder on this computer."
          action={
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus />
              Add repository
            </Button>
          }
        />
      )}
      {data && data.repos.length > 0 && (
        <ul className="divide-y rounded-2xl border">
          {data.repos.map((r) => (
            <li key={r.id} className="flex items-center gap-2 p-2">
              <button
                type="button"
                disabled={!r.exists || !r.isGit}
                onClick={() => setSelected(r.id)}
                className="hover:bg-muted focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-3 rounded-xl p-2 text-left outline-none focus-visible:ring-[3px] disabled:hover:bg-transparent"
              >
                <FolderGit2 className="size-5 shrink-0" />
                <span className="grid min-w-0 flex-1 gap-1">
                  <span className="text-sm font-medium break-all">{r.id}</span>
                  <span className="text-muted-foreground truncate font-mono text-xs">{r.path}</span>
                  <Status repo={r} />
                  {r.lastCommit && (
                    <span className="text-muted-foreground truncate text-xs">
                      {r.lastCommit.sha.slice(0, 8)} {r.lastCommit.subject} · {ago(r.lastCommit.date)}
                    </span>
                  )}
                  {r.error && <span className="text-destructive text-xs break-words">{r.error}</span>}
                </span>
                {r.exists && r.isGit && <ChevronRight className="size-4 shrink-0" />}
              </button>
              <Button variant="ghost" size="icon" aria-label={`Remove ${r.id} from REO`} title="Remove from REO" onClick={() => setRemoving(r)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {adding && <AddRepo repos={data?.repos ?? []} onClose={() => setAdding(false)} onAdded={again} />}
      <AlertDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.id} from REO?</AlertDialogTitle>
            <AlertDialogDescription>REO stops reading it. The folder and its files are not deleted.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removing) remove(removing.id);
                setRemoving(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
