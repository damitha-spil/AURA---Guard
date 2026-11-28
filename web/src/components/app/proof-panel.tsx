// The proof a change needs, shown next to a review or a QA run. Text comes from the engine.
import { Badge } from "@/components/ui/badge";
import type { Evidence } from "@/lib/repos";

const SCOPE = { app: "App or user flow", service: "Service only", "docs-tool": "Docs or developer tool", unknown: "Unknown" } as const;

export function ProofPanel({ evidence, note }: { evidence: Evidence; note: string }) {
  return (
    <section aria-label="Proof" className="grid gap-2 rounded-2xl border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Proof</span>
        <Badge variant={evidence.status === "complete" ? "default" : evidence.status === "blocked" ? "destructive" : "secondary"}>{evidence.status}</Badge>
        <span className="text-muted-foreground">{evidence.kinds.map((k) => SCOPE[k]).join(" + ")}</span>
      </div>
      <ul className="grid gap-1">
        {evidence.items.map((i) => (
          <li key={i.id} className="break-words">
            <span className="font-medium">{i.state === "present" ? "Present" : "Missing"}:</span> {i.label}
            {i.detail && <span className="text-muted-foreground"> ({i.detail})</span>}
          </li>
        ))}
        {evidence.blockers.map((b) => (
          <li key={b} className="text-destructive break-words">Blocked: {b}</li>
        ))}
        {evidence.rejected.map((r) => (
          <li key={r} className="break-words">Not counted: {r}</li>
        ))}
      </ul>
      <p className="text-muted-foreground">{note} Previews, mock data, sample screens and test counts never prove a user flow.</p>
    </section>
  );
}
