---
name: sec-sarif-triage
description: Run Semgrep SAST or ingest SARIF v2.1.0 security findings via sec_semgrep_scan directly into SPIL REO's SHA-256 deduplicated Defects store.
---

# Security: SAST & SARIF Triage

1. Run `sec_semgrep_scan` (or ingest an external CI SARIF file via `sarifJson`) read-only on the target repository.
2. Critical and High vulnerabilities (SQL string concatenation, `shell: true` command injection, raw DOM XSS sinks, SSRF) are deduplicated by SHA-256 fingerprint into `Defects`.
3. Validate each reported slice in context to filter false positives, while keeping the raw source repo unmodified.
4. Provide minimal, parameterized/safe replacement snippets (never secrets) for engineers.
