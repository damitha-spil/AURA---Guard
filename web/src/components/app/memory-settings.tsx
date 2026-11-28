// Settings > Memory: what REO was asked to remember ("remember that ..."). List, edit, delete, add.
// Stored on this computer only. Anything that looks like a secret or a private value is refused.
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

interface Entry { id: string; text: string; created: string; updated: string }
interface Reply { entries: Entry[]; max: number; maxChars: number }

export function MemorySettings() {
  const [data, setData] = React.useState<Reply | null>(null);
  const [draft, setDraft] = React.useState("");
  const [editing, setEditing] = React.useState<{ id: string; text: string } | null>(null);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    const r = await apiGet<Reply>("/api/memory");
    if (r.ok) setData(r.data);
    else setError(r.error || "Could not load memory.");
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  async function add() {
    const r = await apiPost("/api/memory", { text: draft });
    if (!r.ok) return void toast.error(r.error || "Could not remember that.");
    setDraft("");
    void load();
  }
  async function save() {
    if (!editing) return;
    const r = await apiPatch(`/api/memory/${editing.id}`, { text: editing.text });
    if (!r.ok) return void toast.error(r.error || "Could not save.");
    setEditing(null);
    void load();
  }
  async function remove(id: string) {
    const r = await apiDelete(`/api/memory/${id}`);
    if (!r.ok) return void toast.error(r.error || "Could not delete.");
    void load();
  }

  const max = data?.maxChars ?? 300;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memory</CardTitle>
        <CardDescription>
          Short notes REO keeps on this computer and adds to every chat, such as how you like answers. Say &quot;remember that ...&quot; in a chat to add one.
          Memory is not a source for facts about the project: those still need a cited note, commit or file. Secrets and private values (names, e-mail addresses) are refused.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {error && <p className="text-destructive" role="alert">{error}</p>}
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Input value={draft} maxLength={max} onChange={(e) => setDraft(e.target.value)} placeholder="Something for REO to remember" aria-label="New memory" />
          <Button type="submit" disabled={!draft.trim() || (data ? data.entries.length >= data.max : false)}>Remember</Button>
        </form>
        {data && <p className="text-muted-foreground text-xs">{data.entries.length} of {data.max} used. Up to {max} characters each.</p>}
        {data && data.entries.length === 0 && <p className="text-muted-foreground">Nothing is remembered yet.</p>}
        <ul className="divide-y rounded-2xl border">
          {(data?.entries ?? []).slice().reverse().map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 p-3">
              {editing?.id === e.id ? (
                <>
                  <Input className="min-w-0 flex-1" value={editing.text} maxLength={max} onChange={(ev) => setEditing({ id: e.id, text: ev.target.value })} aria-label="Edit memory" />
                  <Button size="sm" onClick={() => void save()} disabled={!editing.text.trim()}>Save</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 break-words">{e.text}</span>
                  <Button size="sm" variant="outline" onClick={() => setEditing({ id: e.id, text: e.text })}>Edit</Button>
                  <Button size="sm" variant="outline" onClick={() => void remove(e.id)}>Delete</Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
