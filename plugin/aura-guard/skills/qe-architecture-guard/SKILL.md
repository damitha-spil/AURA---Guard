---
name: qe-architecture-guard
description: Enforce module boundary rules and catch circular imports deterministically with qe_arch_boundaries (dependency-cruiser pattern).
---

# QE: Architecture Boundary Guard

1. Run `qe_arch_boundaries` alongside `get_blast_radius` whenever refactoring across layers (`web/`, `engine/`, `mcp/`).
2. Block UI modules from importing database drivers, process runners, or engine internal storage helpers directly.
3. Break any reported `circularDependencies` chain by extracting shared contracts into a pure types/utilities leaf module.
4. Keep fixes minimal and local — document intentional layer exceptions as Vault ADRs (`vault/adr/`).
