import * as vscode from "vscode";
import { SCHEME, VirtualDocs, deleteData, logNote, menu, openChat, setup, showToday, startCapture, stopCapture, summarizeDay, togglePause } from "./vsc/commands.ts";
import { registerChat } from "./vsc/chat.ts";
import { Session } from "./vsc/session.ts";
import { createStatusBar } from "./vsc/statusbar.ts";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const out = vscode.window.createOutputChannel("SPIL Quality Support Bot");
  context.subscriptions.push(out);
  const log = (m: string) => out.appendLine(`${new Date().toISOString()} ${m}`);
  const s = new Session({ vsc: vscode, workspaceState: context.workspaceState, log });
  const docs = new VirtualDocs();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, docs));

  // Commands never throw into the editor.
  const guarded = (name: string, fn: () => Promise<void>) =>
    vscode.commands.registerCommand(name, async () => {
      try {
        await fn();
      } catch (e) {
        log(`${name}: ${(e as Error).stack ?? (e as Error).message}`);
        s.warnOnce(`Something went wrong (${(e as Error).message}). See the "SPIL Quality Support Bot" Output channel.`);
      }
    });
  context.subscriptions.push(
    guarded("auraGuard.logIdea", () => logNote(s, "idea")),
    guarded("auraGuard.logDecision", () => logNote(s, "decision")),
    guarded("auraGuard.logCorrection", () => logNote(s, "correction")),
    guarded("auraGuard.showToday", () => showToday(s, docs)),
    guarded("auraGuard.summarizeDay", () => summarizeDay(s, docs)),
    guarded("auraGuard.togglePause", () => togglePause(s)),
    guarded("auraGuard.deleteData", () => deleteData(s)),
    guarded("auraGuard.openChat", () => openChat(s)),
    guarded("auraGuard.setup", () => setup(s)),
    guarded("auraGuard.menu", () => menu(s, docs)),
  );

  try {
    await s.init();
  } catch (e) {
    log(`init: ${(e as Error).message}`);
  }
  context.subscriptions.push(createStatusBar(s));
  const chat = registerChat(s);
  if (chat) context.subscriptions.push(chat);
  context.subscriptions.push({ dispose: () => stopCapture(s) });

  // Nothing is captured until consent. Ask once per workspace unless declined before.
  try {
    if (s.state === "needs-consent" && !context.workspaceState.get<boolean>("declined")) {
      if (await s.askConsent()) startCapture(s);
    } else {
      startCapture(s);
    }
  } catch (e) {
    log(`consent: ${(e as Error).message}`);
  }
  s.changed();
  log(`activated: state=${s.state} repo=${s.key || "-"} terminal=${s.terminalAvailable}`);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("auraGuard")) s.changed();
    }),
  );
}

export function deactivate(): void {}
