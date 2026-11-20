import { test } from "node:test";
import assert from "node:assert/strict";
import { GUARD_ROOT } from "../src/config.ts";
import { checkSpec, extendForbidden, loadForbidden, matchForbiddenText, normalizeKey } from "../src/qa/safety.ts";
import { ForbiddenActionError, guardPage, judgeElement } from "../src/qa/harness.ts";
import type { Page } from "playwright-core";

const list = loadForbidden(GUARD_ROOT);
const wrap = (body: string) =>
  `import { journey } from "../helpers/aura.ts";\njourney("j", async ({ page, step, visible }) => {\n  await step("s", async () => {\n${body}\n  });\n});\n`;
const rules = (body: string) => checkSpec(wrap(body), list).findings.map((f) => f.rule);

test("a safe read-only spec passes", () => {
  const r = checkSpec(wrap(`
    await page.getByRole("link", { name: "Orders" }).click();
    await visible(page.getByText("Needs you"), "the tile");
    const box = page.getByRole("searchbox", { name: "Search orders" });
    await box.fill("acme");
    await box.press("Enter");
    // await page.getByRole("button", { name: "Save" }).click();
  `), list);
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
});

test("forbidden clicks are rejected: names, regex names, text selectors, traced variables", () => {
  assert.ok(rules(`await page.getByRole("button", { name: "Save" }).click();`).includes("forbidden-action"));
  assert.ok(rules(`await page.getByRole("button", { name: /send to spil glass/i }).click();`).includes("forbidden-action"));
  assert.ok(rules(`await page.getByText("Check inbox now").click();`).includes("forbidden-action"));
  assert.ok(rules(`await page.click("text=Delete");`).includes("forbidden-action"));
  assert.ok(rules(`const b = page.getByRole("button", { name: "Confirm order" });\n await b.click();`).includes("forbidden-action"));
  assert.ok(rules(`await page.locator("button[type=submit]").click();`).includes("forbidden-selector"));
  assert.ok(rules(`await page.getByRole("button", { name: "Create" })\n  .first()\n  .click();`).includes("forbidden-action"));
});

test("a click target that cannot be traced, and coordinate clicks, are rejected", () => {
  assert.ok(rules(`for (const b of await page.getByRole("button").all()) { await b.click(); }`).includes("unverifiable-target"));
  assert.ok(rules(`await page.mouse.click(10, 10);`).includes("mouse-click"));
});

test("forbidden fills and presses are rejected; Enter only in a named search box", () => {
  assert.ok(rules(`await page.getByRole("button", { name: "Send" }).fill("x");`).includes("forbidden-action"));
  assert.ok(rules(`await page.getByRole("textbox", { name: "Ask Aura" }).press("Enter");`).includes("enter-may-submit"));
  assert.ok(rules(`await page.keyboard.press("Enter");`).includes("enter-may-submit"));
  assert.ok(rules(`await page.keyboard.press("Control+S");`).includes("commit-key"));
  assert.ok(rules(`await page.keyboard.press("Ctrl+s");`).includes("commit-key"));
  assert.equal(rules(`await page.getByRole("searchbox", { name: "Search settings" }).press("Enter");`).length, 0);
});

test("remote hosts and writing requests are rejected; local GET is fine", () => {
  assert.ok(rules(`await page.request.get("https://example.com/x");`).includes("remote-host"));
  assert.ok(rules(`await fetch("https://example.com/x");`).includes("remote-host"));
  assert.ok(rules(`await page.request.post("http://127.0.0.1:1420/x");`).includes("write-request"));
  assert.ok(rules(`await page.request.get(someUrl);`).includes("unverifiable-request"));
  assert.ok(rules(`await page.evaluate(() => fetch("http://tauri.localhost/x", { method: "POST" }));`).includes("write-request"));
  assert.equal(rules(`await page.request.get("http://127.0.0.1:1420/ok");`).length, 0);
  assert.ok(rules(`await page.goto("https://evil.example/");`).includes("remote-host"));
});

test("native calls, mocks, storage and bad imports are rejected", () => {
  assert.ok(rules(`await page.evaluate(() => window.__TAURI__.core.invoke("save_order"));`).includes("native-call"));
  assert.ok(rules(`await page.route("**/*", (r) => r.fulfill({ body: "x" }));`).includes("mock-api"));
  const bad = `import { execSync } from "node:child_process";\n` + wrap(`await page.getByText("Orders").click();`);
  assert.ok(checkSpec(bad, list).findings.some((f) => f.rule === "import-not-allowed"));
  assert.ok(checkSpec(`console.log(1);`, list).findings.some((f) => f.rule === "no-journey"));
});

