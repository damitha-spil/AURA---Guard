// Outgoing web requests for the native tools. Only public http(s) addresses are reachable:
// the host is resolved first, every address is checked, the connection is pinned to a checked
// address (so a second DNS answer cannot swap it), and each redirect is checked again.

import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { ToolError } from "./common.ts";

/** One request, redirects included, may not take longer than this. */
export const WEB_TIMEOUT_MS = 20_000;
/** Largest page read. Bigger pages are cut here so a huge download cannot fill memory. */
export const MAX_WEB_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const MAX_URL_CHARS = 2_000;

const V4 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], // 169.254 holds cloud metadata
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ["168.63.129.16", 32], // Azure platform address
] as const) V4.addSubnet(net, bits, "ipv4");

const V6_GLOBAL = new BlockList();
V6_GLOBAL.addSubnet("2000::", 3, "ipv6");
const V6_BAD = new BlockList();
// Documentation, Teredo and 6to4: the last two can carry a private IPv4 address inside.
for (const [net, bits] of [["2001:db8::", 32], ["2001::", 32], ["2002::", 16]] as const) V6_BAD.addSubnet(net, bits, "ipv6");

/** True only for an ordinary public address. IPv6 outside global unicast (loopback, link-local, ULA, mapped) is refused. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !V4.check(ip, "ipv4");
  if (family === 6) return V6_GLOBAL.check(ip, "ipv6") && !V6_BAD.check(ip, "ipv6");
  return false;
}

export type Resolve = (host: string) => Promise<string[]>;
export interface RawResponse { status: number; headers: Record<string, string>; body: Buffer }
export interface RawRequest { url: URL; address: string; headers: Record<string, string>; signal: AbortSignal; maxBytes: number }
export type Transport = (req: RawRequest) => Promise<RawResponse>;
export interface NetDeps { resolve?: Resolve; transport?: Transport }

const defaultResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const LOCAL_NAME = /(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa)$/i;

/** Parses a web address and refuses anything that is not plain public http(s). No network use. */
export function parseWebUrl(raw: string): URL {
  const text = raw.trim();
  if (!/^https?:\/\//i.test(text) || /\s/.test(text) || text.length > MAX_URL_CHARS) throw new ToolError("Give a full http or https address.");
  let url: URL;
  try { url = new URL(text); } catch { throw new ToolError("That is not a valid web address."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolError("Only http and https addresses are allowed.", true);
  if (url.username || url.password) throw new ToolError("Addresses with a user name or password are not allowed.", true);
  return url;
}

/** The host's checked address. Throws when any address it resolves to is not public. */
export async function publicAddress(url: URL, resolve: Resolve = defaultResolve): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const refuse = (): never => { throw new ToolError(`Refused: ${host} is a local, private or reserved address.`, true); };
  if (LOCAL_NAME.test(host)) refuse();
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try { addresses = await resolve(host); } catch { throw new ToolError(`Could not find the host ${host}.`); }
  }
  if (!addresses.length) throw new ToolError(`Could not find the host ${host}.`);
  if (!addresses.every(isPublicAddress)) refuse();
  return addresses[0] as string;
}

/** node:http(s) request that connects only to the already checked address. */
const defaultTransport: Transport = ({ url, address, headers, signal, maxBytes }) =>
  new Promise((resolve, reject) => {
    const family = isIP(address);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, {
      method: "GET", headers, signal, agent: false,
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
        o?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as never,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const done = (): void => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
        resolve({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks) });
      };
      res.on("data", (c: Buffer) => {
        if (size >= maxBytes) return;
        const part = c.subarray(0, maxBytes - size);
        size += part.length;
        chunks.push(part);
        if (size >= maxBytes) { done(); res.destroy(); }
      });
      res.on("end", done);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });

function decompress(r: RawResponse, maxBytes: number): Buffer {
  const enc = (r.headers["content-encoding"] ?? "").trim().toLowerCase();
  if (!enc || enc === "identity") return r.body.subarray(0, maxBytes);
  const opts = { maxOutputLength: maxBytes };
  try {
    if (enc === "gzip") return gunzipSync(r.body, opts);
    if (enc === "deflate") return inflateSync(r.body, opts);
    if (enc === "br") return brotliDecompressSync(r.body, opts);
  } catch { /* too large or broken */ }
  throw new ToolError("The page came compressed in a way that could not be read within the size limit.");
}

export interface WebResponse { status: number; url: string; contentType: string; text: string }

/** GET with the address checks above on the first request and on every redirect. */
export async function safeGet(
  raw: string, deps: NetDeps = {}, opts: { headers?: Record<string, string>; maxRedirects?: number; timeoutMs?: number } = {},
): Promise<WebResponse> {
  const transport = deps.transport ?? defaultTransport;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? WEB_TIMEOUT_MS);
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  // A generic agent: requests must not say who or what project is asking.
  const headers = { "user-agent": "Mozilla/5.0 (compatible)", "accept-encoding": "identity", accept: "*/*", ...(opts.headers ?? {}) };
  let url = parseWebUrl(raw);
  for (let hop = 0; ; hop++) {
    const address = await publicAddress(url, deps.resolve);
    let r: RawResponse;
    try {
      r = await transport({ url, address, headers, signal, maxBytes: MAX_WEB_BYTES });
    } catch (e) {
      if (signal.aborted) throw new ToolError("The page took too long.");
      if (e instanceof ToolError) throw e;
      throw new ToolError(`Could not reach ${url.hostname}.`);
    }
    const location = r.headers["location"];
    if (r.status >= 300 && r.status < 400 && location) {
      if (hop >= maxRedirects) throw new ToolError("Too many redirects.");
      let next: string;
      try { next = new URL(location, url).href; } catch { throw new ToolError("The site sent a broken redirect."); }
      url = parseWebUrl(next);
      continue;
    }
    const contentType = (r.headers["content-type"] ?? "").toLowerCase();
    const body = decompress(r, MAX_WEB_BYTES);
    const charset = /charset=["']?([\w-]+)/.exec(contentType)?.[1] ?? "utf-8";
    let text: string;
    try { text = new TextDecoder(charset).decode(body); } catch { text = new TextDecoder().decode(body); }
    return { status: r.status, url: url.href, contentType, text };
  }
}
