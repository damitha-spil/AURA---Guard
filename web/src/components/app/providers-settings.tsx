import * as React from "react";
import { Check, KeyRound, Minus, Plus, RefreshCw, RotateCcw, Search } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { AddProviderDialog, officialSignInLabel, ProviderIcon, type ProviderSummary } from "@/components/app/add-provider-dialog";
import { ModelPicker, type ModelChoice } from "@/components/app/model-picker";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { ago } from "@/lib/pulls";
import { cn } from "@/lib/utils";

type Provider = ProviderSummary;
interface ProvidersReply {
  checkedAt: string;
  healthCheckSeconds: number;
  providers: Provider[];
}
interface Brain {
  wanted: string;
  wantedSource?: string;
  picked: string | null;
  reason: string;
  models: { current: Record<string, string>; catalogue: ModelChoice[] };
  apiKey: { canStore: boolean };
}

const INTERVAL_STEP = 60;
/** The page never asks more often than this, whatever is typed: probing a CLI starts a process. */
const MIN_REFRESH_SECONDS = 30;

const nameOf = (p: Provider) => p.displayName || p.label;
const statusText = (p: Provider) =>
  !p.enabled
    ? "Disabled"
    : p.inUse
      ? p.kind === "cli"
        ? "Authenticated · In use"
        : "In use"
      : p.available
        ? p.kind === "cli"
          ? "Authenticated · Subscription"
          : "Ready"
        : p.kind === "cli"
          ? "Sign in required"
          : "Unavailable";
const configured = (p: Provider) => p.enabled || p.inUse || Boolean(p.keySource || p.binaryPath || p.homeDir);

function Row({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-32 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="text-muted-foreground text-xs break-words">{description}</div>}
      </div>
      <div className="flex w-full max-w-72 min-w-0 flex-wrap justify-end gap-2">{children}</div>
    </div>
  );
}