test("file uploads are only allowed from fixtures", () => {
  assert.ok(rules(`await page.getByLabel("Attach").setInputFiles("C:/Users/x/secret.pdf");`).includes("upload-outside-fixtures"));
  assert.ok(!rules(`await page.getByLabel("Pick").setInputFiles("qa/fixtures/a.pdf");`).includes("upload-outside-fixtures"));
});

test("the forbidden list is data and a company can extend it, never shrink it", () => {
  assert.equal(matchForbiddenText("Archive customer", list), null);
  const ext = extendForbidden(list, { names: ["archive"], allowedHosts: ["evil.example"] });
  assert.equal(matchForbiddenText("Archive customer", ext), "archive");
  assert.ok(ext.names.includes("save"));
  assert.ok(!ext.allowedHosts.includes("evil.example"));
  assert.ok(checkSpec(wrap(`await page.getByText("Archive customer").click();`), ext).findings.some((f) => f.rule === "forbidden-action"));
  assert.equal(normalizeKey("Ctrl+Shift+S"), "control+shift+s");
  assert.equal(matchForbiddenText("Saved as a draft", list), null); // whole words only
});

// ---- runtime guard ----

type Info = Record<string, unknown>;
function fakePage(info: Info) {
  const calls: string[] = [];
  const loc = (label: string): Record<string, unknown> => ({
    click: async () => { calls.push(`click:${label}`); },
    fill: async () => { calls.push(`fill:${label}`); },
    press: async (k: string) => { calls.push(`press:${label}:${k}`); },
    evaluate: async () => info,
    first() { return this; },
    toString: () => `locator('${label}')`,
  });
  const page = {
    getByRole: (_r: string, o?: { name?: string }) => loc(o?.name ?? "x"),
    locator: (s: string) => loc(s),
    keyboard: { press: async (k: string) => { calls.push(`kb:${k}`); } },
    mouse: { click: async () => { calls.push("mouse"); }, move: async () => {} },
    request: { post: async () => { calls.push("request"); } },
    goto: async (u: string) => { calls.push(`goto:${u}`); },
    title: async () => "SPIL Aura",
  };
  return { page: guardPage(page as unknown as Page, list), calls };
}

test("runtime guard throws BEFORE a forbidden click and lets a safe one through", async () => {
  const bad = fakePage({ tag: "button", text: "Save draft", control: true });
  await assert.rejects(() => bad.page.getByRole("button", { name: "x" }).click(), ForbiddenActionError);
  assert.deepEqual(bad.calls, []); // the click never happened

  const good = fakePage({ tag: "a", text: "Orders", control: true });
  await good.page.getByRole("link", { name: "Orders" }).click();
  assert.deepEqual(good.calls, ["click:Orders"]);
  assert.equal(await good.page.title(), "SPIL Aura");
});

test("runtime guard catches a submit button, a bad selector, keys, mouse, request and remote goto", async () => {
  const sub = fakePage({ tag: "button", text: "Go", control: true, submits: true });
  await assert.rejects(() => sub.page.getByRole("button", { name: "Go" }).click(), /submit a form/);
  const sel = fakePage({ tag: "div", text: "ok", control: false });
  await assert.rejects(() => sel.page.locator("button[type=submit]").click(), ForbiddenActionError);
  const k = fakePage({ tag: "input", control: true });
  await assert.rejects(() => k.page.keyboard.press("Control+S"), ForbiddenActionError);
  await assert.rejects(() => k.page.getByRole("textbox", { name: "Ask Aura" }).press("Enter"), ForbiddenActionError);
  await k.page.getByRole("searchbox", { name: "Search orders" }).press("Enter");
  assert.throws(() => k.page.mouse.click(1, 1), ForbiddenActionError);
  assert.throws(() => (k.page as unknown as { request: () => void }).request(), ForbiddenActionError);
  await assert.rejects(async () => { await k.page.goto("https://example.com"); }, ForbiddenActionError);
  assert.deepEqual(k.calls, ["press:Search orders:Enter"]);
});

test("a long container that merely mentions a word is not blocked, a short label is", () => {
  const row = { tag: "div", control: false, text: "Order from ACME, saved as a draft, then asked to send the confirmation later today" };
  assert.equal(judgeElement(row, "locator('row')", list), null);
  assert.ok(judgeElement({ tag: "div", control: false, text: "Send" }, "x", list));
  assert.ok(judgeElement({ tag: "button", control: true, name: "Delete order", text: "" }, "x", list));
});
