// browser_render: the installed Chrome or Edge, headless, with a throwaway profile. It cannot
// click or type. All browser traffic goes through a small local proxy that applies the same
// public-address rule as web_fetch to redirects, scripts and other requests the page makes.
// Limit: this relies on the browser honouring its proxy settings. Traffic that does not use the
// proxy (non-HTTP protocols, browser bugs) is not checked; QUIC and direct WebRTC are switched off.
// The addresses a page itself requests are not run through the masking step.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolError, truncate } from "./common.ts";
import { MAX_WEB_BYTES, publicAddress } from "./net.ts";
import type { Resolve } from "./net.ts";
import { checkOutgoingUrl, pageText } from "./web.ts";

export const BROWSER_TIMEOUT_MS = 45_000;
/** Rendered HTML larger than this stops the browser. */
export const MAX_DOM_BYTES = 8 * 1024 * 1024;
/** Most data one proxied connection may bring in. */
const MAX_PROXY_BYTES = 4 * MAX_WEB_BYTES;

export type RunBrowser = (exe: string, args: string[]) => Promise<string>;
export interface BrowserDeps { resolve?: Resolve; browserPath?: string | null; runBrowser?: RunBrowser }

export function findBrowser(env: Record<string, string | undefined> = process.env): string | null {
  const bases = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((b): b is string => !!b);
  const list = bases.flatMap((b) => [join(b, "Google", "Chrome", "Application", "chrome.exe"), join(b, "Microsoft", "Edge", "Application", "msedge.exe")]);
  list.push(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
  );
  return list.find((p) => existsSync(p)) ?? null;
}

export async function startGuardProxy(resolve?: Resolve): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<Socket>();
  const cap = (from: NodeJS.ReadableStream, kill: () => void): void => {
    let size = 0;
    from.on("data", (c: Buffer) => { size += c.length; if (size > MAX_PROXY_BYTES) kill(); });
  };
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "");
        if (url.protocol !== "http:") throw new Error("protocol");
        const address = await publicAddress(url, resolve);
        const up = httpRequest({ host: address, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers: req.headers }, (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          cap(r, () => r.destroy());
          r.pipe(res);
        });
        up.on("error", () => res.destroy());
        req.pipe(up);
      } catch {
        res.writeHead(403);
        res.end();
      }
    })();
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  server.on("connect", (req, client: Socket, head: Buffer) => {
    client.on("error", () => {});
    void (async () => {
      try {
        const url = new URL(`https://${req.url ?? ""}`);
        const address = await publicAddress(url, resolve);
        const up = connect(Number(url.port || 443), address, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) up.write(head);
          cap(up, () => up.destroy());
          up.pipe(client);
          client.pipe(up);
        });
        sockets.add(up);
        up.on("close", () => { sockets.delete(up); client.destroy(); });
        up.on("error", () => client.destroy());
        client.on("close", () => up.destroy());
      } catch {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => { server.close(); for (const s of sockets) s.destroy(); },
  };
}

const defaultRun: RunBrowser = (exe, args) =>
  new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: BROWSER_TIMEOUT_MS, maxBuffer: MAX_DOM_BYTES, windowsHide: true }, (error, stdout) => {
      if (!error) return resolve(stdout);
      reject(new ToolError(error.killed ? "The page took too long or was too large to render." : "The browser could not render the page."));
    });
  });

export async function browserRender(raw: string, deps: BrowserDeps = {}): Promise<{ url: string; text: string }> {
  const url = checkOutgoingUrl(raw);
  await publicAddress(url, deps.resolve);
  const exe = deps.browserPath === undefined ? findBrowser() : deps.browserPath;
  if (!exe) throw new ToolError("No Chrome or Edge was found on this computer.");
  const profile = mkdtempSync(join(tmpdir(), "guard-browser-"));
  const proxy = await startGuardProxy(deps.resolve);
  try {
    const html = await (deps.runBrowser ?? defaultRun)(exe, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update",
      "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      `--user-data-dir=${profile}`,
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      // Without this Chrome sends localhost requests around the proxy.
      "--proxy-bypass-list=<-loopback>",
      "--virtual-time-budget=5000", "--dump-dom", url.href,
    ]);
    return { url: url.href, text: truncate(pageText(html) || "(the page rendered no visible text)") };
  } finally {
    proxy.close();
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the browser may still hold a file; the OS temp folder is cleared later */ }
  }
}
