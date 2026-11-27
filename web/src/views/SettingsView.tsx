import * as React from "react";
import { Check, ChevronsUpDown, KeyRound, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
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
import { COLOR_THEMES, RADII, type ColorTheme, type Radius } from "@/lib/themes";
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
    const r = await apiPut<{ ok?: boolean; error?: string }>("/api/brain/key", { key: apiKeyInput.trim() });
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

  const schemes = [
    ["light dark", "System", Monitor],
    ["light", "Light", Sun],
    ["dark", "Dark", Moon],
  ] as const;

  return (
    <Page>
      <PageHeader title="Settings" description="Appearance, answer backends, models, API key and index maintenance." />

      <Tabs defaultValue="general" orientation="vertical" className="flex-col gap-6 md:flex-row">
        <TabsList className="h-auto w-full shrink-0 flex-row justify-start overflow-x-auto md:w-48 md:flex-col md:items-stretch">
          <TabsTrigger value="general" className="justify-start">General</TabsTrigger>
          <TabsTrigger value="ai" className="justify-start">AI backend</TabsTrigger>
          <TabsTrigger value="index" className="justify-start">Repositories &amp; index</TabsTrigger>
          <TabsTrigger value="danger" className="text-destructive justify-start">Danger zone</TabsTrigger>
        </TabsList>
        <div className="min-w-0 flex-1">

        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>Choose light, dark, or match your system theme.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-3">
              {schemes.map(([val, label, Icon]) => (
                <Button
                  key={val}
                  variant={scheme === val ? "default" : "outline"}
                  className="justify-start"
                  onClick={() => onSchemeChange(val)}
                >
                  <Icon />
                  {label}
                </Button>
              ))}
            </CardContent>
          </Card>
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Colour theme</CardTitle>
              <CardDescription>Pick the accent colour used across the app.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                {COLOR_THEMES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onColorTheme(t.id)}
                    aria-pressed={colorTheme === t.id}
                    className={cn(
                      "focus-visible:ring-ring/50 flex items-center gap-3 rounded-2xl border p-3 text-left text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none",
                      colorTheme === t.id ? "border-primary bg-muted" : "hover:bg-muted/60",
                    )}
                  >
                    <span data-theme={t.id} className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full">
                      {colorTheme === t.id && <Check className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{t.label}</span>
                  </button>
                ))}
              </div>
              <div className="grid gap-2">
                <Label className="text-xs">Corner radius</Label>
                <div className="flex flex-wrap gap-2">
                  {RADII.map((r) => (
                    <Button key={r.id} variant={radius === r.id ? "default" : "outline"} size="sm" onClick={() => onRadius(r.id)}>
                      {r.label}
                    </Button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="mt-4">
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
                  {brain.backends.map((b) => {
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
                </CardContent>
              </Card>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="min-w-0">
                  <CardHeader>
                    <CardTitle>Model per backend</CardTitle>
                    <CardDescription>Each backend keeps its own model selection.</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4">
                    {[...brain.backends]
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

                <Card className="min-w-0">
                  <CardHeader>
                    <CardTitle>API key</CardTitle>
                    <CardDescription>
                      {brain.apiKey.source ? `${brain.apiKey.source} (${brain.apiKey.storage || "local"})` : "No key saved"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    <form onSubmit={saveKey} className="flex gap-2">
                      <Input
                        type="password"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder="Paste Anthropic API key..."
                        aria-label="API key"
                      />
                      <Button type="submit" disabled={!apiKeyInput.trim()}>
                        <KeyRound />
                        Save
                      </Button>
                    </form>
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
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">Remove saved API key</div>
                <p className="text-muted-foreground text-xs">
                  {brain?.apiKey.source === "stored" ? "Deletes the key from the encrypted OS store." : "No stored key to remove."}
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" disabled={brain?.apiKey.source !== "stored"}>Remove key</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove the saved API key?</AlertDialogTitle>
                    <AlertDialogDescription>You will need to paste it again to use the API backend.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={async () => {
                        const r = await apiDelete("/api/brain/key");
                        toast(r.ok ? "Removed saved API key." : "Could not remove key");
                        load();
                      }}
                    >
                      Remove
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardContent>
          </Card>
        </TabsContent>
        </div>
      </Tabs>
    </Page>
  );
}
