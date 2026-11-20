import { readFileSync, existsSync } from "node:fs";
import type * as vscode from "vscode";
import { MAX_TEXT, cap } from "../core/events.ts";
import type { EventKind } from "../core/events.ts";
import { appendDraft, resolveAiLogTarget } from "../core/draft.ts";
import { localDate } from "../core/repoKey.ts";
import type { Session } from "./session.ts";
import { bindCapture } from "./capture.ts";

export const SCHEME = "aura-guard";

/** Holds text for read-only virtual documents (today's events, the diff sides). */
export class VirtualDocs implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  set(path: string, text: string): string {
    this.docs.set(path, text);
    return path;
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path) ?? "";
  }
}

const SECRET_MSG = "That text looks like it contains a secret, so nothing was saved. Remove the secret and try again.";

/** Needs consent and a running recorder; tells the developer why when it cannot go on. */
async function ready(s: Session, what: string, allowPaused = false): Promise<boolean> {
  const w = s.vsc.window;
  if (s.state === "off") {
    void w.showInformationMessage("SPIL Quality Support Bot is off here. Open a workspace with ai-log/README.md, or add it to auraGuard.workspaces.");
    return false;
  }
  if (s.state === "needs-consent") {
    if (!(await s.askConsent())) return false;
    startCapture(s);
  }
  if (s.state === "paused" && !allowPaused) {
    void w.showInformationMessage(`Capture is paused, so ${what} was not recorded. Resume it from the SPIL Quality Support Bot status bar item.`);
    return false;
  }
  return true;
}

/** Binds capture once, after consent. */
export function startCapture(s: Session): void {
  const h = s as Session & { __subs?: vscode.Disposable[] };
  if (h.__subs || s.state === "off" || s.state === "needs-consent") return;
  h.__subs = bindCapture(s);
}
export function stopCapture(s: Session): void {
  const h = s as Session & { __subs?: vscode.Disposable[] };
  h.__subs?.forEach((d) => d.dispose());
  h.__subs = undefined;
}

export async function logNote(s: Session, kind: Extract<EventKind, "idea" | "decision" | "correction">): Promise<void> {
  const { vsc } = s;
  if (!(await ready(s, `your ${kind}`))) return;
  const text = await vsc.window.showInputBox({
    prompt: `Guard: log a ${kind}`,
    placeHolder: kind === "idea" ? "An idea for later" : kind === "decision" ? "What you decided, and what you rejected" : "What the AI got wrong and what to do instead",
    validateInput: (v) => (v.length > MAX_TEXT ? `Keep it under ${MAX_TEXT} characters.` : undefined),
  });
  if (!text || !text.trim()) return;

  // Offer the cursor position as context. Only the path and line number, never the text.
  let context: { path: string; line: number } | undefined;
  const ed = vsc.window.activeTextEditor;
  const rel = ed ? s.rel(ed.document.uri.fsPath) : null;
  if (ed && rel) {
    const line = ed.selection.active.line + 1;
    const pick = await vsc.window.showQuickPick([`Attach ${rel}:${line}`, "No context"], { placeHolder: "Add where you are as context?" });
    if (pick === undefined) return;
    if (pick.startsWith("Attach")) context = { path: rel, line };
  }
  const data: Record<string, unknown> = { text: cap(text.trim(), MAX_TEXT), ...(context ? { context } : {}) };
  const r = s.recorder!.record(kind, data, text);
  s.changed();
  if (r === "secret") void vsc.window.showWarningMessage(SECRET_MSG);
  else if (r === "cap") void vsc.window.showWarningMessage("Today's event limit was reached, so this was not saved.");
  else if (r === "written") void vsc.window.showInformationMessage(`Guard: ${kind} saved locally.`);
}

export async function showToday(s: Session, docs: VirtualDocs): Promise<void> {
  const { vsc } = s;
  if (s.state === "off" || !s.spool) return void vsc.window.showInformationMessage("SPIL Quality Support Bot is off in this workspace.");
  const f = s.spool.file(s.key, localDate(s.now()));
  const text = existsSync(f) ? readFileSync(f, "utf8") : "";
  const path = docs.set(`/today-${s.key}.jsonl`, text || "// Nothing captured yet today.\n");
  const doc = await vsc.workspace.openTextDocument(vsc.Uri.from({ scheme: SCHEME, path }));
  await vsc.window.showTextDocument(doc, { preview: true });
}

