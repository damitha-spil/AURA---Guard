import * as React from "react";
import {
  Activity,
  Gauge,
  GitPullRequest,
  Bot,
  History,
  ListTodo,
  Bug,
  FlaskConical,
  FolderGit2,
  FolderOpen,
  Home,
  Library,
  MessageSquare,
  Monitor,
  Moon,
  Plug,
  Plus,
  Search,
  Settings,
  Keyboard,
  Sun,
  Workflow,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from "@/components/ui/breadcrumb";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { BrandAvatar } from "@/components/app/brand";
import { NotificationsPopover } from "@/components/app/notifications";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { apiGet } from "@/lib/api";
import { useAppearance } from "@/lib/appearance";
import { COLOR_THEMES, readRadius, readTheme, writeRadius, writeTheme, type ColorTheme, type Radius } from "@/lib/themes";
import { ScrollArea } from "@/components/ui/scroll-area";
const ActivityView = React.lazy(() => import("@/views/ActivityView").then((m) => ({ default: m.ActivityView })));
const RunsView = React.lazy(() => import("@/views/RunsView").then((m) => ({ default: m.RunsView })));
const HomeView = React.lazy(() => import("@/views/HomeView").then((m) => ({ default: m.HomeView })));
const WorkspaceView = React.lazy(() => import("@/views/WorkspaceView").then((m) => ({ default: m.WorkspaceView })));
const QaLabView = React.lazy(() => import("@/views/QaLabView").then((m) => ({ default: m.QaLabView })));
const DefectsView = React.lazy(() => import("@/views/DefectsView").then((m) => ({ default: m.DefectsView })));
const FollowupsView = React.lazy(() => import("@/views/FollowupsView").then((m) => ({ default: m.FollowupsView })));
const AgentsView = React.lazy(() => import("@/views/AgentsView").then((m) => ({ default: m.AgentsView })));
const HarnessView = React.lazy(() => import("@/views/HarnessView").then((m) => ({ default: m.HarnessView })));
const PluginsView = React.lazy(() => import("@/views/PluginsView").then((m) => ({ default: m.PluginsView })));
const KnowledgeView = React.lazy(() => import("@/views/KnowledgeView").then((m) => ({ default: m.KnowledgeView })));
const UsageView = React.lazy(() => import("@/views/UsageView").then((m) => ({ default: m.UsageView })));
const PullsView = React.lazy(() => import("@/views/PullsView").then((m) => ({ default: m.PullsView })));
const ReposView = React.lazy(() => import("@/views/ReposView").then((m) => ({ default: m.ReposView })));
const SettingsView = React.lazy(() => import("@/views/SettingsView").then((m) => ({ default: m.SettingsView })));

const NAV_ITEMS = [
  { id: "home", label: "Home", icon: Home },
  { id: "workspace", label: "Workspace", icon: MessageSquare },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "qa", label: "QA Lab", icon: FlaskConical },
  { id: "runs", label: "QA Runs", icon: History },
  { id: "defects", label: "Defects", icon: Bug },
  { id: "followups", label: "Follow-ups", icon: ListTodo },
  { id: "usage", label: "Usage", icon: Gauge },
  { id: "pulls", label: "Pull requests", icon: GitPullRequest },
  { id: "repos", label: "Repositories", icon: FolderGit2 },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "harness", label: "QA Harness", icon: Workflow },
  { id: "plugins", label: "Plugins", icon: Plug },
  { id: "knowledge", label: "Knowledge", icon: Library },
  { id: "settings", label: "Settings", icon: Settings },
] as const;

type ViewId = (typeof NAV_ITEMS)[number]["id"];
type Scheme = "light dark" | "light" | "dark";
type SearchHit = { kind: string; ref: string; title: string };