/** A text setting that is saved when the field is left or Enter is pressed. */
function TextSetting({ label, value, placeholder, onSave }: { label: string; value: string; placeholder: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const save = () => draft.trim() !== value && onSave(draft.trim());
  return (
    <Input
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

/** Mounted with a key per provider, so a key typed for one provider can never be saved for another. */
function KeyControls({ provider, canStore, onChanged }: { provider: Provider; canStore: boolean; onChanged: () => void }) {
  const [value, setValue] = React.useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    const r = await apiPut(`/api/brain/key/${provider.id}`, { key: value.trim() });
    if (r.ok) {
      setValue("");
      toast.success("API key saved in the encrypted OS store.");
      onChanged();
    } else toast.error(r.error || "Failed to save key.");
  }

  async function remove() {
    const r = await apiDelete(`/api/brain/key/${provider.id}`);
    if (r.ok) toast.success("Removed saved API key.");
    else toast.error(r.error || "Could not remove key");
    onChanged();
  }

  return (
    <Row
      title="API key"
      description={
        !canStore
          ? `This computer has no secure key store. Set ${provider.envVar ?? "the environment variable"} instead.`
          : provider.keySource === "env"
            ? `Using the ${provider.envVar} environment variable.`
            : provider.keySource === "stored"
              ? "A key is saved, encrypted on this computer. Saving again replaces it."
              : "No key saved for this provider."
      }
    >
      <form onSubmit={save} className="flex w-full gap-2">
        <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste API key..." autoComplete="off" aria-label={`API key for ${nameOf(provider)}`} />
        <Button type="submit" disabled={!value.trim() || !canStore}>
          <KeyRound />
          Save
        </Button>
      </form>
      {provider.keySource === "stored" && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm">
              Remove saved key
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove the saved key for {nameOf(provider)}?</AlertDialogTitle>
              <AlertDialogDescription>You will need to paste it again to use this provider.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={remove}>Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </Row>
  );
}

export function ProvidersSettings({ onChanged }: { onChanged: () => void }) {
  const [view, setView] = React.useState<ProvidersReply | null>(null);
  const [brain, setBrain] = React.useState<Brain | null>(null);
  const [error, setError] = React.useState("");
  const [checking, setChecking] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [signingIn, setSigningIn] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const [modelFilter, setModelFilter] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [, setTick] = React.useState(0);

  const load = React.useCallback(async (refresh = false) => {
    setChecking(true);
    const [p, b] = await Promise.all([apiGet<ProvidersReply>(`/api/providers${refresh ? "?refresh=1" : ""}`), apiGet<Brain>("/api/brain")]);
    if (p.ok && Array.isArray(p.data.providers)) {
      setView(p.data);
      setError("");
    } else setError(p.error || "The engine did not return the providers.");
    if (b.ok && b.data.models) setBrain(b.data);
    setChecking(false);
  }, []);

  React.useEffect(() => {
    load();
    // Keeps "Checked 3m ago" current.
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  const interval = view?.healthCheckSeconds ?? 0;
  React.useEffect(() => {
    if (interval <= 0) return;
    const t = window.setInterval(() => load(true), Math.max(MIN_REFRESH_SECONDS, interval) * 1000);
    return () => window.clearInterval(t);
  }, [interval, load]);

  async function change(url: string, body: unknown, done?: string) {
    const r = await apiPut(url, body);
    if (!r.ok) toast.error(r.error || "Could not save that.");
    else if (done) toast.success(done);
    await load();
    onChanged();
  }

  async function test() {
    setTesting(true);
    const r = await apiPost<{ ok: boolean; backend?: string; model?: string; ms?: number; error?: string }>("/api/brain/test", {});
    setTesting(false);
    if (r.data?.ok) toast.success(`Model test passed (${r.data.backend}${r.data.model ? ` · ${r.data.model}` : ""}, ${r.data.ms}ms)`);
    else toast.error(r.data?.error || r.error || "Model test failed.");
  }

  async function signInCli(id: string) {
    setSigningIn(true);
    const r = await apiPost<{ ok: boolean; message?: string; error?: string }>(`/api/providers/${id}/signin`, {});
    setSigningIn(false);
    if (r.ok) {
      toast.success(r.data?.message || "Official sign-in started. Complete sign-in in your browser.");
      window.setTimeout(() => load(true), 4000);
    } else {
      toast.error(r.error || r.data?.error || "Could not start official sign-in.");
    }
  }

  if (!view) {
    return error ? (
      <div role="alert" className="grid justify-items-start gap-3 rounded-2xl border p-4 text-sm">
        <span>Could not load providers: {error}</span>
        <Button variant="outline" size="sm" onClick={() => load()}>
          Retry
        </Button>
      </div>
    ) : (
      <Skeleton className="h-64 w-full" />
    );
  }

  const listed = view.providers.filter((p) => configured(p) || p.id === selectedId);
  const selected = view.providers.find((p) => p.id === selectedId) ?? listed.find((p) => p.inUse) ?? listed[0];
  const locked = brain?.wantedSource === "env";
  const automatic = brain?.wanted === "auto";
  const providerModels = selected && brain ? brain.models.catalogue.filter((m) => m.backends.includes(selected.id)) : [];
  const filteredModels = modelFilter.trim()
    ? providerModels.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(modelFilter.trim().toLowerCase()))
    : providerModels;

  const setInterval_ = (seconds: number) => change("/api/providers", { healthCheckSeconds: Math.max(0, Math.round(seconds)) });

  return (
    <div className="@container grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
      <AddProviderDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        providers={view.providers}
        canStoreKey={brain?.apiKey.canStore ?? false}
        onSaved={(id) => {
          setSelectedId(id);
          load(true);
          onChanged();
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h2 className="text-base font-semibold">Providers</h2>
          <Button variant="ghost" size="icon" aria-label="Add provider" onClick={() => setAddOpen(true)}>
            <Plus />
          </Button>
        </div>
        <Button variant="ghost" size="sm" onClick={() => load(true)} disabled={checking}>
          <RefreshCw className={checking ? "animate-spin" : undefined} />
          {checking ? "Checking..." : `Checked ${ago(view.checkedAt)}`}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          Could not refresh: {error}
        </p>
      )}

      {brain && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4">
          <div className="min-w-40 flex-1">
            <div className="text-sm font-medium">Answers come from: {view.providers.find((p) => p.inUse) ? nameOf(view.providers.find((p) => p.inUse)!) : "no provider"}</div>
            <p className="text-muted-foreground text-xs break-words">
              {brain.reason}
              {locked && " This choice is set by an environment variable, so it cannot be changed here."}
            </p>
          </div>
          <Button
            size="sm"
            variant={automatic ? "default" : "outline"}
            aria-pressed={automatic}
            disabled={locked}
            onClick={() => change("/api/brain", { backend: "auto" }, "REO now picks the provider")}
          >
            Automatic
          </Button>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-2xl border @2xl:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="border-b @2xl:border-r @2xl:border-b-0">
          {listed.map((p) => (
            <div key={p.id} className={cn("flex items-center gap-2 border-b pr-3", selected?.id === p.id && "bg-muted")}>
              <button
                type="button"
                aria-pressed={selected?.id === p.id}
                onClick={() => setSelectedId(p.id)}
                className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-start gap-2 p-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-inset"
              >
                <span className="mt-0.5">
                  <ProviderIcon id={p.id} kind={p.kind} />
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium break-words">{nameOf(p)}</span>
                    {p.version && <span className="text-muted-foreground font-mono text-xs">{p.version}</span>}
                  </span>
                  <span className="text-muted-foreground block text-xs">{statusText(p)}</span>
                </span>
              </button>
              <Switch aria-label={`Enable ${nameOf(p)}`} checked={p.enabled} onCheckedChange={(enabled) => change(`/api/providers/${p.id}`, { enabled })} />
            </div>
          ))}
          {listed.length === 0 && <p className="text-muted-foreground p-3 text-xs">No provider is set up yet.</p>}
          <Button variant="ghost" className="w-full justify-start rounded-none" onClick={() => setAddOpen(true)}>
            <Plus />
            Add provider
          </Button>
        </div>

        {selected ? (
          <div className="min-w-0 divide-y">
            <div className="flex items-center gap-2 p-4">
              <ProviderIcon id={selected.id} kind={selected.kind} />
              <h3 className="min-w-0 flex-1 font-semibold break-words">{nameOf(selected)}</h3>
              {selected.inUse && <Badge>In use</Badge>}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Reset this provider to defaults"
                title="Reset to defaults"
                onClick={() => change(`/api/providers/${selected.id}`, { reset: true }, "Provider reset to defaults")}
              >
                <RotateCcw />
              </Button>
            </div>
            <Row title="Status" description={`${statusText(selected)}. ${selected.detail}`}>
              {selected.inUse ? (
                <Button variant="outline" size="sm" disabled={testing} onClick={test}>
                  {testing ? "Testing..." : "Test connection"}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!selected.available || !selected.enabled || locked}
                  onClick={() => change("/api/brain", { backend: selected.id }, `Now using ${nameOf(selected)}`)}
                >
                  Use this provider
                </Button>
              )}
            </Row>
            <Row title="Display name" description="The name shown in this list.">
              <TextSetting
                key={`${selected.id}-name`}
                label="Display name"
                value={selected.displayName === selected.label ? "" : (selected.displayName ?? "")}
                placeholder={selected.label}
                onSave={(displayName) => change(`/api/providers/${selected.id}`, { displayName })}
              />
            </Row>
            {brain && brain.models.catalogue.some((m) => m.backends.includes(selected.id)) && (
              <Row title="Model" description={selected.inUse ? "This model answers now." : "Used when this provider is in use."}>
                <ModelPicker
                  key={selected.id}
                  choices={brain.models.catalogue.filter((m) => m.backends.includes(selected.id))}
                  current={brain.models.current[selected.id] || selected.model || ""}
                  onPick={(id) => change("/api/brain", { models: { [selected.id]: id } }, "Model saved")}
                />
              </Row>
            )}
            {selected.kind === "api" && (
              <KeyControls
                key={selected.id}
                provider={selected}
                canStore={brain?.apiKey.canStore ?? false}
                onChanged={() => {
                  load(true);
                  onChanged();
                }}
              />
            )}
            {selected.kind === "cli" && (
              <Row
                title="Account"
                description={
                  selected.available
                    ? selected.id === "claude-cli"
                      ? "Signed in with your Claude subscription."
                      : selected.id === "antigravity-cli"
                        ? "Signed in with your Google subscription."
                        : "Signed in with your subscription."
                    : selected.id === "claude-cli"
                      ? "Sign in with your Claude account to use your subscription."
                      : selected.id === "antigravity-cli"
                        ? "Sign in with your Google account to use your subscription."
                        : "Sign in to use your subscription."
                }
              >
                <Button
                  variant={selected.available ? "outline" : "default"}
                  size="sm"
                  disabled={signingIn || !selected.enabled}
                  onClick={() => signInCli(selected.id)}
                >
                  <ProviderIcon id={selected.id} kind={selected.kind} />
                  {signingIn ? "Opening sign-in..." : officialSignInLabel(selected.id, selected.available)}
                </Button>
              </Row>
            )}
            {selected.kind === "cli" && (
              <Row title="Binary path" description="Leave empty to use the program REO finds.">
                <TextSetting
                  key={`${selected.id}-binary`}
                  label="Binary path"
                  value={selected.binaryPath ?? ""}
                  placeholder={selected.detectedPath ?? "Not found on this computer"}
                  onSave={(binaryPath) => change(`/api/providers/${selected.id}`, { binaryPath })}
                />
              </Row>
            )}
            {selected.kind === "cli" && selected.supportsHomeDir && (
              <Row title="Home folder" description="Where this program keeps its settings and sign-in.">
                <TextSetting
                  key={`${selected.id}-home`}
                  label="Home folder"
                  value={selected.homeDir ?? ""}
                  placeholder="Default folder"
                  onSave={(homeDir) => change(`/api/providers/${selected.id}`, { homeDir })}
                />
              </Row>
            )}
            {providerModels.length > 0 && (
              <div className="grid gap-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">Models</div>
                    <div className="text-muted-foreground text-xs">Available models for {nameOf(selected)}.</div>
                  </div>
                  <span className="text-muted-foreground text-xs">{providerModels.length} models</span>
                </div>
                <div className="relative">
                  <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-3.5" />
                  <Input
                    value={modelFilter}
                    onChange={(e) => setModelFilter(e.target.value)}
                    placeholder="Filter models"
                    className="h-8 pl-8 text-xs"
                    aria-label="Filter provider models"
                  />
                </div>
                <div className="max-h-56 divide-y overflow-y-auto rounded-xl border">
                  {filteredModels.map((m) => {
                    const currentModel = brain?.models.current[selected.id] || selected.model || "";
                    const isCurrent = currentModel === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => change("/api/brain", { models: { [selected.id]: m.id } }, `Model set to ${m.label}`)}
                        className={cn(
                          "hover:bg-muted/60 flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors",
                          isCurrent && "bg-muted/80",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="text-xs font-medium">{m.label}</span>
                          <span className="text-muted-foreground ml-2 font-mono text-[11px]">{m.id}</span>
                        </span>
                        {isCurrent && <Check className="text-primary size-3.5 shrink-0" />}
                      </button>
                    );
                  })}
                  {filteredModels.length === 0 && (
                    <p className="text-muted-foreground p-3 text-xs">No models match "{modelFilter}".</p>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground p-4 text-sm">Choose "Add provider" to set one up.</p>
        )}
      </div>

      <section className="grid gap-3">
        <h2 className="text-sm font-semibold">Advanced</h2>
        <div className="rounded-2xl border">
          <Row title="Health check interval" description="Seconds between status checks while this page is open. 0 turns it off; the shortest wait is 30 seconds.">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" aria-label="Shorter interval" disabled={interval <= 0} onClick={() => setInterval_(interval - INTERVAL_STEP)}>
                <Minus />
              </Button>
              <div className="w-24">
                <TextSetting
                  label="Health check interval in seconds"
                  value={String(interval)}
                  placeholder="0"
                  onSave={(v) => (/^\d+$/.test(v) ? setInterval_(Number(v)) : toast.error("Type a whole number of seconds."))}
                />
              </div>
              <Button variant="outline" size="icon" aria-label="Longer interval" onClick={() => setInterval_(interval + INTERVAL_STEP)}>
                <Plus />
              </Button>
            </div>
          </Row>
        </div>
      </section>
    </div>
  );
}
