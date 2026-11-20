import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertDoc } from "../src/index/db.ts";
import type { Db } from "../src/index/db.ts";
import { parseQuestions, loadQuestions } from "../src/quiz/questions.ts";
import type { QuizQuestion } from "../src/quiz/questions.ts";
import { diffRuns, scoreAnswer, scoreRetrieval, summarize, citedRefs } from "../src/quiz/score.ts";
import { pickSample, runQuiz, writeReport } from "../src/quiz/run.ts";
import { GUARD_ROOT } from "../src/config.ts";

function note(db: Db, ref: string, title: string, body: string): void {
  upsertDoc(db, { kind: "note", ref, title, body, hash: ref + body.length, status: "active", noteType: "rule", audience: "internal_dev" });
}

function setup(): Db {
  const db = openDb(":memory:");
  note(db, "rule-price", "Never guess a price", "A price comes from the ERP or from staff. If it is missing, ask.");
  note(db, "rule-secrets", "Secrets stay in the secret store", "Passwords and tokens go into the encrypted secret store.");
  return db;
}

const posQ = (over: Partial<QuizQuestion> = {}): QuizQuestion => ({
  id: "q1", area: "hard-rules", question: "Where does a price come from?",
  expect: { cite: ["rule-price"], mention: ["erp", "staff"] }, status: "draft", ...over,
});
const negQ: QuizQuestion = {
  id: "q2", area: "not-in-knowledge", question: "Who is the chief executive?",
  expect: { cite: [], mention: [], unknown: true }, status: "draft",
};

test("retrieval: expected ref in the top 5 passes, a miss fails with a reason", () => {
  const db = setup();
  const hit = scoreRetrieval(db, posQ());
  assert.equal(hit.pass, true);
  assert.equal(hit.retrieved, true);
  const miss = scoreRetrieval(db, posQ({ expect: { cite: ["rule-secrets"], mention: [] } }));
  assert.equal(miss.pass, false);
  assert.match(miss.reasons[0]!, /rule-secrets/);
});

test("retrieval: negative questions are not scored", () => {
  const r = scoreRetrieval(setup(), negQ);
  assert.equal(r.pass, null);
  const s = summarize([scoreRetrieval(setup(), posQ()), r]);
  assert.equal(s.scored, 1);
  assert.equal(s.total, 2);
  assert.equal(s.rate, 1);
  assert.equal(s.meetsGate, true);
});

test("model scoring: needs an expected source, real citations and the keywords", () => {
  const ok = scoreAnswer(posQ(), { ok: true, text: "From the ERP or staff [rule-price].", sources: [{ ref: "rule-price" }] }, (r) => r === "rule-price");
  assert.equal(ok.pass, true);

  const noSource = scoreAnswer(posQ(), { ok: true, text: "ERP and staff.", sources: [{ ref: "rule-secrets" }] }, () => true);
  assert.equal(noSource.pass, false);
  assert.match(noSource.reasons.join(" "), /no expected ref/);

  const missing = scoreAnswer(posQ(), { ok: true, text: "The ERP [rule-price].", sources: [{ ref: "rule-price" }] }, () => true);
  assert.equal(missing.pass, false);
  assert.match(missing.reasons.join(" "), /staff/);

  const invented = scoreAnswer(posQ(), { ok: true, text: "ERP, staff [rule-price] [made-up-ref].", sources: [{ ref: "rule-price" }] }, (r) => r === "rule-price");
  assert.equal(invented.pass, false);
  assert.match(invented.reasons.join(" "), /made-up-ref/);

  const failed = scoreAnswer(posQ(), { ok: false, text: "", sources: [], error: "no-backend" }, () => true);
  assert.equal(failed.pass, false);
});

