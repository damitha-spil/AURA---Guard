// Saved step lists. A check is a dry run; running the steps needs a second, explicit confirm.
import * as React from "react";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/app/page";
import { apiGet, apiPost } from "@/lib/api";

interface StepList {
  id: string;
  name: string;
  createdAt: string;
  sourceRunId: string | null;
  steps: { action: string; args: string[] }[];
}

interface Replay {
  dryRun: boolean;
  ok: boolean;
  steps: { index: number; action: string; outcome: "pass" | "fail" | "refused" | "dry"; detail: string }[];
}

const OUTCOME = { pass: "Passed", fail: "Failed", refused: "Refused", dry: "Allowed" } as const;

export function SavedSteps({ reload }: { reload: number }) {
  const [lists, setLists] = React.useState<StepList[] | null>(null);
  const [error, setError] = React.useState("");
  const [results, setResults] = React.useState<Record<string, Replay>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<StepList | null>(null);

  React.useEffect(() => {
    apiGet<{ steps: StepList[] }>("/api/steps").then((r) => {
      if (r.ok) setLists(r.data.steps || []);
      else setError(r.error || "Could not load saved steps.");
    });
  }, [reload]);

  async function replay(list: StepList, real: boolean) {
    setBusy(list.id);
    const r = await apiPost<Replay>(`/api/steps/${encodeURIComponent(list.id)}/replay`, real ? { run: true } : {});
    setBusy(null);
    if (r.ok) setResults((prev) => ({ ...prev, [list.id]: r.data }));
    else toast.error(r.error || "Could not run the steps.");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Repeated steps</CardTitle>
        <CardDescription>Open a passed run to save its steps. The steps only read files and local information. No model is used.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
        {lists?.length === 0 && <EmptyState title="No saved steps yet" />}
        {lists?.map((list) => {
          const result = results[list.id];
          return (
            <div key={list.id} className="grid gap-2 rounded-2xl border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium break-words">{list.name}</div>
                  <div className="text-muted-foreground text-xs">
                    Saved {list.createdAt.slice(0, 10)} · steps: {list.steps.length}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => replay(list, false)}>Check only</Button>
                  <Button size="sm" disabled={busy !== null} onClick={() => setConfirm(list)}>Run steps</Button>
                </div>
              </div>
              <ol className="grid max-h-40 gap-1 overflow-auto font-mono text-xs">
                {list.steps.map((s, i) => (
                  <li key={i} className="break-all">{[s.action, ...s.args].join(" ")}</li>
                ))}
              </ol>
              {result && (
                <div className="grid gap-1 text-xs" role="status">
                  <div className="font-medium">
                    {result.dryRun ? (result.ok ? "Check only: all steps are allowed. Nothing was run." : "Check only: some steps are not allowed.") : result.ok ? "Run finished: all steps passed." : "Run finished: some steps did not pass."}
                  </div>
                  {result.steps.map((s) => (
                    <div key={s.index} className="flex flex-wrap items-center gap-2">
                      <Badge variant={s.outcome === "fail" || s.outcome === "refused" ? "destructive" : "secondary"}>{OUTCOME[s.outcome]}</Badge>
                      <span>Step {s.index + 1}: {s.detail}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run these steps?</AlertDialogTitle>
            <AlertDialogDescription>
              REO will run the {confirm?.steps.length} saved steps in "{confirm?.name}" on this computer. They only read.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) replay(confirm, true);
                setConfirm(null);
              }}
            >
              Run steps
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
