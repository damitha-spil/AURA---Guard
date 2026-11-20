# ADR-001: Foundations

Date: 2026-11-20. Status: accepted (the owner said "build this" and the
recommended defaults were taken; the owner can still change any of them).

## Decisions

1. **Language: TypeScript on Node 26**, run directly with
   `--experimental-strip-types`. Rust only later, for parts that measurements
   show are slow (likely the indexer and masking).
   *Why:* mature MCP and Claude Agent SDKs; no heavy Rust builds on a PC that
   runs out of memory; fast to change while the design settles.
2. **Database: Node's built-in `node:sqlite`** (FTS5 confirmed working; extension
   loading available for sqlite-vec later).
   *Why:* no native npm modules to compile.
3. **Runs on this PC first.** An office machine comes later for PR hooks and
   nightly jobs.
4. **Paid model: Guard's own small client**, behind the masking step. Not Aura's
   provider layer, which lives inside the Tauri app.
5. **Repos read on day one: Aura and ERP-MCP.** Others are added in config.
6. **Remote: GitHub** (`origin`), already created by the owner. Folder name kept
   as `D:\AURA - Guard`; the package, CLI and MCP name is `aura-guard`.
7. **Phase 1 search is words only (FTS5).** Meaning search (sqlite-vec and an
   embedding model) and the code graph come in Phase 2.

## Consequences

- Node 24 or newer is required.
- `node:sqlite` is newer than `better-sqlite3`; if it lacks something we need,
  revisit this ADR rather than mixing two drivers.
