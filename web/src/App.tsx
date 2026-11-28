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
  LayoutDashboard,
  Moon,
  Plug,
  Plus,
  Rocket,
  Search,
  Settings,
  Keyboard,
  Sun,
  Workflow,
  SlidersHorizontal,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { ErrorBoundary } from "@/components/app/error-boundary";
import { useEngineStatus } from "@/lib/connection";
import { SHORTCUTS, keysFor, label as keyLabel, useOverrides, useShortcut } from "@/lib/keybindings";
import { SETTINGS_TABS, type SettingsTab } from "@/lib/settings-tabs";
import { useAppearance } from "@/lib/appearance";
import { SettingsMenu } from "@/components/app/settings-menu";
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
const MissionsView = React.lazy(() => import("@/views/MissionsView").then((m) => ({ default: m.MissionsView })));
const UsageView = React.lazy(() => import("@/views/UsageView").then((m) => ({ default: m.UsageView })));
const PullsView = React.lazy(() => import("@/views/PullsView").then((m) => ({ default: m.PullsView })));
const ReposView = React.lazy(() => import("@/views/ReposView").then((m) => ({ default: m.ReposView })));
const SettingsView = React.lazy(() => import("@/views/SettingsView").then((m) => ({ default: m.SettingsView })));

const NAV_ITEMS = [
  { id: "workspace", label: "Home", icon: Home },
  { id: "home", label: "Overview", icon: LayoutDashboard },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "qa", label: "QA Lab", icon: FlaskConical },
  { id: "runs", label: "QA Runs", icon: History },
  { id: "defects", label: "Defects", icon: Bug },
  { id: "followups", label: "Follow-ups", icon: ListTodo },
  { id: "missions", label: "Missions", icon: Rocket },
  { id: "usage", label: "Usage", icon: Gauge },
  { id: "pulls", label: "Pull requests", icon: GitPullRequest },
  { id: "repos", label: "Repositories", icon: FolderGit2 },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "harness", label: "QA Harness", icon: Workflow },
  { id: "plugins", label: "Plugins", icon: Plug },
  { id: "knowledge", label: "Knowledge", icon: Library },
  { id: "settings", label: "Settings", icon: Settings },
] as const;

type NavId = (typeof NAV_ITEMS)[number]["id"];

/** The only pages in the sidebar. Settings sits at the bottom of it. */
const SIDEBAR_NAV: readonly NavId[] = ["workspace", "home", "qa", "defects", "pulls", "repos"];

/** Every other page is listed in the Settings menu. */
const SETTINGS_PAGES: { heading: string; icon: React.ComponentType<{ className?: string }>; ids: readonly NavId[] }[] = [
  { heading: "Quality work", icon: ShieldCheck, ids: ["activity", "missions", "runs", "followups", "harness"] },
  { heading: "Assistant", icon: Sparkles, ids: ["agents", "knowledge", "plugins", "usage"] },
];
const IN_SETTINGS: ReadonlySet<string> = new Set(["settings", ...SETTINGS_PAGES.flatMap((g) => g.ids)]);

type ViewId = (typeof NAV_ITEMS)[number]["id"];
type Scheme = "light dark" | "light" | "dark";
type SearchHit = { kind: string; ref: string; title: string };

