import * as React from "react";
import { Bot, Check, ChevronDown, ChevronUp, KeyRound, Terminal } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiPost, apiPut } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface ProviderSummary {
  id: string;
  label: string;
  displayName: string | null;
  kind: "api" | "cli";
  enabled: boolean;
  available: boolean;
  inUse: boolean;
  version: string | null;
  detail: string;
  model: string | null;
  keySource: "env" | "stored" | null;
  envVar: string | null;
  binaryPath: string | null;
  detectedPath: string | null;
  homeDir: string | null;
  supportsHomeDir: boolean;
}

export function officialSignInLabel(id: string, signedIn = false): string {
  if (signedIn) return "Change account";
  if (id === "antigravity-cli") return "Continue with Google";
  if (id === "claude-cli") return "Continue with Claude";
  if (id === "opencode-cli") return "Sign in with OpenCode";
  return "Sign in";
}

export function ProviderIcon({ id, kind, className }: { id: string; kind: "api" | "cli"; className?: string }) {
  const cls = cn("size-4 shrink-0", className);
  if (id === "antigravity-cli") {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cls} aria-hidden="true">
        <path
          d="M12 3.2C10.5 7.4 7.7 13.8 4.4 20h3.3c1.6-3.4 3-6.7 4.3-10.3 1.3 3.6 2.7 6.9 4.3 10.3h3.3C16.3 13.8 13.5 7.4 12 3.2z"
          fill="#38bdf8"
        />
        <path d="M8.8 15.2c2.1-.6 4.3-.6 6.4 0" stroke="#818cf8" strokeWidth="2.1" strokeLinecap="round" />
      </svg>
    );
  }
  if (id === "claude-cli" || id === "anthropic-api") {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cls} aria-hidden="true">
        <g stroke="#D97757" strokeWidth="2.1" strokeLinecap="round">
          <line x1="12" y1="2.5" x2="12" y2="8" />
          <line x1="12" y1="16" x2="12" y2="21.5" />
          <line x1="2.5" y1="12" x2="8" y2="12" />
          <line x1="16" y1="12" x2="21.5" y2="12" />
          <line x1="5.3" y1="5.3" x2="9.2" y2="9.2" />
          <line x1="14.8" y1="14.8" x2="18.7" y2="18.7" />
          <line x1="18.7" y1="5.3" x2="14.8" y2="9.2" />
          <line x1="9.2" y1="14.8" x2="5.3" y2="18.7" />
          <line x1="8.4" y1="3.3" x2="10.5" y2="8.4" />
          <line x1="13.5" y1="15.6" x2="15.6" y2="20.7" />
          <line x1="20.7" y1="8.4" x2="15.6" y2="10.5" />
          <line x1="8.4" y1="13.5" x2="3.3" y2="15.6" />
        </g>
      </svg>
    );
  }
  if (id === "opencode-cli") {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cls} aria-hidden="true">
        <rect x="5" y="4" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
        <rect x="9" y="8" width="6" height="8" fill="currentColor" opacity="0.6" />
      </svg>
    );
  }
  return kind === "cli" ? <Terminal className={cls} /> : <Bot className={cls} />;
}

const STEPS = [
  { id: 1, label: "Provider" },
  { id: 2, label: "Identity" },
  { id: 3, label: "Config" },
] as const;

