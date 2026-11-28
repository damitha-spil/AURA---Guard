import * as React from "react";
import { Copy, ExternalLink, FileDiff, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { toast } from "sonner";
import { DiffView } from "@/components/app/diff-view";
import type { RepoDiff } from "@/lib/repos";
import type { WorkItem } from "@/lib/workitems";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { apiGet, apiPost } from "@/lib/api";
import { useDiffPrefs } from "@/lib/diff-prefs";
import { ago, safeUrl, type Pull, type PullSource } from "@/lib/pulls";

// The engine opens the link: the desktop window ignores window.open.
export async function openExternal(url: string) {
  const r = await apiPost("/api/open-external", { url });
  if (!r.ok) toast.error(r.error || "Could not open the link. Copy it instead.");
}

function StateIcon({ pull }: { pull: Pull }) {
  const [Icon, label, colour] =
    pull.state === "merged"
      ? [GitMerge, "Merged", "text-primary"]
      : pull.state === "closed"
        ? [GitPullRequestClosed, "Closed", "text-destructive"]
        : pull.draft
          ? [GitPullRequestDraft, "Draft", "text-muted-foreground"]
          : [GitPullRequest, "Open", "text-primary"];
  return (
    <span role="img" aria-label={label} title={label} className="mt-0.5 shrink-0">
      <Icon className={`size-4 ${colour}`} />
    </span>
  );
}

function Details({ pull }: { pull: Pull }) {
  const url = safeUrl(pull.url);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url!);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy");
    }
  }
  const when = (v: string | null) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toLocaleString() : "—");
  return (
    <div className="grid gap-4 px-4 pb-4">
      <dl className="divide-y rounded-2xl border text-sm">
        {[
          ["State", pull.draft && pull.state === "open" ? "open (draft)" : pull.state],
          ["Author", pull.author],
          ["From", pull.sourceBranch],
          ["Into", pull.targetBranch],
          ["Created", when(pull.createdAt)],
          ["Updated", when(pull.updatedAt)],
          ["Host", pull.host],
          ["Labels", pull.labels.join(", ") || "—"],
        ].map(([k, v]) => (
          <div key={k} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 p-3">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {url ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void openExternal(url)}>
              <ExternalLink />
              Open in browser
            </Button>
            <Button variant="outline" onClick={copy}>
              <Copy />
              Copy link
            </Button>
          </div>
          <p className="text-muted-foreground text-xs break-all">If nothing opens, copy the link into your browser. {url}</p>
        </>
      ) : (
        <p className="text-muted-foreground text-xs">There is no secure (https) link for this pull request.</p>
      )}
      <LinkedWorkItems pull={pull} />
      <Changes pull={pull} />
    </div>
  );
}

type PrDiffReply = RepoDiff & { source: "local" | "github-api" | "azure-api"; sourceNote: string };

/** The changes of one pull request, read when asked. Which source gave them is always shown. */
function Changes({ pull }: { pull: Pull }) {
  const { hideWhitespace } = useDiffPrefs();
  const [state, setState] = React.useState<{ busy: boolean; diff?: PrDiffReply; error?: string }>({ busy: false });
  // A different pull request, or a changed whitespace setting, must not show an older answer.
  React.useEffect(() => setState({ busy: false }), [pull.repoId, pull.number, hideWhitespace]);

  async function load() {
    setState({ busy: true });
    const r = await apiGet<PrDiffReply>(`/api/pulls/${encodeURIComponent(pull.repoId)}/${pull.number}/diff${hideWhitespace ? "?ignoreWhitespace=1" : ""}`);
    if (!r.ok || !r.data || !Array.isArray(r.data.files)) setState({ busy: false, error: r.error || "The engine did not return the changes." });
    else setState({ busy: false, diff: r.data });
  }

  return (
    <section className="grid gap-3" aria-label="Changes">
      <h3 className="text-sm font-semibold">Changes</h3>
      {!state.diff && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={state.busy}>
            <FileDiff />
            {state.busy ? "Reading changes..." : state.error ? "Try again" : "Show changes"}
          </Button>
          <span className="text-muted-foreground text-xs">Read only. Uses your local copy when it has the commits, otherwise the host.</span>
        </div>
      )}
      {state.error && (
        <p role="alert" className="border-destructive/50 rounded-2xl border p-3 text-xs break-words">
          {state.error}
        </p>
      )}
      {state.diff && (
        <>
          <p role="status" className="text-muted-foreground text-xs break-words">
            Source: {state.diff.source === "local" ? "your local repository" : state.diff.source === "github-api" ? "GitHub" : "Azure DevOps"}. {state.diff.sourceNote}
          </p>
          <DiffView diff={state.diff} focus={null} />
        </>
      )}
    </section>
  );
}

