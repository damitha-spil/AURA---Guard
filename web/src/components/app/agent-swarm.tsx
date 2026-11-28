import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  Bot,
  CheckCircle2,
  Eye,
  FlaskConical,
  Gauge,
  GitPullRequest,
  Layers,
  Loader2,
  Shield,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface SwarmAgentState {
  agent: string;
  name: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  detail?: string;
  createdBy?: "reo" | "user" | "system";
}

export interface SwarmToolLog {
  agent: string;
  tool: string;
  status: string;
  detail: string;
}

export interface SwarmChatNote {
  from: "user" | "reo";
  text: string;
  action?: string;
}

export interface SwarmState {
  id: string;
  status: "running" | "done" | "stopped";
  startedAt: number;
  agents: SwarmAgentState[];
  tools: SwarmToolLog[];
  chat: SwarmChatNote[];
  defects: Array<{ id: string; title: string }>;
  learned: string[];
  verdict?: string;
}

function agentIcon(id: string) {
  switch (id) {
    case "qa":
      return FlaskConical;
    case "security":
      return Shield;
    case "review":
      return GitPullRequest;
    case "qe":
      return TrendingUp;
    case "a11y":
      return Eye;
    case "perf":
      return Gauge;
    case "architect":
      return Layers;
    case "api":
      return Activity;
    case "triage":
    case "release":
      return Wrench;
    default:
      return Bot;
  }
}

