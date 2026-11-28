import * as React from "react";
import { Check, Search, Star } from "lucide-react";
import { ProviderIcon } from "@/components/app/add-provider-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface ChatModelChoice {
  id: string;
  label: string;
  note?: string;
  backends: string[];
}

export interface ChatBackendChoice {
  id: string;
  label: string;
  available: boolean;
}

export interface ChatModelPickerProps {
  backends: ChatBackendChoice[];
  catalogue: ChatModelChoice[];
  pickedBackend: string | null;
  currentModels: Record<string, string>;
  disabled?: boolean;
  onSelect: (backendId: string, modelId: string) => void;
}

const THINKING_LEVELS = ["Low", "Medium", "High", "Extra"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const FAV_STORAGE_KEY = "reo-fav-models";

function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAV_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveFavorites(ids: string[]): void {
  try {
    localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* ignore storage errors */
  }
}

function inferKind(id: string): "api" | "cli" {
  return id.endsWith("-cli") ? "cli" : "api";
}

function baseModelName(label: string): string {
  return label.replace(/\s*\((Low|Medium|High|Extra)\)\s*$/i, "").trim();
}

function levelOf(label: string): ThinkingLevel | null {
  const m = /\((Low|Medium|High|Extra)\)\s*$/i.exec(label);
  if (!m) return null;
  const norm = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return THINKING_LEVELS.includes(norm as ThinkingLevel) ? (norm as ThinkingLevel) : null;
}

export function ChatModelPicker({
  backends,
  catalogue,
  pickedBackend,
  currentModels,
  disabled,
  onSelect,
}: ChatModelPickerProps) {
  const available = React.useMemo(() => backends.filter((b) => b.available), [backends]);
  const [open, setOpen] = React.useState(false);
  const [rail, setRail] = React.useState<string>(() => pickedBackend || available[0]?.id || "favorites");
  const [query, setQuery] = React.useState("");
  const [favorites, setFavorites] = React.useState<string[]>(() => loadFavorites());
  const [effort, setEffort] = React.useState<ThinkingLevel>("Low");

  const activeBackendId = pickedBackend && available.some((b) => b.id === pickedBackend) ? pickedBackend : available[0]?.id ?? null;
  const activeModelId = activeBackendId ? currentModels[activeBackendId] : undefined;
  const activeChoice = catalogue.find((m) => m.id === activeModelId);
  const activeLabel = activeChoice?.label || activeModelId || "Select model";

  React.useEffect(() => {
    if (open) {
      setRail(activeBackendId || "favorites");
      setQuery("");
      const detected = activeChoice ? levelOf(activeChoice.label) : null;
      if (detected) setEffort(detected);
    }
  }, [open, activeBackendId, activeChoice]);

  if (available.length === 0) return null;

  const toggleFav = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites((prev) => {
      const next = prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key];
      saveFavorites(next);
      return next;
    });
  };

  const q = query.trim().toLowerCase();
  const rows: { backend: ChatBackendChoice; model: ChatModelChoice }[] = [];
  if (rail === "favorites") {
    for (const b of available) {
      for (const m of catalogue) {
        if (!m.backends.includes(b.id)) continue;
        if (favorites.includes(`${b.id}::${m.id}`)) rows.push({ backend: b, model: m });
      }
    }
  } else {
    const b = available.find((x) => x.id === rail) ?? available[0];
    if (b) {
      for (const m of catalogue) {
        if (m.backends.includes(b.id)) rows.push({ backend: b, model: m });
      }
    }
  }

  const filtered = q
    ? rows.filter((r) => `${r.backend.label} ${r.model.label} ${r.model.id}`.toLowerCase().includes(q))
    : rows;

  const handleEffortPick = (lvl: ThinkingLevel) => {
    setEffort(lvl);
    if (!activeBackendId) return;
    const base = activeChoice ? baseModelName(activeChoice.label).toLowerCase() : "";
    const match = catalogue.find(
      (m) =>
        m.backends.includes(activeBackendId) &&
        baseModelName(m.label).toLowerCase() === base &&
        levelOf(m.label) === lvl,
    );
    if (match) {
      onSelect(activeBackendId, match.id);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          className="h-8 max-w-64 min-w-0 gap-1.5 rounded-full px-3 text-xs font-medium"
          aria-label="Active provider and model"
        >
          {activeBackendId && <ProviderIcon id={activeBackendId} kind={inferKind(activeBackendId)} className="size-3.5" />}
          <span className="min-w-0 truncate">{activeLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-glass-surface="popover"
        className="w-[34rem] max-w-[95vw] overflow-hidden rounded-2xl p-0 shadow-xl"
        align="start"
      >
        <div className="grid min-h-72 grid-cols-[2.75rem_minmax(0,1fr)_9.5rem]">
          {/* Left provider icon rail */}
          <div className="bg-muted/40 flex flex-col items-center gap-1 border-r py-2">
            <button
              type="button"
              title="Favorites"
              aria-label="Favorite models"
              onClick={() => setRail("favorites")}
              className={cn(
                "relative flex size-8 items-center justify-center rounded-lg transition-colors",
                rail === "favorites" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {rail === "favorites" && <span className="bg-primary absolute top-1.5 bottom-1.5 -left-1.5 w-0.5 rounded-full" />}
              <Star className="size-4" />
            </button>
            {available.map((b) => {
              const selected = rail === b.id;
              return (
                <button
                  key={b.id}
                  type="button"
                  title={b.label}
                  aria-label={b.label}
                  onClick={() => setRail(b.id)}
                  className={cn(
                    "relative flex size-8 items-center justify-center rounded-lg transition-colors",
                    selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {selected && <span className="bg-primary absolute top-1.5 bottom-1.5 -left-1.5 w-0.5 rounded-full" />}
                  <ProviderIcon id={b.id} kind={inferKind(b.id)} className="size-4" />
                </button>
              );
            })}
          </div>

          {/* Middle searchable model list */}
          <div className="flex min-w-0 flex-col border-r">
            <div className="relative border-b px-2.5 py-2">
              <Search className="text-muted-foreground pointer-events-none absolute top-4.5 left-4.5 size-3.5" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models..."
                className="placeholder:text-muted-foreground w-full bg-transparent pr-2 pl-6 text-xs outline-none"
                aria-label="Search models"
              />
            </div>
            <div className="max-h-68 flex-1 overflow-y-auto p-1.5">
              {filtered.map(({ backend, model }, idx) => {
                const isSelected = activeBackendId === backend.id && activeModelId === model.id;
                const favKey = `${backend.id}::${model.id}`;
                const isFav = favorites.includes(favKey);
                return (
                  <div
                    key={favKey}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      onSelect(backend.id, model.id);
                      const detected = levelOf(model.label);
                      if (detected) setEffort(detected);
                      setOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(backend.id, model.id);
                        setOpen(false);
                      }
                    }}
                    className={cn(
                      "group/mrow hover:bg-muted/80 flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors",
                      isSelected && "bg-muted",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <ProviderIcon id={backend.id} kind={inferKind(backend.id)} className="size-3.5" />
                      <span className="truncate font-medium">{model.label}</span>
                      {isSelected && <Check className="text-primary size-3.5 shrink-0" />}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={isFav ? "Remove favorite" : "Star model"}
                        onClick={(e) => toggleFav(favKey, e)}
                        className={cn(
                          "text-muted-foreground hover:text-foreground transition-opacity",
                          isFav ? "opacity-100" : "opacity-0 group-hover/mrow:opacity-100",
                        )}
                      >
                        <Star className={cn("size-3", isFav && "fill-amber-400 text-amber-400")} />
                      </button>
                      {idx < 9 && (
                        <kbd className="bg-muted text-muted-foreground rounded px-1 py-0.5 font-mono text-[10px]">
                          Ctrl+{idx + 1}
                        </kbd>
                      )}
                    </span>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <p className="text-muted-foreground p-4 text-center text-xs">
                  {rail === "favorites" && favorites.length === 0
                    ? "Star models to pin them here."
                    : "No matching models."}
                </p>
              )}
            </div>
          </div>

          {/* Right thinking-level column */}
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center justify-between gap-1 border-b px-3 py-2">
              <span className="text-muted-foreground text-[11px] font-medium">Thinking Level</span>
              <span className="text-muted-foreground max-w-14 truncate text-[10px]">{activeLabel}</span>
            </div>
            <div className="flex flex-1 flex-col gap-0.5 p-1.5">
              {THINKING_LEVELS.map((lvl) => {
                const chosen = effort === lvl;
                return (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => handleEffortPick(lvl)}
                    className={cn(
                      "hover:bg-muted/80 flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
                      chosen && "bg-muted font-medium",
                    )}
                  >
                    <span>{lvl}</span>
                    {chosen && <Check className="text-primary size-3.5 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