export async function togglePause(s: Session): Promise<void> {
  if (s.state === "needs-consent") {
    if (await s.askConsent()) startCapture(s);
    return;
  }
  if (s.state === "off") return void s.vsc.window.showInformationMessage("SPIL Quality Support Bot is off in this workspace.");
  await s.setPaused(!s.paused);
}

export async function applyDraft(s: Session, rel: string, abs: string, content: string, existed: boolean, save: boolean): Promise<void> {
  const { vsc } = s;
  const uri = vsc.Uri.file(abs);
  await vsc.workspace.fs.createDirectory(vsc.Uri.file(abs.replace(/[\\/][^\\/]+$/, "")));
  const edit = new vsc.WorkspaceEdit();
  if (!existed) {
    edit.createFile(uri, { ignoreIfExists: true, contents: new TextEncoder().encode(content) });
  } else {
    const doc = await vsc.workspace.openTextDocument(uri);
    edit.replace(uri, new vsc.Range(new vsc.Position(0, 0), doc.positionAt(doc.getText().length)), content);
  }
  const ok = await vsc.workspace.applyEdit(edit);
  if (!ok) return void vsc.window.showWarningMessage("SPIL Quality Support Bot: could not update the ai-log file.");
  const doc = await vsc.workspace.openTextDocument(uri);
  if (save && doc.isDirty) await doc.save();
  await vsc.window.showTextDocument(doc);
  void vsc.window.showInformationMessage(save ? `Added to ${rel}. Nothing was committed.` : `Draft added to ${rel} but not saved. Edit it, then save.`);
}

export async function summarizeDay(s: Session, docs: VirtualDocs): Promise<void> {
  const { vsc } = s;
  if (!(await ready(s, "the summary", true))) return;
  const problem = s.guardProblem();
  if (problem) return void vsc.window.showWarningMessage(`SPIL Quality Support Bot: ${problem} Run "Guard: Set up".`);
  let res;
  try {
    res = await vsc.window.withProgress({ location: vsc.ProgressLocation.Notification, title: "SPIL Quality Support Bot: summarizing your day" }, () =>
      s.cli().summarize(s.folder!),
    );
  } catch (e) {
    s.env.log(`summarize: ${(e as Error).message}`);
    return void vsc.window.showWarningMessage(`SPIL Quality Support Bot: ${(e as Error).message}`);
  }
  if (!res.draft.trim()) return void vsc.window.showInformationMessage("SPIL Quality Support Bot: nothing to add for that day.");
  if (res.questions.length > 0) {
    const go = await vsc.window.showInformationMessage(
      `Guard has ${res.questions.length} question(s) for you`,
      { modal: true, detail: res.questions.map((q, i) => `${i + 1}. ${q}`).join("\n") + "\n\nYou can answer them by editing the draft." },
      "Continue",
    );
    if (go !== "Continue") return;
  }
  const target = resolveAiLogTarget(s.folder!, res.file);
  if (!target) return void vsc.window.showWarningMessage("SPIL Quality Support Bot returned an unexpected file name, so nothing was changed.");
  const existed = existsSync(target.abs);
  const content = appendDraft(existed ? readFileSync(target.abs, "utf8") : null, res.draft);

  const left = docs.set(`/current/${target.rel}`, existed ? readFileSync(target.abs, "utf8") : "");
  const right = docs.set(`/proposed/${target.rel}`, content);
  await vsc.commands.executeCommand(
    "vscode.diff",
    vsc.Uri.from({ scheme: SCHEME, path: left }),
    vsc.Uri.from({ scheme: SCHEME, path: right }),
    `SPIL Quality Support Bot: ${target.rel} (current vs with draft)`,
  );
  const pick = await vsc.window.showInformationMessage("Add these entries to ai-log?", "Apply", "Edit first", "Cancel");
  if (pick === "Apply") await applyDraft(s, target.rel, target.abs, content, existed, true);
  else if (pick === "Edit first") await applyDraft(s, target.rel, target.abs, content, existed, false);
}