function statusChipVariant(status: SwarmAgentState["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "done") return "default";
  if (status === "error") return "destructive";
  if (status === "running") return "secondary";
  return "outline";
}

export function AgentSwarm({
  mission,
  onOpenDefects,
  onStop,
}: {
  mission: SwarmState;
  onOpenDefects?: () => void;
  onStop?: (id: string) => void;
}) {
  const [elapsedSec, setElapsedSec] = React.useState(0);
  const [rated, setRated] = React.useState<"up" | "down" | null>(null);

  React.useEffect(() => {
    if (mission.status !== "running") return;
    const t = window.setInterval(() => {
      setElapsedSec(Math.max(1, Math.floor((Date.now() - mission.startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(t);
  }, [mission.status, mission.startedAt]);

  const totalAgents = Math.max(1, mission.agents.length);
  const finishedAgents = mission.agents.filter((a) => a.status === "done" || a.status === "error" || a.status === "skipped").length;
  const progressWidth = Math.max(16, Math.round((finishedAgents / totalAgents) * 400));

  async function sendFeedback(rating: "up" | "down") {
    setRated(rating);
    const r = await apiPost(`/api/reo/mission/${mission.id}/feedback`, { rating });
    if (r.ok) toast.success(rating === "up" ? "Feedback recorded · routing reinforced" : "Feedback recorded · routing adjusted");
    else toast.error(r.error || "Could not record feedback");
  }

  return (
    <Card className="border-primary/20 bg-card/90 w-full gap-3 py-3 shadow-sm">
      <CardHeader className="px-4 pb-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {mission.status === "running" && (
              <motion.span
                className="bg-primary inline-block size-2.5 rounded-full"
                animate={{ opacity: [0.35, 1, 0.35], scale: [0.9, 1.15, 0.9] }}
                transition={{ duration: 1.4, repeat: Infinity }}
              />
            )}
            <CardTitle className="text-sm">REO Agent Swarm</CardTitle>
            <Badge variant="outline" className="font-mono text-[10px]">
              {finishedAgents}/{mission.agents.length} · {elapsedSec}s
            </Badge>
            {mission.verdict && (
              <Badge variant={mission.verdict === "BLOCK_RELEASE" ? "destructive" : mission.verdict === "PASS" ? "default" : "secondary"}>
                {mission.verdict}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {mission.status === "running" ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-7 px-2.5 text-xs"
                onClick={() => onStop?.(mission.id)}
              >
                <Square className="size-3" />
                Stop
              </Button>
            ) : (
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="icon-sm"
                  variant={rated === "up" ? "default" : "ghost"}
                  aria-label="Helpful swarm run"
                  onClick={() => sendFeedback("up")}
                >
                  <ThumbsUp className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant={rated === "down" ? "destructive" : "ghost"}
                  aria-label="Unhelpful swarm run"
                  onClick={() => sendFeedback("down")}
                >
                  <ThumbsDown className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>
        <svg viewBox="0 0 400 5" className="mt-1.5 h-1.5 w-full" aria-hidden="true">
          <rect x="0" y="0" width="400" height="5" rx="2.5" className="fill-muted" />
          <rect x="0" y="0" width={mission.status === "done" ? 400 : progressWidth} height="5" rx="2.5" className="fill-primary" />
        </svg>
      </CardHeader>

      <CardContent className="grid gap-3 px-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {mission.agents.map((ag) => {
            const Icon = agentIcon(ag.agent);
            const isRunning = ag.status === "running";
            return (
              <motion.div
                key={ag.agent}
                animate={isRunning ? { opacity: [0.7, 1, 0.7] } : { opacity: 1 }}
                transition={isRunning ? { duration: 1.5, repeat: Infinity } : { duration: 0.2 }}
                className={cn(
                  "rounded-xl border p-2.5 text-xs transition-colors",
                  isRunning && "border-primary/60 bg-primary/5",
                  ag.status === "done" && "border-border bg-muted/30",
                  ag.status === "error" && "border-destructive/50 bg-destructive/5",
                  ag.status === "skipped" && "opacity-60",
                )}
              >
                <div className="flex items-start justify-between gap-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-lg">
                      {isRunning ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : ag.status === "done" ? (
                        <CheckCircle2 className="text-primary size-3.5" />
                      ) : ag.status === "error" ? (
                        <XCircle className="text-destructive size-3.5" />
                      ) : (
                        <Icon className="size-3.5" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{ag.name}</div>
                      <div className="text-muted-foreground truncate font-mono text-[10px]">@{ag.agent}</div>
                    </div>
                  </div>
                  <Badge variant={statusChipVariant(ag.status)} className="h-4 px-1.5 text-[9px]">
                    {ag.status}
                  </Badge>
                </div>
                {ag.createdBy === "reo" && (
                  <div className="mt-1.5 flex items-center gap-1 text-[10px]">
                    <Badge variant="secondary" className="h-4 gap-0.5 px-1.5 text-[9px]">
                      <Sparkles className="size-2.5" />
                      Created by REO
                    </Badge>
                  </div>
                )}
                {ag.detail && <p className="text-muted-foreground mt-1.5 line-clamp-2 text-[11px]">{ag.detail}</p>}
              </motion.div>
            );
          })}
        </div>

        {mission.tools.length > 0 && (
          <div className="bg-muted/40 grid gap-1 rounded-xl border p-2.5">
            <div className="text-muted-foreground text-[10px] font-medium uppercase">Live activity</div>
            <AnimatePresence initial={false}>
              {mission.tools.slice(-6).map((t, i) => (
                <motion.div
                  key={`${t.agent}-${t.tool}-${i}`}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center justify-between gap-2 text-[11px]"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-mono font-medium uppercase">{t.agent}</span> · {t.tool} —{" "}
                    <span className="text-muted-foreground">{t.detail}</span>
                  </span>
                  <Badge variant={t.status === "error" ? "destructive" : t.status === "done" ? "secondary" : "outline"} className="h-4 shrink-0 px-1.5 text-[9px]">
                    {t.status}
                  </Badge>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}

        {mission.chat.length > 0 && (
          <div className="grid gap-1.5 rounded-xl border p-2.5 text-xs">
            {mission.chat.map((c, idx) => (
              <div key={idx} className={cn("flex gap-2", c.from === "user" ? "justify-end" : "justify-start")}>
                <span
                  className={cn(
                    "max-w-[85%] rounded-xl px-2.5 py-1 text-[11px]",
                    c.from === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                  )}
                >
                  {c.text}
                </span>
              </div>
            ))}
          </div>
        )}

        {mission.learned.length > 0 && (
          <div className="bg-primary/5 border-primary/20 grid gap-1 rounded-xl border p-2.5 text-xs">
            {mission.learned.map((line, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[11px]">
                <Sparkles className="text-primary size-3.5 shrink-0" />
                <span>{line}</span>
              </div>
            ))}
          </div>
        )}

        {mission.defects.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-2.5 text-xs">
            <span>
              <strong>{mission.defects.length}</strong> defect{mission.defects.length === 1 ? "" : "s"} filed automatically
            </span>
            {onOpenDefects && (
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={onOpenDefects}>
                Open in Defects
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
