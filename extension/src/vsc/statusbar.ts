import type * as vscode from "vscode";
import type { Session } from "./session.ts";

export function statusText(s: Session): { text: string; tooltip: string } {
  const n = s.recorder?.today ?? 0;
  const d = s.recorder?.dropped ?? 0;
  switch (s.state) {
    case "capturing":
      return { text: `$(eye) Guard: capturing ${n} | ${d} dropped`, tooltip: `SPIL AURA QA Bot is recording this workspace locally. ${n} events today, ${d} dropped because they held a secret. Click for the menu.` };
    case "paused":
      return { text: `$(debug-pause) Guard: paused ${n}`, tooltip: "SPIL AURA QA Bot capture is paused. Nothing is recorded. Click for the menu." };
    case "needs-consent":
      return { text: "$(shield) Guard: needs consent", tooltip: "SPIL AURA QA Bot is not recording. Click to read what it would capture and decide." };
    default:
      return { text: "$(circle-slash) Guard: off", tooltip: "SPIL AURA QA Bot is off in this workspace (no ai-log/README.md and not listed in auraGuard.workspaces)." };
  }
}

export function createStatusBar(s: Session): vscode.StatusBarItem {
  const { vsc } = s;
  const item = vsc.window.createStatusBarItem(vsc.StatusBarAlignment.Left, 0);
  item.command = "auraGuard.menu";
  const update = () => {
    const t = statusText(s);
    item.text = t.text;
    item.tooltip = t.tooltip;
  };
  s.setOnChange(update);
  update();
  item.show();
  return item;
}