export function App() {
  const [view, setView] = React.useState<ViewId>("home");
  const [workspaceSeen, setWorkspaceSeen] = React.useState(false);
  const [pendingPrompt, setPendingPrompt] = React.useState<string | undefined>(undefined);
  const [routeNotice, setRouteNotice] = React.useState<string | undefined>(undefined);
  const [resetKey, setResetKey] = React.useState(0);
  const [scheme, setScheme] = React.useState<Scheme>(() => {
    try {
      const s = localStorage.getItem("color-scheme");
      return s === "light" || s === "dark" ? s : "light dark";
    } catch {
      return "light dark";
    }
  });
  const [colorTheme, setColorTheme] = React.useState<ColorTheme>(readTheme);
  const [radius, setRadius] = React.useState<Radius>(readRadius);
  const appearance = useAppearance();
  const themeChoices: { id: ColorTheme; label: string }[] = [
    ...COLOR_THEMES,
    ...(appearance.custom ? [{ id: "custom" as const, label: appearance.custom.name }] : []),
  ];
  const applyTheme = React.useCallback((t: ColorTheme) => {
    setColorTheme(t);
    writeTheme(t);
  }, []);
  const applyRadius = React.useCallback((r: Radius) => {
    setRadius(r);
    writeRadius(r);
  }, []);
  // Set when a repository page opens the pull request list; the sidebar clears it again.
  const [pullsSource, setPullsSource] = React.useState("");
  const [headSlot, setHeadSlot] = React.useState<HTMLElement | null>(null);
  const [listSlot, setListSlot] = React.useState<HTMLElement | null>(null);
  const [engineOk, setEngineOk] = React.useState<boolean | null>(null);
  const [inboxCount, setInboxCount] = React.useState(0);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchHits, setSearchHits] = React.useState<SearchHit[]>([]);
  const [searched, setSearched] = React.useState(false);
  const [hitSheet, setHitSheet] = React.useState<{ title: string; content: string } | null>(null);

  const applyScheme = React.useCallback((next: Scheme) => {
    setScheme(next);
    try {
      if (next === "light dark") localStorage.removeItem("color-scheme");
      else localStorage.setItem("color-scheme", next);
    } catch {
      // ignore storage failure
    }
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", next);
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = next === "dark" || (next === "light dark" && prefersDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  // "System" follows the computer when it switches between light and dark.
  React.useEffect(() => {
    if (scheme !== "light dark") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => document.documentElement.classList.toggle("dark", mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [scheme]);

  React.useEffect(() => {
    apiGet<{ total?: number; inbox?: { total?: number } }>("/api/project").then((r) => {
      setEngineOk(r.ok);
      if (r.ok && r.data.inbox?.total) setInboxCount(r.data.inbox.total);
    });
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (e.key === "?" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchHits([]);
      setSearched(false);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      const r = await apiGet<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`);
      if (cancelled) return;
      if (r.ok) setSearchHits(r.data.hits || []);
      setSearched(true);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [searchQuery]);

  async function openHit(h: SearchHit) {
    setSearchOpen(false);
    const r = await apiGet<{ content?: string; text?: string; title?: string }>(
      `/api/doc?ref=${encodeURIComponent(h.ref)}`,
    );
    setHitSheet({
      title: r.data?.title || h.title || h.ref,
      content: r.data?.content || r.data?.text || r.error || "Document unavailable.",
    });
  }

  const goTo = React.useCallback((v: ViewId) => {
    setPullsSource("");
    if (v === "workspace") setWorkspaceSeen(true);
    setView(v);
  }, []);

  function launchWorkspace(prompt?: string, notice?: string) {
    setPendingPrompt(prompt);
    setRouteNotice(notice);
    goTo("workspace");
  }

  function newChat() {
    setResetKey((k) => k + 1);
    setRouteNotice(undefined);
    goTo("workspace");
  }

  const clearInitial = React.useCallback(() => setPendingPrompt(undefined), []);
  const current = NAV_ITEMS.find((n) => n.id === view)!;
  const engineLabel = engineOk === null ? "Connecting" : engineOk ? "Engine Ready" : "Offline";

  return (
    <MotionConfig reducedMotion={appearance.reduceMotion ? "always" : "user"}>
    <TooltipProvider>
      <SidebarProvider className="has-data-[variant=inset]:bg-muted" style={{ "--sidebar-width": "17rem" } as React.CSSProperties}>
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" onClick={() => goTo("home")}>
                  <BrandAvatar />
                  <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">SPIL REO</span>
                    <span
                      className="text-muted-foreground truncate text-xs"
                      title="A Multi-Agent Quality Engineering & Software Assurance Platform."
                    >
                      Multi-Agent QE &amp; Assurance
                    </span>
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <div ref={setHeadSlot} />
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV_ITEMS.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        tooltip={item.label}
                        isActive={view === item.id}
                        onClick={() => goTo(item.id)}
                      >
                        <item.icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <div ref={setListSlot} className="flex min-h-0 flex-1 flex-col" />
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip={engineLabel} className="cursor-default">
                  <span
                    className={
                      "size-2 shrink-0 rounded-full " +
                      (engineOk === null ? "bg-muted-foreground" : engineOk ? "bg-primary" : "bg-destructive")
                    }
                  />
                  <span>{engineLabel}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton tooltip="Theme">
                      {scheme === "dark" ? <Moon /> : scheme === "light" ? <Sun /> : <Monitor />}
                      <span>Theme</span>
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="end">
                    <DropdownMenuRadioGroup value={scheme} onValueChange={(v) => applyScheme(v as Scheme)}>
                      <DropdownMenuRadioItem value="light dark">System</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>Colour</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuRadioGroup value={colorTheme} onValueChange={(v) => applyTheme(v as ColorTheme)}>
                          {themeChoices.map((t) => (
                            <DropdownMenuRadioItem key={t.id} value={t.id}>
                              <span data-theme={t.id} className="bg-primary mr-2 inline-block size-3 rounded-full" />
                              {t.label}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>

        <SidebarInset className="h-[calc(100svh-1rem)] min-w-0 overflow-hidden">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <Breadcrumb className="min-w-0">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage>{current.label}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setSearchOpen(true)}
                aria-label="Search vault and commits"
              >
                <Search />
                <span className="hidden sm:inline">Search</span>
                <kbd className="bg-muted hidden rounded px-1.5 font-mono text-[10px] md:inline">Ctrl K</kbd>
              </Button>
              <Button variant="outline" size="sm" onClick={newChat}>
                <Plus />
                <span className="hidden sm:inline">New Chat</span>
              </Button>
              <NotificationsPopover count={inboxCount} onCount={setInboxCount} onOpenInbox={() => goTo("knowledge")} />
            </div>
          </header>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {workspaceSeen && (
              <div className={view === "workspace" ? "flex min-h-0 flex-1" : "hidden"}>
                <React.Suspense fallback={<Skeleton className="m-6 h-40 w-full" />}>
                <WorkspaceView
                  initialPrompt={pendingPrompt}
                  routeNotice={routeNotice}
                  resetKey={resetKey}
                  active={view === "workspace"}
                  headSlot={headSlot}
                  listSlot={listSlot}
                  onClearInitial={clearInitial}
                  onOpenDefects={() => goTo("defects")}
                />
                </React.Suspense>
              </div>
            )}
            {view !== "workspace" && (
              <ScrollArea className="min-h-0 flex-1">
                <React.Suspense fallback={<div className="space-y-3 p-6"><Skeleton className="h-8 w-48" /><Skeleton className="h-40 w-full" /></div>}>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={view}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                {view === "home" && (
                  <HomeView onOpenWorkspace={launchWorkspace} onOpenView={(v) => goTo(v as ViewId)} />
                )}
                {view === "activity" && <ActivityView onOpenView={(v) => goTo(v as ViewId)} />}
                {view === "qa" && <QaLabView />}
                {view === "runs" && <RunsView />}
                {view === "defects" && <DefectsView />}
                {view === "followups" && <FollowupsView />}
                {view === "agents" && (
                  <AgentsView
                    onRunMission={(prompt) =>
                      launchWorkspace(prompt, "Dispatched specialist mission from Agent Catalog")
                    }
                  />
                )}
                {view === "usage" && <UsageView />}
                {view === "pulls" && <PullsView initialSource={pullsSource} />}
                {view === "repos" && (
                  <ReposView
                    onOpenPulls={(repoId) => {
                      setPullsSource(repoId);
                      setView("pulls");
                    }}
                  />
                )}
                {view === "harness" && <HarnessView />}
                {view === "plugins" && <PluginsView />}
                {view === "knowledge" && <KnowledgeView />}
                {view === "settings" && <SettingsView scheme={scheme} onSchemeChange={applyScheme} colorTheme={colorTheme} onColorTheme={applyTheme} radius={radius} onRadius={applyRadius} />}
                  </motion.div>
                </AnimatePresence>
                </React.Suspense>
              </ScrollArea>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>

      <CommandDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Search"
        description="Search vault notes, commits and files"
      >
        <CommandInput value={searchQuery} onValueChange={setSearchQuery} placeholder="Search vault & commits..." />
        <CommandList>
          {!searchQuery.trim() && (
            <>
              <CommandGroup heading="Go to">
                {NAV_ITEMS.map((n) => (
                  <CommandItem key={n.id} value={`go ${n.label}`} onSelect={() => { setSearchOpen(false); goTo(n.id); }}>
                    <n.icon />
                    {n.label}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Actions">
                <CommandItem value="new chat" onSelect={() => { setSearchOpen(false); newChat(); }}>
                  <Plus />
                  New chat
                </CommandItem>
                <CommandItem value="run qa review" onSelect={() => { setSearchOpen(false); launchWorkspace("@qa @review inspect the latest branch changes"); }}>
                  <FlaskConical />
                  Run QA &amp; Review
                </CommandItem>
                <CommandItem value="security audit" onSelect={() => { setSearchOpen(false); launchWorkspace("@security audit localhost backend safety"); }}>
                  <Bug />
                  Cyber Security Audit
                </CommandItem>
                <CommandItem value="theme dark" onSelect={() => { setSearchOpen(false); applyScheme("dark"); }}>
                  <Moon />
                  Dark theme
                </CommandItem>
                <CommandItem value="theme light" onSelect={() => { setSearchOpen(false); applyScheme("light"); }}>
                  <Sun />
                  Light theme
                </CommandItem>
                {themeChoices.map((t) => (
                  <CommandItem key={t.id} value={`change theme colour ${t.label}`} onSelect={() => { setSearchOpen(false); applyTheme(t.id); }}>
                    <span data-theme={t.id} className="bg-primary inline-block size-3 rounded-full" />
                    Change theme: {t.label}
                  </CommandItem>
                ))}
                <CommandItem value="shortcuts help" onSelect={() => { setSearchOpen(false); setHelpOpen(true); }}>
                  <Keyboard />
                  Keyboard shortcuts
                  <CommandShortcut>?</CommandShortcut>
                </CommandItem>
              </CommandGroup>
            </>
          )}
          {searched && searchHits.length === 0 && (
            <CommandEmpty>No matching notes, commits, or files found.</CommandEmpty>
          )}
          {searchHits.length > 0 && (
            <CommandGroup heading="Results">
              {searchHits.map((h) => (
                <CommandItem key={h.ref} value={h.ref} forceMount onSelect={() => openHit(h)}>
                  <FolderOpen />
                  <span className="min-w-0 flex-1 truncate">{h.title}</span>
                  <Badge variant="outline">{h.kind}</Badge>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>Move around without the mouse.</DialogDescription>
          </DialogHeader>
          <dl className="grid gap-2 text-sm">
            {[
              ["Ctrl K", "Command palette and search"],
              ["Ctrl B", "Toggle sidebar"],
              ["Enter", "Send message (Shift+Enter for a new line)"],
              ["?", "Show this help"],
            ].map(([k, d]) => (
              <div key={k} className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">{d}</dt>
                <dd><kbd className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{k}</kbd></dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>

      <Sheet open={hitSheet !== null} onOpenChange={(o) => !o && setHitSheet(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle className="break-words">{hitSheet?.title}</SheetTitle>
            <SheetDescription>Source document</SheetDescription>
          </SheetHeader>
          <pre className="px-4 pb-4 font-mono text-xs break-words whitespace-pre-wrap">{hitSheet?.content}</pre>
        </SheetContent>
      </Sheet>

      <Toaster theme={scheme === "light dark" ? "system" : scheme} />
    </TooltipProvider>
    </MotionConfig>
  );
}
