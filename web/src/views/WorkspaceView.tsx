import * as React from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Copy,
  FlaskConical,
  GitPullRequest,
  PanelRight,
  Plus,
  Search,
  Shield,
  Square,
  Trash2,
  TrendingUp,
} from "lucide-react";
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
} from "@/components/ui/alert-dialog";
import { BrandAvatar } from "@/components/app/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarGroup, SidebarGroupLabel } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { familyOf } from "@/components/app/model-picker";
import { cn } from "@/lib/utils";
import { useAppearance } from "@/lib/appearance";
import { BASIC_COMMANDS, SLASH_MENU, isRunnerCommand, slashName } from "@/lib/slash";
import { apiDelete, apiGet, apiPost, apiPut, streamNdjson } from "@/lib/api";

interface ChatSummary {
  id: string;
  title?: string;
  updated?: string;
}

interface WorkStep {
  label: string;
  status: string;
}

interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  ts?: string;
  error?: boolean;
  pending?: boolean;
  sources?: { ref: string; title?: string; kind?: string; status?: string }[];
  work?: { secs: number; steps: WorkStep[] };
}

interface MissionStep {
  id: string;
  agent: string;
  title: string;
  status: string;
}

interface ToolLog {
  agent: string;
  tool: string;
  status: string;
  detail: string;
  output?: unknown;
}

interface BrainSummary {
  wanted?: string;
  wantedSource?: string;
  picked: string | null;
  backends: { id: string; label: string; available: boolean }[];
  models: {
    current: Record<string, string>;
    catalogue: { id: string; label: string; note?: string; backends: string[] }[];
  };
}

interface AgentLite {
  id: string;
  name: string;
  role: string;
}

const PRESETS = [
  { icon: FlaskConical, title: "Inspect the UI", desc: "QA crawl of UI features and desktop windows", prompt: "@qa inspect UI features and desktop crawlers" },
  { icon: Shield, title: "Security audit", desc: "Probe localhost backend safety", prompt: "@security audit localhost backend safety" },
  { icon: GitPullRequest, title: "Review latest commit", desc: "Analyze the most recent changes", prompt: "@review analyze latest commit changes" },
  { icon: TrendingUp, title: "Trajectory and drift", desc: "7-day commits and knowledge drift", prompt: "@qe compute 7-day commit trajectory & KB drift" },
];

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function dayGroup(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "Older";
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startToday.getTime() - t) / 86400000) + 1;
  if (t >= startToday.getTime()) return "Today";
  if (days <= 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  return "Older";
}

const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Older"];

function friendlyTitle(t?: string): string {
  const v = (t || "").trim();
  return v.length > 3 ? v : "New chat";
}

/** A failed request arrives as the raw reply body; show only its error sentence. */
function errorText(message: unknown): string {
  const raw = String(message || "Error running request.");
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : raw;
  } catch {
    return raw;
  }
}

function statusVariant(s: string) {
  return s === "error" ? ("destructive" as const) : s === "done" ? ("default" as const) : ("secondary" as const);
}

