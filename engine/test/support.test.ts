import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertDoc } from "../src/index/db.ts";
import type { Db } from "../src/index/db.ts";
import type { CompleteFn } from "../src/brain/client.ts";
import { leakCheck, loadForbiddenTerms } from "../src/support/leak.ts";
import { draftSupport, exportSupport, parseDraft, supportNotes, writeSupportNote } from "../src/support/draft.ts";
import { loadVault } from "../src/vault/load.ts";

const kinds = (text: string, terms?: string[]): string[] => leakCheck(text, terms).reasons.map((r) => r.kind);

const CLEAN = "# Saving an order\n\n## What to do\n\n1. Check the order lines.\n2. Press Save.\n\n## What to expect\n\nA saved order shows a number.\n\n## Known limits\n\nSome orders need a person.\n\n## When to ask for help\n\nIf the number does not appear.\n";

test("leak check passes clean plain-words text", () => {
  assert.deepEqual(kinds(CLEAN), []);
  assert.deepEqual(kinds("Use and/or the 1/2 option. Orders from 2026-11-20 are fine."), []);
});

test("leak check rejects each forbidden class", () => {
  assert.ok(kinds("Open C:\\Users\\work\\notes.txt now").includes("path"));
  assert.ok(kinds("See apps/personal-agent/src/main now").includes("path"));
  assert.ok(kinds("Edit the file orders.rs first").includes("file-extension"));
  assert.ok(kinds("Open settings.json and change it").includes("file-extension"));
  assert.ok(kinds("It was fixed in 3f9a2c1b8d").includes("commit-id"));
  assert.ok(kinds("Go to https://intranet.example.test/help").includes("url"));
  assert.ok(kinds("The server is at 10.20.30.40 today").includes("ip-address"));
  assert.ok(kinds("Ask the host files.fabrics-internal.local").includes("host-name"));
  assert.ok(kinds("This was bug #1234 last month").includes("ticket-reference"));
  assert.ok(kinds("It happens after a regression in the branch").includes("forbidden-term"));
});

test("leak check rejects text that a masking detector flags", () => {
  const token = "gh" + "p_" + "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5";
  assert.ok(kinds(`Use this token ${token} to log in`).includes("secret-detector"));
  const email = "jo.smith" + "@" + "acme-glass-works.org";
  assert.ok(kinds(`Write to ${email} for help`).includes("sensitive-detector"));
  // The matched secret itself is never repeated in the reasons.
  const reasons = leakCheck(`token ${token}`).reasons;
  assert.ok(reasons.every((r) => !r.sample.includes(token)));
});

test("companies extend the forbidden words with vault/support/forbidden-terms.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-support-terms-"));
  try {
    assert.ok(!loadForbiddenTerms(dir).includes("zeta customer"));
    writeFileSync(join(dir, "forbidden-terms.json"), JSON.stringify({ terms: ["Zeta Customer", " "] }));
    const terms = loadForbiddenTerms(dir);
    assert.ok(terms.includes("zeta customer"));
    assert.ok(terms.includes("commit"), "defaults stay");
    assert.ok(kinds("Order for Zeta Customer is late", terms).includes("forbidden-term"));
    writeFileSync(join(dir, "forbidden-terms.json"), "not json");
    assert.ok(loadForbiddenTerms(dir).includes("commit"), "a broken file falls back to the defaults");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "guard-support-"));
  const vault = join(root, "vault");
  const db: Db = openDb(":memory:");
  upsertDoc(db, {
    kind: "note", ref: "pattern-saving-orders", title: "How saving an order works",
    body: "Saving an order checks the lines first. The backend saves, never the AI. See src/orders/save.rs, fixed in 3f9a2c1b8d.",
    hash: "h1", status: "active", noteType: "pattern", audience: "internal_dev",
  });
  return { root, vault, db, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const reply = (text: string, calls?: string[]): CompleteFn => async (req) => {
  calls?.push(req.user);
  return { text, usage: { input_tokens: 1, output_tokens: 1 } };
};

test("a clean draft is written as a proposed customer_support domain note in vault/support", async () => {
  const s = setup();
  try {
    const r = await draftSupport(s.db, s.vault, "saving an order", reply(CLEAN), { now: new Date(2026, 4, 6) });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.attempts, 1);
    assert.deepEqual(r.headings, ["What to do", "What to expect", "Known limits", "When to ask for help"]);
    assert.match(r.file.replace(/\\/g, "/"), /vault\/support\/domain-support-saving-an-order\.md$/);
    const { notes, problems } = loadVault(s.vault);
    assert.equal(problems.length, 0);
    const n = notes.find((x) => x.meta.id === r.id)!;
    assert.deepEqual(n.meta.audience, ["customer_support"]);
    assert.equal(n.meta.type, "domain");
    assert.equal(n.meta.status, "proposed");
    assert.equal(n.meta.source, "evidence");
    assert.equal(n.meta.created, "2026-05-06");
    assert.deepEqual(supportNotes(s.vault).map((x) => x.id), [r.id]);
  } finally {
    s.cleanup();
  }
});

