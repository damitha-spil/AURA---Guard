// Shared test helpers for the chat and server tests (not a test file itself).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertDoc } from "../src/index/db.ts";
import type { Db } from "../src/index/db.ts";
import type { GuardConfig } from "../src/types.ts";

export function tmpCfg(): GuardConfig {
  const root = mkdtempSync(join(tmpdir(), "guard-chat-"));
  return { department: "dev", dataDir: join(root, "data"), vaultDir: join(root, "vault"), repos: [], busyProcesses: [], root };
}

/** A secret built at run time so no literal secret sits in the source. */
export const fakeSecret = (): string => "gh" + "p_" + "k3Jd9sLq2VxZb7NmQw4RtYh8UcFa1PeXo5Gi";

export function seed(): Db {
  const db = openDb(":memory:");
  upsertDoc(db, { kind: "note", ref: "rule-erp-create", title: "The AI never gets an ERP create tool", body: "The backend owns every ERP create operation. The AI only requests a checked action.", hash: "1", status: "active", noteType: "rule", audience: "internal_dev" });
  upsertDoc(db, { kind: "note", ref: "draft-erp-idea", title: "Draft idea about ERP create", body: "Maybe allow the AI a create tool for drafts. <img src=x onerror=alert(1)>", hash: "2", status: "proposed", noteType: "rule", audience: "internal_dev" });
  upsertDoc(db, { kind: "note", ref: "support-only", title: "Customer ERP create help", body: "ERP create help for customers", hash: "3", status: "active", audience: "customer_support" });
  upsertDoc(db, { kind: "commit", ref: "aura@abc1234", title: "Add ERP create guard", body: "ERP create guard", hash: "4", audience: "internal_dev", repo: "aura" });
  return db;
}
