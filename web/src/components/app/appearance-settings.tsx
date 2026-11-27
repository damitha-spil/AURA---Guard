import * as React from "react";
import { Brush, Check, Copy, Moon, Pencil, RotateCcw, Sun, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { resetAppearance, updateAppearance, useAppearance, type Appearance, type CustomTheme } from "@/lib/appearance";
import { COLOR_THEMES, RADII, themeAccent, themeSeed, type Accent, type ColorTheme, type Radius } from "@/lib/themes";
import { cn } from "@/lib/utils";

type Scheme = "light dark" | "light" | "dark";

const SCHEMES = [
  { id: "light dark", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

// The drawn previews show both modes at once, so they cannot use the live colour variables.
const SURFACES = {
  light: { page: "oklch(0.99 0 0)", side: "oklch(0.95 0 0)", line: "oklch(0.88 0 0)", edge: "oklch(0.9 0 0)" },
  dark: { page: "oklch(0.18 0 0)", side: "oklch(0.23 0 0)", line: "oklch(0.34 0 0)", edge: "oklch(0.32 0 0)" },
};

const FOCUS = "focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]";

/** A small drawing of the app: sidebar, messages, composer and the accent dot. */
function MiniApp({ mode, accent }: { mode: "light" | "dark"; accent: Accent }) {
  const s = SURFACES[mode];
  const colour = accent[mode];
  const bar = (className: string, background: string = s.line) => <span className={cn("block h-1.5 rounded-full", className)} style={{ background }} />;
  return (
    <span aria-hidden className="flex h-full w-full" style={{ background: s.page }}>
      <span className="flex w-1/4 flex-col gap-1.5 p-1.5" style={{ background: s.side }}>
        {bar("w-full", colour)}
        {bar("w-full")}
        {bar("w-3/4")}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
        {bar("w-2/5 self-end opacity-70", colour)}
        {bar("w-3/4")}
        {bar("w-1/2")}
        <span className="mt-auto flex items-center justify-between gap-1 rounded-md border p-1" style={{ borderColor: s.edge }}>
          {bar("w-1/3")}
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: colour }} />
        </span>
      </span>
    </span>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid gap-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-40 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Range({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <>
      <span className="bg-muted w-14 rounded-md py-1 text-center font-mono text-xs tabular-nums">{value}%</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn("accent-primary w-36 rounded-full", FOCUS)}
      />
    </>
  );
}

function Pick<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger className={cn("w-40", className)} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, text]) => (
          <SelectItem key={v} value={v}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Orb({ colour, mode, selected }: { colour: string; mode: "light" | "dark"; selected: boolean }) {
  const base = mode === "light" ? "oklch(0.97 0 0)" : "oklch(0.16 0 0)";
  const Icon = mode === "light" ? Sun : Moon;
  return (
    <span className={cn("relative block rounded-full p-0.5 ring-2", selected ? "ring-primary" : "ring-transparent")}>
      <span
        className="ring-foreground/10 block size-11 rounded-full ring-1"
        style={{ background: `radial-gradient(circle at 65% 25%, ${colour} 10%, ${base} 95%)` }}
      />
      {selected && (
        <span className="bg-background absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full border">
          <Icon className="size-3" />
        </span>
      )}
    </span>
  );
}

function ThemeCard({
  label,
  accent,
  selected,
  onSelect,
  actions,
}: {
  label: string;
  accent: Accent;
  selected: boolean;
  onSelect: () => void;
  actions: React.ReactNode;
}) {
  return (
    <div className={cn("relative min-w-0 rounded-2xl border", selected ? "border-primary bg-muted" : "hover:bg-muted/60")}>
      <button type="button" onClick={onSelect} aria-pressed={selected} className={cn("flex w-full flex-col gap-3 rounded-2xl p-3 text-left", FOCUS)}>
        <span className="flex justify-center gap-4 pt-1">
          <Orb colour={accent.light} mode="light" selected={selected} />
          <Orb colour={accent.dark} mode="dark" selected={selected} />
        </span>
        <span className="flex min-h-7 items-center gap-1 pr-16 text-sm font-medium">
          {selected && <Check className="size-4 shrink-0" />}
          <span className="truncate">{label}</span>
        </span>
      </button>
      <div className="absolute right-2 bottom-2.5 flex">{actions}</div>
    </div>
  );
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={label} title={label} onClick={onClick}>
      {children}
    </Button>
  );
}

