// "Add repository": a command-palette picker. Step 1 chooses a source, step 2 chooses a folder,
// step 3 names it. Focus stays in the top box; arrows move through the rows below it.
import * as React from "react";
import { ArrowLeft, ChevronRight, Folder, FolderGit2, FolderPlus, HardDrive, Home, LoaderCircle, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { apiGet, apiPost } from "@/lib/api";
import type { FolderListing, Repo } from "@/lib/repos";
import { cn } from "@/lib/utils";

type Step = "sources" | "folder";

/** Ways to add a repository. A new kind needs one entry here and its own step. */
const SOURCES: { step: Step; title: string; subtitle: string; icon: typeof Folder }[] = [
  { step: "folder", title: "Local folder", subtitle: "Browse a folder on disk", icon: FolderPlus },
];

interface Item {
  key: string;
  title: string;
  subtitle?: string;
  icon: typeof Folder;
  badge?: string;
  added?: boolean;
  heading?: string;
  /** Enter or click. Missing when the row cannot be chosen. */
  run?: () => void;
  /** Look inside a repository folder instead of choosing it. */
  browse?: () => void;
}

const looksLikePath = (v: string) => /^([A-Za-z]:([\\/]|$)|\/|\\\\)/.test(v.trim());
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** The name the engine will choose when the box is left empty. */
function defaultName(path: string, taken: Set<string>): string {
  const base = baseName(path).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "").slice(0, 50) || "repo";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** Each part of a path with the path up to it. */
function crumbs(path: string): { label: string; path: string }[] {
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter(Boolean);
  const rooted = path.startsWith("/");
  const list = parts.map((label, i) => {
    const joined = (rooted ? "/" : "") + parts.slice(0, i + 1).join(sep);
    return { label, path: i === 0 && !rooted ? joined + sep : joined };
  });
  return rooted ? [{ label: "/", path: "/" }, ...list] : list;
}

const Key = ({ children }: { children: React.ReactNode }) => <kbd className="bg-muted rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium">{children}</kbd>;

export function AddRepo({ repos, onClose, onAdded }: { repos: Repo[]; onClose: () => void; onAdded: () => void }) {
  const [step, setStep] = React.useState<Step | "sources">("sources");
  const [location, setLocation] = React.useState<string | null>(null);
  const [chosen, setChosen] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [name, setName] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [listing, setListing] = React.useState<{ key: string; data?: FolderListing; error?: string } | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const input = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();

  const wanted = `${location ?? ""}#${attempt}`;
  React.useEffect(() => {
    if (step !== "folder") return;
    let cancelled = false;
    apiGet<FolderListing>(`/api/repos/browse?path=${encodeURIComponent(location ?? "")}`).then((r) => {
      if (cancelled) return;
      const ok = r.ok && Array.isArray(r.data.entries) && Array.isArray(r.data.suggestions);
      setListing(ok ? { key: wanted, data: r.data } : { key: wanted, error: r.error || "That folder could not be opened." });
    });
    return () => {
      cancelled = true;
    };
  }, [step, location, wanted]);
  const current = listing?.key === wanted ? listing : null;

  React.useEffect(() => {
    input.current?.focus();
  }, [step, chosen]);

  function show(next: string | null) {
    setLocation(next);
    setQuery("");
    setActive(0);
    setError("");
  }

  function choose(path: string) {
    setChosen(path);
    setName("");
    setError("");
  }

  const canGoBack = step !== "sources";
  function back() {
    setError("");
    setActive(0);
    if (chosen !== null) {
      setChosen(null);
    } else if (location !== null) {
      // At the top of a drive there is no parent, so back returns to the starting places.
      show(current?.data ? current.data.parent : null);
    } else {
      setStep("sources");
      setQuery("");
    }
  }

  async function add() {
    if (!chosen || busy) return;
    setBusy(true);
    setError("");
    const r = await apiPost("/api/repos", { path: chosen, ...(name.trim() ? { id: name.trim() } : {}) });
    setBusy(false);
    if (!r.ok) return setError(r.error || "Could not add the repository.");
    toast.success("Repository added");
    onAdded();
    onClose();
  }

  const filter = query.trim().toLowerCase();
  const typedPath = step === "folder" && looksLikePath(query);
  const items: Item[] = [];
  if (chosen === null && step === "sources") {
    for (const s of SOURCES.filter((x) => `${x.title} ${x.subtitle}`.toLowerCase().includes(filter))) {
      items.push({ key: s.step, title: s.title, subtitle: s.subtitle, icon: s.icon, heading: "Sources", run: () => { setStep(s.step); show(null); } });
    }
  } else if (chosen === null && typedPath) {
    items.push({ key: "jump", title: "Go to this folder", subtitle: query.trim(), icon: ChevronRight, run: () => { const p = query.trim(); show(/^[A-Za-z]:$/.test(p) ? `${p}\\` : p); setAttempt((n) => n + 1); } });
  } else if (chosen === null && current?.data) {
    const d = current.data;
    if (d.path === null) {
      for (const s of d.suggestions.filter((x) => `${x.name} ${x.path}`.toLowerCase().includes(filter))) {
        items.push({
          key: s.path,
          title: s.name,
          subtitle: s.kind === "projects" ? `Holds a repository you added · ${s.path}` : s.path,
          icon: s.kind === "home" ? Home : s.kind === "drive" ? HardDrive : Folder,
          heading: "Start from",
          run: () => show(s.path),
        });
      }
    } else {
      if (d.isGit && !filter) {
        items.push({ key: "this", title: "Use this folder", subtitle: d.path, icon: FolderGit2, badge: "Git", added: d.added, run: d.added ? undefined : () => choose(d.path!) });
      }
      for (const e of d.entries.filter((x) => x.name.toLowerCase().includes(filter))) {
        items.push({
          key: e.path,
          title: e.name,
          icon: e.isGit ? FolderGit2 : Folder,
          badge: e.isGit ? "Git" : undefined,
          added: e.added,
          heading: "Folders",
          run: e.added ? undefined : e.isGit ? () => choose(e.path) : () => show(e.path),
          browse: e.isGit ? () => show(e.path) : undefined,
        });
      }
    }
  }
  const index = Math.min(active, Math.max(0, items.length - 1));
  const rowId = (i: number) => `${listId}-${i}`;

  React.useEffect(() => {
    document.getElementById(rowId(index))?.scrollIntoView({ block: "nearest" });
  });

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    const value = e.currentTarget.value;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) setActive((index + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (chosen !== null) add();
      else items[index]?.run?.();
    } else if (e.key === "ArrowRight" && chosen === null && e.currentTarget.selectionStart === value.length && items[index]?.browse) {
      e.preventDefault();
      items[index].browse!();
    } else if (e.key === "Backspace" && value === "" && canGoBack) {
      e.preventDefault();
      // A held key stops at the empty box instead of running back through every folder.
      if (!e.repeat) back();
    }
  }

  const loading = step === "folder" && chosen === null && !typedPath && !current;
  const placeholder = chosen !== null ? "Short name (optional)" : step === "folder" ? "Filter folders, or paste a full path" : "Search...";
  const taken = new Set([...repos.map((r) => r.id), "vault"]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="top-[12vh] flex max-h-[76vh] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Add repository</DialogTitle>
        <DialogDescription className="sr-only">Choose a git folder on this computer. REO reads it and does not change it.</DialogDescription>

        <div className="flex items-center gap-2 border-b px-3 py-2">
          {canGoBack ? (
            <Button variant="ghost" size="icon" className="size-8" aria-label="Back" onClick={() => { back(); input.current?.focus(); }}>
              <ArrowLeft />
            </Button>
          ) : (
            <span className="flex size-8 items-center justify-center">
              <Search className="text-muted-foreground size-4" />
            </span>
          )}
          <input
            ref={input}
            autoFocus
            value={chosen !== null ? name : query}
            onChange={(e) => {
              setError("");
              if (chosen !== null) setName(e.target.value);
              else {
                setQuery(e.target.value);
                setActive(0);
              }
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={placeholder}
            role={chosen === null ? "combobox" : undefined}
            aria-expanded={chosen === null ? true : undefined}
            aria-controls={chosen === null ? listId : undefined}
            aria-activedescendant={chosen === null && items.length ? rowId(index) : undefined}
            spellCheck={false}
            autoComplete="off"
            className="placeholder:text-muted-foreground h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          {(loading || busy) && <LoaderCircle className="text-muted-foreground size-4 shrink-0 animate-spin" />}
        </div>

        {step === "folder" && (
          <nav aria-label="Current folder" className="flex flex-wrap items-center gap-x-0.5 border-b px-4 py-2 text-xs">
            <button type="button" onClick={() => { setChosen(null); show(null); input.current?.focus(); }} className="hover:bg-muted focus-visible:ring-ring/50 rounded-md px-1.5 py-0.5 outline-none focus-visible:ring-[3px]">
              Start
            </button>
            {crumbs(chosen ?? location ?? "").map((c) => (
              <React.Fragment key={c.path}>
                <ChevronRight className="text-muted-foreground size-3" />
                <button type="button" onClick={() => { setChosen(null); show(c.path); input.current?.focus(); }} className="hover:bg-muted focus-visible:ring-ring/50 max-w-40 truncate rounded-md px-1.5 py-0.5 outline-none focus-visible:ring-[3px]">
                  {c.label}
                </button>
              </React.Fragment>
            ))}
          </nav>
        )}

        <div
          key={`${step} ${location} ${chosen}`}
          className="animate-in fade-in-0 slide-in-from-right-2 motion-reduce:animate-none min-h-0 flex-1 overflow-y-auto p-2 duration-150"
        >
          {chosen !== null ? (
            <div className="grid gap-3 p-2">
              <div className="bg-muted flex items-start gap-3 rounded-2xl p-3">
                <FolderGit2 className="text-primary mt-0.5 size-5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium break-all">{baseName(chosen)}</div>
                  <div className="text-muted-foreground font-mono text-xs break-all">{chosen}</div>
                </div>
              </div>
              <p className="text-muted-foreground text-xs">
                It will be called <span className="text-foreground font-medium break-all">{name.trim() || defaultName(chosen, taken)}</span>. Type above to
                change that. REO only reads the folder.
              </p>
              {error && (
                <p role="alert" className="border-destructive/50 text-destructive rounded-2xl border p-3 text-xs break-words">
                  {error}
                </p>
              )}
              <Button onClick={add} disabled={busy} className="justify-self-end">
                <FolderPlus />
                {busy ? "Adding..." : "Add repository"}
              </Button>
            </div>
          ) : (
            <>
              {current?.error && !typedPath && (
                <div role="alert" className="grid justify-items-start gap-2 p-3 text-sm">
                  <span className="text-destructive break-words">{current.error}</span>
                  <Button variant="outline" size="sm" onClick={() => { show(null); input.current?.focus(); }}>
                    Back to start
                  </Button>
                </div>
              )}
              <div id={listId} role="listbox" aria-label={step === "folder" ? "Folders" : "Sources"}>
                {items.map((item, i) => (
                  <React.Fragment key={item.key}>
                    {item.heading && item.heading !== items[i - 1]?.heading && (
                      <div role="presentation" className="text-muted-foreground px-3 pt-2 pb-1 text-xs">
                        {item.heading}
                      </div>
                    )}
                    <div
                      id={rowId(i)}
                      role="option"
                      aria-selected={i === index}
                      aria-disabled={!item.run}
                      onMouseMove={() => i !== index && setActive(i)}
                      onClick={() => { item.run?.(); input.current?.focus(); }}
                      className={cn("flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2", i === index && "bg-accent", !item.run && "cursor-default")}
                    >
                      <item.icon className={cn("size-4 shrink-0", item.badge ? "text-primary" : "text-muted-foreground", !item.run && "opacity-50")} />
                      <span className={cn("min-w-0 flex-1", !item.run && "opacity-60")}>
                        <span className="block truncate text-sm font-medium">{item.title}</span>
                        {item.subtitle && <span className="text-muted-foreground block truncate text-xs">{item.subtitle}</span>}
                      </span>
                      {item.badge && <Badge className="shrink-0">{item.badge}</Badge>}
                      {item.added && (
                        <Badge variant="outline" className="shrink-0">
                          Already added
                        </Badge>
                      )}
                      {item.browse && (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={`Open ${item.title}`}
                          title="Look inside"
                          onClick={(e) => {
                            e.stopPropagation();
                            item.browse!();
                            input.current?.focus();
                          }}
                          className="hover:bg-background shrink-0 rounded-md p-1"
                        >
                          <ChevronRight className="size-4" />
                        </button>
                      )}
                    </div>
                  </React.Fragment>
                ))}
              </div>
              {!loading && !current?.error && items.length === 0 && (
                <p className="text-muted-foreground p-4 text-center text-sm">{filter ? "Nothing matches." : "No folders in here."}</p>
              )}
              {loading && step === "folder" && <p className="text-muted-foreground p-4 text-center text-sm">Reading folders...</p>}
              {current?.data?.truncated && !typedPath && (
                <p className="text-muted-foreground p-3 text-xs">Only some folders are shown. Paste the full path to reach another one.</p>
              )}
            </>
          )}
        </div>

        <div className="bg-muted/50 text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs">
          {chosen === null && (
            <span className="flex items-center gap-1">
              <Key>↑</Key>
              <Key>↓</Key> Navigate
            </span>
          )}
          <span className="flex items-center gap-1">
            <Key>Enter</Key> {chosen !== null ? "Add" : "Select"}
          </span>
          {items[index]?.browse && (
            <span className="flex items-center gap-1">
              <Key>→</Key> Look inside
            </span>
          )}
          {canGoBack && (
            <span className="flex items-center gap-1">
              <Key>Backspace</Key> Back
            </span>
          )}
          <span className="flex items-center gap-1">
            <Key>Esc</Key> Close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
