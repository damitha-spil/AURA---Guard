import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskOutgoing, unmask } from "../src/mask/mask.ts";
import { auditOutgoing } from "../src/mask/audit.ts";
// @ts-expect-error plain JS module without types
import { buildCases } from "../../evals/masking/generate.mjs";

interface Case {
  id: string;
  text: string;
  expect: "block" | "replace" | "clean";
  kinds?: string[];
  values?: string[];
  dict?: boolean;
}

// Cases are generated from a fixed seed; no secret-shaped text is kept in git.
const cases: Case[] = buildCases() as Case[];

const DICTIONARY = [
  { term: "Acme Glass", kind: "customer" },
  { term: "Brightview", kind: "customer" },
  { term: "SQLPROD01", kind: "internal_host" },
  { term: "cobalt_erp", kind: "schema" },
  { term: "Zenith Fabricators", kind: "customer" },
];

test("case file has at least 100 cases", () => {
  assert.ok(cases.length >= 100, `only ${cases.length}`);
});

test("gate: every block case is blocked, with no original value left", () => {
  const list = cases.filter((c) => c.expect === "block");
  const missed: string[] = [];
  for (const c of list) {
    const r = maskOutgoing(c.text, { dictionary: DICTIONARY });
    const leaked = (c.values ?? []).filter((v) => r.text.includes(v));
    if (r.ok || leaked.length > 0) missed.push(`${c.id} (ok=${r.ok}, leaked=${leaked.length})`);
    if (c.kinds) {
      const got = new Set(r.blocked.map((b) => b.kind));
      for (const k of c.kinds) if (!got.has(k)) missed.push(`${c.id} wrong kind, wanted ${k}, got ${[...got]}`);
    }
  }
  console.log(`block rate: ${list.length - missed.length}/${list.length}`);
  assert.equal(missed.length, 0, `missed: ${missed.join("; ")}`);
});

test("every replace case is replaced, no original value left, and not blocked", () => {
  const list = cases.filter((c) => c.expect === "replace");
  const bad: string[] = [];
  for (const c of list) {
    const r = maskOutgoing(c.text, { dictionary: c.dict ? DICTIONARY : [] });
    const leaked = (c.values ?? []).filter((v) => r.text.includes(v));
    const kindsOk = (c.kinds ?? []).every((k) => r.replaced.some((x) => x.kind === k));
    if (!r.ok || r.replaced.length === 0 || leaked.length > 0 || !kindsOk) {
      bad.push(`${c.id} (ok=${r.ok}, replaced=${r.replaced.length}, leaked=${leaked.length}, kinds=${kindsOk})`);
    }
  }
  console.log(`replace rate: ${list.length - bad.length}/${list.length}`);
  assert.equal(bad.length, 0, `bad: ${bad.join("; ")}`);
});

test("clean cases: false positives at most 2%", () => {
  const list = cases.filter((c) => c.expect === "clean");
  const fp: string[] = [];
  for (const c of list) {
    const r = maskOutgoing(c.text, { dictionary: DICTIONARY });
    if (!r.ok || r.replaced.length > 0 || r.text !== c.text) fp.push(`${c.id}: ${JSON.stringify(c.text.slice(0, 60))}`);
  }
  const rate = fp.length / list.length;
  console.log(`false positives: ${fp.length}/${list.length} (${(rate * 100).toFixed(1)}%)`, fp);
  assert.ok(rate <= 0.02, `false positive rate ${(rate * 100).toFixed(1)}%: ${fp.join("; ")}`);
});

test("placeholders are stable per value within a call", () => {
  const r = maskOutgoing("a@x.test then b@x.test then A@X.TEST and 10.1.1.1 and 10.1.1.2 and 10.1.1.1", {});
  assert.equal(r.text, "EMAIL_01 then EMAIL_02 then EMAIL_01 and INTERNAL_IP_01 and INTERNAL_IP_02 and INTERNAL_IP_01");
  assert.equal(r.ok, true);
});

test("unmask round trip", () => {
  const input = "Acme Glass at 10.2.3.4 mailed jo@example.test; Brightview too";
  const r = maskOutgoing(input, { dictionary: DICTIONARY });
  assert.ok(!r.text.includes("Acme Glass") && !r.text.includes("10.2.3.4"));
  assert.equal(unmask(r.text, r.map), input);
  assert.equal(unmask("CUSTOMER_10 EMAIL_01x", r.map), "CUSTOMER_10 EMAIL_01x");
});

test("dictionary terms match case-insensitively on word boundaries", () => {
  const r = maskOutgoing("brightview, BRIGHTVIEW and Brightviews and xBrightview", { dictionary: DICTIONARY });
  assert.equal(r.text, "CUSTOMER_01, CUSTOMER_01 and Brightviews and xBrightview");
});

test("secrets are replaced in text and never enter the map", () => {
  const r = maskOutgoing("token=Zk3!hunter9x and mail a@x.test");
  assert.equal(r.ok, false);
  assert.ok(r.text.includes("[SECRET_PASSWORD_VALUE]"));
  assert.ok(![...r.map.values()].some((v) => v.includes("hunter9x")));
});

test("overlap: a secret wins over a sensitive span inside it", () => {
  const r = maskOutgoing("postgres://svc:Pa55word9@10.0.0.5/db and user@x.test");
  assert.equal(r.ok, false);
  assert.ok(!r.text.includes("Pa55word9"));
});

test("audit lines hold hashes and counts only", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-audit-"));
  try {
    const input = "mail jo@example.test token=Zk3!hunter9x Acme Glass";
    const r = maskOutgoing(input, { dictionary: DICTIONARY });
    const sha256 = createHash("sha256").update(r.text).digest("hex");
    // Extra fields (a careless caller passing the payload) must be dropped.
    const rec = { ts: "2026-11-20T10:00:00Z", role: "reviewer", model: "m", sha256, blocked: r.blocked, replaced: r.replaced, payload: input };
    auditOutgoing(dir, rec);
    auditOutgoing(dir, rec);
    const files = readdirSync(dir);
    assert.deepEqual(files, ["egress-2026-11-20.jsonl"]);
    const raw = readFileSync(join(dir, files[0] as string), "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2);
    for (const original of ["jo@example.test", "hunter9x", "Acme Glass", "payload"]) assert.ok(!raw.includes(original), original);
    assert.deepEqual(Object.keys(JSON.parse(lines[0] as string)).sort(), ["blocked", "model", "replaced", "role", "sha256", "ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
