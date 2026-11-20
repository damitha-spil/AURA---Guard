import type * as vscode from "vscode";
import { cap } from "../core/events.ts";
import { readCommit } from "../core/gitinfo.ts";
import { SaveAggregator } from "../core/saves.ts";
import { allowedCommand } from "../core/terminal.ts";
import type { Session } from "./session.ts";

/** Minimal slice of the git extension API that we use (git.d.ts, API version 1). */
interface GitRepo {
  rootUri: vscode.Uri;
  state: { HEAD?: { name?: string; commit?: string } };
  onDidCommit?: vscode.Event<void>;
}
interface GitApi {
  repositories: GitRepo[];
  onDidOpenRepository: vscode.Event<GitRepo>;
}

/**
 * Binds VS Code events to the recorder. Called only after consent. Every handler
 * goes through Recorder.record, which checks consent, pause and the source switch again.
 */
export function bindCapture(s: Session): vscode.Disposable[] {
  const { vsc } = s;
  const subs: vscode.Disposable[] = [];
  const saves = new SaveAggregator();
  const starts = new WeakMap<object, number>();
  const rec = () => s.recorder!;
  const after = () => s.changed();

  const flushSaves = (all: boolean) => {
    for (const b of saves.flush(Date.now(), all)) {
      rec().record(
        "save",
        { path: b.path, language: b.language, count: b.count, windowStart: new Date(b.windowStart).toISOString(), windowEnd: new Date(b.windowEnd).toISOString() },
        `${b.path}|${b.windowStart}`,
      );
    }
    after();
  };

  // Saves: only the file name and a count. Contents are never read.
  subs.push(
    vsc.workspace.onDidSaveTextDocument((doc) => {
      try {
        if (doc.uri.scheme !== "file" || s.paused || !s.cfg<boolean>("capture.saves", true)) return;
        const rel = s.rel(doc.uri.fsPath);
        if (rel) saves.add(rel, doc.languageId, Date.now());
      } catch (e) {
        s.env.log(`save handler: ${(e as Error).message}`);
      }
    }),
  );
  const timer = setInterval(() => flushSaves(false), 60_000);
  subs.push({ dispose: () => { clearInterval(timer); flushSaves(true); } });

  // Tasks.
  subs.push(
    vsc.tasks.onDidStartTaskProcess((e) => starts.set(e.execution, Date.now())),
    vsc.tasks.onDidEndTaskProcess((e) => {
      try {
        const t0 = starts.get(e.execution) ?? Date.now();
        const ms = Date.now() - t0;
        rec().record("task", { name: e.execution.task.name, exitCode: e.exitCode ?? -1, ms }, `${e.execution.task.name}|${t0}`);
        after();
      } catch (err) {
        s.env.log(`task handler: ${(err as Error).message}`);
      }
    }),
  );

  // Terminal commands via shell integration (VS Code 1.93+). Output is never read.
  const w = vsc.window as Partial<typeof vscode.window>;
  if (typeof w.onDidEndTerminalShellExecution === "function" && typeof w.onDidStartTerminalShellExecution === "function") {
    subs.push(
      w.onDidStartTerminalShellExecution((e) => starts.set(e.execution, Date.now())),
      w.onDidEndTerminalShellExecution((e) => {
        try {
          const cmd = allowedCommand(e.execution.commandLine.value);
          if (!cmd) return;
          const t0 = starts.get(e.execution) ?? Date.now();
          rec().record("terminal", { command: cmd, exitCode: e.exitCode ?? -1, ms: Date.now() - t0 }, `${cmd}|${t0}`);
          after();
        } catch (err) {
          s.env.log(`terminal handler: ${(err as Error).message}`);
        }
      }),
    );
    s.terminalAvailable = true;
  } else {
    s.terminalAvailable = false;
  }

  // Commits via the built-in git extension's onDidCommit event.
  void bindGit(s, subs, after);
  return subs;
}

async function bindGit(s: Session, subs: vscode.Disposable[], after: () => void): Promise<void> {
  const { vsc } = s;
  try {
    const ext = vsc.extensions.getExtension<{ getAPI(v: 1): GitApi; enabled?: boolean }>("vscode.git");
    if (!ext) return;
    const exports = ext.isActive ? ext.exports : await ext.activate();
    const api = exports.getAPI(1);
    const seen = new Set<string>();
    const attach = (repo: GitRepo) => {
      if (!s.folder || s.rel(repo.rootUri.fsPath) === null && repo.rootUri.fsPath.toLowerCase() !== s.folder.toLowerCase()) return;
      if (!repo.onDidCommit) return;
      s.branchFn = () => repo.state.HEAD?.name ?? "detached";
      subs.push(
        repo.onDidCommit(() => {
          void onCommit(s, repo, seen).then(after, (e) => s.env.log(`commit handler: ${(e as Error).message}`));
        }),
      );
    };
    api.repositories.forEach(attach);
    subs.push(api.onDidOpenRepository(attach));
  } catch (e) {
    s.env.log(`git capture unavailable: ${(e as Error).message}`);
  }
}

async function onCommit(s: Session, repo: GitRepo, seen: Set<string>): Promise<void> {
  const sha = repo.state.HEAD?.commit;
  if (!sha || seen.has(sha)) return;
  seen.add(sha);

  const info = await readCommit(s.run, repo.rootUri.fsPath, sha);
  if (!info || info.isMerge) return; // merge commits are noise
  const r = s.recorder!;
  r.record("commit", { sha: info.sha, subject: cap(info.subject, 300), ...(info.body ? { body: info.body } : {}), files: info.files }, info.sha);
  // A count-only diagnostics snapshot at the moment of the commit.
  if (s.cfg<boolean>("capture.diagnostics", true)) {
    let errors = 0;
    let warnings = 0;
    let files = 0;
    for (const [, list] of s.vsc.languages.getDiagnostics()) {
      const e = list.filter((d) => d.severity === 0).length;
      const w = list.filter((d) => d.severity === 1).length;
      errors += e;
      warnings += w;
      if (e + w > 0) files++;
    }
    r.record("diagnostics", { errors, warnings, files }, info.sha);
  }
}