/** Azure DevOps work items linked to the pull request. */
function LinkedWorkItems({ pull }: { pull: Pull }) {
  const [state, setState] = React.useState<{ items?: WorkItem[]; error?: string }>({});
  React.useEffect(() => {
    if (pull.host !== "azure-devops") return;
    let cancelled = false;
    setState({});
    apiGet<unknown>(`/api/pulls/${encodeURIComponent(pull.repoId)}/${pull.number}/workitems`).then((r) => {
      if (cancelled) return;
      const items = (r.data as { items?: unknown } | undefined)?.items;
      if (!r.ok || !Array.isArray(items)) setState({ error: r.error || "The engine did not return work items." });
      else setState({ items: items as WorkItem[] });
    });
    return () => {
      cancelled = true;
    };
  }, [pull.repoId, pull.number, pull.host]);

  if (pull.host !== "azure-devops") return null;
  return (
    <section className="grid gap-2" aria-label="Linked work items">
      <h3 className="text-sm font-semibold">Work items</h3>
      {!state.items && !state.error && <p className="text-muted-foreground text-xs">Reading linked work items...</p>}
      {state.error && <p role="alert" className="text-xs break-words">{state.error}</p>}
      {state.items?.length === 0 && <p className="text-muted-foreground text-xs">No work items are linked to this pull request.</p>}
      {state.items && state.items.length > 0 && (
        <ul className="divide-y rounded-2xl border">
          {state.items.map((w) => {
            const url = safeUrl(w.url);
            return (
              <li key={w.id} className="flex items-start gap-2 p-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block break-words">{w.title}</span>
                  <span className="text-muted-foreground block text-xs">#{w.id} · {w.type} · {w.state}{w.assignedTo ? ` · ${w.assignedTo}` : ""}</span>
                </span>
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
    </section>
  );
}

export function SourceErrors({ sources }: { sources: PullSource[] }) {
  return (
    <ul className="grid gap-1">
      {sources.map((s) => (
        <li key={s.repoId} className="break-words">
          <span className="font-medium">{s.repoId}:</span> {s.error || "Could not read this repository."}
        </li>
      ))}
    </ul>
  );
}

export function PullList({ pulls, onShow }: { pulls: Pull[]; onShow: (p: Pull) => void }) {
  const { openPullsInApp } = useDiffPrefs();
  // Without a safe link there is nothing to open outside, so the details open here instead.
  const show = (p: Pull) => {
    const url = safeUrl(p.url);
    if (!openPullsInApp && url) void openExternal(url);
    else onShow(p);
  };
  return (
    <ul className="divide-y overflow-hidden rounded-2xl border">
      {pulls.map((p) => (
        <li key={`${p.repoId}/${p.id}`}>
          <button
            type="button"
            onClick={() => show(p)}
            className="hover:bg-muted focus-visible:ring-ring/50 flex w-full items-start gap-3 p-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-inset"
          >
            <StateIcon pull={p} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 text-sm font-medium break-words">{p.title}</span>
                {p.draft && <Badge variant="secondary">Draft</Badge>}
                {p.labels.map((l) => (
                  <Badge key={l} variant="outline">
                    {l}
                  </Badge>
                ))}
              </span>
              <span className="text-muted-foreground mt-0.5 block text-xs break-words">
                {p.repoId} #{p.number} · {p.author} · {p.sourceBranch} → {p.targetBranch}
              </span>
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {p.updatedAt ? ago(p.updatedAt) : `created ${ago(p.createdAt)}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PullSheet({ pull, onClose }: { pull: Pull | null; onClose: () => void }) {
  return (
    <Sheet open={pull !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle className="break-words">{pull?.title}</SheetTitle>
          <SheetDescription>{pull && `${pull.repoId} #${pull.number}`}</SheetDescription>
        </SheetHeader>
        {pull && <Details pull={pull} />}
      </SheetContent>
    </Sheet>
  );
}
