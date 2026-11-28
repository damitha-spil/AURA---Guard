// Saved prompts in the chat box. The engine keeps them and refuses any that hold a secret.
import * as React from "react";
import { BookText, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { apiDelete, apiGet, apiPost } from "@/lib/api";

interface SavedPrompt {
  id: string;
  name: string;
  text: string;
}

export function SavedPrompts({ draft, onInsert }: { draft: string; onInsert: (text: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [prompts, setPrompts] = React.useState<SavedPrompt[] | null>(null);
  const [problem, setProblem] = React.useState("");
  const [filter, setFilter] = React.useState("");
  const [name, setName] = React.useState("");

  const load = React.useCallback(async () => {
    const r = await apiGet<{ prompts?: SavedPrompt[] }>("/api/prompts");
    if (r.ok && Array.isArray(r.data.prompts)) {
      setPrompts(r.data.prompts);
      setProblem("");
    } else {
      setPrompts([]);
      setProblem(r.error || "Could not load saved prompts.");
    }
  }, []);

  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function save() {
    if (!name.trim() || !draft.trim()) return;
    const r = await apiPost("/api/prompts", { name, text: draft });
    if (!r.ok) return void toast.error(r.error || "Could not save the prompt.");
    setName("");
    toast.success("Prompt saved");
    load();
  }

  async function remove(id: string) {
    const r = await apiDelete(`/api/prompts/${id}`);
    if (!r.ok) toast.error(r.error || "Could not delete the prompt.");
    load();
  }

  const q = filter.trim().toLowerCase();
  const shown = (prompts ?? []).filter((p) => !q || `${p.name} ${p.text}`.toLowerCase().includes(q));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="icon-sm" variant="ghost" className="rounded-full" aria-label="Saved prompts" title="Saved prompts">
          <BookText className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-80 gap-2 p-2">
        {(prompts?.length ?? 0) > 5 && (
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
            placeholder="Find a prompt..."
            aria-label="Find a saved prompt"
            className="h-8"
          />
        )}
        <div className="max-h-56 overflow-y-auto">
          {prompts === null && <p className="text-muted-foreground p-2 text-xs">Loading...</p>}
          {problem && <p className="text-destructive p-2 text-xs break-words">{problem}</p>}
          {prompts !== null && !problem && shown.length === 0 && (
            <p className="text-muted-foreground p-2 text-xs">{q ? "No prompt matches." : "No saved prompts yet. Type a message, name it below and save it."}</p>
          )}
          {shown.map((p) => (
            <div key={p.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onInsert(p.text);
                }}
                className="hover:bg-muted focus-visible:ring-ring/50 min-w-0 flex-1 rounded-xl px-2 py-1.5 text-left outline-none focus-visible:ring-[3px]"
              >
                <span className="block truncate text-sm font-medium">{p.name}</span>
                <span className="text-muted-foreground block truncate text-xs">{p.text}</span>
              </button>
              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Delete prompt ${p.name}`} onClick={() => remove(p.id)}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        <div className="flex gap-1 border-t pt-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // The popover belongs to the message form, so Enter must not send the message.
              if (e.key !== "Enter") return;
              e.preventDefault();
              save();
            }}
            maxLength={60}
            placeholder={draft.trim() ? "Name the typed message" : "Type a message to save one"}
            aria-label="Prompt name"
            className="h-8"
          />
          <Button type="button" size="sm" disabled={!name.trim() || !draft.trim()} onClick={save}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
