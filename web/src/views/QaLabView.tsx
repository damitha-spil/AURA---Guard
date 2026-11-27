import * as React from "react";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Page, PageHeader, ResultView } from "@/components/app/page";
import { apiGet, apiPost } from "@/lib/api";

export function QaLabView() {
  const [tab, setTab] = React.useState("crawler");
  const [matchTitle, setMatchTitle] = React.useState("AURA");
  const [baseUrl, setBaseUrl] = React.useState("http://127.0.0.1:4310");
  const [specText, setSpecText] = React.useState("");
  const [output, setOutput] = React.useState<unknown>(null);
  const [outputTitle, setOutputTitle] = React.useState("Result");
  const [busy, setBusy] = React.useState(false);

  async function run(title: string, fn: () => Promise<{ ok: boolean; data: unknown; error?: string }>) {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    setOutputTitle(title);
    setOutput(r.ok ? r.data : { error: r.error || "Request failed", details: r.data });
    if (r.ok) toast.success(`${title} finished`);
    else toast.error(r.error || `${title} failed`);
  }

  const Run = ({ label, onClick, variant, disabled }: { label: string; onClick: () => void; variant?: "outline"; disabled?: boolean }) => (
    <Button className="w-full" variant={variant} disabled={busy || disabled} onClick={onClick}>
      {busy ? <Loader2 className="animate-spin" /> : <Play />}
      {label}
    </Button>
  );

  return (
    <Page>
      <PageHeader
        title="QA Lab"
        description="Desktop crawls, local security probes, OpenAPI contract checks and quality-engineering analysis."
      />

      <Tabs value={tab} onValueChange={setTab}>
        <div className="max-w-full overflow-x-auto">
          <TabsList>
            <TabsTrigger value="crawler">Crawler</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            <TabsTrigger value="openapi">OpenAPI</TabsTrigger>
            <TabsTrigger value="qe">QE</TabsTrigger>
            <TabsTrigger value="backend">Backend</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="crawler">
          <Card>
            <CardHeader>
              <CardTitle>Desktop crawler</CardTitle>
              <CardDescription>Safely inspects allowed desktop windows before any interaction.</CardDescription>
            </CardHeader>
            <CardContent className="grid max-w-sm gap-2">
              <Label htmlFor="match-title">Window title filter</Label>
              <Input id="match-title" value={matchTitle} onChange={(e) => setMatchTitle(e.target.value)} placeholder="e.g. AURA" />
            </CardContent>
            <CardFooter className="flex flex-col gap-2">
              <Run label="Probe backends" variant="outline" onClick={() => run("Crawler backends", () => apiGet("/api/qa/crawlers"))} />
              <Run label="Run dry crawl" onClick={() => run("Dry crawl", () => apiPost("/api/qa/crawl", { matchTitle, dryRun: true, maxActions: 5 }))} />
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="security">
          <Card>
            <CardHeader>
              <CardTitle>Security probes</CardTitle>
              <CardDescription>Locked to localhost / 127.0.0.1 targets (SQLi, XSS, headers, traversal).</CardDescription>
            </CardHeader>
            <CardContent className="grid max-w-sm gap-2">
              <Label htmlFor="sec-url">Base URL</Label>
              <Input id="sec-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:4310" />
            </CardContent>
            <CardFooter className="flex flex-col">
              <Run label="Run security probes" onClick={() => run("Security probes", () => apiPost("/api/qa/security-probes", { baseUrl }))} />
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="openapi">
          <Card>
            <CardHeader>
              <CardTitle>OpenAPI contracts</CardTitle>
              <CardDescription>Paste an OpenAPI JSON spec to generate and run read-only endpoint checks.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid max-w-sm gap-2">
                <Label htmlFor="oa-url">Base URL</Label>
                <Input id="oa-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="oa-spec">Spec</Label>
                <Textarea
                  id="oa-spec"
                  rows={8}
                  className="font-mono text-xs"
                  value={specText}
                  onChange={(e) => setSpecText(e.target.value)}
                  placeholder='{"openapi":"3.0.0","paths":{"/health":{"get":{"responses":{"200":{"description":"ok"}}}}}}'
                />
              </div>
            </CardContent>
            <CardFooter className="flex flex-col">
              <Run
                label="Run contract checks"
                disabled={!specText.trim()}
                onClick={() => run("Contract checks", () => apiPost("/api/qa/openapi", { specText, baseUrl }))}
              />
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="qe">
          <Card>
            <CardHeader>
              <CardTitle>Quality engineering</CardTitle>
              <CardDescription>Fixup churn hotspots, commit trajectory, code refinement and knowledge drift.</CardDescription>
            </CardHeader>
            <CardFooter className="flex flex-col gap-2">
              <Run label="7-day commit trajectory" onClick={() => run("Commit trajectory", () => apiPost("/api/qe/trajectory", { lookbackDays: 7 }))} />
              <Run label="Code refine & KB drift" variant="outline" onClick={() => run("Refine & drift", () => apiPost("/api/qe/refine", {}))} />
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="backend">
          <Card>
            <CardHeader>
              <CardTitle>Backend QA &amp; saved runs</CardTitle>
              <CardDescription>Verify MCP scope isolation, vault secret safety, and review recent QA runs.</CardDescription>
            </CardHeader>
            <CardFooter className="flex flex-col gap-2">
              <Run label="Run backend QA suite" onClick={() => run("Backend QA suite", () => apiPost("/api/qa/backend-check", {}))} />
              <Run label="List QA runs" variant="outline" onClick={() => run("QA runs", () => apiGet("/api/qa/runs"))} />
            </CardFooter>
          </Card>
        </TabsContent>
      </Tabs>

      {output !== null && <ResultView data={output} title={outputTitle} />}
    </Page>
  );
}
