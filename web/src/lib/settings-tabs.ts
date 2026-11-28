/** The Settings tabs, shared with the command palette so each can be opened directly. */
export const SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "source", label: "Source control" },
  { id: "diffs", label: "Diffs & pull requests" },
  { id: "keyboard", label: "Keyboard" },
  { id: "notifications", label: "Notifications" },
  { id: "memory", label: "Memory" },
  { id: "index", label: "Repositories & index" },
  { id: "health", label: "System health" },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];
