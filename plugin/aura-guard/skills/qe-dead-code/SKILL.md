---
name: qe-dead-code
description: Surface unused files, dead exported symbols, and unused npm dependencies via qe_dead_code_scan (Knip pattern).
---

# QE: Dead Code & Bloat Audit

1. Execute `qe_dead_code_scan` against configured TS/JS repositories during PR reviews or weekly QE digests.
2. Separate true dead code from CLI/framework entry points before recommending deletion.
3. Prioritize removing unused production `dependencies` first (reduces supply-chain CVE surface and bundle size), followed by dead helpers and orphan modules.
4. Cross-check removal impact with `get_blast_radius` before flagging high-confidence cleanup tasks.
