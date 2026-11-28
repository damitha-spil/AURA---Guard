// Missions: background runs of the agent loop. They keep going while you use other pages or chats, and end
// when the engine restarts. One per chat, two at once. Each writes its answer into its chat when it ends.
import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, Page, PageHeader } from "@/components/app/page";
import { ApprovalCardView, CreatedLinks } from "@/components/app/chat-extras";
import { apiGet, apiPost } from "@/lib/api";
import { MAX_MISSIONS_RUNNING } from "@/lib/missions";
import type { MissionInfo } from "@/lib/missions";

const WORD: Record<MissionInfo["status"], string> = { running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" };

export function MissionsView({ onOpenChat, onOpenView }: { onOpenChat: (id: string) => void; onOpenView: (v: string) => void }) {
  const [missions, setMissions] = React.useState<MissionInfo[] | null>(null);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    const r = await apiGet<{ missions: MissionInfo[] }>("/api/missions");
    if (r.ok) { setMissions(r.data.missions || []); setError(""); }
    else setError(r.error || "Could not load missions.");
  }, []);
  React.useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [load]);

  async function cancel(id: string) {
    const r = await apiPost(`/api/missions/${id}/cancel`, {});
    if (!r.ok) toast.error(r.error || "Could not cancel.");
    void load();
  }
  async function decide(id: string, approve: boolean) {
    const r = await apiPost(`/api/approvals/${id}`, { approve });
    if (!r.ok) toast.error(r.error || "That card is not waiting any more.");
    void load();
  }

  const running = (missions ?? []).filter((m) => m.status === "running").length;
  return (
    <Page>
      <PageHeader title="Missions" description={`Background runs of agent mode. ${running} of ${MAX_MISSIONS_RUNNING} running. A mission ends if the app restarts.`} />
      {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
      {missions && missions.length === 0 && (
        <EmptyState title="No missions yet" description="In a chat, turn Agent on and use Run as mission. It keeps working while you do something else." />
      )}
      <div className="space-y-3">
        {(missions ?? []).map((m) => (
          <Card key={m.id} className="space-y-2 p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant={m.status === "running" ? "default" : m.status === "done" ? "secondary" : "outline"}>{WORD[m.status]}</Badge>
                <span className="min-w-0 truncate font-medium">{m.title}</span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => onOpenChat(m.chatId)}>Open chat</Button>
                {m.status === "running" && <Button size="sm" variant="outline" onClick={() => void cancel(m.id)}>Cancel</Button>}
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              Started {new Date(m.startedAt).toLocaleTimeString()} · {m.steps.length} step{m.steps.length === 1 ? "" : "s"}
              {m.steps.length > 0 && ` · last: ${m.steps[m.steps.length - 1]!.label}`}
            </p>
            {m.summary && m.status !== "running" && <p className="text-muted-foreground text-xs break-words">{m.summary}</p>}
            <CreatedLinks items={m.created} onOpenView={onOpenView} />
            {m.approvals.map((a) => <ApprovalCardView key={a.id} card={a} onDecide={decide} />)}
          </Card>
        ))}
      </div>
    </Page>
  );
}
