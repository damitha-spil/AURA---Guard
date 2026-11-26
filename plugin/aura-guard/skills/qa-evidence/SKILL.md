---
name: qa-evidence
description: Build a redacted PR Evidence Packet (800/1100/1440 px screenshots, video note, deterministic oracle report, and release gate summary) ready to paste into an Azure DevOps PR.
---

# PR Evidence Packet

Run from the developer's Guard folder:

```
node "${user_config.guard_home}/bin/aura-guard.mjs" qa evidence <run-id>
```

## Steps

1. Run UI checks at `800,1100,1440` px width against a running Aura window (background Cua Driver or CDP).
2. Generate the redacted packet via `qa evidence <run-id>` or MCP `qa_get_evidence_packet`.
3. Inspect `.artifacts/qa/<run-id>/pr-evidence.md` and verify screenshots/video before marking a PR ready.
4. Never include credentials, server addresses, or customer names.
