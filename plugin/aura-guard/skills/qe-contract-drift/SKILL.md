---
name: qe-contract-drift
description: Check API endpoints, MCP tool schemas, TypeScript/Rust IPC payloads, DTOs, and database migrations for breaking changes or documentation/contract drift.
---

# QE: Contract, Schema & Migration Drift Check

Ensure frontend, backend, MCP servers, and databases stay synchronized across every change.

## Checklist

1. **IPC & MCP Tool Parity:** When a Rust Tauri command or MCP tool changes parameters/return shape, verify every UI caller, skill, and `co_changed` partner updated together.
2. **API / Swagger Compatibility:** Flag removed fields, narrowed types, renamed enum variants, or changed HTTP status codes that break existing clients.
3. **Database & Migration Safety:** Check SQL migrations for destructive drops, missing backward-compatible defaults, unindexed foreign keys, or Cobalt QA DB policy violations.
4. **Vault & Config Schemas:** Verify `guard.config` / `desk.json` / `forbidden-actions.json` schema changes preserve backward compatibility or document migration notes.
