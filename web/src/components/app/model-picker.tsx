import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ModelChoice = { id: string; label: string; note: string; backends: string[] };

export function familyOf(label: string): string {
  const base = label.split(" (")[0].trim();
  const words = base.split(" ");
  return /^gemini/i.test(base) ? words.slice(0, 3).join(" ") : words[0];
}

/** Searchable model list grouped by family. Shows a check on the selected model. */
export function ModelPicker({ choices, current, onPick, className, compact }: { choices: ModelChoice[]; current: string; onPick: (id: string) => void; className?: string; compact?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const groups = new Map<string, ModelChoice[]>();
  for (const m of choices) {
    const f = familyOf(m.label);
    groups.set(f, [...(groups.get(f) || []), m]);
  }
  const selected = choices.find((m) => m.id === current);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={compact ? "ghost" : "outline"} size={compact ? "sm" : "default"} role="combobox" aria-expanded={open} className={cn("min-w-0 justify-between", compact ? "max-w-full" : "w-full", className)}>
          <span className="min-w-0 flex-1 truncate text-left">
            {selected ? selected.label : current ? `${current} (custom)` : "Select model"}
          </span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${choices.length} models...`} />
          <CommandList className="max-h-72">
            <CommandEmpty>No model found.</CommandEmpty>
            {[...groups.entries()].map(([family, list]) => (
              <CommandGroup key={family} heading={family}>
                {list.map((m) => (
                  <CommandItem
                    key={m.id}
                    value={`${m.label} ${m.id} ${m.note}`}
                    onSelect={() => {
                      setOpen(false);
                      onPick(m.id);
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{m.label}</span>
                      {m.note && <span className="text-muted-foreground block truncate text-xs">{m.note}</span>}
                    </span>
                    {m.id === current && <Check className="size-4" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
