// The first screen and the project status popover. Pure helpers (titles.js) are tested without a
// browser. The browser tests drive the real page against the stub server with the installed Edge
// (playwright-core, no download); they skip with a clear message when Edge cannot be started.
import { test, after } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { startStub } from "./ui-stub-server.ts";
import type { StubHandle, StubOpts } from "./ui-stub-server.ts";

type Card = { id: string; icon: string; title: string; hint: string; text?: string; fill?: string };
interface Titles {
  agoShort(iso: string | number | null, now?: number): string;
  indexState(at: string | number | null, now?: number): { state: string; label: string; short: string };
  repoRows(r: unknown, now?: number): { key: string; label: string; branch: string; commitText: string; indexText: string; state: string; commits: number }[];
  statusSummary(a?: { status?: unknown; project?: unknown; now?: number }): Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  normalizeSuggestions(raw: unknown): Card[];
  suggestionCards(raw: unknown): Card[];
  FALLBACK_SUGGESTIONS: Card[];
  QA_CARD: Card;
  FRESH_DAYS: number;
}
const uiDir = join(import.meta.dirname, "..", "..", "ui");
const T = (await import(pathToFileURL(join(uiDir, "titles.js")).href)) as Titles;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

test("index age reads as plain words: fresh, stale, never", () => {
  assert.equal(T.agoShort(ago(10_000), NOW), "just now");
  assert.equal(T.agoShort(ago(8 * MIN), NOW), "8 min ago");
  assert.equal(T.agoShort(ago(3 * HOUR), NOW), "3 h ago");
  assert.equal(T.agoShort(ago(DAY + HOUR), NOW), "yesterday");
  assert.equal(T.agoShort(ago(5 * DAY), NOW), "5 days ago");
  assert.equal(T.agoShort(null, NOW), "never");
  assert.equal(T.agoShort("not a date", NOW), "never");
  const fresh = T.indexState(ago(8 * MIN), NOW);
  assert.deepEqual(fresh, { state: "fresh", label: "Indexed 8 min ago", short: "indexed 8 min ago" });
  assert.equal(T.indexState(ago(T.FRESH_DAYS * DAY), NOW).state, "fresh", "exactly the limit is still fresh");
  const stale = T.indexState(ago(12 * DAY), NOW);
  assert.equal(stale.state, "stale");
  assert.equal(stale.short, "index is 12 days old");
  assert.match(stale.label, /Indexed 12 days ago\. It is getting old\./);
  assert.deepEqual(T.indexState(null, NOW), { state: "never", label: "Not indexed yet", short: "never indexed" });
  assert.equal(T.indexState("", NOW).state, "never");
});

test("repo rows: label, branch, last commit and index age in words; odd rows never throw", () => {
  const rows = T.repoRows([
    { id: "a", label: "aura-app", branch: "development", lastCommitAt: ago(26 * HOUR), indexedAt: ago(8 * MIN), commits: 560 },
    { id: "b", label: "erp-mcp", branch: "main", lastCommitAt: null, indexedAt: null, commits: 0 },
    null,
    { id: "c" },
  ], NOW);
  assert.equal(rows.length, 3, "null rows are dropped");
  assert.deepEqual(rows[0], { key: "a", label: "aura-app", branch: "development", commitText: "Last commit yesterday", indexText: "Indexed 8 min ago", state: "fresh", commits: 560 });
  assert.equal(rows[1]!.commitText, "No commits read yet");
  assert.equal(rows[1]!.indexText, "Not indexed yet");
  assert.equal(rows[1]!.state, "never");
  assert.equal(rows[2]!.label, "c", "a missing label falls back to the id");
  assert.deepEqual(T.repoRows(undefined, NOW), []);
  assert.deepEqual(T.repoRows("nope", NOW), []);
});

