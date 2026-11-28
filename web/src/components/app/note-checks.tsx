// Notes that read nearly the same, and notes nobody has reviewed for a while. Nothing here changes a note.
import * as React from "react";
import { Check, FileText } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, IconRow } from "@/components/app/page";
import { apiGet } from "@/lib/api";

interface Hygiene {
  threshold: number;
  outdatedAfterDays: number;
  duplicates: { a: string; b: string; overlap: number }[];
  outdated: { id: string; lastUpdated: string; ageDays: number }[];
}

export function NoteChecks({ titleOf, onOpen }: { titleOf: (id: string) => string; onOpen: (id: string, title: string) => void }) {
  const [data, setData] = React.useState<Hygiene | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    apiGet<Hygiene>("/api/notes/hygiene").then((r) => {
      if (r.ok && Array.isArray(r.data.duplicates)) setData(r.data);
      else setError(r.error || "Could not check the notes.");
    });
  }, []);

  if (error) return <EmptyState title="Note checks unavailable" description={error} />;
  if (!data) return <Skeleton className="h-40 w-full" />;
  const open = (id: string) => () => onOpen(id, titleOf(id));
  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-xs">These checks only read your notes. You decide what to change.</p>
      <Card className="gap-2 p-4">
        <h3 className="text-sm font-medium">Look-alike notes ({data.duplicates.length})</h3>
        <p className="text-muted-foreground text-xs">
          At least {Math.round(data.threshold * 100)}% of the shorter note's words are in the other one. Select a note to read it.
        </p>
        {data.duplicates.length === 0 && <EmptyState icon={Check} title="No look-alike notes found" />}
        {data.duplicates.map((p) => (
          <div key={`${p.a}|${p.b}`} className="grid gap-1 rounded-2xl border p-2 sm:grid-cols-2">
            <IconRow icon={FileText} title={titleOf(p.a)} subtitle={p.a} onClick={open(p.a)} />
            <IconRow icon={FileText} title={titleOf(p.b)} subtitle={p.b} right={`${Math.round(p.overlap * 100)}%`} onClick={open(p.b)} />
          </div>
        ))}
      </Card>
      <Card className="gap-2 p-4">
        <h3 className="text-sm font-medium">Old notes ({data.outdated.length})</h3>
        <p className="text-muted-foreground text-xs">Not reviewed for more than {data.outdatedAfterDays} days. If a note was never reviewed, its created date is used.</p>
        {data.outdated.length === 0 && <EmptyState icon={Check} title="No old notes found" />}
        {data.outdated.map((n) => (
          <IconRow key={n.id} icon={FileText} title={titleOf(n.id)} subtitle={`Last date: ${n.lastUpdated}`} right={`${n.ageDays} days`} onClick={open(n.id)} />
        ))}
      </Card>
    </div>
  );
}
