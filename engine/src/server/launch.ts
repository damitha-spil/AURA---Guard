// Starts the chat server and its own app-style browser window; stops the server when the window closes.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { GuardConfig } from "../types.ts";
import { PRODUCT_NAME } from "../brand.ts";
import { createBrain } from "../brain/select.ts";
import { createGuardServer, newToken } from "./server.ts";

/** Window size for the app window. The page works from 800 px wide up. */
export const WINDOW_SIZE = "1180,780";

/** Known install places for Edge, then Chrome, built from environment folders (nothing hard-coded). */
export function browserCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const roots = [env["ProgramFiles(x86)"], env["ProgramFiles"], env["LocalAppData"]].filter((x): x is string => !!x);
  const rels = [["Microsoft", "Edge", "Application", "msedge.exe"], ["Google", "Chrome", "Application", "chrome.exe"]];
  const out: string[] = [];
  for (const rel of rels) for (const r of roots) out.push(join(r, ...rel));
  return out;
}

/** Edge first, then Chrome. Returns null when neither is installed. */
export function findBrowser(env: Record<string, string | undefined> = process.env): string | null {
  const found = browserCandidates(env).filter((p) => existsSync(p));
  const edge = found.find((p) => p.toLowerCase().endsWith("msedge.exe"));
  return edge ?? found[0] ?? null;
}

export function browserArgs(url: string, profileDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${WINDOW_SIZE}`,
  ];
}

export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

export interface UiOptions {
  port: number; // 0 = pick a free port
  open: boolean;
  out: (s: string) => void;
}

/** Resolves with an exit code when the window closes or the process is interrupted. */
export async function runUi(cfg: GuardConfig, opts: UiOptions): Promise<number> {
  const token = newToken();
  const brain = createBrain(cfg);
  const server = createGuardServer(cfg, { token, complete: brain.complete });
  const port = await listen(server, opts.port);
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  opts.out(`${PRODUCT_NAME} is running at http://127.0.0.1:${port}/`);

  let child: ChildProcess | null = null;
  const done = new Promise<number>((resolve) => {
    const stop = (code: number): void => {
      server.close();
      server.closeAllConnections();
      resolve(code);
    };
    process.once("SIGINT", () => {
      child?.kill();
      stop(0);
    });
    if (!opts.open) {
      opts.out(`Open this link in a browser (it works once per launch): ${url}`);
      opts.out("Press Ctrl+C to stop.");
      return;
    }
    const browser = findBrowser();
    if (!browser) {
      opts.out("Edge or Chrome was not found. Open this link yourself:");
      opts.out(url);
      opts.out("Press Ctrl+C to stop.");
      return;
    }
    const profile = join(cfg.dataDir, "ui-profile");
    mkdirSync(profile, { recursive: true });
    child = spawn(browser, browserArgs(url, profile), { stdio: "ignore", windowsHide: false });
    child.once("error", (e) => {
      opts.out(`Could not start the window: ${e.message}`);
      stop(1);
    });
    child.once("exit", () => {
      opts.out("Window closed. Stopping the server.");
      stop(0);
    });
  });
  return done;
}
