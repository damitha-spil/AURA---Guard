// The plain daily digest of real defects. Dates are UTC, like the stored times.
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FetchedReport } from "@/components/app/report-view";

export function DailyDigest() {
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  return (
    <Card className="gap-3 p-4">
      <div className="grid gap-2 justify-self-start">
        <Label htmlFor="digest-date">Day (UTC)</Label>
        <Input id="digest-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      {date ? <FetchedReport url={`/api/defects/digest?date=${encodeURIComponent(date)}`} title="Digest" /> : <p className="text-muted-foreground text-xs">Pick a day.</p>}
      <p className="text-muted-foreground text-xs">Sample data is not counted.</p>
    </Card>
  );
}