test("status summary: the pill line, the tone, the counts and the inbox come from the server facts", () => {
  const project = {
    repos: [{ id: "a", label: "aura-app", branch: "development", lastCommitAt: ago(DAY), indexedAt: ago(8 * MIN), commits: 5 }],
    index: { indexedAt: ago(8 * MIN), commits: 812, files: 2140, notes: 64 },
    vault: { notes: 64, active: 51, proposed: 13, stale: 2, problems: 0 },
    inbox: { pending: 5 }, lastDaily: ago(20 * HOUR),
  };
  const status = { index: { note: 64, commit: 812, file: 2140 }, vault: { notes: 64, problems: 0 }, backend: { picked: "claude-cli", label: "Claude plan" }, running: null };
  const s = T.statusSummary({ status, project, now: NOW });
  assert.equal(s.line, "Claude plan · indexed 8 min ago");
  assert.equal(s.tone, "ok");
  assert.equal(s.model, "Claude plan");
  assert.equal(s.countsText, "812 commits · 2,140 files · 64 notes");
  assert.deepEqual(s.vault, { notes: 64, active: 51, proposed: 13, stale: 2, problems: 0 });
  assert.equal(s.vaultText, "No problems in the vault");
  assert.equal(s.pending, 5);
  assert.equal(s.pendingText, "5 notes need your review");
  assert.equal(s.repos.length, 1);
  assert.match(s.daily, /Daily note 20 h ago/);
  assert.equal(T.statusSummary({ status, project: { ...project, inbox: { pending: 1 } }, now: NOW }).pendingText, "1 note needs your review");
  assert.equal(T.statusSummary({ status, project: { ...project, inbox: { pending: 0 } }, now: NOW }).pendingText, "Nothing waiting for your review");

  const stale = T.statusSummary({ status, project: { ...project, index: { ...project.index, indexedAt: ago(12 * DAY) } }, now: NOW });
  assert.equal(stale.tone, "warn");
  assert.equal(stale.line, "Claude plan · index is 12 days old");
  const never = T.statusSummary({ status, project: { ...project, index: { indexedAt: null, commits: 0, files: 0, notes: 0 } }, now: NOW });
  assert.equal(never.tone, "warn");
  assert.equal(never.line, "Claude plan · never indexed");
  assert.equal(T.statusSummary({ status, project: { ...project, vault: { ...project.vault, problems: 3 } }, now: NOW }).vaultText, "3 problems to fix in the vault");
  assert.equal(T.statusSummary({ status, project: { ...project, vault: { ...project.vault, problems: 3 } }, now: NOW }).tone, "warn");
  const noModel = T.statusSummary({ status: { ...status, backend: { picked: null, label: "No model" } }, project, now: NOW });
  assert.equal(noModel.tone, "bad");
  assert.equal(noModel.modelOk, false);
});

test("status summary still works on an older server: no project facts, no status, junk", () => {
  const status = { index: { note: 64, commit: 812, file: 2140 }, vault: { notes: 64, problems: 0 }, backend: { picked: "claude-cli", label: "Claude plan" } };
  const old = T.statusSummary({ status, project: null, now: NOW });
  assert.equal(old.line, "Claude plan · 64 notes");
  assert.equal(old.index, null);
  assert.equal(old.pending, null);
  assert.deepEqual(old.repos, []);
  assert.equal(old.countsText, "812 commits · 2,140 files · 64 notes");
  const none = T.statusSummary({ status: null, project: null, now: NOW });
  assert.equal(none.line, "No model · checking");
  assert.doesNotThrow(() => T.statusSummary({ status: "x" as unknown, project: 5 as unknown, now: NOW }));
  assert.doesNotThrow(() => T.statusSummary());
});

test("suggestions: up to four from the server, a plain fallback, then the QA card last", () => {
  const raw = { suggestions: [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, title: `Question ${n}`, hint: `Hint ${n}`, text: `Ask ${n}` })) };
  const four = T.normalizeSuggestions(raw);
  assert.equal(four.length, 4);
  assert.deepEqual(four.map((c) => c.text), ["Ask 1", "Ask 2", "Ask 3", "Ask 4"]);
  assert.ok(four.every((c) => c.icon && c.title && c.hint !== undefined));
  assert.equal(T.normalizeSuggestions({ suggestions: [{ id: "x", title: "Only a title" }] })[0]!.text, "Only a title", "the title is sent when no text is given");
  assert.equal(T.normalizeSuggestions({ suggestions: [{ title: "", text: "" }, null, 7, { hint: "no title" }] }).length, 4, "nothing usable: the fallback");
  for (const bad of [null, undefined, {}, { suggestions: [] }, { suggestions: "x" }, "junk"]) {
    const fb = T.normalizeSuggestions(bad);
    assert.deepEqual(fb.map((c) => c.id), T.FALLBACK_SUGGESTIONS.map((c) => c.id));
  }
  assert.ok(T.FALLBACK_SUGGESTIONS.every((c) => c.text && c.title && c.hint));
  const cards = T.suggestionCards(raw);
  assert.equal(cards.length, 5);
  const qa = cards[4]!;
  assert.equal(qa.id, "qa-change");
  assert.equal(qa.title, "QA this change");
  assert.equal(qa.fill, "Can you QA the latest change?");
  assert.equal(qa.text, undefined, "the QA card has nothing to send: it only fills the box");
  assert.ok(cards.slice(0, 4).every((c) => c.fill === undefined && c.text));
  assert.equal(T.suggestionCards(null).length, 5);
  T.FALLBACK_SUGGESTIONS.push({ id: "x", icon: "x", title: "x", hint: "x", text: "x" });
  assert.equal(T.normalizeSuggestions(null).length, 5, "(the fallback list itself is copied, not shared)");
  T.FALLBACK_SUGGESTIONS.pop();
});

