// web_search and web_fetch. Brave Search when BRAVE_SEARCH_API_KEY is set; otherwise
// DuckDuckGo's HTML results, with Bing's results page as the fallback.

import { assertMayLeave, ToolError, truncate } from "./common.ts";
import { parseWebUrl, safeGet } from "./net.ts";
import type { NetDeps } from "./net.ts";

export const MAX_RESULTS = 6;
/** A longer "query" is a pasted document, not a search. */
export const MAX_QUERY_CHARS = 400;
/** Bing serves a reduced page to unknown agents, so it is asked as a normal browser. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface WebHit { title: string; url: string; snippet: string }
export interface WebDeps extends NetDeps { env?: Record<string, string | undefined> }

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/** Named entities pages commonly use and every numeric one, in one pass. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (all, name: string) => {
    if (name[0] !== "#") return ENTITIES[name] ?? all;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

const stripHtml = (s: string): string => decodeEntities(s.replace(/<[^<>]*>/g, "")).replace(/\s+/g, " ").trim();

const HIDDEN = ["head", "script", "style", "noscript", "svg", "template"];

/** Removes comments and hidden elements in one pass, so a hostile page cannot stall a regular expression. */
function dropHidden(html: string): string {
  const lower = html.toLowerCase();
  const open = new RegExp(`<!--|<(${HIDDEN.join("|")})(?=[\\s/>])`, "g");
  let out = "";
  let pos = 0;
  for (let m = open.exec(lower); m; m = open.exec(lower)) {
    const close = m[1] ? `</${m[1]}>` : "-->";
    const end = lower.indexOf(close, m.index + m[0].length);
    out += html.slice(pos, m.index) + " ";
    pos = end < 0 ? html.length : end + close.length;
    open.lastIndex = pos;
  }
  return out + html.slice(pos);
}

/** Readable text of an HTML page: its title, then the visible text one block per line. */
export function pageText(html: string): string {
  const title = /<title[^<>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
  const heading = decodeEntities(title).replace(/\s+/g, " ").trim();
  const body = decodeEntities(
    dropHidden(html)
      .replace(/<br\s*\/?>|<\/?(?:p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|nav|main|aside|pre|blockquote|dt|dd)\b[^<>]*>/gi, "\n")
      .replace(/<[^<>]*>/g, ""),
  ).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return heading && body ? `${heading}\n\n${body}` : heading || body;
}

const isWeb = (u: string): boolean => /^https?:\/\/\S+$/i.test(u);

/** DuckDuckGo links go through a redirect that carries the real address in `uddg=`. */
function ddgTarget(href: string): string {
  const wrapped = /[?&]uddg=([^&]+)/.exec(href)?.[1];
  if (wrapped) {
    try { return decodeURIComponent(wrapped); } catch { return ""; }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

export function parseDuckDuckGo(html: string): WebHit[] {
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripHtml(m[1] as string));
  return [...html.matchAll(/<a([^<>]*class="result__a"[^<>]*)>([\s\S]*?)<\/a>/g)]
    .slice(0, MAX_RESULTS)
    .map((m, i) => ({
      title: stripHtml(m[2] as string),
      url: ddgTarget(decodeEntities(/href="([^"]+)"/.exec(m[1] as string)?.[1] ?? "")),
      snippet: snippets[i] ?? "",
    }))
    .filter((h) => h.title && isWeb(h.url));
}

/** Bing wraps links as `bing.com/ck/a?...&u=a1<base64url of the real address>&...`. */
function bingTarget(href: string): string {
  const encoded = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(href)?.[1];
  return encoded ? Buffer.from(encoded, "base64url").toString("utf8") : href;
}

export function parseBing(html: string): WebHit[] {
  const hits: WebHit[] = [];
  for (const block of html.split("class=\"b_algo\"").slice(1)) {
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const url = bingTarget((link[1] as string).replace(/&amp;/g, "&"));
    const title = stripHtml(link[2] as string);
    if (!title || !isWeb(url)) continue;
    hits.push({ title, url, snippet: stripHtml(/<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? "") });
    if (hits.length === MAX_RESULTS) break;
  }
  return hits;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "what", "how", "are", "was", "why", "who", "can", "you", "does", "from",
  "that", "this", "about", "into", "when", "where", "which",
]);

/**
 * Keeps hits that mention at least half of the query's words: a scraped engine that suspects a bot
 * can answer with unrelated pages. Queries with non-ASCII words are left alone.
 */
export function relevant(hits: WebHit[], query: string): WebHit[] {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP_WORDS.has(w)))];
  if (!words.length || words.some((w) => /[^\x00-\x7f]/.test(w))) return hits;
  const needed = Math.ceil(words.length / 2);
  return hits.filter((h) => {
    const text = `${h.title} ${h.url} ${h.snippet}`.toLowerCase();
    return words.filter((w) => text.includes(w)).length >= needed;
  });
}