export function App() {
  const [view, setView] = React.useState<ViewId>("workspace");
  const [workspaceSeen, setWorkspaceSeen] = React.useState(true);
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
  const engine = useEngineStatus();
  const shortcutKeys = useOverrides();
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab>("general");
  const [openRequest, setOpenRequest] = React.useState<{ id: string; n: number } | undefined>(undefined);
  const [chatHits, setChatHits] = React.useState<{ id: string; title: string; snippet: string }[]>([]);
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

  const online = engine.state === "online";
  React.useEffect(() => {
    if (!online) return;
    apiGet<{ total?: number; inbox?: { total?: number } }>("/api/project").then((r) => {
      if (r.ok && r.data.inbox?.total) setInboxCount(r.data.inbox.total);
    });
  }, [online]);

  React.useEffect(() => {
    const q = searchQuery.trim();
    setSearched(false);
    if (!q) {
      setSearchHits([]);
      setChatHits([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      const [r, c] = await Promise.all([
        apiGet<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`),
        apiGet<{ hits?: { id: string; title: string; snippet: string }[] }>(`/api/chats/search?q=${encodeURIComponent(q)}`),
      ]);
      if (cancelled) return;
      setSearchHits(r.ok ? r.data.hits || [] : []);
      setChatHits(c.ok && Array.isArray(c.data.hits) ? c.data.hits.slice(0, 6) : []);
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

  function openSettings(tab: SettingsTab) {
    setSettingsTab(tab);
    goTo("settings");
  }

  function openChat(id: string) {
    setOpenRequest((p) => ({ id, n: (p?.n ?? 0) + 1 }));
    setRouteNotice(undefined);
    goTo("workspace");
  }

  useShortcut("palette", () => setSearchOpen((o) => !o));
  useShortcut("newChat", newChat);
  useShortcut("settings", () => goTo("settings"));
  useShortcut("help", () => setHelpOpen(true));

  // Every word typed must appear in a command's name for it to stay listed.
  const words = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const run = (fn: () => void) => () => {
    setSearchOpen(false);
    setSearchQuery("");
    fn();
  };
  const commandGroups = [
    {
      heading: "Go to",
      items: NAV_ITEMS.map((n) => ({ name: n.label, icon: <n.icon />, act: () => goTo(n.id) })),
    },
    {
      heading: "Actions",
      items: [
        { name: "New chat", icon: <Plus />, act: newChat },
        { name: "Run QA & Review", icon: <FlaskConical />, act: () => launchWorkspace("@qa @review inspect the latest branch changes") },
        { name: "Cyber Security Audit", icon: <Bug />, act: () => launchWorkspace("@security audit localhost backend safety") },
        { name: "Dark theme", icon: <Moon />, act: () => applyScheme("dark") },
        { name: "Light theme", icon: <Sun />, act: () => applyScheme("light") },
        ...themeChoices.map((t) => ({
          name: `Change theme colour: ${t.label}`,
          icon: <span data-theme={t.id} className="bg-primary inline-block size-3 rounded-full" />,
          act: () => applyTheme(t.id),
        })),
        { name: "Keyboard shortcuts", icon: <Keyboard />, act: () => setHelpOpen(true) },
      ],
    },
    {
      heading: "Settings",
      items: SETTINGS_TABS.map((t) => ({ name: `Settings: ${t.label}`, icon: <Settings />, act: () => openSettings(t.id) })),
    },
  ]
    .map((g) => ({ ...g, items: g.items.filter((i) => words.every((w) => i.name.toLowerCase().includes(w))) }))
    .filter((g) => g.items.length > 0);
  const nothingFound = searched && !commandGroups.length && !chatHits.length && !searchHits.length;

  const clearInitial = React.useCallback(() => setPendingPrompt(undefined), []);
  const current = NAV_ITEMS.find((n) => n.id === view)!;

  return (
    <MotionConfig reducedMotion={appearance.reduceMotion ? "always" : "user"}>
    <TooltipProvider>
      <SidebarProvider className="has-data-[variant=inset]:bg-muted" style={{ "--sidebar-width": "17rem" } as React.CSSProperties}>
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" onClick={() => goTo("workspace")}>
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
                  {SIDEBAR_NAV.map((id) => NAV_ITEMS.find((n) => n.id === id)!).map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton tooltip={item.label} isActive={view === item.id} onClick={() => goTo(item.id)}>
                        <item.icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <div ref={setListSlot} className="flex min-h-72 flex-1 flex-col empty:hidden" />
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Settings" isActive={IN_SETTINGS.has(view)} onClick={() => goTo("settings")}>
                  <Settings />
                  <span>Settings</span>
                </SidebarMenuButton>
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
                {IN_SETTINGS.has(view) && view !== "settings" && (
                  <>
                    <BreadcrumbItem>Settings</BreadcrumbItem>
                    <BreadcrumbSeparator />
                  </>
                )}
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
                {keysFor("palette", shortcutKeys) && (
                  <kbd className="bg-muted hidden rounded px-1.5 font-mono text-[10px] md:inline">{keyLabel(keysFor("palette", shortcutKeys))}</kbd>
                )}
              </Button>
              <Button variant="outline" size="sm" onClick={newChat}>
                <Plus />
                <span className="hidden sm:inline">New Chat</span>
              </Button>
              <NotificationsPopover count={inboxCount} onCount={setInboxCount} onOpenInbox={() => goTo("knowledge")} />
            </div>
          </header>

          {(engine.state === "offline" || engine.state === "unpaired") && (
            <div role="alert" className="border-destructive/50 flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
              <span className="min-w-0 flex-1">
                {engine.state === "unpaired"
                  ? "The engine does not recognise this window. Open SPIL REO from its own window again."
                  : "The engine is not answering. Nothing can be loaded or saved until it is running again."}
              </span>
              <Button variant="outline" size="sm" onClick={engine.check}>
                Check again
              </Button>
            </div>
          )}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {workspaceSeen && (
              <div className={view === "workspace" ? "flex min-h-0 flex-1" : "hidden"}>
                <ErrorBoundary what="The Workspace">
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
                  onOpenView={(v) => goTo(v as ViewId)}
                  openRequest={openRequest}
                />
                </React.Suspense>
                </ErrorBoundary>
              </div>
            )}
            {view !== "workspace" && (
              <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              {IN_SETTINGS.has(view) && (
                <SettingsMenu
                  groups={[
                    {
                      heading: "Preferences",
                      icon: SlidersHorizontal,
                      items: SETTINGS_TABS.map((t) => ({ key: t.id, label: t.label, active: view === "settings" && settingsTab === t.id, open: () => openSettings(t.id) })),
                    },
                    ...SETTINGS_PAGES.map((g) => ({
                      heading: g.heading,
                      icon: g.icon,
                      items: g.ids.map((id) => ({ key: id, label: NAV_ITEMS.find((n) => n.id === id)!.label, active: view === id, open: () => goTo(id) })),
                    })),
                  ]}
                />
              )}
              <ScrollArea className="min-h-0 min-w-0 flex-1">
                <ErrorBoundary key={view} what="This page">
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
                {view === "missions" && <MissionsView onOpenChat={openChat} onOpenView={(v) => goTo(v as ViewId)} />}
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
                {view === "settings" && <SettingsView tab={settingsTab} onTab={setSettingsTab} scheme={scheme} onSchemeChange={applyScheme} colorTheme={colorTheme} onColorTheme={applyTheme} radius={radius} onRadius={applyRadius} />}
                  </motion.div>
                </AnimatePresence>
                </React.Suspense>
                </ErrorBoundary>
              </ScrollArea>
              </div>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>

      <CommandDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Search"
        description="Run a command or search chats, vault notes, commits and files"
        shouldFilter={false}
      >
        <CommandInput value={searchQuery} onValueChange={setSearchQuery} placeholder="Type a command, or search chats, notes and commits..." />
        <CommandList>
          {commandGroups.map((g) => (
            <CommandGroup key={g.heading} heading={g.heading}>
              {g.items.map((i) => (
                <CommandItem key={i.name} value={`command ${i.name}`} onSelect={run(i.act)}>
                  {i.icon}
                  {i.name}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {chatHits.length > 0 && (
            <CommandGroup heading="Chats">
              {chatHits.map((h) => (
                <CommandItem key={h.id} value={`chat ${h.id}`} onSelect={run(() => openChat(h.id))}>
                  <MessageSquare />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{h.title}</span>
                    {h.snippet && <span className="text-muted-foreground block truncate text-xs">{h.snippet}</span>}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {searchHits.length > 0 && (
            <CommandGroup heading="Notes, commits and files">
              {searchHits.map((h) => (
                <CommandItem key={h.ref} value={`ref ${h.ref}`} onSelect={() => openHit(h)}>
                  <FolderOpen />
                  <span className="min-w-0 flex-1 truncate">{h.title}</span>
                  <Badge variant="outline">{h.kind}</Badge>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {nothingFound && <p className="text-muted-foreground p-6 text-center text-sm">No command, chat, note, commit or file matches.</p>}
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
              ...SHORTCUTS.map((k) => [keyLabel(keysFor(k.id, shortcutKeys)), k.label]),
              ["Ctrl B", "Toggle sidebar"],
              ["Enter", "Send message (Shift+Enter for a new line)"],
              ["Up arrow", "Bring back an earlier message"],
            ].map(([k, d]) => (
              <div key={d} className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">{d}</dt>
                <dd><kbd className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{k}</kbd></dd>
              </div>
            ))}
          </dl>
          <Button variant="outline" size="sm" onClick={() => { setHelpOpen(false); openSettings("keyboard"); }}>
            Change shortcuts
          </Button>
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
