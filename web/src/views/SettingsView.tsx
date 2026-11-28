import * as React from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppearanceSettings } from "@/components/app/appearance-settings";
import { DiffSettings } from "@/components/app/diff-settings";
import { ProvidersSettings } from "@/components/app/providers-settings";
import { SourceControlSettings } from "@/components/app/source-control-settings";
import { SystemHealth } from "@/components/app/system-health";
import { KeyboardSettings } from "@/components/app/keyboard-settings";
import { NotificationSettings } from "@/components/app/notification-settings";
import { SETTINGS_TABS, type SettingsTab } from "@/lib/settings-tabs";
import type { ColorTheme, Radius } from "@/lib/themes";
import { Page, PageHeader } from "@/components/app/page";
import { apiGet, apiPost } from "@/lib/api";

interface BrainView {
  picked: string | null;
}

interface SystemInfo {
  repos: { id: string; label: string; path: string }[];
  vaultNotes: number;
  vaultProblems: number;
  skillsCount: number;
  defectsCount: number;
}


type Scheme = "light dark" | "light" | "dark";

export function SettingsView({
  tab,
  onTab,
  scheme,
  onSchemeChange,
  colorTheme,
  onColorTheme,
  radius,
  onRadius,
}: {
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  scheme: Scheme;
  onSchemeChange: (s: Scheme) => void;
  colorTheme: ColorTheme;
  onColorTheme: (t: ColorTheme) => void;
  radius: Radius;
  onRadius: (r: Radius) => void;
}) {
  const [brain, setBrain] = React.useState<BrainView | null>(null);
  const [sys, setSys] = React.useState<SystemInfo | null>(null);
  async function load() {
    const [b, s] = await Promise.all([apiGet<BrainView>("/api/brain"), apiGet<SystemInfo>("/api/reo/system")]);
    if (b.ok) setBrain(b.data);
    if (s.ok) setSys(s.data);
  }

  React.useEffect(() => {
    load();
  }, []);

  async function rebuildIndex() {
    const id = toast.loading("Rebuilding SQLite FTS5 index...");
    const r = await apiPost("/api/index", {});
    if (r.ok) toast.success("SQLite index rebuilt cleanly.", { id });
    else toast.error("Index rebuild failed.", { id });
    load();
  }

  return (
    <Page>
      <PageHeader title="Settings" description="Appearance, providers, source control, diffs and index maintenance." />

      <Tabs value={tab} onValueChange={(v) => onTab(v as SettingsTab)} orientation="vertical" className="flex-col gap-6 lg:flex-row">
        <TabsList className="h-auto w-full shrink-0 flex-row justify-start overflow-x-auto lg:w-48 lg:flex-col lg:items-stretch">
          {SETTINGS_TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="justify-start">{t.label}</TabsTrigger>
          ))}
        </TabsList>
        <div className="min-w-0 flex-1">

        <TabsContent value="general">
          <AppearanceSettings
            scheme={scheme}
            onSchemeChange={onSchemeChange}
            colorTheme={colorTheme}
            onColorTheme={onColorTheme}
            radius={radius}
            onRadius={onRadius}
          />
          <Card className="mt-8">
            <CardHeader>
              <CardTitle>About this engine</CardTitle>
              <CardDescription>Read from the local engine</CardDescription>
            </CardHeader>
            <CardContent className="divide-y text-sm">
              {[
                ["Active backend", brain?.picked ?? "none"],
                ["Vault notes", sys?.vaultNotes ?? "-"],
                ["Vault problems", sys?.vaultProblems ?? "-"],
                ["Skills", sys?.skillsCount ?? "-"],
              ].map(([k, v]) => (
                <div key={String(k)} className="flex items-center justify-between gap-4 py-2">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="font-medium">{String(v)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="providers">
          <ProvidersSettings onChanged={load} />
        </TabsContent>
        <TabsContent value="source">
          <SourceControlSettings />
        </TabsContent>
        <TabsContent value="diffs">
          <DiffSettings />
        </TabsContent>

        <TabsContent value="keyboard">
          <KeyboardSettings />
        </TabsContent>
        <TabsContent value="notifications">
          <NotificationSettings />
        </TabsContent>

        <TabsContent value="health">
          <SystemHealth />
        </TabsContent>

        <TabsContent value="index">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle>Configured repositories</CardTitle>
                  <CardDescription>
                    {sys ? `Vault notes: ${sys.vaultNotes} · Skills: ${sys.skillsCount} · Defects: ${sys.defectsCount}` : "Loading..."}
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={rebuildIndex}>
                  <RefreshCw />
                  Rebuild index
                </Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {!sys && <Skeleton className="h-16 w-full" />}
              {sys?.repos.map((r) => (
                <div key={r.id} className="min-w-0 rounded-2xl border p-3 text-sm">
                  <div className="truncate font-medium">{r.label} <span className="text-muted-foreground">({r.id})</span></div>
                  <div className="text-muted-foreground mt-0.5 truncate font-mono text-xs">{r.path}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
        </div>
      </Tabs>
    </Page>
  );
}
