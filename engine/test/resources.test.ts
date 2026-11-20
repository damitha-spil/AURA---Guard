import { test } from "node:test";
import assert from "node:assert/strict";
import { busyProcesses, canRunHeavyWork, memoryPressure, parseTasklistCsv } from "../src/guard/resources.ts";
import type { GuardConfig } from "../src/types.ts";

const SAMPLE =
  '"System Idle Process","0","Services","0","8 K"\r\n"cargo.exe","1234","Console","1","150,000 K"\r\n"rustc.exe","99","Console","1","900,000 K"\r\n"Code - Insiders.exe","7","Console","1","1 K"\r\n';

test("parseTasklistCsv reads image names", () => {
  assert.deepEqual(parseTasklistCsv(SAMPLE), ["System Idle Process", "cargo.exe", "rustc.exe", "Code - Insiders.exe"]);
});

test("busyProcesses is empty for no names and for unlikely names", async () => {
  assert.deepEqual(await busyProcesses([]), []);
  assert.deepEqual(await busyProcesses(["definitely-not-a-process-xyz"]), []);
});

test("memoryPressure is well formed", () => {
  const m = memoryPressure();
  assert.ok(m.totalMb > 0 && m.freeMb >= 0);
  assert.equal(typeof m.low, "boolean");
});

test("canRunHeavyWork returns a well-formed result", async () => {
  const cfg = { busyProcesses: ["definitely-not-a-process-xyz"] } as unknown as GuardConfig;
  const r = await canRunHeavyWork(cfg);
  assert.equal(typeof r.ok, "boolean");
  assert.ok(Array.isArray(r.reasons));
  assert.equal(r.ok, r.reasons.length === 0);
});
