// First-run checklist: provider, repository, index, health. Shown in an empty chat until all four are done
// or the person closes it (remembered on this computer). Each row opens the page where it is fixed.
import * as React from "react";
import { Check, Circle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api";

const KEY = "reo.onboarding.dismissed";
interface Item { id: string; label: string; done: boolean; tab: string }

export function OnboardingChecklist({ onOpenSettings }: { onOpenSettings: (tab: string) => void }) {
  const [items, setItems] = React.useState<Item[] | null>(null);
  const [hidden, setHidden] = React.useState(() => {
    try { return window.localStorage.getItem(KEY) === "1"; } catch { return false; }
  });
  React.useEffect(() => {
    if (hidden) return;
    let stop = false;
    void (async () => {
      const [b, r, s, h] = await Promise.all([
        apiGet<{ picked: string | null }>("/api/brain"),
        apiGet<{ repos: unknown[] }>("/api/repos"),
        apiGet<{ index: Record<string, number> | null }>("/api/status"),
        apiGet<{ rows: { status: string }[] }>("/api/health"),
      ]);
      if (stop) return;
      setItems([
        { id: "provider", label: "Pick a model provider", done: b.ok && !!b.data.picked, tab: "providers" },
        { id: "repo", label: "Add a repository", done: r.ok && (r.data.repos?.length ?? 0) > 0, tab: "index" },
        { id: "index", label: "Build the index", done: s.ok && !!s.data.index && Object.keys(s.data.index).length > 0, tab: "index" },
        { id: "health", label: "Run the health check with no failures", done: h.ok && (h.data.rows?.length ?? 0) > 0 && !h.data.rows.some((x) => x.status === "fail"), tab: "health" },
      ]);
    })();
    return () => { stop = true; };
  }, [hidden]);
  if (hidden || !items || items.every((i) => i.done)) return null;
  const close = (): void => {
    try { window.localStorage.setItem(KEY, "1"); } catch { /* private mode */ }
    setHidden(true);
  };
  return (
    <div className="bg-muted/40 mx-auto w-full max-w-xl rounded-2xl border p-4 text-sm" aria-label="Getting started">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Getting started</span>
        <Button size="icon-sm" variant="ghost" aria-label="Hide the checklist" onClick={close}><X /></Button>
      </div>
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              {i.done ? <Check className="size-4 text-emerald-600" /> : <Circle className="text-muted-foreground size-4" />}
              <span className={i.done ? "text-muted-foreground line-through" : ""}>{i.label}</span>
            </span>
            {!i.done && <Button size="sm" variant="outline" onClick={() => onOpenSettings(i.tab)}>Open</Button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
