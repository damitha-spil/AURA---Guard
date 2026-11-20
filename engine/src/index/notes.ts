import type { NoteProblem } from "../types.ts";
import { loadVault } from "../vault/load.ts";
import { deleteDoc, upsertDoc } from "./db.ts";
import type { Db } from "./db.ts";

export function indexVault(
  db: Db,
  vaultDir: string,
): { added: number; updated: number; removed: number; problems: NoteProblem[] } {
  const { notes, problems } = loadVault(vaultDir);
  let added = 0;
  let updated = 0;
  let removed = 0;
  db.exec("BEGIN");
  try {
    const exists = db.prepare("SELECT 1 FROM docs WHERE ref=?");
    const delAnchors = db.prepare("DELETE FROM anchors WHERE note_id=?");
    const addAnchor = db.prepare(
      "INSERT INTO anchors(note_id, repo, path, symbol, verified_sha) VALUES (?,?,?,?,?)",
    );
    for (const n of notes) {
      const was = exists.get(n.meta.id) !== undefined;
      const changed = upsertDoc(db, {
        kind: "note",
        ref: n.meta.id,
        title: n.meta.title ?? n.meta.id,
        body: n.body,
        hash: n.hash,
        status: n.meta.status,
        noteType: n.meta.type,
        audience: n.meta.audience.join(","),
        date: n.meta.created,
      });
      if (!changed) continue;
      if (was) updated++;
      else added++;
      delAnchors.run(n.meta.id);
      for (const a of n.meta.code_anchors ?? []) {
        addAnchor.run(n.meta.id, a.repo, a.path, a.symbol ?? null, a.verified_sha ?? null);
      }
    }
    const keep = new Set(notes.map((n) => n.meta.id));
    const rows = db.prepare("SELECT ref FROM docs WHERE kind='note'").all() as { ref: string }[];
    for (const r of rows) {
      if (keep.has(r.ref)) continue;
      deleteDoc(db, r.ref);
      db.prepare("DELETE FROM anchors WHERE note_id=?").run(r.ref);
      removed++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { added, updated, removed, problems };
}
