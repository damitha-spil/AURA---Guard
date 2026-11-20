import { existsSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type * as vscode from "vscode";
import { GuardCli, defaultRunner, validateGuardHome } from "../core/cli.ts";
import type { Runner } from "../core/cli.ts";
import { grantConsent, readConsent } from "../core/consent.ts";
import type { Consent } from "../core/consent.ts";
import { gitFirstName } from "../core/gitinfo.ts";
import { Recorder } from "../core/recorder.ts";
import type { Source } from "../core/recorder.ts";
import { repoKey } from "../core/repoKey.ts";
import { Spool, resolveSpoolDir } from "../core/spool.ts";

export type VsCode = typeof vscode;
export type State = "off" | "needs-consent" | "paused" | "capturing";

export interface Env {
  vsc: VsCode;
  workspaceState: { get<T>(k: string): T | undefined; update(k: string, v: unknown): Thenable<void> };
  log: (msg: string) => void;
  runner?: Runner;
  env?: Record<string, string | undefined>;
  home?: string;
  now?: () => Date;
}

export const CONSENT_TITLE = "SPIL Quality Support Bot wants to record your work in this workspace";
export const CONSENT_DETAIL = [
  "WHAT IS CAPTURED (only in this workspace, only on this PC):",
  "- git commits: message, file names and line counts",
  "- file saves: file name and a count per 5 minutes",
  "- task runs: name, exit code, duration",
  "- terminal commands from a short allow-list (git, cargo, npm, node, ...), with arguments masked",
  "- error and warning counts when you commit",
  "- ideas, decisions and corrections you type, and @guard questions and answers",
  "",
  "WHAT IS NEVER CAPTURED:",
  "- file contents, keystrokes, the clipboard, the browser, terminal output",
  "- anything outside workspaces you opt in to",
  "",
  "Text is masked first. If a secret is found, the whole event is thrown away.",
  "",
  "WHERE IT GOES: a local folder (the spool) on this PC. Nothing leaves the machine unless you review a drafted summary and commit it yourself.",
  "",
  "YOU CONTROL IT: the status bar item shows the state; click it to pause, look at today's events, or delete your data. Uninstalling stops everything.",
].join("\n");

/** Everything one opted-in workspace needs: settings, consent, the recorder and the Guard CLI. */
export class Session {
  readonly vsc: VsCode;
  folder: string | undefined;
  key = "";
  dev = "unknown";
  spoolDir = "";
  spool: Spool | undefined;
  recorder: Recorder | undefined;
  consent: Consent | null = null;
  terminalAvailable = true;
  warned = false;
  private onChange: () => void = () => {};

  readonly env: Env;
  constructor(env: Env) {
    this.env = env;
    this.vsc = env.vsc;
  }

  now(): Date {
    return this.env.now ? this.env.now() : new Date();
  }
  get run(): Runner {
    return this.env.runner ?? defaultRunner;
  }
  cfg<T>(key: string, fallback: T): T {
    const v = this.vsc.workspace.getConfiguration("auraGuard").get<T>(key);
    return v === undefined || v === null ? fallback : v;
  }
  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }
  changed(): void {
    this.onChange();
  }

  /** One plain warning per session at most; details go to the Output channel. */
  warnOnce(msg: string): void {
    this.env.log(msg);
    if (this.warned) return;
    this.warned = true;
    void this.vsc.window.showWarningMessage(`SPIL Quality Support Bot: ${msg}`);
  }

  /** Workspace opt-in: ai-log/README.md at the root, or listed in auraGuard.workspaces. */
  optedIn(): boolean {
    if (!this.folder) return false;
    const norm = (p: string) => resolve(p).toLowerCase();
    const listed = this.cfg<string[]>("workspaces", []).some((w) => norm(w) === norm(this.folder!));
    return listed || existsSync(join(this.folder, "ai-log", "README.md"));
  }

  async init(): Promise<void> {
    const f = this.vsc.workspace.workspaceFolders?.[0];
    this.folder = f && f.uri.scheme === "file" ? f.uri.fsPath : undefined;
    if (!this.folder) return;
    this.key = repoKey(this.folder);
    if (!this.optedIn()) return;
    try {
      this.spoolDir = resolveSpoolDir(this.cfg<string>("spoolDir", ""), this.env.env ?? process.env, this.env.home);
    } catch (e) {
      this.warnOnce((e as Error).message);
      return;
    }
    const named = this.cfg<string>("developerName", "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    this.dev = named || (await gitFirstName(this.run, this.folder));
    this.spool = new Spool(this.spoolDir);
    this.consent = readConsent(this.spoolDir);
    this.recorder = new Recorder({
      spool: this.spool,
      repo: this.key,
      dev: this.dev,
      getConsent: () => this.consent,
      isPaused: () => this.paused,
      sourceOn: (s: Source) => this.cfg<boolean>(`capture.${s}`, true),
      branch: () => this.branchFn(),
      now: () => this.now(),
    });
    this.recorder.refreshToday();
  }

  branchFn: () => string = () => "unknown";

  get paused(): boolean {
    return this.env.workspaceState.get<boolean>("paused") === true;
  }
  async setPaused(p: boolean): Promise<void> {
    await this.env.workspaceState.update("paused", p);
    this.changed();
  }

  get state(): State {
    if (!this.folder || !this.recorder) return "off";
    if (!this.consent || this.consent.repos[this.key] !== true) return "needs-consent";
    return this.paused ? "paused" : "capturing";
  }

  /** The first-run dialog. Returns true when the developer accepted and consent.json was written. */
  async askConsent(): Promise<boolean> {
    if (!this.recorder) return false;
    const accept = "Accept and start capturing";
    const choice = await this.vsc.window.showInformationMessage(CONSENT_TITLE, { modal: true, detail: CONSENT_DETAIL }, accept);
    if (choice !== accept) {
      await this.env.workspaceState.update("declined", true);
      this.changed();
      return false;
    }
    try {
      this.consent = grantConsent(this.spoolDir, this.dev, this.key, this.now());
    } catch (e) {
      this.warnOnce(`Could not save your consent: ${(e as Error).message}`);
      return false;
    }
    await this.env.workspaceState.update("declined", false);
    this.changed();
    return true;
  }

  guardProblem(): string | null {
    return validateGuardHome(this.cfg<string>("guardHome", "").trim());
  }
  cli(): GuardCli {
    return new GuardCli(this.cfg<string>("guardHome", "").trim(), this.cfg<string>("nodePath", "").trim(), this.run);
  }

  rel(abs: string): string | null {
    if (!this.folder) return null;
    const r = relative(this.folder, abs).replace(/\\/g, "/");
    return r.startsWith("..") || /^[a-z]:/i.test(r) ? null : r;
  }

  /** Local delete of this workspace's spool folder (used when Guard is not set up). */
  deleteLocal(): void {
    if (!this.spoolDir || !this.key) return;
    rmSync(join(this.spoolDir, this.key), { recursive: true, force: true });
    this.spool?.reset();
    if (this.recorder) this.recorder.today = 0;
  }
}
