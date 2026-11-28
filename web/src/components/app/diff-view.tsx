// Read-only diff viewer. All repository text is rendered as React text, never as HTML.
import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { parsePatch, splitRows, type DiffLine } from "@/lib/diff";
import { LARGE_FILE_LINES, updateDiffPrefs, useDiffPrefs } from "@/lib/diff-prefs";
import type { DiffFile, RepoDiff } from "@/lib/repos";
import { cn } from "@/lib/utils";

/** Side by side needs two readable columns; below this width the viewer stacks. */
const SPLIT_MIN_WIDTH = 640;
/** Most lines drawn for one file before asking, so a huge patch cannot freeze the window. */
const LINE_CAP = 2000;

export function Counts({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="diff-add-text">+{additions ?? "—"}</span> <span className="diff-del-text">-{deletions ?? "—"}</span>
    </span>
  );
}

const tint = (l: DiffLine | null) =>
  l?.kind === "add" ? "diff-add-line" : l?.kind === "del" ? "diff-del-line" : l?.kind === "hunk" ? "bg-muted text-muted-foreground" : l?.kind === "meta" ? "text-muted-foreground" : "";

const Num = ({ n }: { n: number | null }) => <span className="text-muted-foreground w-10 shrink-0 pr-2 text-right select-none">{n ?? ""}</span>;

function Cell({ line, side }: { line: DiffLine | null; side: "old" | "new" }) {
  return (
    <div className={cn("flex min-w-0", tint(line), !line && "bg-muted/40")}>
      <Num n={line ? (side === "old" ? line.oldNo : line.newNo) : null} />
      <code className="min-w-0 flex-1">{line?.text || " "}</code>
    </div>
  );
}

function Patch({ patch, split }: { patch: string; split: boolean }) {
  const lines = React.useMemo(() => parsePatch(patch), [patch]);
  const [all, setAll] = React.useState(false);
  const shown = all ? lines : lines.slice(0, LINE_CAP);
  return (
    <>
      <pre className="diff-scroll overflow-x-auto py-1 font-mono text-xs">
        {split ? (
          // Both columns must stay in view, so side by side always wraps.
          <div className="break-all whitespace-pre-wrap">
            {splitRows(shown).map((r, i) =>
              "full" in r ? (
                <div key={i} className={cn("px-2", tint(r.full))}>
                  <code>{r.full.text}</code>
                </div>
              ) : (
                <div key={i} className="grid grid-cols-2 divide-x">
                  <Cell line={r.left} side="old" />
                  <Cell line={r.right} side="new" />
                </div>
              ),
            )}
          </div>
        ) : (
          <div className="diff-lines">
            {shown.map((l, i) => (
              <div key={i} className={cn("flex", tint(l))}>
                <Num n={l.oldNo} />
                <Num n={l.newNo} />
                <code className="min-w-0 flex-1 pr-2">{l.text || " "}</code>
              </div>
            ))}
          </div>
        )}
      </pre>
      {shown.length < lines.length && (
        <Button variant="ghost" size="sm" className="m-1" onClick={() => setAll(true)}>
          Show all {lines.length} lines
        </Button>
      )}
    </>
  );
}

export const fileAnchor = (path: string) => `diff-file-${path}`;