export function AddProviderDialog({
  open,
  onOpenChange,
  providers,
  canStoreKey,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: ProviderSummary[];
  canStoreKey: boolean;
  onSaved: (selectedId: string) => void;
}) {
  const sorted = React.useMemo(
    () =>
      [...providers].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "cli" ? -1 : 1;
        return a.label.localeCompare(b.label);
      }),
    [providers],
  );

  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  const [showAll, setShowAll] = React.useState(false);
  const [pickedId, setPickedId] = React.useState<string>("");
  const [label, setLabel] = React.useState("");
  const [binaryPath, setBinaryPath] = React.useState("");
  const [homeDir, setHomeDir] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const picked = sorted.find((p) => p.id === pickedId) ?? sorted[0] ?? null;
  const visible = showAll ? sorted : sorted.slice(0, 6);

  React.useEffect(() => {
    if (!open) return;
    const initial = sorted.find((p) => !p.enabled) ?? sorted[0];
    setStep(1);
    setShowAll(false);
    setPickedId(initial?.id ?? "");
    setLabel(initial?.displayName || initial?.label || "");
    setBinaryPath(initial?.binaryPath ?? "");
    setHomeDir(initial?.homeDir ?? "");
    setApiKey("");
  }, [open, sorted]);

  const selectProvider = (p: ProviderSummary) => {
    setPickedId(p.id);
    setLabel(p.displayName || p.label);
    setBinaryPath(p.binaryPath ?? "");
    setHomeDir(p.homeDir ?? "");
    setApiKey("");
  };

  async function handleOfficialSignIn() {
    if (!picked) return;
    setBusy(true);
    const enableRes = await apiPut(`/api/providers/${picked.id}`, { enabled: true });
    if (!enableRes.ok) {
      setBusy(false);
      toast.error(enableRes.error || "Could not enable provider.");
      return;
    }
    const r = await apiPost<{ ok: boolean; message?: string; error?: string }>(`/api/providers/${picked.id}/signin`, {});
    setBusy(false);
    if (r.ok) {
      toast.success(r.data?.message || "Official sign-in started. Complete sign-in in your browser.");
      onSaved(picked.id);
      onOpenChange(false);
    } else {
      toast.error(r.error || r.data?.error || "Could not start official sign-in.");
    }
  }

  async function handleSaveManual() {
    if (!picked) return;
    setBusy(true);
    const body: Record<string, unknown> = {
      enabled: true,
      displayName: label.trim() && label.trim() !== picked.label ? label.trim() : null,
    };
    if (picked.kind === "cli") {
      body.binaryPath = binaryPath.trim() || null;
      if (picked.supportsHomeDir) body.homeDir = homeDir.trim() || null;
    }
    const res = await apiPut(`/api/providers/${picked.id}`, body);
    if (!res.ok) {
      setBusy(false);
      toast.error(res.error || "Could not save provider settings.");
      return;
    }
    if (picked.kind === "api" && apiKey.trim()) {
      const keyRes = await apiPut(`/api/brain/key/${picked.id}`, { key: apiKey.trim() });
      if (!keyRes.ok) {
        setBusy(false);
        toast.error(keyRes.error || "Saved provider, but failed to store API key.");
        return;
      }
    }
    setBusy(false);
    toast.success(`${picked.label} configured and enabled.`);
    onSaved(picked.id);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
          <DialogDescription>Add an account or configure a provider on this device.</DialogDescription>
        </DialogHeader>

        {/* 3-step stepper */}
        <div className="bg-muted/50 grid grid-cols-3 gap-1 rounded-xl border p-1">
          {STEPS.map((s) => {
            const done = step > s.id;
            const current = step === s.id;
            return (
              <div
                key={s.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  current && "bg-background text-foreground shadow-xs",
                  !current && "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
                    done && "border-primary bg-primary text-primary-foreground",
                    current && "border-primary text-primary",
                    !done && !current && "border-border",
                  )}
                >
                  {done ? <Check className="size-3" /> : s.id}
                </span>
                <span className="truncate">{s.label}</span>
              </div>
            );
          })}
        </div>

        {step === 1 && (
          <div className="grid gap-3 py-1">
            <div className="text-xs font-medium text-muted-foreground">Provider</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {visible.map((p) => {
                const active = picked?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => selectProvider(p)}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors",
                      active ? "border-primary bg-primary/8" : "hover:bg-muted/60",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <ProviderIcon id={p.id} kind={p.kind} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{p.displayName || p.label}</span>
                        <span className="text-muted-foreground block text-[11px]">
                          {p.id === "antigravity-cli"
                            ? "Google Subscription"
                            : p.id === "claude-cli"
                              ? "Claude Subscription"
                              : p.kind === "cli"
                                ? "Subscription"
                                : "API key"}
                        </span>
                      </span>
                    </span>
                    {active ? (
                      <span className="bg-primary text-primary-foreground flex size-5 shrink-0 items-center justify-center rounded-full">
                        <Check className="size-3" />
                      </span>
                    ) : (
                      p.available && <Badge variant="secondary" className="text-[10px]">Ready</Badge>
                    )}
                  </button>
                );
              })}
            </div>
            {sorted.length > 6 && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start text-xs"
              >
                {showAll ? (
                  <>
                    Show less <ChevronUp className="size-3.5" />
                  </>
                ) : (
                  <>
                    Show more ({sorted.length - 6}) <ChevronDown className="size-3.5" />
                  </>
                )}
              </button>
            )}
          </div>
        )}

        {step === 2 && picked && (
          <div className="grid gap-4 py-2">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">Label</div>
                <div className="text-muted-foreground text-xs">Shown in the provider list.</div>
              </div>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={picked.label}
                className="max-w-56"
                aria-label="Provider label"
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">Provider ID</div>
                <div className="text-muted-foreground text-xs">Identifier used by REO backend routing.</div>
              </div>
              <Badge variant="outline" className="font-mono text-xs">{picked.id}</Badge>
            </div>
          </div>
        )}

        {step === 3 && picked && (
          <div className="grid gap-4 py-2">
            {picked.kind === "cli" ? (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Binary path</div>
                    <div className="text-muted-foreground text-xs">Leave blank for automatic CLI discovery.</div>
                  </div>
                  <Input
                    value={binaryPath}
                    onChange={(e) => setBinaryPath(e.target.value)}
                    placeholder={picked.detectedPath ?? "Automatic"}
                    className="max-w-60"
                    aria-label="Binary path"
                  />
                </div>
                {picked.supportsHomeDir && (
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">Home folder</div>
                      <div className="text-muted-foreground text-xs">Custom config &amp; sign-in directory.</div>
                    </div>
                    <Input
                      value={homeDir}
                      onChange={(e) => setHomeDir(e.target.value)}
                      placeholder="Default folder"
                      className="max-w-60"
                      aria-label="Home folder"
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium">API key</div>
                  <div className="text-muted-foreground text-xs">
                    {canStoreKey
                      ? "Stored encrypted in your OS credential store."
                      : `No OS key store; set ${picked.envVar ?? "environment variable"}.`}
                  </div>
                </div>
                <div className="flex max-w-60 items-center gap-1.5">
                  <KeyRound className="text-muted-foreground size-4 shrink-0" />
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    disabled={!canStoreKey}
                    placeholder={picked.keySource ? "Already set (paste to replace)" : "Paste API key..."}
                    autoComplete="off"
                    aria-label="API key"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === 1 ? (
            <>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" variant="outline" disabled={!picked || busy} onClick={() => setStep(2)}>
                Configure manually
              </Button>
              {picked?.kind === "cli" && (
                <Button type="button" disabled={busy} onClick={handleOfficialSignIn}>
                  <ProviderIcon id={picked.id} kind={picked.kind} />
                  {officialSignInLabel(picked.id)}
                </Button>
              )}
            </>
          ) : step === 2 ? (
            <>
              <Button type="button" variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button type="button" onClick={() => setStep(3)}>
                Next
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button type="button" disabled={busy} onClick={handleSaveManual}>
                {busy ? "Saving..." : "Add provider"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
