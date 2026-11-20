import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/index/db.ts";
import { refreshGraph, storedGraphSha } from "../src/graph/refresh.ts";
import type { GuardConfig } from "../src/types.ts";

test("refreshGraph skips plainly when the repo is unknown or graphify is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-refresh-"));
  try {
    const cfg: GuardConfig = {
      dataDir: dir, vaultDir: dir, busyProcesses: [], root: dir,
      repos: [{ id: "r", path: dir }],
    };
    const db = openDb(":memory:");
    assert.equal((await refreshGraph(cfg, db, "nope")).status, "skipped");
    const r = await refreshGraph(cfg, db, "r");
    assert.equal(r.status, "skipped");
    assert.match(r.reason!, /graphify is not installed/);
    assert.equal(storedGraphSha(db, "r"), undefined);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
