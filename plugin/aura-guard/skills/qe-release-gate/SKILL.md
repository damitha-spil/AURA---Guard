---
name: qe-release-gate
description: Compute an overall Release Readiness & Quality Gate verdict combining QA pass rates, deterministic oracles, security blockers, blast radius, AI-log coverage, and PR evidence completeness.
---

# QE: Release Readiness & Quality Gate

Deliver an objective `PASS` / `WARN` / `BLOCK` release recommendation grounded in measured evidence rather than guesswork.

## Gate Criteria

- **BLOCK when any of:**
  - Blocker Tier 0 defect/security finding (secret in code, hardcoded SQL connection string, plico edit, ERP write tool given to AI).
  - Critical/High security audit finding without mitigation.
  - Failed QA journey, failing deterministic oracle (horizontal overflow, console/IPC error, missing form button `type`, raw tool JSON leak), or safety gate failure.
- **WARN when any of:**
  - UI changed without verified `800 / 1100 / 1440` px screenshots + walkthrough video.
  - Service/API changed without request/result/readback proof on test environment.
  - Unreviewed Tier 0 defect/policy risks, missing `ai-log/` entry, or stale Vault rules on touched files.
- **PASS only when:** All checks pass, evidence packet is attached and redacted, and no unresolved blockers remain.
