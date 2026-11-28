// The changed files as folders. Arrow keys move, Right and Left open and close a folder, Enter opens a file.
// Names are shown as React text only.
import * as React from "react";
import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import { allFolders, buildTree, visibleRows, type TreeFileInput } from "@/lib/diff-tree";
import { cn } from "@/lib/utils";

function Totals({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="diff-add-text">+{additions}</span> <span className="diff-del-text">-{deletions}</span>
    </span>
  );
}

export function DiffFileTree({ files, isViewed, onPick }: { files: readonly TreeFileInput[]; isViewed: (path: string) => boolean; onPick: (path: string) => void }) {
  const tree = React.useMemo(() => buildTree(files), [files]);
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(allFolders(tree)));
  const seen = React.useRef<Set<string>>(new Set(allFolders(tree)));
  const [active, setActive] = React.useState(0);
  const [focusNow, setFocusNow] = React.useState(false);
  const items = React.useRef<(HTMLDivElement | null)[]>([]);

  // A folder that appears later (a filter was cleared) starts open; ones the person closed stay closed.
  React.useEffect(() => {
    const fresh = allFolders(tree).filter((p) => !seen.current.has(p));
    if (!fresh.length) return;
    fresh.forEach((p) => seen.current.add(p));
    setOpen((o) => new Set([...o, ...fresh]));
  }, [tree]);

  const rows = React.useMemo(() => visibleRows(tree, open), [tree, open]);
  const at = Math.min(active, Math.max(0, rows.length - 1));

  React.useEffect(() => {
    if (focusNow) {
      items.current[at]?.focus();
      setFocusNow(false);
    }
  }, [focusNow, at]);

  const toggle = (path: string, to: boolean) =>
    setOpen((o) => {
      const next = new Set(o);
      if (to) next.add(path);
      else next.delete(path);
      return next;
    });
  const go = (i: number) => {
    setActive(Math.max(0, Math.min(rows.length - 1, i)));
    setFocusNow(true);
  };

  function onKeyDown(e: React.KeyboardEvent) {
    const row = rows[at];
    if (!row) return;
    const { node, depth } = row;
    const isDir = node.kind === "dir";
    switch (e.key) {
      case "ArrowDown": go(at + 1); break;
      case "ArrowUp": go(at - 1); break;
      case "Home": go(0); break;
      case "End": go(rows.length - 1); break;
      case "ArrowRight":
        if (isDir && !open.has(node.path)) toggle(node.path, true);
        else if (isDir && rows[at + 1] && rows[at + 1]!.depth > depth) go(at + 1);
        break;
      case "ArrowLeft":
        if (isDir && open.has(node.path)) toggle(node.path, false);
        else {
          for (let i = at - 1; i >= 0; i--) if (rows[i]!.depth < depth) { go(i); break; }
        }
        break;
      case "Enter":
      case " ":
        if (isDir) toggle(node.path, !open.has(node.path));
        else onPick(node.path);
        break;
      default: return;
    }
    e.preventDefault();
  }

  return (
    <div role="tree" aria-label="Changed files by folder" onKeyDown={onKeyDown} className="max-h-72 overflow-y-auto rounded-2xl border p-1">
      {rows.map(({ node, depth }, i) => {
        const isDir = node.kind === "dir";
        const expanded = isDir && open.has(node.path);
        return (
          <div
            key={`${node.kind}:${node.path}`}
            ref={(el) => { items.current[i] = el; }}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={isDir ? expanded : undefined}
            tabIndex={i === at ? 0 : -1}
            onFocus={() => setActive(i)}
            onClick={() => {
              setActive(i);
              if (isDir) toggle(node.path, !expanded);
              else onPick(node.path);
            }}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            className="hover:bg-muted focus-visible:ring-ring/50 flex cursor-pointer items-center gap-2 rounded-xl py-1 pr-2 outline-none focus-visible:ring-[3px]"
          >
            {isDir ? (expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />) : <span className="size-4 shrink-0" />}
            {isDir ? <Folder className="text-muted-foreground size-4 shrink-0" /> : <FileText className="text-muted-foreground size-4 shrink-0" />}
            <span className={cn("min-w-0 flex-1 truncate font-mono text-xs", !isDir && isViewed(node.path) && "text-muted-foreground line-through")} title={node.path}>
              {node.name}
              {isDir && <span className="text-muted-foreground"> ({node.files})</span>}
            </span>
            <Totals additions={node.additions} deletions={node.deletions} />
          </div>
        );
      })}
    </div>
  );
}
