---
id: pattern-checks-in-memory-safe-order
type: pattern
status: proposed
audience: [internal_dev]
department: dev
source: import
title: "Run checks in a memory-safe order"
code_anchors:
  - repo: spil-aura
    path: .claude/skills/aura-checks
  - repo: spil-aura
    path: AGENTS.md
created: 2026-11-20
---

# Run checks in a memory-safe order

The developer PC runs out of memory, so stop the dev app and the PDF reader before building.

1. Rust: `cargo test -p agent-core --lib`, then `cargo test` in `src-tauri`, with one build job.
2. UI: `npx tsc --noEmit`, then `npx vitest run` with one worker, in `apps/aura-ui`.
3. Always: `git diff --check`.

Keep generated evidence in the ignored `.artifacts/` folder.
