import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, Page, PageHeader } from "@/components/app/page";
import { apiGet, apiPatch, apiPost } from "@/lib/api";

type ItemStatus = "open" | "done";

interface Followup {
  id: string;
  text: string;
  owner: string;
  due: string | null;
  status: ItemStatus;
  link: string | null;
}

interface Task {
  id: string;
  text: string;
  status: ItemStatus;
}

interface Chat {
  id: string;
  title?: string;
}

function Row({ text, detail, status, onToggle }: { text: string; detail?: string; status: ItemStatus; onToggle: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-3 p-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm break-words">{text}</div>
        {detail && <div className="text-muted-foreground text-xs break-words">{detail}</div>}
      </div>
      <Badge variant={status === "done" ? "secondary" : "outline"}>{status}</Badge>
      <Button variant="outline" size="sm" onClick={onToggle}>{status === "done" ? "Reopen" : "Mark done"}</Button>
    </li>
  );
}

function Followups() {
  const [items, setItems] = React.useState<Followup[] | null>(null);
  const [error, setError] = React.useState("");
  const [text, setText] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [due, setDue] = React.useState("");
  const [link, setLink] = React.useState("");

  const load = React.useCallback(async () => {
    const r = await apiGet<{ followups: Followup[] }>("/api/followups");
    if (r.ok) setItems(r.data.followups || []);
    else setError(r.error || "Could not load follow-ups.");
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    const r = await apiPost("/api/followups", { text, owner, due, link: link.trim() });
    if (!r.ok) return void toast.error(r.error || "Could not save the follow-up.");
    setText("");
    setDue("");
    setLink("");
    load();
  }

  async function toggle(f: Followup) {
    const r = await apiPatch(`/api/followups/${encodeURIComponent(f.id)}`, { status: f.status === "done" ? "open" : "done" });
    if (!r.ok) toast.error(r.error || "Could not update the follow-up.");
    load();
  }

  const sorted = [...(items ?? [])].sort((a, b) => Number(a.status === "done") - Number(b.status === "done"));
  return (
    <div className="grid gap-4">
      <Card className="p-4">
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2 sm:col-span-2">
            <Label htmlFor="fu-text">What needs to be done</Label>
            <Input id="fu-text" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fu-owner">Who (optional)</Label>
            <Input id="fu-owner" value={owner} maxLength={80} onChange={(e) => setOwner(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fu-due">Due date (optional)</Label>
            <Input id="fu-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fu-link">Defect or run id (optional)</Label>
            <Input id="fu-link" value={link} maxLength={80} onChange={(e) => setLink(e.target.value)} />
          </div>
          <Button type="submit" className="self-end justify-self-start" disabled={!text.trim()}>Add follow-up</Button>
        </form>
      </Card>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      {items?.length === 0 && <EmptyState title="No follow-ups yet" />}
      {sorted.length > 0 && (
        <ul className="divide-y rounded-2xl border">
          {sorted.map((f) => (
            <Row
              key={f.id}
              text={f.text}
              detail={[f.owner, f.due ? `due ${f.due}` : "", f.link ?? ""].filter(Boolean).join(" · ")}
              status={f.status}
              onToggle={() => toggle(f)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionTasks() {
  const [chats, setChats] = React.useState<Chat[] | null>(null);
  const [session, setSession] = React.useState("");
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [text, setText] = React.useState("");

  React.useEffect(() => {
    apiGet<{ chats: Chat[] }>("/api/chats").then((r) => {
      const list = r.ok ? r.data.chats || [] : [];
      setChats(list);
      if (list[0]) setSession(list[0].id);
    });
  }, []);

  const load = React.useCallback(async (id: string) => {
    const r = await apiGet<{ tasks: Task[] }>(`/api/tasks?session=${encodeURIComponent(id)}`);
    if (r.ok) setTasks(r.data.tasks || []);
    else toast.error(r.error || "Could not load tasks.");
  }, []);
  React.useEffect(() => {
    setTasks([]);
    if (session) load(session);
  }, [session, load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !session) return;
    const r = await apiPost("/api/tasks", { sessionId: session, text });
    if (!r.ok) return void toast.error(r.error || "Could not save the task.");
    setText("");
    load(session);
  }

  async function toggle(t: Task) {
    const r = await apiPatch(`/api/tasks/${encodeURIComponent(t.id)}`, { status: t.status === "done" ? "open" : "done" });
    if (!r.ok) toast.error(r.error || "Could not update the task.");
    load(session);
  }

  if (chats?.length === 0) return <EmptyState title="No chats yet" description="Start a chat in the Workspace. Each chat has its own task list." />;
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label>Chat</Label>
        <Select value={session} onValueChange={setSession}>
          <SelectTrigger className="w-full sm:max-w-md" aria-label="Chat"><SelectValue placeholder="Choose a chat" /></SelectTrigger>
          <SelectContent>
            {(chats ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.title || c.id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <form onSubmit={add} className="flex flex-wrap gap-2">
        <Input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="New task" aria-label="New task" className="w-full sm:max-w-md" />
        <Button type="submit" disabled={!text.trim() || !session}>Add task</Button>
      </form>
      {session && tasks.length === 0 && <EmptyState title="No tasks for this chat" />}
      {tasks.length > 0 && (
        <ul className="divide-y rounded-2xl border">
          {tasks.map((t) => (
            <Row key={t.id} text={t.text} status={t.status} onToggle={() => toggle(t)} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function FollowupsView() {
  return (
    <Page>
      <PageHeader title="Follow-ups" description="Things to come back to. Saved on this computer. Text that looks like a secret is not saved." />
      <Tabs defaultValue="followups">
        <TabsList>
          <TabsTrigger value="followups">Follow-ups</TabsTrigger>
          <TabsTrigger value="tasks">Chat tasks</TabsTrigger>
        </TabsList>
        <TabsContent value="followups"><Followups /></TabsContent>
        <TabsContent value="tasks"><SessionTasks /></TabsContent>
      </Tabs>
    </Page>
  );
}