test("no department wording or plumbing is left in the web UI", () => {
  const files = readdirSync(uiDir).filter((f) => /\.(js|css|html)$/.test(f));
  assert.ok(files.length >= 15);
  const hits: string[] = [];
  for (const f of files) {
    readFileSync(join(uiDir, f), "utf8").split(/\r?\n/).forEach((line, i) => {
      // The one allowed use: a QA result's data field, which now holds the project name.
      if (f === "qa.js" && /q\.department/.test(line)) return;
      if (/department|dept|--dc\b|has-dept/i.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
  for (const gone of ["depts.js", "depts.css", "departments.js", "wizard.js", "deptapi.js"]) assert.ok(!files.includes(gone), `${gone} is deleted`);
  const html = readFileSync(join(uiDir, "index.html"), "utf8");
  assert.ok(!/depts\.css|view-landing|view-dept|tab-dept|id="wizard"/.test(html));
  assert.match(html, /<title>AURA Sentinel<\/title>/);
});

test("brand: the product is AURA Sentinel with a fixed accent per style and mode", async () => {
  const b = (await import(pathToFileURL(join(uiDir, "brand.js")).href)) as Record<string, string>;
  assert.equal(b["PRODUCT_NAME"], "AURA Sentinel");
  assert.equal(b["PRODUCT_SHORT"], "Sentinel");
  assert.equal(b["MONOGRAM"], "AS");
  const themes = readFileSync(join(uiDir, "themes.css"), "utf8");
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b2: string): number => (Math.max(lum(a), lum(b2)) + 0.05) / (Math.min(lum(a), lum(b2)) + 0.05);
  // One token set per mode. Light is the default (:root), dark is [data-mode="dark"].
  let seen = 0;
  for (const [name, re] of [["light", /:root,:root\[data-mode="light"\]\{([^}]*)\}/], ["dark", /:root\[data-mode="dark"\]\{([^}]*)\}/]] as const) {
    const block = re.exec(themes)?.[1] ?? "";
    const v = Object.fromEntries(block.split(/;\s*/).filter((x) => x.includes(":")).map((x) => { const i = x.indexOf(":"); return [x.slice(0, i).trim(), x.slice(i + 1).trim()]; })) as Record<string, string>;
    seen++;
    assert.ok(ratio(v["--brand-on"]!, v["--brand"]!) >= 4.5, `${name}: text on the accent`);
    assert.ok(ratio(v["--accent-text"]!, v["--accent"]!) >= 4.5, `${name}: button text`);
    assert.ok(ratio(v["--tile-ink"]!, v["--tile-a"]!) >= 4.5, `${name}: monogram on the tile start`);
    assert.ok(ratio(v["--tile-ink"]!, v["--tile-b"]!) >= 4.5, `${name}: monogram on the tile end`);
    assert.ok(ratio(v["--text"]!, v["--surface"]!) >= 4.5, `${name}: text on surface`);
    assert.ok(ratio(v["--muted"]!, v["--surface"]!) >= 4.5, `${name}: muted text on surface`);
    for (const t of ["ok", "warn", "bad", "info"]) assert.ok(ratio(v[`--${t}`]!, v[`--${t}-soft`]!) >= 4.5, `${name}: ${t} on its soft background`);
  }
  assert.equal(seen, 2, "light and dark");
});

/* ---------- the real page, driven in Edge against the stub ---------- */

let browser: Browser | null = null;
let browserWhy = "";
try {
  browser = await chromium.launch({ channel: "msedge" });
} catch (e) {
  browserWhy = `Edge could not be started (${String((e as Error).message).split("\n")[0]})`;
}
after(async () => { await browser?.close(); });
const needBrowser = (t: TestContext): boolean => {
  if (browser) return true;
  t.skip(browserWhy);
  return false;
};

async function open(opts: StubOpts = {}, size = { width: 1440, height: 1000 }, stayOnOverview = false): Promise<{ page: Page; stub: StubHandle; close: () => Promise<void> }> {
  const stub = await startStub(opts);
  const ctx = await browser!.newContext({ viewport: size });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(stub.url);
  await page.waitForSelector("#view-overview:not([hidden]) .land-title");
  if (!stayOnOverview) {
    await page.click('[data-nav="chat"]'); // the chat history column belongs to the Chat page
    await page.waitForSelector(".suggest");
  }
  return { page, stub, close: async () => { await ctx.close(); await stub.close(); assert.deepEqual(errors, [], "no script errors on the page"); } };
}

test("the app opens on the Overview with real KPI cards, a pipeline and honest panels; search finds notes", async (t) => {
  if (!needBrowser(t)) return;
  const { page, close } = await open({}, undefined, true);
  try {
    assert.equal(await page.locator("#view-overview").isVisible(), true, "the app opens on the Overview");
    assert.equal(await page.locator("#view-chat").isVisible(), false);
    assert.equal(await page.locator("#tab-overview.active").count(), 1);
    assert.equal(await page.locator(".ov-stat").count(), 3, "three big stat blocks");
    assert.match((await page.locator(".ov-stat").nth(1).textContent()) ?? "", /Commits, last 30 days/);
    assert.equal(await page.locator(".ov-stat .spark").count(), 2, "sparklines for commits and QA pass rate");
    assert.equal(await page.locator("#view-overview #composer").count(), 1, "the real composer sits in the hero");
    assert.equal(await page.locator("#sidebar").isVisible(), false, "no sidebar on the home page");
    assert.equal(await page.locator("#drawer-btn").isVisible(), false, "no sidebar toggle on the home page");
    assert.equal(await page.locator("#hero-composer-slot .composer-wrap.is-hero").count(), 1);
    assert.match((await page.locator(".land-title").textContent()) ?? "", /Ask anything about/);
    assert.equal(await page.locator(".ov-node").count(), 5);
    assert.match((await page.locator(".ov-run").first().textContent()) ?? "", /QA the latest change/);
    assert.equal(await page.locator("#bell-n").textContent(), "5");
    await page.fill("#global-search", "order");
    await page.waitForSelector("#gsearch-results .gs-row");
    assert.match((await page.locator("#gsearch-results").textContent()) ?? "", /Order flow overview/);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#gsearch-results").isVisible(), false);
    await page.click("#theme-toggle");
    assert.equal(await page.locator("html").getAttribute("data-mode"), "dark");
    await page.click("#theme-toggle");
    assert.equal(await page.locator("html").getAttribute("data-mode"), "light");
    await page.click('[data-nav="chat"]');
    assert.equal(await page.locator("#view-chat").isVisible(), true);
    assert.equal(await page.locator("#view-chat #composer").count(), 1, "the composer moves to the chat page");
  } finally {
    await close();
  }
});

test("first screen: a new empty chat for SPIL AURA with four question cards and the QA card", async (t) => {
  if (!needBrowser(t)) return;
  const { page, stub, close } = await open();
  try {
    assert.equal(await page.title(), "AURA Sentinel");
    assert.equal(await page.locator("#view-chat").isVisible(), true, "the Chat page shows after choosing Chat");
    assert.equal((await page.locator(".empty h2").textContent()), "Ask your codebase, get sources");
    assert.match((await page.locator(".empty .empty-sub").textContent()) ?? "", /Answers come only from the vault notes and the indexed code, with sources\. Type \/ for commands\./);
    assert.equal(await page.locator("#mascot").count(), 1, "the mascot sits above the composer");
    assert.equal(await page.locator("#chat-title").textContent(), "New chat");
    assert.equal(await page.locator(".chat-item.active").count(), 0, "no old chat is opened");
    assert.ok((await page.locator(".chat-item").count()) >= 5, "the latest chats are listed in the sidebar");
    const cards = await page.locator(".suggest .suggest-title").allTextContents();
    assert.equal(cards.length, 5);
    assert.equal(cards[0], "How is SPIL AURA put together?");
    assert.equal(cards[4], "QA this change");
    assert.equal(await page.locator("#inbox-count").textContent(), "5", "the inbox badge comes from the project facts");
    assert.match((await page.locator("#status-line").textContent()) ?? "", /^Claude plan · indexed \d+ min ago$/);
    assert.equal(await page.locator("#tab-dept, [data-view=dept], #dept-bar").count(), 0, "no department item anywhere");
    // Every request the screen made: none carries a department, and the new endpoints were used.
    const urls = stub.seen.map((s) => s.url);
    assert.ok(urls.includes("/api/project") && urls.includes("/api/suggestions") && urls.includes("/api/status"));
    assert.ok(!urls.some((u) => /dept|department/i.test(u)), `no department in any URL: ${urls.join(" ")}`);
    assert.ok(!stub.seen.some((s) => /dept|department/i.test(JSON.stringify(s.body))));
    assert.ok(!urls.some((u) => u.startsWith("/api/departments")));
  } finally {
    await close();
  }
});

test("first screen: a question card sends its text; no department is sent with it", async (t) => {
  if (!needBrowser(t)) return;
  const { page, stub, close } = await open();
  try {
    await page.locator(".suggest").nth(1).click();
    await page.waitForSelector(".msg.assistant .answer.bubble");
    const ask = stub.seen.filter((s) => /\/ask$/.test(s.url));
    assert.equal(ask.length, 1);
    assert.equal(ask[0]!.body["question"], "What changed recently?");
    assert.ok(!stub.seen.some((s) => /dept|department/i.test(s.url + JSON.stringify(s.body))));
  } finally {
    await close();
  }
});

test("first screen: QA this change fills the composer and does not send", async (t) => {
  if (!needBrowser(t)) return;
  const { page, stub, close } = await open();
  try {
    const before = stub.seen.length;
    await page.locator('.suggest[data-suggest="qa-change"]').click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator("#input").inputValue(), "Can you QA the latest change?");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "input", "the box has focus, ready to send");
    assert.equal(await page.locator("#send").isEnabled(), true);
    assert.ok(!stub.seen.slice(before).some((s) => s.method === "POST"), "nothing was posted");
    assert.equal(await page.locator(".msg.user").count(), 0, "no message was added");
    assert.equal(await page.locator(".empty").count(), 1, "still the first screen");
  } finally {
    await close();
  }
});

