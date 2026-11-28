import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Copy,
  FileText,
  FlaskConical,
  GitPullRequest,
  PanelRight,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Shield,
  Square,
  TrendingUp,
  X,
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
import { AssistantAvatar, BrandAvatar } from "@/components/app/brand";

const ReoBot3D = React.lazy(() => import("@/components/app/reo-bot-3d"));
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChatList, chatTitle, type ChatSummary } from "@/components/app/chat-list";
import { FindBar, Marked } from "@/components/app/chat-find";
import { SavedPrompts } from "@/components/app/saved-prompts";
import { ErrorBoundary } from "@/components/app/error-boundary";
import { HISTORY_NOTE, MAX_MESSAGE_CHARS, chatMarkdown, composeMessage, recallable } from "@/lib/chat";
import { useShortcut } from "@/lib/keybindings";
import { notifyReply } from "@/lib/notify";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ChatModelPicker } from "@/components/app/chat-model-picker";
import { AgentSwarm, type SwarmState } from "@/components/app/agent-swarm";
import { cn } from "@/lib/utils";
import { useAppearance } from "@/lib/appearance";
import { BASIC_COMMANDS, SLASH_MENU, isRunnerCommand, slashName } from "@/lib/slash";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, streamNdjson } from "@/lib/api";

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
  swarm?: SwarmState;
  /** Marks the reply of a run started in this window, so updates reach only that bubble. */
  run?: number;
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

interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  text?: string;
}

/** Most files and most text read from each; file text is shortened again to fit the message limit. */
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_CHARS = 12_000;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextResource(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (/json|xml|javascript|typescript|yaml|toml|csv|svg/i.test(file.type)) return true;
  return /\.(txt|md|markdown|json|ya?ml|toml|xml|csv|tsv|log|ts|tsx|js|jsx|mjs|cjs|py|java|rs|go|cs|css|scss|html|sql|sh|ps1|bat|env|ini|conf)$/i.test(
    file.name,
  );
}

