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
  const [astPattern, setAstPattern] = React.useState("");
  const [hurlText, setHurlText] = React.useState("GET /api/health\nHTTP 200\n[Asserts]\nstatus == 200");
  const [baselinePath, setBaselinePath] = React.useState("");
  const [currentPath, setCurrentPath] = React.useState("");
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

  function runTool(title: string, tool: string, args: Record<string, unknown> = {}) {
    return run(title, () => apiPost("/api/reo/tools/run", { tool, args }));
  }

  const Run = ({ label, onClick, variant, disabled }: { label: string; onClick: () => void; variant?: "outline"; disabled?: boolean }) => (
    <Button type="button" className="w-full" variant={variant} disabled={busy || disabled} onClick={onClick}>
      {busy ? <Loader2 className="animate-spin" /> : <Play />}
      {label}
    </Button>
  );

  return (
    <Page>
      <PageHeader
        title="QA Lab"
        description="Desktop crawls, Playwright A11y/WCAG/CWV, Tier 0 AST & mutation, DevSecOps SAST/CVE/Nuclei, and API fuzz/Hurl/k6 checks."
      />

      <Tabs value={tab} onValueChange={setTab}>
        <div className="max-w-full overflow-x-auto">
          <TabsList>
            <TabsTrigger value="crawler">Crawler</TabsTrigger>
            <TabsTrigger value="visual-a11y">Visual &amp; A11y</TabsTrigger>
            <TabsTrigger value="tier0">Tier 0 AST &amp; Mutation</TabsTrigger>
            <TabsTrigger value="devsecops">DevSecOps</TabsTrigger>
            <TabsTrigger value="fuzz-load">Fuzz, Hurl &amp; Load</TabsTrigger>
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

        <TabsContent value="visual-a11y">
          <Card>
            <CardHeader>
              <CardTitle>Visual, Accessibility &amp; Core Web Vitals</CardTitle>
              <CardDescription>
                Semantic ARIA tree snapshot, WCAG 2.1/2.2 Axe gate, Lighthouse CWV budgets, and visual regression diff (localhost only).
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid max-w-md gap-1.5">
                <Label htmlFor="vis-url">Local Target URL</Label>
                <Input id="vis-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="vis-base">Baseline Screenshot Path (optional)</Label>
                  <Input id="vis-base" value={baselinePath} onChange={(e) => setBaselinePath(e.target.value)} placeholder="path/to/baseline.png" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="vis-curr">Current Screenshot Path (optional)</Label>
                  <Input id="vis-curr" value={currentPath} onChange={(e) => setCurrentPath(e.target.value)} placeholder="path/to/current.png" />
                </div>
              </div>
            </CardContent>
            <CardFooter className="grid gap-2 sm:grid-cols-2">
              <Run label="Playwright ARIA Tree Snapshot" onClick={() => runTool("A11y Tree Snapshot", "qa_a11y_tree_snapshot", { url: baseUrl })} />
              <Run label="Run Axe WCAG Audit" onClick={() => runTool("Axe WCAG Audit", "qa_axe_audit", { url: baseUrl })} />
              <Run label="Run Lighthouse CWV Budget" variant="outline" onClick={() => runTool("Lighthouse CWV Budget", "qa_lighthouse_budget", { url: baseUrl })} />
              <Run
                label="Compare Visual Diff"
                variant="outline"
                disabled={!baselinePath.trim() || !currentPath.trim()}
                onClick={() => runTool("Visual Diff", "qa_visual_diff", { baselinePath, currentPath })}
              />
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="tier0">
          <Card>
            <CardHeader>
              <CardTitle>Tier 0 AST, Dead Code, Boundaries &amp; Mutation</CardTitle>
              <CardDescription>Zero-token deterministic code quality audits across configured repositories.</CardDescription>
            </CardHeader>
            <CardContent className="grid max-w-md gap-1.5">
              <Label htmlFor="ast-pattern">Optional AST / Pattern Query</Label>
              <Input
                id="ast-pattern"
                value={astPattern}
                onChange={(e) => setAstPattern(e.target.value)}
                placeholder="e.g. dangerouslySetInnerHTML"
              />
            </CardContent>
            <CardFooter className="grid gap-2 sm:grid-cols-2">
              <Run label="Run ast-grep Rules" onClick={() => runTool("ast-grep Tier 0", "review_ast_grep", { pattern: astPattern })} />
              <Run label="Scan Dead Code & Deps (Knip)" onClick={() => runTool("Knip Dead Code", "qe_dead_code_scan", {})} />
              <Run label="Check Arch Boundaries & Cycles" variant="outline" onClick={() => runTool("Arch Boundaries", "qe_arch_boundaries", {})} />
              <Run label="Run Mutation Adequacy Audit" variant="outline" onClick={() => runTool("Mutation Audit", "qe_mutation_score", {})} />
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="devsecops">
          <Card>
            <CardHeader>
              <CardTitle>DevSecOps SAST, Secrets, CVE Gate &amp; Nuclei</CardTitle>
              <CardDescription>Semgrep OWASP SAST, Gitleaks history, OSV/Trivy CVE gate, and localhost Nuclei templates.</CardDescription>
            </CardHeader>
            <CardContent className="grid max-w-md gap-1.5">
              <Label htmlFor="sec-nuclei-url">Localhost Base URL (for Nuclei)</Label>
              <Input id="sec-nuclei-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </CardContent>
            <CardFooter className="grid gap-2 sm:grid-cols-2">
              <Run label="Semgrep SAST + SARIF Ingest" onClick={() => runTool("Semgrep SAST", "sec_semgrep_scan", {})} />
              <Run label="Gitleaks Commit Secret Audit" onClick={() => runTool("Gitleaks History", "sec_gitleaks_history", { maxCommits: 25 })} />
              <Run label="Dependency CVE Gate (OSV/Trivy)" variant="outline" onClick={() => runTool("Dependency CVE Gate", "sec_dependency_cves", {})} />
              <Run label="Nuclei Localhost Scan" variant="outline" onClick={() => runTool("Nuclei Localhost", "sec_nuclei_local", { baseUrl })} />
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="fuzz-load">
          <Card>
            <CardHeader>
              <CardTitle>API Property Fuzzing, Hurl Contracts &amp; k6 Smoke Load</CardTitle>
              <CardDescription>Locked strictly to localhost targets with capped VUs (&lt;=10) and duration (&lt;=10s).</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid max-w-md gap-1.5">
                <Label htmlFor="fuzz-url">Local Base URL</Label>
                <Input id="fuzz-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="hurl-suite">Hurl Contract Script</Label>
                <Textarea
                  id="hurl-suite"
                  rows={5}
                  className="font-mono text-xs"
                  value={hurlText}
                  onChange={(e) => setHurlText(e.target.value)}
                />
              </div>
            </CardContent>
            <CardFooter className="grid gap-2 sm:grid-cols-3">
              <Run label="Run Hurl Contracts" onClick={() => runTool("Hurl Contracts", "api_hurl_runner", { baseUrl, hurlText })} />
              <Run
                label="Fuzz OpenAPI Spec"
                variant="outline"
                disabled={!specText.trim()}
                onClick={() => runTool("Schemathesis Fuzz", "api_schemathesis_fuzz", { baseUrl, specText })}
              />
              <Run label="Run k6 Smoke Load (2s)" variant="outline" onClick={() => runTool("k6 Smoke Load", "qa_k6_smoke_load", { url: baseUrl, vus: 3, durationSeconds: 2 })} />
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