function ThemeEditor({
  draft,
  replaces,
  onChange,
  onCancel,
  onSave,
}: {
  draft: CustomTheme;
  replaces: boolean;
  onChange: (t: CustomTheme) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const accent = themeAccent("custom", draft);
  const hues = [0, 60, 120, 180, 240, 300, 360].map((h) => `oklch(0.6 0.17 ${h})`).join(", ");
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Custom theme</DialogTitle>
          <DialogDescription>
            {replaces ? "You can keep one custom theme. Saving replaces it." : "Pick an accent colour for light and dark."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="theme-name">Name</Label>
            <Input id="theme-name" value={draft.name} maxLength={24} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="theme-hue">Accent hue: {Math.round(draft.hue)}</Label>
            <span className="h-2 rounded-full" style={{ background: `linear-gradient(to right, ${hues})` }} />
            <input id="theme-hue" type="range" min={0} max={360} value={draft.hue} onChange={(e) => onChange({ ...draft, hue: Number(e.target.value) })} className={cn("accent-primary w-full rounded-full", FOCUS)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="theme-chroma">Colour strength: {Math.round((draft.chroma / 0.25) * 100)}%</Label>
            <input id="theme-chroma" type="range" min={0} max={0.25} step={0.01} value={draft.chroma} onChange={(e) => onChange({ ...draft, chroma: Number(e.target.value) })} className={cn("accent-primary w-full rounded-full", FOCUS)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(["light", "dark"] as const).map((mode) => (
              <span key={mode} className="h-24 overflow-hidden rounded-xl border">
                <MiniApp mode={mode} accent={accent} />
              </span>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">Save and apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const SAMPLE_DIFF: { n: number; kind: "same" | "del" | "add"; text: string }[] = [
  { n: 1, kind: "same", text: "export function verdict(checks: Check[]) {" },
  { n: 2, kind: "del", text: '  return checks.length ? "pass" : "fail";' },
  { n: 2, kind: "add", text: '  return checks.every((c) => c.ok) ? "pass" : "fail"; // 0O 1lI' },
  { n: 3, kind: "same", text: "}" },
];

export function AppearanceSettings({
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
  const a = useAppearance();
  const [draft, setDraft] = React.useState<CustomTheme | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const activeAccent = themeAccent(colorTheme, a.custom);

  const startTheme = (from: ColorTheme, label: string) =>
    setDraft({ name: `${label} copy`.slice(0, 24), ...themeSeed(from, a.custom) });

  function saveTheme() {
    if (!draft) return;
    updateAppearance({ custom: { ...draft, name: draft.name.trim() || "My theme" } });
    onColorTheme("custom");
    setDraft(null);
  }

  function deleteTheme() {
    if (colorTheme === "custom") onColorTheme("green");
    updateAppearance({ custom: null });
    setConfirmDelete(false);
  }

  function reset() {
    resetAppearance();
    onSchemeChange("light dark");
    onColorTheme("green");
    onRadius("default");
  }

  const set = (patch: Partial<Appearance>) => updateAppearance(patch);

  return (
    <div className="@container grid gap-8">
      <Section title="Color scheme">
        <div className="grid grid-cols-3 gap-3">
          {SCHEMES.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={scheme === s.id}
              onClick={() => onSchemeChange(s.id)}
              className={cn(
                "min-w-0 rounded-2xl border-2 p-1.5",
                FOCUS,
                scheme === s.id ? "border-primary bg-muted" : "hover:bg-muted/60 border-border",
              )}
            >
              <span className="relative block h-20 overflow-hidden rounded-xl border @lg:h-32">
                {s.id !== "dark" && <MiniApp mode="light" accent={activeAccent} />}
                {s.id === "dark" && <MiniApp mode="dark" accent={activeAccent} />}
                {s.id === "light dark" && (
                  <span className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
                    <MiniApp mode="dark" accent={activeAccent} />
                  </span>
                )}
              </span>
              <span className={cn("block pt-1.5 text-xs font-medium", scheme !== s.id && "text-muted-foreground")}>{s.label}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="Themes"
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => (a.custom ? setDraft(a.custom) : startTheme(colorTheme, "My theme"))}>
            <Brush />
            {a.custom ? "Edit custom theme" : "Create theme"}
          </Button>
        }
      >
        <div className="grid grid-cols-1 gap-3 @3xs:grid-cols-2 @lg:grid-cols-3">
          {COLOR_THEMES.map((t) => (
            <ThemeCard
              key={t.id}
              label={t.label}
              accent={themeAccent(t.id, a.custom)}
              selected={colorTheme === t.id}
              onSelect={() => onColorTheme(t.id)}
              actions={
                <IconAction label={`Start a custom theme from ${t.label}`} onClick={() => startTheme(t.id, t.label)}>
                  <Copy />
                </IconAction>
              }
            />
          ))}
          {a.custom && (
            <ThemeCard
              label={a.custom.name}
              accent={themeAccent("custom", a.custom)}
              selected={colorTheme === "custom"}
              onSelect={() => onColorTheme("custom")}
              actions={
                <>
                  <IconAction label="Edit custom theme" onClick={() => setDraft(a.custom)}>
                    <Pencil />
                  </IconAction>
                  <IconAction label="Delete custom theme" onClick={() => setConfirmDelete(true)}>
                    <Trash2 />
                  </IconAction>
                </>
              }
            />
          )}
        </div>
      </Section>

      <Section title="Interface">
        <div className="bg-card divide-y rounded-2xl border">
          <Row title="Contrast" description="How strong secondary text and borders look.">
            <Range label="Contrast" value={a.contrast} min={50} max={150} onChange={(contrast) => set({ contrast })} />
          </Row>
          <Row title="Glass opacity" description="Lower values let the page show through menus, dialogs and the message box.">
            <Range label="Glass opacity" value={a.glass} min={50} max={100} onChange={(glass) => set({ glass })} />
          </Row>
          <Row title="Chat width" description="How wide messages and the message box can grow.">
            <Pick
              label="Chat width"
              value={a.chatWidth}
              options={[["compact", "Compact"], ["comfortable", "Comfortable"], ["wide", "Wide"], ["full", "Full"]]}
              onChange={(chatWidth) => set({ chatWidth })}
            />
          </Row>
          <Row title="Corner radius" description="How round cards, buttons and inputs are.">
            <Pick label="Corner radius" value={radius} options={RADII.map((r) => [r.id, r.label] as const)} onChange={onRadius} />
          </Row>
          <Row title="Work details" description="Show the plan and tool steps in the chat by default.">
            <Switch aria-label="Work details" checked={a.showWork} onCheckedChange={(showWork) => set({ showWork })} />
          </Row>
          <Row title="Reduce motion" description="Turn off animations and smooth scrolling.">
            <Switch aria-label="Reduce motion" checked={a.reduceMotion} onCheckedChange={(reduceMotion) => set({ reduceMotion })} />
          </Row>
        </div>
      </Section>

      <Section title="Typography">
        <div className="bg-card divide-y rounded-2xl border">
          <div>
            <Row title="Interface font" description="Everything except code.">
              <Pick
                label="Interface font"
                value={a.uiFont}
                options={[["inter", "Inter Variable"], ["system", "System font"], ["segoe", "Segoe UI"], ["arial", "Arial"], ["georgia", "Georgia"]]}
                onChange={(uiFont) => set({ uiFont })}
              />
              <Pick
                label="Interface font size"
                className="w-24"
                value={String(a.uiSize)}
                options={[13, 14, 15, 16, 17, 18].map((n) => [String(n), `${n} px`] as const)}
                onChange={(v) => set({ uiSize: Number(v) })}
              />
            </Row>
            <p className="mx-4 mb-4 rounded-xl border p-3 text-sm">
              Ask REO to check why the <span className="text-primary font-medium">sign-in test</span> fails now and then, and list what
              to fix before release.
            </p>
          </div>
          <div>
            <Row title="Monospace font" description="Code, diffs, file previews and command output.">
              <Pick
                label="Monospace font"
                value={a.monoFont}
                options={[["default", "System mono"], ["consolas", "Consolas"], ["cascadia", "Cascadia Mono"], ["courier", "Courier New"]]}
                onChange={(monoFont) => set({ monoFont })}
              />
              <Pick
                label="Monospace font size"
                className="w-28"
                value={String(a.monoSize)}
                options={[0, 11, 12, 13, 14, 15, 16].map((n) => [String(n), n ? `${n} px` : "Default"] as const)}
                onChange={(v) => set({ monoSize: Number(v) })}
              />
            </Row>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 px-4 pb-4">
              <div className="overflow-hidden rounded-xl border">
                <div className="bg-muted flex justify-between gap-2 px-3 py-2 font-mono text-xs">
                  <span className="truncate">src/review/verdict.ts</span>
                  <span className="shrink-0">-1 +1</span>
                </div>
                <pre className="overflow-x-auto py-1 font-mono text-xs">
                  {SAMPLE_DIFF.map((l, i) => (
                    <div
                      key={i}
                      className={cn("flex gap-3 px-3", l.kind === "del" && "bg-destructive/15", l.kind === "add" && "bg-primary/15")}
                    >
                      <span className="text-muted-foreground shrink-0">
                        {l.n} {l.kind === "del" ? "-" : l.kind === "add" ? "+" : " "}
                      </span>
                      <code className="min-w-0">{l.text}</code>
                    </div>
                  ))}
                </pre>
              </div>
              <pre className="bg-muted overflow-x-auto rounded-xl border p-3 font-mono text-xs">
                <span className="text-primary">reo&gt;</span> /status{"\n\n"}
                {"  "}Notes indexed   128{"\n"}
                {"  "}Repos indexed   2{"\n\n"}
                <span className="text-primary">  12 passed</span>   1 warning   <span className="text-destructive">0 failed</span>
                {"\n"}
                {"  "}Review ready. REO suggests changes; a person decides what is merged.
              </pre>
            </div>
          </div>
          <Row title="Word wrap" description="Wrap long lines in all code blocks. When off, each screen keeps its usual layout.">
            <Switch aria-label="Word wrap" checked={a.wordWrap} onCheckedChange={(wordWrap) => set({ wordWrap })} />
          </Row>
        </div>
      </Section>

      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={reset}>
          <RotateCcw />
          Reset to defaults
        </Button>
      </div>

      {draft && <ThemeEditor draft={draft} replaces={a.custom !== null} onChange={setDraft} onCancel={() => setDraft(null)} onSave={saveTheme} />}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your custom theme?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteTheme}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