test("a leaking draft is retried once with the reasons, then accepted when clean", async () => {
  const s = setup();
  try {
    const calls: string[] = [];
    let n = 0;
    const complete: CompleteFn = async (req) => {
      calls.push(req.user);
      n++;
      return { text: n === 1 ? CLEAN.replace("Press Save.", "Edit src/orders/save.rs.") : CLEAN, usage: { input_tokens: 1, output_tokens: 1 } };
    };
    const r = await draftSupport(s.db, s.vault, "saving an order", complete);
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2);
    assert.match(calls[1]!, /rejected by an automatic check/);
    assert.match(calls[1]!, /path|file-extension/);
  } finally {
    s.cleanup();
  }
});

test("a draft that keeps leaking writes nothing and reports why", async () => {
  const s = setup();
  try {
    const bad = CLEAN.replace("Press Save.", "Edit orders.rs and see https://host.example.test/x.");
    const calls: string[] = [];
    const r = await draftSupport(s.db, s.vault, "saving an order", reply(bad, calls));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "leak");
    assert.equal(calls.length, 2);
    assert.ok(r.reasons.length > 0);
    assert.throws(() => readdirSync(join(s.vault, "support")), /ENOENT/);
  } finally {
    s.cleanup();
  }
});

test("no internal note about the topic means no model call and no file", async () => {
  const s = setup();
  try {
    const calls: string[] = [];
    const r = await draftSupport(s.db, s.vault, "zebra migration", reply(CLEAN, calls));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "no-sources");
    assert.equal(calls.length, 0);
  } finally {
    s.cleanup();
  }
});

test("the writer itself refuses an unsafe draft", () => {
  const s = setup();
  try {
    const r = writeSupportNote(s.vault, "Saving", "Run it from C:\\tools\\x now.", ["pattern-saving-orders"]);
    assert.equal(r.ok, false);
    assert.throws(() => readdirSync(join(s.vault, "support")), /ENOENT/);
    const ok = writeSupportNote(s.vault, "Saving", "Press Save.", ["pattern-saving-orders"]);
    assert.equal(ok.ok, true);
    const again = writeSupportNote(s.vault, "Saving", "Press Save.", ["pattern-saving-orders"]);
    assert.equal(again.ok, true);
    if (ok.ok && again.ok) assert.notEqual(ok.id, again.id, "never overwrites");
  } finally {
    s.cleanup();
  }
});

test("export strips frontmatter and the provenance comment, and writes only under data/support-export", async () => {
  const s = setup();
  try {
    const r = await draftSupport(s.db, s.vault, "saving an order", reply(CLEAN));
    assert.ok(r.ok);
    if (!r.ok) return;
    const data = join(s.root, "data");
    const e = exportSupport(s.vault, data, r.id);
    assert.equal(e.ok, true);
    if (!e.ok) return;
    assert.equal(e.status, "proposed");
    const text = readFileSync(e.file, "utf8");
    assert.ok(text.startsWith("# Saving an order"));
    assert.ok(!text.includes("---"));
    assert.ok(!text.includes("<!--") && !text.includes("pattern-saving-orders"));
    assert.match(e.file.replace(/\\/g, "/"), /data\/support-export\/.+\.md$/);
    assert.equal(exportSupport(s.vault, data, "nope").ok, false);

    // A note that has been edited into a leak is refused at export too.
    const f = join(s.vault, "support", `${r.id}.md`);
    writeFileSync(f, readFileSync(f, "utf8").replace("Press Save.", "Open https://host.example.test/x."));
    const bad = exportSupport(s.vault, data, r.id);
    assert.equal(bad.ok, false);
    mkdirSync(join(s.root, "unused"), { recursive: true });
  } finally {
    s.cleanup();
  }
});

test("parseDraft takes the title and strips a code fence", () => {
  const p = parseDraft("```markdown\n# Hello\n\n## A\n\ntext\n```", "topic");
  assert.equal(p.title, "Hello");
  assert.ok(p.body.startsWith("## A"));
  assert.equal(parseDraft("no heading here", "topic").title, "topic");
});
