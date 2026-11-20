import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeSecret, seed, tmpCfg } from "./chat-helpers.ts";
import { answer } from "../src/chat/answer.ts";
import type { Step } from "../src/chat/answer.ts";
import { upsertDoc } from "../src/index/db.ts";
import { maskAll } from "../src/brain/client.ts";
import type { CompleteFn, CompleteRequest } from "../src/brain/client.ts";

const cfg = tmpCfg();
const usage = { input_tokens: 1, output_tokens: 1 };

/** The same masking step the real brain runs before anything leaves the machine. */
function maskingComplete(seen: CompleteRequest[]): CompleteFn {
  return async (req) => {
    maskAll([...req.system, req.user]);
    seen.push(req);
    return { text: "The backend owns ERP creates [rule-erp-create].", usage };
  };
}

test("a retrieved source that looks like a secret is left out; the question is still answered", async () => {
  const db = seed();
  const secret = fakeSecret();
  upsertDoc(db, {
    kind: "note", ref: "leaky-note", title: "ERP create notes", hash: "9", status: "active", audience: "internal_dev",
    body: `ERP create notes. The old deploy token was ${secret} (pasted by mistake).`,
  });
  const seen: CompleteRequest[] = [];
  const steps: Step[] = [];
  const r = await answer(cfg, db, { history: [], question: "ERP create tool" }, { complete: maskingComplete(seen), onStep: (s) => steps.push(s) });
  assert.equal(r.ok, true, r.text);
  assert.equal(seen.length, 1, "the model was called once");
  assert.ok(!seen[0]!.system.join("\n").includes(secret), "the secret never reached the prompt");
  assert.ok(!r.sources.some((s) => s.ref === "leaky-note"), "the leaky source is not offered as a citation");
  const found = steps.find((s) => s.id === "found");
  assert.match(found?.detail ?? "", /left out because it looked like a secret: leaky-note/);
});

test("Guard's own ids (words plus a hex tail) are not mistaken for secrets", async () => {
  const db = seed();
  upsertDoc(db, {
    kind: "note", ref: "pattern-cochange-0829e6e17ce2", title: "Files that change together: ERP create", hash: "8",
    status: "proposed", audience: "internal_dev", body: "ERP create changes usually come with the guard tests.",
  });
  const seen: CompleteRequest[] = [];
  const steps: Step[] = [];
  const r = await answer(cfg, db, { history: [], question: "ERP create" }, { complete: maskingComplete(seen), onStep: (s) => steps.push(s) });
  assert.equal(r.ok, true, r.text);
  assert.ok(seen[0]!.system.join("\n").includes("pattern-cochange-0829e6e17ce2"), "the note was used as a source");
  assert.equal(steps.find((s) => s.id === "found")?.detail, undefined, "nothing was left out");
});

test("when the block is not the question, the message says so", async () => {
  const db = seed();
  const secret = fakeSecret();
  const seen: CompleteRequest[] = [];
  const r = await answer(
    cfg, db,
    { history: [{ role: "user", text: `my token is ${secret}` }], question: "ERP create tool" },
    { complete: maskingComplete(seen) },
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "blocked");
  assert.equal(seen.length, 0, "nothing was sent");
  assert.match(r.text, /Something in this chat/);
  assert.ok(!/Your message looks like/.test(r.text), "the question itself is not blamed");
  assert.ok(!r.text.includes(secret));
});