function FileCard({ file, open, onToggle, split }: { file: DiffFile; open: boolean; onToggle: () => void; split: boolean }) {
  return (
    <div id={fileAnchor(file.path)} className="min-w-0 overflow-hidden rounded-2xl border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="bg-muted/60 focus-visible:ring-ring/50 flex w-full items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-inset"
      >
        {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1 font-mono text-xs break-all">{file.path}</span>
        <Badge variant="outline">{file.status}</Badge>
        <Counts additions={file.additions} deletions={file.deletions} />
      </button>
      {open &&
        (file.withheld ? (
          <p className="text-muted-foreground p-3 text-xs">
            {typeof file.withheld === "string" ? file.withheld : "The content of this file is withheld."}
          </p>
        ) : file.patch ? (
          <Patch patch={file.patch} split={split} />
        ) : (
          <p className="text-muted-foreground p-3 text-xs">No text changes to show.</p>
        ))}
    </div>
  );
}

export function DiffView({ diff, focus }: { diff: RepoDiff; focus: { path: string; n: number } | null }) {
  const prefs = useDiffPrefs();
  const box = React.useRef<HTMLDivElement>(null);
  const [wide, setWide] = React.useState(true);
  // Files the person opened or closed by hand; the rest follow the setting.
  const [overrides, setOverrides] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= SPLIT_MIN_WIDTH));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => setOverrides({}), [prefs.files]);

  React.useEffect(() => {
    if (!focus) return;
    setOverrides((o) => ({ ...o, [focus.path]: true }));
    const t = window.setTimeout(() => document.getElementById(fileAnchor(focus.path))?.scrollIntoView({ block: "start" }), 0);
    return () => window.clearTimeout(t);
  }, [focus]);

  const isOpen = (f: DiffFile) =>
    overrides[f.path] ?? (prefs.files === "expanded" && (f.patch?.split("\n").length ?? 0) <= LARGE_FILE_LINES);
  const setAll = (open: boolean) => setOverrides(Object.fromEntries(diff.files.map((f) => [f.path, open])));

  return (
    <div ref={box} data-diff-colors={prefs.colors} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span>
          {diff.files.length} file{diff.files.length === 1 ? "" : "s"}
        </span>
        <Counts additions={diff.additions} deletions={diff.deletions} />
        <div role="group" aria-label="Diff layout" className="bg-muted flex gap-0.5 rounded-2xl p-[3px]">
          {(["stacked", "split"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={prefs.layout === v}
              onClick={() => updateDiffPrefs({ layout: v })}
              className={cn(
                "focus-visible:ring-ring/50 rounded-xl px-2.5 py-0.5 text-xs font-medium outline-none focus-visible:ring-[3px]",
                prefs.layout === v ? "bg-background shadow-xs" : "text-muted-foreground",
              )}
            >
              {v === "stacked" ? "Stacked" : "Side by side"}
            </button>
          ))}
        </div>
        <Label className="flex items-center gap-2 text-xs">
          <Switch checked={prefs.hideWhitespace} onCheckedChange={(hideWhitespace) => updateDiffPrefs({ hideWhitespace })} />
          Hide whitespace
        </Label>
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
            Expand all
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAll(false)}>
            Collapse all
          </Button>
        </span>
      </div>
      {prefs.layout === "split" && !wide && <p className="text-muted-foreground text-xs">Too narrow for side by side, so lines are stacked.</p>}
      {diff.truncated && <p className="bg-muted rounded-2xl p-3 text-xs">This diff was cut short. Some changes are not shown.</p>}
      {diff.files.length === 0 && <p className="text-muted-foreground rounded-2xl border border-dashed p-6 text-center text-sm">No changes between these.</p>}
      {diff.files.length > 1 && (
        <ul className="max-h-56 overflow-y-auto rounded-2xl border p-1" aria-label="Changed files">
          {diff.files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => {
                  setOverrides((o) => ({ ...o, [f.path]: true }));
                  window.setTimeout(() => document.getElementById(fileAnchor(f.path))?.scrollIntoView({ block: "start" }), 0);
                }}
                className="hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-xl px-2 py-1 text-left outline-none focus-visible:ring-[3px]"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
                <Counts additions={f.additions} deletions={f.deletions} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {diff.files.map((f) => (
        <FileCard
          key={f.path}
          file={f}
          open={isOpen(f)}
          onToggle={() => setOverrides((o) => ({ ...o, [f.path]: !isOpen(f) }))}
          split={prefs.layout === "split" && wide}
        />
      ))}
    </div>
  );
}