const PRESETS = [
  { icon: FlaskConical, title: "Inspect the UI", desc: "QA crawl of UI features and desktop windows", prompt: "@qa inspect UI features and desktop crawlers" },
  { icon: Shield, title: "Security audit", desc: "Probe localhost backend safety", prompt: "@security audit localhost backend safety" },
  { icon: GitPullRequest, title: "Review latest commit", desc: "Analyze the most recent changes", prompt: "@review analyze latest commit changes" },
  { icon: TrendingUp, title: "Trajectory and drift", desc: "7-day commits and knowledge drift", prompt: "@qe compute 7-day commit trajectory & KB drift" },
];


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
  openRequest,
}: {
  initialPrompt?: string;
  routeNotice?: string;
  resetKey: number;
  active: boolean;
  headSlot: HTMLElement | null;
  listSlot: HTMLElement | null;
  onClearInitial: () => void;
  onOpenDefects: () => void;
  /** A chat picked outside this page (command palette). `n` changes on each pick. */
  openRequest?: { id: string; n: number };
}) {
  const [chats, setChats] = React.useState<ChatSummary[]>([]);
  const [chatsLoaded, setChatsLoaded] = React.useState(false);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  // Read by running requests, which outlive the render that started them.
  const activeRef = React.useRef<string | null>(null);
  const openSeq = React.useRef(0);
  const runSeq = React.useRef(0);
  const [findOpen, setFindOpen] = React.useState(false);
  const [findQuery, setFindQuery] = React.useState("");
  const [findFocus, setFindFocus] = React.useState(0);
  const messagesBox = React.useRef<HTMLDivElement | null>(null);
  const recall = React.useRef<{ index: number; draft: string } | null>(null);
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
  const [activeMissionId, setActiveMissionId] = React.useState<string | null>(null);
  const [harnessOpen, setHarnessOpen] = React.useState(false);
  const [missionSub, setMissionSub] = React.useState("Ready for multi-agent execution");
  const [planSteps, setPlanSteps] = React.useState<MissionStep[]>([]);
  const [toolLogs, setToolLogs] = React.useState<ToolLog[]>([]);
  const [autoDefects, setAutoDefects] = React.useState<{ id: string; title: string }[]>([]);
  const [docSheet, setDocSheet] = React.useState<{ title: string; content: string } | null>(null);
  const [brain, setBrain] = React.useState<BrainSummary | null>(null);
  const [agents, setAgents] = React.useState<AgentLite[]>([]);
  const [deleteTarget, setDeleteTarget] = React.useState<ChatSummary | null>(null);
  const [presetGaze, setPresetGaze] = React.useState(0);
  const [attachments, setAttachments] = React.useState<AttachedFile[]>([]);
  const [dragOver, setDragOver] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [justReplied, setJustReplied] = React.useState(false);
  const prevBusyRef = React.useRef(false);
  React.useEffect(() => {
    if (prevBusyRef.current && !busy && messages.length > 0) {
      setJustReplied(true);
      const t = window.setTimeout(() => setJustReplied(false), 1800);
      prevBusyRef.current = busy;
      return () => window.clearTimeout(t);
    }
    prevBusyRef.current = busy;
  }, [busy, messages.length]);
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

  // Unsent text and files stay with their chat. Kept in memory only: unsent text is not masked yet,
  // so it is never written to disk.
  const drafts = React.useRef(new Map<string, { input: string; attachments: AttachedFile[] }>());
  const draftNow = React.useRef({ input, attachments });
  draftNow.current = { input, attachments };

  const showChat = React.useCallback((id: string | null, next: ChatMsg[]) => {
    if (id !== activeRef.current) {
      drafts.current.set(activeRef.current ?? "new", draftNow.current);
      const draft = drafts.current.get(id ?? "new") ?? { input: "", attachments: [] };
      // Now held by the box itself; a copy left here could bring back text that was already sent.
      drafts.current.delete(id ?? "new");
      draftNow.current = draft;
      setInput(draft.input);
      setAttachments(draft.attachments);
      setFindOpen(false);
      setFindQuery("");
      recall.current = null;
    }
    activeRef.current = id;
    setActiveId(id);
    setMessages(next);
  }, []);

  async function openChat(id: string, find?: string) {
    const seq = ++openSeq.current;
    const r = await apiGet<{ id: string; messages: ChatMsg[] }>(`/api/chats/${id}`);
    if (seq !== openSeq.current) return;
    if (!r.ok) return void toast.error(r.error || "Could not open the chat.");
    showChat(id, r.data.messages || []);
    if (find) {
      setFindQuery(find);
      setFindOpen(true);
      setFindFocus((n) => n + 1);
    }
  }

  const newChat = React.useCallback(() => {
    openSeq.current++;
    showChat(null, []);
  }, [showChat]);

  async function deleteChat(id: string) {
    const r = await apiDelete(`/api/chats/${id}`);
    if (r.ok) {
      if (activeRef.current === id) newChat();
      drafts.current.delete(id);
    }
    toast(r.ok ? "Chat deleted" : "Could not delete chat");
    refreshChats();
  }

  async function updateChat(id: string, patch: { title?: string; pinned?: boolean }) {
    const r = await apiPatch(`/api/chats/${id}`, patch);
    if (!r.ok) toast.error(r.error || "Could not change the chat.");
    refreshChats();
  }

  async function copyChat(c: ChatSummary) {
    const r = await apiGet<{ messages: ChatMsg[] }>(`/api/chats/${c.id}`);
    if (!r.ok) return void toast.error(r.error || "Could not read the chat.");
    copy(chatMarkdown(chatTitle(c.title), r.data.messages || []));
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
      recall.current = null;

      // 1. Live swarm steering while an active swarm mission is already running
      if (activeMissionId) {
        const isSteer = /^(stop|cancel|abort|skip\s+[a-z0-9_-]+)\b/i.test(q) || /@[a-z0-9-]+/i.test(q);
        if (isSteer) {
          setMessages((prev) => [...prev, { role: "user", text: q }]);
          const r = await apiPost<{ ok?: boolean; action?: string; target?: string }>(
            `/api/reo/mission/${activeMissionId}/message`,
            { text: q },
          );
          if (r.ok) {
            toast.success(`Swarm command: ${r.data.action || "sent"}`);
          } else {
            toast.error(r.error || "Could not steer running swarm");
          }
          return;
        }
        // Regular chat message while swarm runs: pass as a note to swarm AND ask REO chat concurrently
        apiPost(`/api/reo/mission/${activeMissionId}/message`, { text: q }).catch(() => {});
      }

      // 2. Natural-language asset creation: "create an agent / tool / skill ..."
      const createMatch = /^(?:create|make|build)\s+(?:an?\s+)?(agent|tool|skill)\s+([\s\S]+)$/i.exec(q);
      if (createMatch) {
        const kind = createMatch[1]!.toLowerCase() as "agent" | "tool" | "skill";
        const description = createMatch[2]!.trim();
        setBusy(true);
        setMessages((prev) => [...prev, { role: "user", text: q }, { role: "assistant", text: "Creating with REO...", pending: true }]);
        const res = await apiPost<{ ok: boolean; item?: { id?: string; name: string } }>("/api/reo/create", { kind, description });
        setBusy(false);
        const msg = res.ok
          ? `Created ${kind}: **${res.data.item?.name || ""}** (${res.data.item?.id || "ready"}) — tagged **Created by REO** in the Agents view.`
          : `Could not create ${kind}: ${res.error || "failed"}`;
        setMessages((prev) => [...prev.slice(0, -1), { role: "assistant", text: msg, error: !res.ok }]);
        apiGet<{ agents: AgentLite[] }>("/api/reo/agents").then((r) => {
          if (r.ok) setAgents(r.data.agents || []);
        });
        return;
      }

      // 3. Multi-agent Swarm Mission (runs non-blocking so user can chat while swarm runs!)
      const name = slashName(q);
      const runner = isRunnerCommand(q, runnerNames);
      const isMission =
        (!name || name === "qa") &&
        !runner &&
        (/^@(qa|qe|review|security|api|report|a11y|perf|release|architect|triage|knowledge|custom-[a-z0-9-]+)\b/i.test(q) ||
          /\b(run mission|audit|probe|crawl|qa )\b/i.test(q));

      if (isMission) {
        const missionId = `mission-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
        setActiveMissionId(missionId);
        setPlanSteps([]);
        setToolLogs([]);
        setAutoDefects([]);
        setMissionSub("Launching parallel REO agent swarm...");

        const initSwarm: SwarmState = {
          id: missionId,
          status: "running",
          startedAt: Date.now(),
          agents: [],
          tools: [],
          chat: [],
          defects: [],
          learned: [],
        };
        setMessages((prev) => [...prev, { role: "user", text: q }, { role: "assistant", text: "", swarm: initSwarm }]);

        const patchSwarm = (updater: (cur: SwarmState) => SwarmState) => {
          setMessages((prev) =>
            prev.map((m) => (m.swarm?.id === missionId ? { ...m, swarm: updater(m.swarm) } : m)),
          );
        };

        void streamNdjson(
          "/api/reo/mission",
          { prompt: q, missionId },
          (ev) => {
            if (ev.type === "mission") {
              const ag = Array.isArray(ev.agents) ? ev.agents.join(", ") : "";
              setMissionSub(ev.status === "started" ? `Active agents: ${ag}` : `Completed (${ag})`);
              if (ev.status === "done") {
                patchSwarm((cur) => ({ ...cur, status: "done" }));
                setActiveMissionId((curId) => (curId === missionId ? null : curId));
                apiGet<{ agents: AgentLite[] }>("/api/reo/agents").then((r) => {
                  if (r.ok) setAgents(r.data.agents || []);
                });
              }
            } else if (ev.type === "agent") {
              const nextAg = {
                agent: String(ev.agent || ""),
                name: String(ev.name || ev.agent || ""),
                status: (ev.status as "queued" | "running" | "done" | "error" | "skipped") || "queued",
                detail: typeof ev.detail === "string" ? ev.detail : undefined,
                createdBy: ev.createdBy as "reo" | "user" | "system" | undefined,
              };
              patchSwarm((cur) => {
                const idx = cur.agents.findIndex((a) => a.agent === nextAg.agent);
                const agentsList = idx < 0 ? [...cur.agents, nextAg] : cur.agents.map((a, i) => (i === idx ? nextAg : a));
                return { ...cur, agents: agentsList };
              });
            } else if (ev.type === "plan" && Array.isArray(ev.steps)) {
              setPlanSteps(ev.steps as MissionStep[]);
            } else if (ev.type === "tool") {
              const tl = {
                agent: String(ev.agent || ""),
                tool: String(ev.tool || ""),
                status: String(ev.status || ""),
                detail: String(ev.detail || ""),
                output: ev.output,
              };
              setToolLogs((prev) => [...prev, tl]);
              patchSwarm((cur) => ({
                ...cur,
                tools: [...cur.tools, { agent: tl.agent, tool: tl.tool, status: tl.status, detail: tl.detail }],
              }));
            } else if (ev.type === "chat") {
              patchSwarm((cur) => ({
                ...cur,
                chat: [...cur.chat, { from: ev.from === "user" ? "user" : "reo", text: String(ev.text || ""), action: typeof ev.action === "string" ? ev.action : undefined }],
              }));
            } else if (ev.type === "learned") {
              const summary = String(ev.summary || "");
              if (summary) patchSwarm((cur) => ({ ...cur, learned: [...cur.learned, summary] }));
            } else if (ev.type === "defect" && ev.defect) {
              const d = ev.defect as { id: string; title: string };
              setAutoDefects((prev) => [...prev, d]);
              patchSwarm((cur) => ({
                ...cur,
                defects: cur.defects.some((x) => x.id === d.id) ? cur.defects : [...cur.defects, d],
              }));
              toast(`Defect filed: ${d.id}`);
            } else if (ev.type === "verdict") {
              patchSwarm((cur) => ({ ...cur, verdict: String(ev.verdict || "") }));
            }
          },
        ).finally(() => {
          patchSwarm((cur) => (cur.status === "running" ? { ...cur, status: "done" } : cur));
          setActiveMissionId((curId) => (curId === missionId ? null : curId));
        });
        return;
      }

      setBusy(true);
      const started = Date.now();
      const work: WorkStep[] = [];
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const run = ++runSeq.current;

      const startedIn = activeRef.current;
      let cid = startedIn;
      if (!cid) {
        const created = await apiPost<{ id: string }>("/api/chats", {});
        if (created.ok && created.data.id) {
          cid = created.data.id;
          if (activeRef.current === startedIn) {
            activeRef.current = cid;
            setActiveId(cid);
          }
        }
      }
      // The person may open another chat while this one is answering; its replies must stay here.
      const here = () => activeRef.current === cid;

      if (here()) {
        setMessages((prev) => [
          ...prev,
          { role: "user", text: q },
          { role: "assistant", text: "Working...", pending: true, run },
        ]);
      }
      let answered = false;
      let failed = false;
      const reply = (msg: Omit<ChatMsg, "role">) => {
        if (!msg.pending) answered = true;
        failed = Boolean(msg.error);
        if (!here()) return;
        setMessages((prev) => {
          const next: ChatMsg = { role: "assistant", ...msg, run };
          const at = prev.findIndex((m) => m.run === run);
          return at < 0 ? [...prev, next] : prev.map((m, i) => (i === at ? next : m));
        });
      };
      let output = "";

      if (runner) {
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
        if (!finished && !ctrl.signal.aborted) reply({ text: output || "The command did not finish.", error: true });
      } else if (cid) {
        await streamNdjson(
          `/api/chats/${cid}/ask`,
          { question: q, notesOnly, ...(webSearch && !notesOnly ? { webSearch: true } : {}) },
          (ev) => {
            if (ev.type === "answer") {
              reply({
                text: String(ev.text || ""),
                sources: Array.isArray(ev.sources) ? (ev.sources as ChatMsg["sources"]) : [],
                work: work.length ? { secs: Math.max(1, Math.round((Date.now() - started) / 1000)), steps: work } : undefined,
              });
            } else if (ev.type === "error") {
              reply({ text: errorText(ev.message), error: true });
            }
          },
          ctrl.signal,
        ).catch(() => {});
      }

      if (ctrl.signal.aborted) {
        if (!answered) {
          const note = "Stopped waiting. The engine may still finish this and save the result in the chat.";
          reply({ text: output ? `${output.trimEnd()}\n\n${note}` : note, error: true });
        }
      } else {
        if (!answered) reply({ text: "No reply arrived. Check that the engine is running, then try again.", error: true });
        notifyReply(failed);
      }
      setBusy(false);
      refreshChats();
    },
    [busy, activeMissionId, notesOnly, webSearch, runnerNames],
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

  const findingRef = React.useRef(false);
  findingRef.current = findOpen;
  React.useEffect(() => {
    // While finding, the view stays on the match.
    if (!findingRef.current) endRef.current?.scrollIntoView({ behavior: appearance.reduceMotion ? "auto" : "smooth" });
  }, [messages, appearance.reduceMotion]);

  const openedRequest = React.useRef(0);
  React.useEffect(() => {
    if (openRequest && openRequest.n !== openedRequest.current) {
      openedRequest.current = openRequest.n;
      openChat(openRequest.id);
    }
    // openChat reads only refs and state setters, so the request alone decides when this runs.
  }, [openRequest]);

  useShortcut(
    "findInChat",
    () => {
      setFindOpen(true);
      setFindFocus((n) => n + 1);
    },
    active && messages.length > 0,
  );
  useShortcut("focusComposer", () => inputRef.current?.focus(), active);
  useShortcut("toggleCanvas", () => setHarnessOpen((o) => !o), active);

  async function attachFiles(files: FileList | File[]) {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (room === 0) {
      toast.error(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
      return;
    }
    const slice = incoming.slice(0, room);
    if (incoming.length > room) {
      toast(`Only the first ${room} file${room === 1 ? "" : "s"} were attached (max ${MAX_ATTACHMENTS}).`);
    }
    const read = await Promise.all(
      slice.map(async (file): Promise<AttachedFile> => {
        let text: string | undefined;
        if (isTextResource(file)) {
          try {
            const raw = await file.text();
            text = raw.length > MAX_ATTACHMENT_CHARS ? `${raw.slice(0, MAX_ATTACHMENT_CHARS)}\n... [truncated]` : raw;
          } catch {
            text = undefined;
          }
        }
        return {
          id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          size: file.size,
          type: file.type || "application/octet-stream",
          text,
        };
      }),
    );
    setAttachments((prev) => [...prev, ...read]);
  }

  const outgoing = composeMessage(
    input,
    attachments.map((a) => ({ name: a.name, sizeLabel: formatBytes(a.size), type: a.type, text: a.text })),
  );
  const canSend = outgoing.text.length > 0 && outgoing.fits;
  const showMeter = attachments.length > 0 || outgoing.text.length > MAX_MESSAGE_CHARS * 0.75;

  function submit() {
    // While a reply is running the typed text stays in the box.
    if (busy || !canSend) return;
    setInput("");
    setAttachments([]);
    runPrompt(outgoing.text);
  }

  /** Up and down arrows bring back messages already sent in this chat. */
  function recallKey(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
    const sent = recallable(messages);
    const now = recall.current && sent[recall.current.index] === input ? recall.current : null;
    const box = e.currentTarget;
    let next: string;
    if (e.key === "ArrowUp") {
      if ((!now && input !== "") || !sent.length || box.value.slice(0, box.selectionStart).includes("\n")) return false;
      const index = now ? Math.max(0, now.index - 1) : sent.length - 1;
      recall.current = { index, draft: now ? now.draft : input };
      next = sent[index];
    } else {
      if (!now || box.value.slice(box.selectionEnd).includes("\n")) return false;
      const index = now.index + 1;
      next = index < sent.length ? sent[index] : now.draft;
      recall.current = index < sent.length ? { index, draft: now.draft } : null;
    }
    e.preventDefault();
    setInput(next);
    return true;
  }

  function editAgain(text: string) {
    setInput((v) => (v.trim() ? `${v}\n${text}` : text));
    inputRef.current?.focus();
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

  const modelPicker = brain ? (
    <ChatModelPicker
      backends={brain.backends}
      catalogue={brain.models.catalogue}
      pickedBackend={brain.picked}
      currentModels={brain.models.current}
      disabled={busy}
      onSelect={switchModel}
    />
  ) : null;

  // In an empty chat the composer sits mid-page, where a menu above it would be cut off.
  const menuSide = messages.length === 0 ? "top-full mt-2" : "bottom-full mb-2";

  const botMood = busy
    ? ("thinking" as const)
    : justReplied
      ? ("happy" as const)
      : input.trim().length > 0
        ? ("typing" as const)
        : ("idle" as const);

  const composer = (
    <div className="group/composer relative mx-auto w-full max-w-(--chat-width,48rem)">
      {messages.length > 0 && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-14 right-5 z-0 flex items-start gap-1.5"
        >
          <AnimatePresence>
            {busy && (
              <motion.div
                key="thinking-cloud"
                initial={{ opacity: 0, scale: 0.75, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.75, y: 4 }}
                transition={{ type: "spring", stiffness: 380, damping: 24 }}
                className="relative -mt-4 flex items-center gap-1 rounded-2xl border bg-card/95 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur-xs"
              >
                <span>Thinking</span>
                <span className="inline-flex gap-0.5" aria-hidden="true">
                  <motion.span
                    animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
                    transition={{ duration: 1.1, repeat: Infinity, delay: 0 }}
                  >
                    ·
                  </motion.span>
                  <motion.span
                    animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
                    transition={{ duration: 1.1, repeat: Infinity, delay: 0.2 }}
                  >
                    ·
                  </motion.span>
                  <motion.span
                    animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
                    transition={{ duration: 1.1, repeat: Infinity, delay: 0.4 }}
                  >
                    ·
                  </motion.span>
                </span>
                <span className="bg-card/95 border-border absolute -right-1.5 bottom-0.5 size-2 rounded-full border" />
                <span className="bg-card/95 border-border absolute -right-3 -bottom-1 size-1.5 rounded-full border" />
              </motion.div>
            )}
          </AnimatePresence>
          <motion.div
            animate={
              botMood === "thinking"
                ? { y: [-8, -14, -8], rotate: [-2, 2.5, -2], scale: 1.05 }
                : botMood === "happy"
                  ? { y: [-6, -12, -4], rotate: [0, -4, 3, 0], scale: 1.06 }
                  : botMood === "typing"
                    ? { y: 2, rotate: 0, scale: 1 }
                    : { y: 18, rotate: 0, scale: 0.94 }
            }
            transition={
              botMood === "thinking"
                ? { y: { duration: 2.2, repeat: Infinity, ease: "easeInOut" }, rotate: { duration: 2.4, repeat: Infinity, ease: "easeInOut" }, scale: { type: "spring", stiffness: 320, damping: 22 } }
                : { type: "spring", stiffness: 320, damping: 22 }
            }
          >
            <ErrorBoundary what="The animation" fallback={null}>
              <React.Suspense fallback={null}>
                <ReoBot3D
                  active={active && messages.length > 0}
                  typing={input.trim().length > 0}
                  floating={busy}
                  mood={botMood}
                  compact
                  className="h-20 w-24 sm:h-20 sm:w-24"
                />
              </React.Suspense>
            </ErrorBoundary>
          </motion.div>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) attachFiles(e.dataTransfer.files);
        }}
        data-glass-surface="card"
        className={cn(
          "bg-card relative z-10 rounded-3xl border p-3 shadow-xs transition-colors",
          dragOver && "border-primary bg-primary/5",
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Upload files or resources"
          onChange={(e) => {
            if (e.target.files) attachFiles(e.target.files);
            e.target.value = "";
          }}
        />
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
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5 px-1">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="bg-muted/80 inline-flex max-w-56 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
              >
                <FileText className="text-muted-foreground size-3.5 shrink-0" />
                <span className="truncate font-medium">{a.name}</span>
                <span className="text-muted-foreground shrink-0 text-[10px]">{formatBytes(a.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  className="text-muted-foreground hover:text-foreground shrink-0 rounded-full"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {activeMissionId && (
          <div className="mb-1.5 flex items-center justify-between gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs">
            <span>Swarm running — messages steer the swarm (<code>stop</code>, <code>skip &lt;agent&gt;</code>, <code>@agent</code>) or ask a question concurrently.</span>
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
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
              return;
            }
            if (slashItems.length === 0 && mentionAgents.length === 0) recallKey(e);
          }}
          placeholder="Ask a question, type @ for an agent or / for a command..."
          className="max-h-52 min-h-20 resize-none border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
          aria-label="Message"
        />
        {showMeter && (
          <p role={outgoing.fits ? "status" : "alert"} className={cn("px-2 text-xs", outgoing.fits ? "text-muted-foreground" : "text-destructive")} title={HISTORY_NOTE}>
            {outgoing.text.length.toLocaleString()} / {MAX_MESSAGE_CHARS.toLocaleString()} characters.
            {!outgoing.fits && ` Too long to send: remove ${(outgoing.text.length - MAX_MESSAGE_CHARS).toLocaleString()} characters.`}
            {outgoing.fits && outgoing.shortened && " Attached files will be shortened to fit."}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="rounded-full"
              aria-label="Attach files or resources"
              title="Attach files or resources"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="size-4" />
            </Button>
            <SavedPrompts draft={input} onInsert={editAgain} />
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
            <Button type="submit" size="icon" className="rounded-full" aria-label="Send" disabled={!canSend}>
              <ArrowUp />
            </Button>
          )}
        </div>
      </form>
      <p className="text-muted-foreground mt-2 text-center text-xs" title={HISTORY_NOTE}>
        Enter to send · Shift+Enter new line · Up arrow for earlier messages
      </p>
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
        {routeNotice && !findOpen && <Badge variant="outline" className="max-w-64"><span className="truncate">{routeNotice}</span></Badge>}
        {findOpen && !empty && (
          <FindBar
            query={findQuery}
            onQuery={setFindQuery}
            onClose={() => {
              setFindOpen(false);
              setFindQuery("");
              inputRef.current?.focus();
            }}
            scope={messagesBox}
            messages={messages}
            focusRequest={findFocus}
          />
        )}
        {!empty && !findOpen && (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Find in this chat"
              title="Find in this chat"
              onClick={() => {
                setFindOpen(true);
                setFindFocus((n) => n + 1);
              }}
            >
              <Search />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy chat as Markdown"
              title="Copy chat as Markdown"
              onClick={() => copy(chatMarkdown(chatTitle(chats.find((c) => c.id === activeId)?.title), messages))}
            >
              <Copy />
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon" aria-label="Toggle Execution Canvas" aria-pressed={harnessOpen} onClick={() => setHarnessOpen((o) => !o)}>
          <PanelRight />
        </Button>
      </div>

      {empty ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex min-h-full w-full max-w-(--chat-width,48rem) flex-col justify-center gap-6 px-4 py-8">
            <div className="flex flex-col items-center gap-2">
              <ErrorBoundary what="The animation" fallback={<BrandAvatar className="size-16" />}>
                <React.Suspense fallback={<BrandAvatar className="size-16" />}>
                  <ReoBot3D
                    active={active && empty}
                    typing={input.trim().length > 0}
                    gazeX={presetGaze}
                  />
                </React.Suspense>
              </ErrorBoundary>
              <h2 className="text-center text-3xl font-semibold tracking-tight">What should we check today?</h2>
            </div>
            {composer}
            <div className="grid gap-3 sm:grid-cols-2">
              {PRESETS.map((p, idx) => (
                <button
                  key={p.prompt}
                  type="button"
                  onMouseEnter={() => setPresetGaze(idx % 2 === 0 ? -0.45 : 0.45)}
                  onMouseLeave={() => setPresetGaze(0)}
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
            <div ref={messagesBox} className="mx-auto flex w-full max-w-(--chat-width,48rem) flex-col gap-6 p-4 pt-12 md:p-6 md:pt-12">
              {messages.map((m, i) => {
                const isUser = m.role === "user";
                if (isUser) {
                  return (
                    <div key={i} className="group flex flex-col items-end gap-1">
                      <div className="bg-primary text-primary-foreground max-w-[85%] rounded-3xl px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap">
                        <Marked text={m.text} query={findOpen ? findQuery : ""} />
                      </div>
                      <div className="flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => editAgain(m.text)}>
                          <RotateCcw />
                          Use again
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => copy(m.text)}>
                          <Copy />
                          Copy
                        </Button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={i} className="group flex gap-3">
                    <AssistantAvatar />
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
                      {m.swarm && (
                        <AgentSwarm
                          mission={m.swarm}
                          onOpenDefects={onOpenDefects}
                          onStop={(mid) => {
                            apiPost(`/api/reo/mission/${mid}/stop`, {}).catch(() => {});
                          }}
                        />
                      )}
                      {(!m.swarm || m.text) && (
                        <div
                          className={cn(
                            "text-sm leading-relaxed break-words whitespace-pre-wrap",
                            m.error && "border-destructive text-destructive rounded-2xl border p-3",
                          )}
                        >
                          {m.pending ? <Skeleton className="h-4 w-40" /> : <Marked text={m.text} query={findOpen ? findQuery : ""} />}
                        </div>
                      )}
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
          <ChatList
            chats={chats}
            loaded={chatsLoaded}
            activeId={activeId}
            onOpen={openChat}
            onPin={(c) => updateChat(c.id, { pinned: !c.pinned })}
            onRename={(id, title) => updateChat(id, { title })}
            onCopy={copyChat}
            onDelete={setDeleteTarget}
          />,
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
              &quot;{chatTitle(deleteTarget?.title)}&quot; will be removed. This cannot be undone.
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
