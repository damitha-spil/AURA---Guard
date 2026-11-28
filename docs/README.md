# SPIL REO Documentation Index

Central directory of architecture, design, planning, and technical reference documents for **SPIL REO** (*A Multi-Agent Quality Engineering & Software Assurance Platform.*).

## Top-Level Documents

| Document | Purpose |
|---|---|
| [README.md](../README.md) | Quick start, desktop/web run commands, tech stack overview, Claude Code plugin setup |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | System layers, memory model, masking gate, multi-provider brain, React/Tauri frontend, QA Harness |
| [STATUS.md](../STATUS.md) | Current implementation status and built architecture summary |
| [SPIL_REO_BLUEPRINT.md](../SPIL_REO_BLUEPRINT.md) | Multi-agent REO orchestrator, defect store, plugins, and platform blueprint |
| [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) | Phased build roadmap and verification gates |
| [THINKING.md](../THINKING.md) | Design rationale, trade-offs, and ideas kept or dropped |
| [AGENTS.md](../AGENTS.md) | Engineering rules, repo safety boundaries, TypeScript/test/cargo checks |
| [AI_HANDOFF.md](../AI_HANDOFF.md) | Chronological session handoff log, checks, and open items |
| [CHANGES.md](../CHANGES.md) | Repository changelog |

## Technical Guides (`docs/`)

| Document | Topic |
|---|---|
| [brain-settings.md](brain-settings.md) | Multi-backend model settings, CLI subscription backends, and encrypted OS key storage |
| [qa-agent.md](qa-agent.md) | QA sub-agent targeting, risk analysis, test cases, and evidence collection |
| [qa-tool-research.md](qa-tool-research.md) | Research notes on QA/UIA/CUA automation tooling |
| [qa-tool-summary.md](qa-tool-summary.md) | Summary of QA tooling choices and safety tiers |
| [vscode-extension.md](vscode-extension.md) | Opt-in VS Code developer activity capture extension |
| [capture-events.md](capture-events.md) | Extension-to-engine capture spool event contract |
| [capture-privacy.md](capture-privacy.md) | Privacy model and team rollout guidance for activity capture |

## Architecture Decision Records & Plans

| Document | Topic |
|---|---|
| [adr/001-foundations.md](adr/001-foundations.md) | Foundational architectural decisions (Node TypeScript, SQLite, Obsidian Vault, masking) |
| [plans/qa-qe-phases.md](plans/qa-qe-phases.md) | Phased QA & QE engineering capabilities roadmap |
