import * as React from "react";
import { KeyRound, RefreshCw } from "lucide-react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ModelPicker } from "@/components/app/model-picker";
import { AppearanceSettings } from "@/components/app/appearance-settings";
import type { ColorTheme, Radius } from "@/lib/themes";
import { Page, PageHeader } from "@/components/app/page";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";

interface BrainView {
  wanted: string;
  wantedSource?: string;
  picked: string | null;
  reason: string;
  backends: { id: string; kind: string; label: string; available: boolean; detail: string }[];
  models: {
    current: Record<string, string>;
    catalogue: { id: string; label: string; note: string; backends: string[] }[];
  };
  apiKey: { source: string | null; storage: string | null; canStore: boolean };
  apiKeys: { id: string; label: string; env: string; source: "env" | "stored" | null }[];
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
  scheme,
  onSchemeChange,
  colorTheme,
  onColorTheme,
  radius,
  onRadius,
}: {
  scheme: Scheme;
  onSchemeChange: (s: Scheme) => void;
  colorTheme: ColorTheme;
  onColorTheme: (t: ColorTheme) => void;
  radius: Radius;
  onRadius: (r: Radius) => void;
}) {
  const [brain, setBrain] = React.useState<BrainView | null>(null);
  const [sys, setSys] = React.useState<SystemInfo | null>(null);
  const [apiKeyInput, setApiKeyInput] = React.useState("");
  const [keyProvider, setKeyProvider] = React.useState("anthropic-api");
  const [testing, setTesting] = React.useState(false);

  async function load() {
    const [b, s] = await Promise.all([apiGet<BrainView>("/api/brain"), apiGet<SystemInfo>("/api/reo/system")]);
    if (b.ok) setBrain(b.data);
    if (s.ok) setSys(s.data);
  }

  React.useEffect(() => {
    load();
  }, []);

  async function selectBackend(id: string) {
    const r = await apiPut<BrainView>("/api/brain", { backend: id });
    if (r.ok) {
      setBrain(r.data);
      toast.success(`Active answer backend set to ${id}`);
    } else toast.error(r.error || "Could not change backend");
  }

  async function selectModel(backendId: string, modelId: string) {
    const target = brain?.backends.find((b) => b.id === backendId);
    const canSwitchBackend = Boolean(target?.available && brain?.wantedSource !== "env");
    const payload = canSwitchBackend
      ? { backend: backendId, models: { [backendId]: modelId } }
      : { models: { [backendId]: modelId } };
    const r = await apiPut<BrainView>("/api/brain", payload);
    if (r.ok) {
      setBrain(r.data);
      toast.success(
        canSwitchBackend && target
          ? `Switched active model to ${modelId} (${target.label})`
          : `Updated ${backendId} model to ${modelId}`,
      );
    } else toast.error(r.error || "Could not change model");
  }

  async function saveKey(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKeyInput.trim()) return;
    const r = await apiPut<{ ok?: boolean; error?: string }>(`/api/brain/key/${keyProvider}`, { key: apiKeyInput.trim() });
    if (r.ok) {
      setApiKeyInput("");
      toast.success("API key saved in the encrypted OS store.");
      load();
    } else toast.error(r.error || "Failed to save key.");
  }

  async function testModel() {
    setTesting(true);
    const r = await apiPost<{ ok: boolean; backend?: string; model?: string; ms?: number; error?: string }>("/api/brain/test", {});
    setTesting(false);
    if (r.data?.ok) toast.success(`Model test passed (${r.data.backend}${r.data.model ? ` · ${r.data.model}` : ""}, ${r.data.ms}ms)`);
    else toast.error(r.data?.error || "Model test failed.");
  }

  async function rebuildIndex() {
    const id = toast.loading("Rebuilding SQLite FTS5 index...");
    const r = await apiPost("/api/index", {});
    if (r.ok) toast.success("SQLite index rebuilt cleanly.", { id });
    else toast.error("Index rebuild failed.", { id });
    load();
  }

  async function removeKey(id: string) {
    const r = await apiDelete(`/api/brain/key/${id}`);
    if (r.ok) toast.success("Removed saved API key.");
    else toast.error("Could not remove key");
    load();
  }

  const keyRow = brain?.apiKeys.find((k) => k.id === keyProvider);
  const storedKeys = brain?.apiKeys.filter((k) => k.source === "stored") ?? [];
  const groups = [
    { title: "API keys (pay per use)", rows: brain?.backends.filter((b) => b.kind === "api") ?? [] },
    { title: "Subscriptions through a CLI", rows: brain?.backends.filter((b) => b.kind === "cli") ?? [] },
  ];

  return (
    <Page>
      <PageHeader title="Settings" description="Appearance, answer backends, models, API key and index maintenance." />

      <Tabs defaultValue="general" orientation="vertical" className="flex-col gap-6 lg:flex-row">
        <TabsList className="h-auto w-full shrink-0 flex-row justify-start overflow-x-auto lg:w-48 lg:flex-col lg:items-stretch">
          <TabsTrigger value="general" className="justify-start">General</TabsTrigger>
          <TabsTrigger value="ai" className="justify-start">AI backend</TabsTrigger>
          <TabsTrigger value="index" className="justify-start">Repositories &amp; index</TabsTrigger>
          <TabsTrigger value="danger" className="text-destructive justify-start">Danger zone</TabsTrigger>
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

        <TabsContent value="ai" className="space-y-4">
          {!brain && <Skeleton className="h-64 w-full" />}
          {brain && (
            <>
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle>Where do answers come from?</CardTitle>
                      <CardDescription>{brain.reason}</CardDescription>
                    </div>
                    <Button variant="outline" size="sm" disabled={testing} onClick={testModel}>
                      {testing ? "Testing..." : "Test connection"}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-3">
                  {groups.map((g) => (
                    <div key={g.title} className="grid gap-2">
                      <h3 className="text-muted-foreground text-xs font-medium uppercase">{g.title}</h3>
                      <div className="grid gap-2 xl:grid-cols-2">
                  {g.rows.map((b) => {
                    const inUse = brain.picked === b.id;
                    return (
                      <button
                        type="button"
                        key={b.id}
                        disabled={!b.available}
                        onClick={() => selectBackend(b.id)}
                        className={cn(
                          "flex w-full items-center justify-between gap-4 rounded-2xl border p-4 text-left transition-colors disabled:opacity-60",
                          inUse ? "border-primary bg-accent" : "hover:bg-accent/50",
                        )}
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{b.label}</div>
                          <p className="text-muted-foreground mt-0.5 text-xs">
                            {b.detail}
                            {brain.models.current[b.id] ? ` · Current: ${brain.models.current[b.id]}` : ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge variant={b.available ? "secondary" : "outline"}>{b.available ? "Ready" : "Unavailable"}</Badge>
                          {inUse && <Badge>In use</Badge>}
                        </div>
                      </button>
                    );
                  })}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="min-w-0">
                  <CardHeader>
                    <CardTitle>Model per backend</CardTitle>
                    <CardDescription>
                      Each backend keeps its own model. A provider appears here once its key is saved or its CLI is found.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4">
                    {brain.backends
                      .filter((b) => brain.models.catalogue.some((m) => m.backends.includes(b.id)))
                      .sort((a, b) => Number(brain.picked === b.id) - Number(brain.picked === a.id))
                      .map((b) => (
                        <div key={b.id} className="grid min-w-0 gap-2">
                          <Label className="text-xs">
                            {b.label}
                            {brain.picked === b.id && <Badge className="ml-2">In use</Badge>}
                          </Label>
                          <ModelPicker
                            choices={brain.models.catalogue.filter((m) => m.backends.includes(b.id))}
                            current={brain.models.current[b.id] || ""}
                            onPick={(id) => selectModel(b.id, id)}
                          />
                        </div>
                      ))}
                  </CardContent>
                </Card>

                <Card className="min-w-0 self-start">
                  <CardHeader>
                    <CardTitle>API keys</CardTitle>
                    <CardDescription>
                      {!brain.apiKey.canStore
                        ? "This computer has no secure key store. Use environment variables instead."
                        : "One key per provider, encrypted on this computer."}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    <Select
                      value={keyProvider}
                      onValueChange={(v) => {
                        setKeyProvider(v);
                        setApiKeyInput(""); // a key typed for one provider must not be saved for another
                      }}
                    >
                      <SelectTrigger className="w-full" aria-label="Provider">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {brain.apiKeys.map((k) => (
                          <SelectItem key={k.id} value={k.id}>
                            {k.label}
                            {k.source ? " (key set)" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <form onSubmit={saveKey} className="flex gap-2">
                      <Input
                        type="password"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder={`Paste ${keyRow?.label ?? "API key"}...`}
                        autoComplete="off"
                        aria-label="API key"
                      />
                      <Button type="submit" disabled={!apiKeyInput.trim() || !brain.apiKey.canStore}>
                        <KeyRound />
                        Save
                      </Button>
                    </form>
                    <p className="text-muted-foreground text-xs">
                      {keyRow?.source === "env"
                        ? `Using the ${keyRow.env} environment variable.`
                        : keyRow?.source === "stored"
                          ? "A key is saved. Saving again replaces it."
                          : "No key saved for this provider."}
                    </p>
                  </CardContent>
                </Card>
              </div>
            </>
          )}
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
        <TabsContent value="danger">
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="text-destructive">Danger zone</CardTitle>
              <CardDescription>These actions cannot be undone.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {storedKeys.length === 0 && <p className="text-muted-foreground text-xs">No stored key to remove.</p>}
              {storedKeys.map((k) => (
                <div key={k.id} className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{k.label}</div>
                    <p className="text-muted-foreground text-xs">Deletes this key from the encrypted OS store.</p>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" size="sm">Remove key</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove the saved {k.label}?</AlertDialogTitle>
                        <AlertDialogDescription>You will need to paste it again to use this provider.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => removeKey(k.id)}>Remove</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
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