const BLOCKED_HINT =
  "Web search is blocked from this network: DuckDuckGo answered with a bot check and Bing returned nothing relevant. " +
  "Use /fetch on a page you already know, or set BRAVE_SEARCH_API_KEY.";

async function brave(query: string, key: string, deps: WebDeps): Promise<WebHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(MAX_RESULTS) })}`;
  // No redirects: the key must never travel to another address.
  const r = await safeGet(url, deps, { maxRedirects: 0, headers: { accept: "application/json", "x-subscription-token": key } });
  if (r.status !== 200) throw new ToolError(`Brave Search answered ${r.status}.`);
  let rows: { title?: unknown; url?: unknown; description?: unknown }[];
  try {
    rows = (JSON.parse(r.text) as { web?: { results?: typeof rows } }).web?.results ?? [];
  } catch { throw new ToolError("Brave Search sent an answer that could not be read."); }
  return rows.slice(0, MAX_RESULTS)
    .map((x) => ({ title: stripHtml(String(x.title ?? "")), url: String(x.url ?? ""), snippet: stripHtml(String(x.description ?? "")) }))
    .filter((h) => h.title && isWeb(h.url));
}

async function keyless(query: string, deps: WebDeps): Promise<WebHit[]> {
  const q = new URLSearchParams({ q: query }).toString();
  let first: ToolError | null = null;
  try {
    const r = await safeGet(`https://html.duckduckgo.com/html/?${q}`, deps, { timeoutMs: 10_000 });
    // DuckDuckGo answers automated-looking requests with 202 and a bot-check page.
    if (r.status === 202 || r.text.includes("anomaly-modal")) throw new ToolError(BLOCKED_HINT);
    if (r.status !== 200) throw new ToolError(`DuckDuckGo answered ${r.status}.`);
    const hits = relevant(parseDuckDuckGo(r.text), query);
    if (hits.length) return hits;
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    first = e;
  }
  try {
    const r = await safeGet(`https://www.bing.com/search?${q}`, deps, { headers: { "user-agent": BROWSER_UA, "accept-language": "en-US,en;q=0.9" } });
    if (r.status !== 200) throw new ToolError(`Bing answered ${r.status}.`);
    const hits = relevant(parseBing(r.text), query);
    if (hits.length || !first) return hits;
  } catch (e) {
    if (!first) throw e;
  }
  // Report the first failure, so a bot check is not passed off as "no results".
  throw first;
}

export async function webSearch(query: string, deps: WebDeps = {}): Promise<WebHit[]> {
  const q = query.trim();
  if (!q) throw new ToolError("The search query is empty.");
  if (q.length > MAX_QUERY_CHARS) throw new ToolError(`That is too long for a web search (limit ${MAX_QUERY_CHARS} characters).`);
  assertMayLeave("search query", q);
  const key = (deps.env ?? process.env).BRAVE_SEARCH_API_KEY?.trim();
  return key ? brave(q, key, deps) : keyless(q, deps);
}

/** Checks an address the user typed before any of it (the host name included) leaves the machine. */
export function checkOutgoingUrl(raw: string): URL {
  const url = parseWebUrl(raw);
  const forms = [raw.trim()];
  try { forms.push(decodeURIComponent(raw.trim())); } catch { /* not valid percent-encoding: the raw form is checked */ }
  assertMayLeave("address", ...forms);
  return url;
}

export async function webFetch(raw: string, deps: NetDeps = {}): Promise<{ url: string; text: string }> {
  checkOutgoingUrl(raw);
  const r = await safeGet(raw, deps);
  if (r.status < 200 || r.status >= 300) throw new ToolError(`The site answered ${r.status}.`);
  if (r.contentType && !/^text\/|json|xml|javascript/.test(r.contentType)) throw new ToolError(`That address is not a text page (${r.contentType.split(";")[0]}).`);
  const html = r.contentType ? r.contentType.includes("html") : /^\s*<(?:!doctype html|html)/i.test(r.text);
  const text = html ? pageText(r.text) : r.text;
  return { url: r.url, text: truncate(text || "(the page has no readable text; try /browse)") };
}