test("model scoring: a negative question passes only when the answer declines", () => {
  const declines = scoreAnswer(negQ, { ok: true, text: "I do not know, the sources do not say.", sources: [{ ref: "rule-price" }] }, () => true);
  assert.equal(declines.pass, true);
  const noSources = scoreAnswer(negQ, { ok: true, text: "Nothing.", sources: [] }, () => true);
  assert.equal(noSources.pass, true);
  const guesses = scoreAnswer(negQ, { ok: true, text: "It is the founder.", sources: [{ ref: "rule-price" }] }, () => true);
  assert.equal(guesses.pass, false);
  assert.match(guesses.reasons[0]!, /not in the knowledge/);
});

test("citedRefs finds bracketed refs but not markdown links", () => {
  assert.deepEqual(citedRefs("see [a-b] and [link](http://x) and [c:d]"), ["a-b", "c:d"]);
});

test("runQuiz model mode with a fake answer function, a cap and the judge", async () => {
  const db = setup();
  const qs = [posQ({ id: "q1" }), posQ({ id: "q2" }), posQ({ id: "q3" }), { ...negQ, id: "q4" }];
  const asked: string[] = [];
  const run = await runQuiz(db, qs, {
    mode: "model", cap: 2, date: "2026-01-02",
    ask: async (q) => {
      asked.push(q);
      return { ok: true, text: "The ERP or staff [rule-price]. I do not know more.", sources: [{ ref: "rule-price" }] };
    },
    judge: async () => ({ text: '{"verdict":"pass","reason":"fine"}', usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  assert.equal(run.results.length, 2);
  assert.equal(run.skipped, 2);
  // The negative question takes the last slot of a capped sample.
  assert.deepEqual(run.results.map((r) => r.id), ["q1", "q4"]);
  assert.equal(run.results[0]!.judge?.verdict, "pass");
  assert.equal(pickSample(qs, 10).length, 4);
});

test("diffRuns lists regressions and fixes", () => {
  const prev = [{ id: "a", pass: true }, { id: "b", pass: false }, { id: "c", pass: true }];
  const cur = ["a", "b", "c", "d"].map((id) => ({
    id, area: "x", question: "q", unknown: false, retrieved: null, topRefs: [], reasons: [],
    pass: id === "a" || id === "b" || id === "d",
  }));
  const d = diffRuns(prev, cur);
  assert.deepEqual(d.regressed, ["c"]);
  assert.deepEqual(d.fixed, ["b"]);
  assert.equal(d.newlyScored, 1);
});

test("writeReport writes a markdown report with the gate and a diff against the previous run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-quiz-"));
  try {
    const db = setup();
    const first = await runQuiz(db, [posQ(), negQ], { mode: "retrieval", date: "2026-01-01" });
    writeReport(dir, first);
    const second = await runQuiz(db, [posQ({ expect: { cite: ["rule-secrets"], mention: [] } }), negQ], { mode: "retrieval", date: "2026-01-02" });
    const w = writeReport(dir, second);
    const text = readFileSync(w.file, "utf8");
    assert.match(text, /BELOW the gate/);
    assert.match(text, /Regressed: q1/);
    assert.match(text, /Failures \(1\)/);
    assert.ok(readdirSync(join(dir, "quiz")).includes("2026-01-02.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("question files are validated", () => {
  assert.throws(() => parseQuestions(JSON.stringify([{ id: "a", area: "x", question: "q", expect: { cite: [], mention: [] }, status: "draft" }])), /needs expect/);
  assert.throws(() => parseQuestions(JSON.stringify([
    { id: "a", area: "x", question: "q", expect: { cite: ["r"], mention: [] }, status: "draft" },
    { id: "a", area: "x", question: "q", expect: { cite: ["r"], mention: [] }, status: "draft" },
  ])), /duplicate/);
});

// The questions come from private repos, so the file is not in git: this check
// only runs where the owner has it locally.
test("the local question file has 50 drafts, 8 of them negative", { skip: !existsSync(join(GUARD_ROOT, "evals", "quiz", "questions.json")) }, () => {
  const qs = loadQuestions(GUARD_ROOT);
  assert.equal(qs.length, 50);
  assert.equal(qs.filter((q) => q.expect.unknown).length, 8);
  assert.ok(qs.every((q) => q.status === "draft"));
});