function useIsXl() {
  const [xl, setXl] = React.useState(() => window.matchMedia("(min-width: 1280px)").matches);
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const on = () => setXl(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return xl;
}

export function WorkspaceView({
  initialPrompt,
  routeNotice,
  resetKey,
  active,
  headSlot,
  listSlot,
  onClearInitial,
  onOpenDefects,
}: {
  initialPrompt?: string;
  routeNotice?: string;
  resetKey: number;
  active: boolean;
  headSlot: HTMLElement | null;
  listSlot: HTMLElement | null;
  onClearInitial: () => void;
  onOpenDefects: () => void;
}) {
  const [chats, setChats] = React.useState<ChatSummary[]>([]);
  const [chatsLoaded, setChatsLoaded] = React.useState(false);
  const [chatSearch, setChatSearch] = React.useState("");
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<ChatMsg[]>([]);
  const [input, setInput] = React.useState("");
  const [notesOnly, setNotesOnly] = React.useState(false);
  const appearance = useAppearance();
  const [showWork, setShowWork] = React.useState(appearance.showWork);
  React.useEffect(() => setShowWork(appearance.showWork), [appearance.showWork]);
  const [webSearch, setWebSearch] = React.useState(false);
  const [runnerNames, setRunnerNames] = React.useState<string[]>(BASIC_COMMANDS);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [harnessOpen, setHarnessOpen] = React.useState(false);
  const [missionSub, setMissionSub] = React.useState("Ready for multi-agent execution");
  const [planSteps, setPlanSteps] = React.useState<MissionStep[]>([]);
  const [toolLogs, setToolLogs] = React.useState<ToolLog[]>([]);
  const [autoDefects, setAutoDefects] = React.useState<{ id: string; title: string }[]>([]);
  const [docSheet, setDocSheet] = React.useState<{ title: string; content: string } | null>(null);
  const [brain, setBrain] = React.useState<BrainSummary | null>(null);
  const [agents, setAgents] = React.useState<AgentLite[]>([]);
  const [deleteTarget, setDeleteTarget] = React.useState<ChatSummary | null>(null);
  const [modelOpen, setModelOpen] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const endRef = React.useRef<HTMLDivElement | null>(null);
  const isXl = useIsXl();

  const refreshBrain = React.useCallback(async () => {
    const r = await apiGet<BrainSummary>("/api/brain");
    if (r.ok) setBrain(r.data);
  }, []);

  async function switchModel(backendId: string, modelId: string) {
    const chosenLabel = brain?.models.catalogue.find((m) => m.id === modelId)?.label || modelId;
    setBrain((prev) =>
      prev
        ? {
            ...prev,
            picked: backendId,
            wanted: backendId,
            models: { ...prev.models, current: { ...prev.models.current, [backendId]: modelId } },
          }
        : prev,
    );
    const payload =
      brain?.wantedSource === "env"
        ? { models: { [backendId]: modelId } }
        : { backend: backendId, models: { [backendId]: modelId } };
    const r = await apiPut<BrainSummary>("/api/brain", payload);
    if (r.ok) {
      setBrain(r.data);
      toast.success(`Switched to ${chosenLabel}`);
    } else {
      refreshBrain();
      toast.error(r.error || "Could not switch model");
    }
  }

  async function refreshChats() {
    const r = await apiGet<{ chats: ChatSummary[] }>("/api/chats");
    if (r.ok) setChats(r.data.chats || []);
    setChatsLoaded(true);
  }

  async function openChat(id: string) {
    const r = await apiGet<{ id: string; messages: ChatMsg[] }>(`/api/chats/${id}`);
    if (r.ok) {
      setActiveId(id);
      setMessages(r.data.messages || []);
    }
  }

  const newChat = React.useCallback(() => {
    setActiveId(null);
    setMessages([]);
  }, []);

  async function deleteChat(id: string) {
    const r = await apiDelete(`/api/chats/${id}`);
    if (activeId === id) newChat();
    toast(r.ok ? "Chat deleted" : "Could not delete chat");
    refreshChats();
  }

  async function openSource(ref: string, title?: string) {
    const r = await apiGet<{ content?: string; text?: string; title?: string }>(
      `/api/doc?ref=${encodeURIComponent(ref)}`,
    );
    setDocSheet({
      title: r.data?.title || title || ref,
      content: r.data?.content || r.data?.text || r.error || "Document unavailable.",
    });
  }

  const runPrompt = React.useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      setBusy(true);
      const started = Date.now();
      const work: WorkStep[] = [];
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      let cid = activeId;
      if (!cid) {
        const created = await apiPost<{ id: string }>("/api/chats", {});
        if (created.ok && created.data.id) {
          cid = created.data.id;
          setActiveId(cid);
        }
      }

      setMessages((prev) => [
        ...prev,
        { role: "user", text: q },
        { role: "assistant", text: "Working...", pending: true },
      ]);

      // Slash lines other than /qa never start a mission, even if they contain words like "audit".
      const name = slashName(q);
      const runner = isRunnerCommand(q, runnerNames);
      const isMission =
        (!name || name === "qa") &&
        !runner &&
        (/^@(qa|qe|review|security|api|report)\b/i.test(q) || /\b(run mission|audit|probe|crawl|qa )\b/i.test(q));
      if (isMission) {
        setHarnessOpen(true);
        setPlanSteps([]);
        setToolLogs([]);
        setAutoDefects([]);
        setMissionSub("Planning specialist sub-agent mission...");
        await streamNdjson(
          "/api/reo/mission",
          { prompt: q },
          (ev) => {
            if (ev.type === "mission") {
              const ag = Array.isArray(ev.agents) ? ev.agents.join(", ") : "";
              setMissionSub(ev.status === "started" ? `Active agents: ${ag}` : `Completed (${ag})`);
            } else if (ev.type === "plan" && Array.isArray(ev.steps)) {
              setPlanSteps(ev.steps as MissionStep[]);
            } else if (ev.type === "tool") {
              work.push({ label: `${String(ev.agent || "").toUpperCase()} · ${String(ev.tool || "")}`, status: String(ev.status || "") });
              setToolLogs((prev) => [
                ...prev,
                {
                  agent: String(ev.agent || ""),
                  tool: String(ev.tool || ""),
                  status: String(ev.status || ""),
                  detail: String(ev.detail || ""),
                  output: ev.output,
                },
              ]);
            } else if (ev.type === "defect" && ev.defect) {
              const d = ev.defect as { id: string; title: string };
              setAutoDefects((prev) => [...prev, d]);
              toast(`Defect filed: ${d.id}`);
            }
          },
          ctrl.signal,
        ).catch(() => {});
      }

      const reply = (msg: Omit<ChatMsg, "role">) =>
        setMessages((prev) => [...prev.slice(0, -1), { role: "assistant", ...msg }]);

      if (runner) {
        let output = "";
        let finished = false;
        await streamNdjson(
          "/api/command",
          { line: q, chatId: cid },
          (ev) => {
            if (ev.type === "output") {
              output += String(ev.chunk || "");
              reply({ text: output, pending: !output });
            } else if (ev.type === "done") {
              finished = true;
              const note = ev.timedOut ? "\n\nStopped: it ran too long." : "";
              reply({ text: (output.trimEnd() || "(no output)") + note, error: ev.code !== 0 });
            } else if (ev.type === "error") {
              finished = true;
              reply({ text: errorText(ev.message), error: true });
            }
          },
          ctrl.signal,
        ).catch(() => {});
        if (!finished) reply({ text: output || "The command did not finish.", error: true });
      } else if (cid) {
        await streamNdjson(
          `/api/chats/${cid}/ask`,
          { question: q, notesOnly, ...(webSearch && !notesOnly ? { webSearch: true } : {}) },
          (ev) => {
            if (ev.type === "answer") {
              setMessages((prev) => [
                ...prev.slice(0, -1),
                {
                  role: "assistant",
                  text: String(ev.text || ""),
                  sources: Array.isArray(ev.sources) ? (ev.sources as ChatMsg["sources"]) : [],
                  work: work.length ? { secs: Math.max(1, Math.round((Date.now() - started) / 1000)), steps: work } : undefined,
                },
              ]);
            } else if (ev.type === "error") {
              setMessages((prev) => [
                ...prev.slice(0, -1),
                { role: "assistant", text: errorText(ev.message), error: true },
              ]);
            }
          },
          ctrl.signal,
        ).catch(() => {});
      }

      setBusy(false);
      refreshChats();
    },
    [activeId, busy, notesOnly, webSearch, runnerNames],
  );

  React.useEffect(() => {
    refreshChats();
    refreshBrain();
    apiGet<{ commands?: { name: string }[] }>("/api/commands").then((r) => {
      if (r.ok && r.data.commands) setRunnerNames(r.data.commands.map((c) => c.name));
    });
    apiGet<{ agents: AgentLite[] }>("/api/reo/agents").then((r) => {
      if (r.ok) setAgents(r.data.agents || []);
    });
  }, [refreshBrain]);

  React.useEffect(() => {
    if (resetKey > 0) newChat();
  }, [resetKey, newChat]);

  React.useEffect(() => {
    if (initialPrompt) {
      const p = initialPrompt;
      onClearInitial();
      runPrompt(p);
    }
  }, [initialPrompt, onClearInitial, runPrompt]);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: appearance.reduceMotion ? "auto" : "smooth" });
  }, [messages, appearance.reduceMotion]);

  const grouped = React.useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    const list = chats.filter((c) => !q || friendlyTitle(c.title).toLowerCase().includes(q));
    const map = new Map<string, ChatSummary[]>();
    for (const c of list) {
      const g = dayGroup(c.updated);
      map.set(g, [...(map.get(g) || []), c]);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [chats, chatSearch]);

  function submit() {
    const val = input;
    setInput("");
    runPrompt(val);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy");
    }
  }

  const mention = /(?:^|\s)@(\w*)$/.exec(input);
  const mentionAgents = mention
    ? agents.filter((a) => a.id.toLowerCase().startsWith(mention[1].toLowerCase())).slice(0, 6)
    : [];

  // The command menu shows while the first word of a "/" line is still being typed.
  const slash = /^\/([a-z]*)$/i.exec(input);
  const slashItems = slash ? SLASH_MENU.filter((c) => c.name.startsWith(slash[1].toLowerCase())) : [];

  function pickCommand(name: string) {
    setInput(`/${name} `);
    inputRef.current?.focus();
  }

  const availableBackends = brain ? brain.backends.filter((b) => b.available) : [];
  const activeModelId = brain?.picked ? brain.models.current[brain.picked] : undefined;
  const activeModelLabel = brain?.models.catalogue.find((m) => m.id === activeModelId)?.label || activeModelId;

  const modelPicker =
    availableBackends.length === 0 ? null : (
      <Popover open={modelOpen} onOpenChange={setModelOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" disabled={busy} className="max-w-64 min-w-0 gap-1" aria-label="Active model">
            <span className="min-w-0 truncate">{activeModelLabel || "Select model"}</span>
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search models..." />
            <CommandList className="max-h-72">
              <CommandEmpty>No model found.</CommandEmpty>
              {availableBackends.flatMap((b) => {
                const choices = brain!.models.catalogue.filter((m) => m.backends.includes(b.id));
                const fams = new Map<string, typeof choices>();
                for (const m of choices) fams.set(familyOf(m.label), [...(fams.get(familyOf(m.label)) || []), m]);
                return [...fams.entries()].map(([fam, list]) => (
                  <CommandGroup key={`${b.id}-${fam}`} heading={availableBackends.length > 1 ? `${b.label} · ${fam}` : fam}>
                    {list.map((m) => (
                      <CommandItem
                        key={`${b.id}::${m.id}`}
                        value={`${b.label} ${m.label} ${m.id} ${m.note || ""}`}
                        onSelect={() => {
                          setModelOpen(false);
                          switchModel(b.id, m.id);
                        }}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{m.label}</span>
                          {m.note && <span className="text-muted-foreground block truncate text-xs">{m.note}</span>}
                        </span>
                        {brain!.picked === b.id && brain!.models.current[b.id] === m.id && <Check className="size-4" />}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ));
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );

  // In an empty chat the composer sits mid-page, where a menu above it would be cut off.
  const menuSide = messages.length === 0 ? "top-full mt-2" : "bottom-full mb-2";

  const composer = (
    <div className="mx-auto w-full max-w-(--chat-width,48rem)">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        data-glass-surface="card"
        className="bg-card relative rounded-3xl border p-3 shadow-xs"
      >
        {mentionAgents.length > 0 && (
          <div data-glass-surface="popover" className={cn("bg-popover absolute right-3 left-3 z-10 rounded-2xl border p-1 shadow-md", menuSide)}>
            {mentionAgents.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setInput((v) => v.replace(/@\w*$/, `@${a.id} `))}
                className="hover:bg-muted flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm"
              >
                <Bot className="size-4 shrink-0" />
                <span className="font-medium">@{a.id}</span>
                <span className="text-muted-foreground min-w-0 truncate text-xs">{a.role}</span>
              </button>
            ))}
          </div>
        )}
        {slashItems.length > 0 && (
          <div data-glass-surface="popover" className={cn("bg-popover absolute right-3 left-3 z-10 max-h-72 overflow-y-auto rounded-2xl border p-1 shadow-md", menuSide)}>
            {slashItems.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => pickCommand(c.name)}
                className="hover:bg-muted flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm"
              >
                <span className="shrink-0 font-mono text-xs font-medium">{c.usage}</span>
                <span className="text-muted-foreground min-w-0 truncate text-xs">{c.help}</span>
              </button>
            ))}
          </div>
        )}
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Tab completes the first menu entry. Enter always sends what was typed.
            if (e.key === "Tab" && !e.shiftKey && slashItems.length > 0 && input.length > 1) {
              e.preventDefault();
              pickCommand(slashItems[0].name);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask a question, type @ for an agent or / for a command..."
          className="max-h-52 min-h-20 resize-none border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
          aria-label="Message"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {modelPicker}
            <Button type="button" size="sm" variant={showWork ? "secondary" : "outline"} aria-pressed={showWork} onClick={() => setShowWork((v) => !v)} className="rounded-full text-xs">
              Show work
            </Button>
            <Button type="button" size="sm" variant={notesOnly ? "secondary" : "outline"} aria-pressed={notesOnly} onClick={() => { if (!notesOnly) setWebSearch(false); setNotesOnly(!notesOnly); }} className="rounded-full text-xs">
              Notes only
            </Button>
            <Button type="button" size="sm" variant={webSearch ? "secondary" : "outline"} aria-pressed={webSearch} disabled={notesOnly} onClick={() => setWebSearch((v) => !v)} className="rounded-full text-xs">
              Web search
            </Button>
          </div>
          {busy ? (
            <Button type="button" size="icon" variant="destructive" className="rounded-full" aria-label="Stop" onClick={() => abortRef.current?.abort()}>
              <Square />
            </Button>
          ) : (
            <Button type="submit" size="icon" className="rounded-full" aria-label="Send" disabled={!input.trim()}>
              <ArrowUp />
            </Button>
          )}
        </div>
      </form>
      <p className="text-muted-foreground mt-2 text-center text-xs">Enter to send · Shift+Enter new line</p>
    </div>
  );

  const canvas = (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      {planSteps.length === 0 && toolLogs.length === 0 && autoDefects.length === 0 && (
        <div className="text-muted-foreground rounded-2xl border border-dashed p-6 text-center text-xs">
          Mission plan, tool calls and auto-filed defects appear here when you run an agent such as @qa or @security.
        </div>
      )}

      {!showWork && (planSteps.length > 0 || toolLogs.length > 0) && (
        <div className="text-muted-foreground rounded-2xl border border-dashed p-4 text-xs">
          Steps are hidden. Turn on &quot;Show work&quot; in the composer to see the plan and tool calls.
        </div>
      )}

      {showWork && planSteps.length > 0 && (
        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Mission plan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-4">
            {planSteps.map((st) => (
              <div key={st.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate">
                  <span className="text-muted-foreground uppercase">{st.agent}</span> · {st.title}
                </span>
                <Badge variant={statusVariant(st.status)}>{st.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {showWork &&
        toolLogs.map((tl, idx) => (
          <Collapsible key={idx}>
            <Card className="gap-2 py-3">
              <CardHeader className="px-4">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="min-w-0 truncate text-xs">
                    {tl.agent.toUpperCase()} · {tl.tool}
                  </CardTitle>
                  <Badge variant={statusVariant(tl.status)}>{tl.status}</Badge>
                </div>
                <CardDescription className="text-xs break-words">{tl.detail}</CardDescription>
              </CardHeader>
              {tl.output !== undefined && (
                <CardContent className="px-4">
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="-ml-2 h-7 text-xs">
                      <ChevronDown />
                      Output
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="bg-muted mt-2 max-h-40 overflow-auto rounded-md p-2 text-[11px]">
                      {JSON.stringify(tl.output, null, 2).slice(0, 600)}
                    </pre>
                  </CollapsibleContent>
                </CardContent>
              )}
            </Card>
          </Collapsible>
        ))}

      {autoDefects.map((d) => (
        <Card key={d.id} className="gap-2 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Auto-filed defect {d.id}</CardTitle>
            <CardDescription className="text-xs break-words">{d.title}</CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <Button variant="outline" size="sm" onClick={onOpenDefects}>
              Open in Defects
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );

  const empty = messages.length === 0;

  const conversation = (
    <div className="relative flex h-full min-w-0 flex-col">
      <div className="absolute top-2 right-3 z-10 flex items-center gap-2">
        {routeNotice && <Badge variant="outline" className="max-w-64"><span className="truncate">{routeNotice}</span></Badge>}
        <Button variant="ghost" size="icon" aria-label="Toggle Execution Canvas" aria-pressed={harnessOpen} onClick={() => setHarnessOpen((o) => !o)}>
          <PanelRight />
        </Button>
      </div>

      {empty ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex min-h-full w-full max-w-(--chat-width,48rem) flex-col justify-center gap-8 px-4 py-12">
            <div className="flex flex-col items-center gap-4">
              <BrandAvatar className="size-16" />
              <h2 className="text-center text-3xl font-semibold tracking-tight">What should we check today?</h2>
            </div>
            {composer}
            <div className="grid gap-3 sm:grid-cols-2">
              {PRESETS.map((p) => (
                <button
                  key={p.prompt}
                  type="button"
                  onClick={() => runPrompt(p.prompt)}
                  className="hover:bg-muted focus-visible:ring-ring/50 flex items-start gap-3 rounded-2xl border p-4 text-left transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
                >
                  <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-xl">
                    <p.icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{p.title}</span>
                    <span className="text-muted-foreground block text-xs">{p.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </ScrollArea>
      ) : (
        <>
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex w-full max-w-(--chat-width,48rem) flex-col gap-6 p-4 pt-12 md:p-6 md:pt-12">
              {messages.map((m, i) => {
                const isUser = m.role === "user";
                if (isUser) {
                  return (
                    <div key={i} className="flex justify-end">
                      <div className="bg-primary text-primary-foreground max-w-[85%] rounded-3xl px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap">
                        {m.text}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={i} className="group flex gap-3">
                    <BrandAvatar />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      {showWork && m.work && (
                        <Collapsible>
                          <CollapsibleTrigger asChild>
                            <Button variant="ghost" size="sm" className="-ml-2 h-7 text-xs">
                              <ChevronDown />
                              Worked for {m.work.secs}s · {m.work.steps.length} step{m.work.steps.length === 1 ? "" : "s"}
                            </Button>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <ul className="text-muted-foreground space-y-1 pl-2 text-xs">
                              {m.work.steps.map((s, k) => (
                                <li key={k} className="flex items-center justify-between gap-2">
                                  <span className="min-w-0 truncate">{s.label}</span>
                                  <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                                </li>
                              ))}
                            </ul>
                          </CollapsibleContent>
                        </Collapsible>
                      )}
                      <div
                        className={cn(
                          "text-sm leading-relaxed break-words whitespace-pre-wrap",
                          m.error && "border-destructive text-destructive rounded-2xl border p-3",
                        )}
                      >
                        {m.pending ? <Skeleton className="h-4 w-40" /> : m.text}
                      </div>
                      {m.sources && m.sources.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {m.sources.map((s) => (
                            <Badge key={s.ref} variant="outline" asChild className="max-w-full cursor-pointer">
                              <button type="button" onClick={() => openSource(s.ref, s.title)}>
                                <span className="truncate">{s.title || s.ref}</span>
                              </button>
                            </Badge>
                          ))}
                        </div>
                      )}
                      {!m.pending && (
                        <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <Button variant="ghost" size="sm" className="-ml-2 h-7 text-xs" onClick={() => copy(m.text)}>
                            <Copy />
                            Copy
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>
          </ScrollArea>
          <div className="p-3 md:p-4">{composer}</div>
        </>
      )}
    </div>
  );

  const head =
    active && headSlot
      ? createPortal(
          <Button onClick={newChat} className="w-full group-data-[collapsible=icon]:hidden">
            <Plus />
            New chat
          </Button>,
          headSlot,
        )
      : null;

  const list =
    active && listSlot
      ? createPortal(
          <SidebarGroup className="min-h-0 flex-1 group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Chats</SidebarGroupLabel>
            <div className="relative mb-2 px-2">
              <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-4 size-4" />
              <Input
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                placeholder="Search chats..."
                className="h-9 pl-8"
                aria-label="Search chats"
              />
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-3 px-2 pb-2">
                {!chatsLoaded && <Skeleton className="h-8 w-full" />}
                {chatsLoaded && grouped.length === 0 && <p className="text-muted-foreground p-2 text-xs">No chats yet.</p>}
                {grouped.map(([label, items]) => (
                  <div key={label} className="space-y-0.5">
                    <div className="text-muted-foreground px-2 pb-1 text-[11px] font-medium">{label}</div>
                    {items.map((c) => (
                      <div
                        key={c.id}
                        className={cn(
                          "group/chat flex items-center gap-1 rounded-xl text-sm",
                          activeId === c.id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
                        )}
                      >
                        <button type="button" onClick={() => openChat(c.id)} className="min-w-0 flex-1 truncate px-2 py-1.5 text-left" title={friendlyTitle(c.title)}>
                          {friendlyTitle(c.title)}
                        </button>
                        {c.updated && (
                          <span className="text-muted-foreground shrink-0 pr-2 text-[11px] group-hover/chat:hidden">{relTime(c.updated)}</span>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="mr-1 hidden size-6 shrink-0 group-focus-within/chat:inline-flex group-hover/chat:inline-flex"
                          aria-label="Delete chat"
                          onClick={() => setDeleteTarget(c)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </SidebarGroup>,
          listSlot,
        )
      : null;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0">
      {head}
      {list}

      <ResizablePanelGroup orientation="horizontal" className="min-w-0 flex-1">
        <ResizablePanel id="chat" minSize="40%">
          {conversation}
        </ResizablePanel>

        {isXl && harnessOpen && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel id="canvas" defaultSize="32%" minSize="22%" maxSize="50%">
              <aside className="flex h-full flex-col">
                <div className="p-4">
                  <h3 className="text-sm font-semibold">Execution Canvas</h3>
                  <p className="text-muted-foreground text-xs">{missionSub}</p>
                </div>
                <Separator />
                <ScrollArea className="min-h-0 flex-1">{canvas}</ScrollArea>
              </aside>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      {!isXl && (
        <Sheet open={harnessOpen} onOpenChange={setHarnessOpen}>
          <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
            <SheetHeader>
              <SheetTitle>Execution Canvas</SheetTitle>
              <SheetDescription>{missionSub}</SheetDescription>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">{canvas}</ScrollArea>
          </SheetContent>
        </Sheet>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{friendlyTitle(deleteTarget?.title)}&quot; will be removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) deleteChat(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={docSheet !== null} onOpenChange={(o) => !o && setDocSheet(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle className="break-words">{docSheet?.title || "Source"}</SheetTitle>
            <SheetDescription>Source document</SheetDescription>
          </SheetHeader>
          <pre className="px-4 pb-4 font-mono text-xs break-words whitespace-pre-wrap">{docSheet?.content}</pre>
        </SheetContent>
      </Sheet>
    </div>
  );
}
