// Pieces of a chat reply beyond its text: approval cards, links to what REO created, and the live card
// of a background mission. Plain text only (no HTML rendering); buttons call back into the page.
import { Check, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createdKindLabel, createdView } from "@/lib/missions";
import type { ApprovalInfo, CreatedInfo, MissionInfo } from "@/lib/missions";

const STATE_WORD: Record<ApprovalInfo["state"], string> = { pending: "Waiting for you", approved: "Approved", declined: "Declined", expired: "Not answered in time" };

/** A generic Approve / Decline card. Nothing runs until Approve. */
export function ApprovalCardView({ card, onDecide }: { card: ApprovalInfo; onDecide: (id: string, approve: boolean) => void }) {
  const pending = card.state === "pending";
  return (
    <div className="bg-muted/40 flex flex-col gap-2 rounded-2xl border p-3 text-sm" role={pending ? "alertdialog" : "group"} aria-label={`Approval: ${card.title}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{card.title}</span>
        <Badge variant={pending ? "default" : card.state === "approved" ? "secondary" : "outline"}>{STATE_WORD[card.state]}</Badge>
      </div>
      <p className="text-muted-foreground text-xs break-all">{card.detail}</p>
      <p className="text-muted-foreground text-xs">REO asks before it does anything outside its own data. It does nothing until you approve.</p>
      {pending && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onDecide(card.id, true)}><Check /> Approve</Button>
          <Button size="sm" variant="outline" onClick={() => onDecide(card.id, false)}><X /> Decline</Button>
        </div>
      )}
    </div>
  );
}

/** What REO created for this answer, each as a button to the page that shows it. */
export function CreatedLinks({ items, onOpenView }: { items: CreatedInfo[]; onOpenView?: (v: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">Created in REO</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((c) => (
          <Badge key={`${c.kind}-${c.id}`} variant="outline" asChild className="max-w-full cursor-pointer">
            <button type="button" onClick={() => onOpenView?.(createdView(c.kind))} title={`Open ${createdKindLabel(c.kind)} list`}>
              <span className="truncate">{createdKindLabel(c.kind)}: {c.label || c.id}</span>
            </button>
          </Badge>
        ))}
      </div>
    </div>
  );
}

/** The live card of a running mission in its chat. */
export function MissionCard({ mission, onCancel, onDecide }: { mission: MissionInfo; onCancel: (id: string) => void; onDecide: (id: string, approve: boolean) => void }) {
  const last = mission.steps[mission.steps.length - 1];
  return (
    <div className="bg-muted/30 flex flex-col gap-2 rounded-2xl border p-3 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium"><Loader2 className="size-4 animate-spin" /> Mission running in the background</span>
        <Button size="sm" variant="outline" onClick={() => onCancel(mission.id)}>Cancel mission</Button>
      </div>
      <p className="text-muted-foreground text-xs break-words">{mission.title}</p>
      <ul className="text-muted-foreground space-y-1 text-xs">
        {mission.steps.slice(-6).map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">{s.label}</span>
            <Badge variant={s.status === "error" ? "destructive" : s.status === "done" ? "default" : "secondary"}>{s.status}</Badge>
          </li>
        ))}
        {!last && <li>Starting...</li>}
      </ul>
      {mission.approvals.map((a) => <ApprovalCardView key={a.id} card={a} onDecide={onDecide} />)}
      <p className="text-muted-foreground text-xs">You can open another chat or page. The answer is saved in this chat when it finishes. A restart of the app ends the mission.</p>
    </div>
  );
}
