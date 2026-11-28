// The simple and technical views of one report. Both are made by the engine and shown as plain text.
import * as React from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiGet } from "@/lib/api";
import type { RenderedReport, ReportViewName } from "@/lib/repos";

function ViewToggle({ view, onView }: { view: ReportViewName; onView: (v: ReportViewName) => void }) {
  return (
    <Tabs value={view} onValueChange={(v) => onView(v as ReportViewName)}>
      <TabsList aria-label="Report view">
        <TabsTrigger value="simple">Simple</TabsTrigger>
        <TabsTrigger value="technical">Technical</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function Body({ report }: { report: RenderedReport }) {
  const text = report.format === "text" ? report.body : JSON.stringify(report.body, null, 2);
  return <pre className="bg-muted max-h-96 overflow-auto rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap">{text}</pre>;
}

/** Both views are already here, so switching asks the engine nothing. */
export function ReportViews({ reports }: { reports: Record<ReportViewName, RenderedReport> }) {
  const [view, setView] = React.useState<ReportViewName>("simple");
  return (
    <section aria-label="Report" className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Report</h3>
        <ViewToggle view={view} onView={setView} />
      </div>
      <Body report={reports[view]} />
    </section>
  );
}

/** Reads the report from a GET address that takes ?view=. Reading again changes nothing. */
export function FetchedReport({ url, title = "Report" }: { url: string; title?: string }) {
  const [view, setView] = React.useState<ReportViewName>("simple");
  const [state, setState] = React.useState<{ key: string; report?: RenderedReport; error?: string } | null>(null);
  const key = `${url}${url.includes("?") ? "&" : "?"}view=${view}`;

  React.useEffect(() => {
    let live = true;
    apiGet<{ report?: RenderedReport }>(key).then((r) => {
      if (!live) return;
      setState(r.ok && r.data.report ? { key, report: r.data.report } : { key, error: r.error || "Could not load the report." });
    });
    return () => {
      live = false;
    };
  }, [key]);

  const current = state?.key === key ? state : null;
  return (
    <section aria-label={title} className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <ViewToggle view={view} onView={setView} />
      </div>
      {!current && <p className="text-muted-foreground text-xs">Loading...</p>}
      {current?.error && <p role="alert" className="text-destructive text-xs">{current.error}</p>}
      {current?.report && <Body report={current.report} />}
    </section>
  );
}
