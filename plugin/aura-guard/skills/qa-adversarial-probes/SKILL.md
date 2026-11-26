---
name: qa-adversarial-probes
description: Run safe, local/test-only adversarial ("foreign attack") probes against endpoints and inputs (SQLi, XSS, malformed payloads, IDOR/auth boundaries, rate limits) while hard-blocking production and ERP writes.
---

# QA: Safe Adversarial ("Foreign Attack") Probes

Test how local/sandbox endpoints and UI forms withstand hostile inputs without risking production data or ERP corruption.

## Safety Lock (Non-Negotiable)

- Target **ONLY** `127.0.0.1`, `localhost`, or explicitly configured isolated test environments using the **Cobalt test database**.
- Never probe production URLs, external third-party APIs, or ERP write/commit endpoints.

## Probe Categories

1. **Injection Strings:** Benign canary SQLi (`' OR '1'='1`), XSS (`<svg onload=...>`), and path traversal (`../../etc/passwd`) verifying strict rejection/escaping and zero raw reflection or SQL errors.
2. **Auth & IDOR Checks:** Replay requests without session cookie/token (`401`), with wrong Host/Origin (`403`), or as non-admin hitting admin routes (`403`).
3. **Payload & Header Abuse:** Oversized JSON bodies (`413`), null bytes, deeply nested JSON, missing `Content-Type`, and invalid HTTP methods.
4. **Protocol & Leak Check:** Verify responses never expose stack traces, DB schemas, internal paths, or secrets.