test("first screen: a failing suggestions call shows the plain fallback cards", async (t) => {
  if (!needBrowser(t)) return;
  const { page, close } = await open({ failSuggestions: true });
  try {
    const cards = await page.locator(".suggest .suggest-title").allTextContents();
    assert.deepEqual(cards, [...T.FALLBACK_SUGGESTIONS.map((c) => c.title), "QA this change"]);
  } finally {
    await close();
  }
});

test("first screen: an older server without project facts still opens, with the old inbox count", async (t) => {
  if (!needBrowser(t)) return;
  const { page, close } = await open({ failProject: true });
  try {
    assert.equal(await page.locator(".empty h2").textContent(), "Ask your codebase, get sources");
    assert.match((await page.locator("#status-line").textContent()) ?? "", /^Claude plan · 64 notes$/);
    await page.click("#status-toggle");
    assert.match((await page.locator("#status-detail").textContent()) ?? "", /No repository has been read yet\./);
  } finally {
    await close();
  }
});

test("status popover: repos, counts, inbox and a model line, in plain words", async (t) => {
  if (!needBrowser(t)) return;
  const { page, close } = await open();
  try {
    await page.click("#status-toggle");
    const box = page.locator("#status-detail");
    assert.equal(await box.isVisible(), true);
    const text = (await box.textContent()) ?? "";
    for (const want of ["SPIL AURA", "Indexed 8 min ago", "aura-app", "development", "Last commit yesterday", "erp-mcp-servers", "main", "Last commit 3 days ago", "812 commits", "2,140 files", "64 notes", "Active", "51", "Proposed", "13", "Stale", "No problems in the vault", "5 notes need your review", "Index now", "Model: Claude plan", "Model & keys"]) assert.ok(text.includes(want), `popover shows "${want}"`);
    assert.equal(await page.locator("#status-toggle").getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    assert.equal(await box.isVisible(), false, "Escape closes it");
    await page.click("#status-toggle");
    await page.click('#status-detail [data-k="inbox"]');
    assert.equal(await page.locator("#view-inbox").isVisible(), true, "Open inbox goes to the inbox");
    assert.equal(await box.isVisible(), false);
    await page.click("#menu-btn"); // outside Chat the status card is reached from the top-right menu
    await page.click('[data-menu="status-toggle"]');
    await page.click('#status-detail [data-k="keys"]');
    assert.equal(await page.locator("#view-settings").isVisible(), true, "Model & keys opens the settings");
  } finally {
    await close();
  }
});

test("status popover: a stale index and a never-indexed project are said plainly", async (t) => {
  if (!needBrowser(t)) return;
  const old = await open({ staleIndex: true });
  try {
    assert.match((await old.page.locator("#status-line").textContent()) ?? "", /index is 12 days old/);
    assert.ok(/warn/.test((await old.page.locator("#status-dot").getAttribute("class")) ?? ""));
    await old.page.click("#status-toggle");
    assert.match((await old.page.locator("#status-detail").textContent()) ?? "", /Indexed 12 days ago\. It is getting old\./);
  } finally {
    await old.close();
  }
  const fresh = await open({ neverIndexed: true });
  try {
    assert.match((await fresh.page.locator("#status-line").textContent()) ?? "", /never indexed/);
    await fresh.page.click("#status-toggle");
    assert.match((await fresh.page.locator("#status-detail").textContent()) ?? "", /Not indexed yet/);
    assert.match((await fresh.page.locator("#status-detail").textContent()) ?? "", /Nothing indexed yet|0 commits/);
  } finally {
    await fresh.close();
  }
});

test("status popover: Index now runs the index command through the streaming API, shows progress and refreshes", async (t) => {
  if (!needBrowser(t)) return;
  const { page, stub, close } = await open({ staleIndex: true });
  try {
    assert.match((await page.locator("#status-line").textContent()) ?? "", /index is 12 days old/);
    await page.click("#status-toggle");
    await page.click('#status-detail [data-k="index"]');
    await page.waitForFunction(() => /Indexing|Reading|Index/.test(document.getElementById("index-note")?.textContent ?? ""));
    await page.waitForFunction(() => /indexed (just now|\d+ min ago)/.test(document.getElementById("status-line")?.textContent ?? ""), null, { timeout: 8000 });
    const posts = stub.seen.filter((s) => s.method === "POST" && s.url === "/api/command");
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]!.body, { line: "/index" }, "only the command line is sent, nothing else");
    assert.match((await page.locator("#status-detail").textContent()) ?? "", /Indexed (just now|\d+ min ago)/);
    assert.ok(!stub.seen.some((s) => /dept|department/i.test(s.url + JSON.stringify(s.body))));
  } finally {
    await close();
  }
});