export async function deleteData(s: Session): Promise<void> {
  const { vsc } = s;
  if (s.state === "off") return void vsc.window.showInformationMessage("SPIL Quality Support Bot is off in this workspace.");
  const yes = "Delete";
  const c = await vsc.window.showWarningMessage(
    "Delete all SPIL Quality Support Bot data captured for this workspace?",
    { modal: true, detail: "This removes the captured events for this workspace from the local spool. Your ai-log files and git history are not touched." },
    yes,
  );
  if (c !== yes) return;
  try {
    if (s.guardProblem()) {
      s.deleteLocal();
      void vsc.window.showInformationMessage("Deleted your captured events for this workspace.");
    } else {
      const r = await s.cli().purge(s.folder!, { all: true });
      s.spool?.reset();
      if (s.recorder) s.recorder.today = 0;
      void vsc.window.showInformationMessage(`Deleted ${r.removed} item(s) of captured data for this workspace.`);
    }
  } catch (e) {
    s.env.log(`delete: ${(e as Error).message}`);
    void vsc.window.showWarningMessage(`SPIL Quality Support Bot: ${(e as Error).message}`);
  }
  s.changed();
}

export async function openChat(s: Session): Promise<void> {
  const problem = s.guardProblem();
  if (problem) return void s.vsc.window.showWarningMessage(`SPIL Quality Support Bot: ${problem}`);
  s.cli()
    .openUi()
    .catch((e: Error) => s.env.log(`chat window: ${e.message}`));
  void s.vsc.window.showInformationMessage("SPIL Quality Support Bot chat window is starting.");
}

export async function setup(s: Session): Promise<void> {
  const { vsc } = s;
  const pick = await vsc.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Use this SPIL Quality Support Bot folder", title: "Choose your SPIL Quality Support Bot clone" });
  const dir = pick?.[0]?.fsPath ?? s.cfg<string>("guardHome", "").trim();
  if (!dir) return;
  await vsc.workspace.getConfiguration("auraGuard").update("guardHome", dir, vsc.ConfigurationTarget.Global);
  const problem = s.guardProblem();
  if (problem) return void vsc.window.showWarningMessage(`SPIL Quality Support Bot: ${problem}`);
  let nodeV = "";
  try {
    nodeV = (await s.run(s.cfg<string>("nodePath", "").trim() || "node", ["--version"], { timeout: 10_000, maxBuffer: 4096 })).stdout.trim();
  } catch {
    return void vsc.window.showWarningMessage("SPIL Quality Support Bot: Node was not found. Set auraGuard.nodePath to node 24 or newer.");
  }
  try {
    const st = await s.cli().status();
    const repos = st.repos.length;
    void vsc.window.showInformationMessage(
      `SPIL Quality Support Bot is ready. Node ${nodeV}. Consent: ${st.consent.accepted ? "accepted" : "not given yet"}. Spool: ${st.spoolDir} (${repos} workspace(s) with data).`,
    );
  } catch (e) {
    void vsc.window.showWarningMessage(`SPIL Quality Support Bot: ${(e as Error).message}`);
  }
  if (s.state === "needs-consent" && (await s.askConsent())) startCapture(s);
}

export async function menu(s: Session, docs: VirtualDocs): Promise<void> {
  const { vsc } = s;
  const items: { label: string; description?: string; run?: () => Promise<void> }[] = [];
  if (s.state === "needs-consent") items.push({ label: "Review and accept consent...", run: () => togglePause(s) });
  if (s.state === "capturing" || s.state === "paused") {
    items.push({ label: s.paused ? "Resume capture" : "Pause capture", run: () => togglePause(s) });
    items.push({ label: "Show today's captured events", run: () => showToday(s, docs) });
  }
  items.push(
    { label: "Summarize my day", run: () => summarizeDay(s, docs) },
    { label: "Log an idea", run: () => logNote(s, "idea") },
    { label: "Open Guard chat", run: () => openChat(s) },
    { label: "Delete my data", run: () => deleteData(s) },
    { label: "Settings", run: async () => void (await vsc.commands.executeCommand("workbench.action.openSettings", "auraGuard")) },
  );
  if (s.state !== "off") {
    items.push({ label: `Terminal capture: ${s.terminalAvailable ? "available" : "unavailable (no shell integration)"}`, description: "info" });
    items.push({ label: `Today: ${s.recorder?.today ?? 0} events, ${s.recorder?.dropped ?? 0} dropped for secrets`, description: "info" });
  }
  const p = await vsc.window.showQuickPick(items, { placeHolder: "SPIL Quality Support Bot" });
  await p?.run?.();
}
