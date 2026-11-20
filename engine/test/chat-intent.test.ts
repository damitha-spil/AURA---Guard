import { test } from "node:test";
import assert from "node:assert/strict";
import { detectIntent, isRunConfirmation, QA_NEEDS_INPUT_HEAD, QA_RESULT_HEAD, slashQaText } from "../src/chat/intent.ts";
import { decideRoute } from "../src/chat/qa-route.ts";

const POSITIVE = [
  "Can you QA it", "can you QA this?", "QA PR 123", "qa the latest change", "Please QA the checkout", "test this change", "Test PR #45",
  "what should I test for the checkout feature", "What should we test after this change?", "write test cases for the login flow",
  "create a test plan for orders", "Give me a regression test plan", "run a smoke test on the build", "verify the latest commit",
  "can you test it", "sanity check this branch", "Could you verify the pricing fix?", "how should I test this", "help me test the parser",
  "do a QA pass on feature/x", "I need test cases for the nesting change", "generate test scenarios for PR 99", "/qa the latest change",
  "acceptance test the new screen", "what do I need to test", "Is this ready to test?", "retest the fix", "UAT checklist for the release",
  "let's QA it", "test it", "please test the changes in src/a.ts", "QA", "Hey, can you QA the last 3 commits?", "test everything in this branch",
];
const NEGATIVE = [
  "why does the test fail in orders?", "where are the tests?", "how do I run the tests?", "what is QA?", "who does QA here?",
  "which tests cover the parser?", "is there a test for the login flow?", "explain regression testing", "what is a smoke test",
  "the test is flaky", "test failed in CI again", "tests are passing now", "how many tests do we have", "what does the QA agent do",
  "does the build pass", "Tell me about the testing library", "where is the test plan", "how does the checkout work",
  "what is the pricing rule", "describe the QA process", "/status", "/qa status", "/qa run journey-x", "hello", "what is a test case",
  "testing is hard", "", "   ",
];

test("intent: messages that ask for QA go to the QA agent", () => {
  for (const m of POSITIVE) {
    const r = detectIntent(m);
    assert.equal(r.intent, "qa", `${JSON.stringify(m)} -> ${r.reason}`);
    assert.ok(r.confidence > 0.5 && r.reason.length > 0);
  }
});

test("intent: ordinary questions, even ones that mention tests, stay normal answers", () => {
  for (const m of NEGATIVE) {
    const r = detectIntent(m);
    assert.equal(r.intent, "ask", `${JSON.stringify(m)} -> ${r.reason}`);
  }
});

test("intent: /qa <text> is QA, but the existing /qa sub-commands are not", () => {
  assert.equal(slashQaText("/qa the latest change"), "the latest change");
  assert.equal(slashQaText("/qaz hi"), null);
  assert.equal(detectIntent("/qa PR 12").intent, "qa");
  assert.equal(detectIntent("/qa").intent, "qa");
  for (const sub of ["status", "plan", "generate", "check", "run"]) assert.equal(detectIntent(`/qa ${sub} x`).intent, "ask", sub);
  assert.equal(detectIntent("/review").intent, "ask");
});

test("intent: a reply to the bot's own QA question is read as the answer", () => {
  const history = [{ role: "assistant" as const, text: `${QA_NEEDS_INPUT_HEAD}\n\nWhich change?` }];
  assert.equal(detectIntent("PR 123", history).intent, "qa");
  assert.equal(detectIntent("feature/checkout", history).intent, "qa");
  assert.equal(detectIntent("The checkout now rounds totals to two places", history).intent, "qa");
  // A different question is still a question.
  assert.equal(detectIntent("why is the sky blue?", history).intent, "ask");
  // Without the question above, a bare reference is not QA.
  assert.equal(detectIntent("PR 123", []).intent, "ask");
});

test("intent: confirming a journey run needs the QA result above", () => {
  const history = [{ role: "assistant" as const, text: `# ${QA_RESULT_HEAD}: the latest change\n...` }];
  for (const m of ["run the journeys", "yes, run them", "Yes run the read-only journeys", "go ahead"]) {
    assert.equal(isRunConfirmation(m), true, m);
    assert.equal(detectIntent(m, history).intent, "qa", m);
  }
  assert.equal(detectIntent("run the journeys", []).intent, "ask");
  assert.equal(isRunConfirmation("what does run mean in rust"), false);
});

test("route: an explicit mode or runJourneys beats detection", () => {
  assert.equal(decideRoute("Can you QA it", [], { mode: "ask" }).intent, "ask");
  assert.equal(decideRoute("hello", [], { mode: "qa" }).intent, "qa");
  assert.equal(decideRoute("hello", [], { runJourneys: true }).intent, "qa");
  assert.equal(decideRoute("Can you QA it", []).intent, "qa");
});