test("shortcuts still work with no department: Ctrl+K, Ctrl+/, Ctrl+B, Ctrl+,", async (t) => {
  if (!needBrowser(t)) return;
  const { page, close } = await open();
  try {
    await page.locator(".chat-open").first().click();
    await page.waitForSelector(".msg.assistant");
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".empty");
    assert.equal(await page.locator("#chat-title").textContent(), "New chat");
    await page.click('[data-nav="reports"]');
    await page.keyboard.press("Control+/");
    assert.equal(await page.locator("#view-chat").isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "input");
    await page.keyboard.press("Control+b");
    assert.equal(await page.locator("#app").getAttribute("class"), "app side-collapsed");
    await page.keyboard.press("Control+b");
    await page.keyboard.press("Control+,");
    assert.equal(await page.locator("#view-settings").isVisible(), true);
    await page.keyboard.press("Control+Shift+d");
    assert.equal(await page.locator("#view-settings").isVisible(), true, "Ctrl+Shift+D does nothing now");
  } finally {
    await close();
  }
});

test("suggestion cards accept the plain question strings the real server sends", async () => {
  const titles = await import(pathToFileURL(join(import.meta.dirname, "..", "..", "ui", "titles.js")).href);
  const cards = titles.suggestionCards({ suggestions: ["What is the rule: The AI never gets an ERP create tool?", "Is the index fresh?", "", "  "] });
  const questions = cards.filter((c: { id: string }) => c.id !== "qa-change");
  assert.equal(questions.length, 2, "blank strings are skipped, no fallback when the server sent usable ones");
  assert.equal(questions[0].title, "The AI never gets an ERP create tool");
  assert.equal(questions[0].hint, "A rule in the vault");
  assert.equal(questions[0].text, "What is the rule: The AI never gets an ERP create tool?", "the full question is what gets sent");
  assert.equal(questions[1].title, "Is the index fresh?");
  assert.equal(cards[cards.length - 1].id, "qa-change", "the QA card stays last");
  // Nothing usable from the server still gives the four fallback cards.
  assert.equal(titles.suggestionCards({ suggestions: [] }).filter((c: { id: string }) => c.id !== "qa-change").length, 4);
});
