---
name: sec-logging-perf
description: Zero-trust audit of Logging security (PII/token/stack-trace leakage, audit tampering), Project Architecture (circular deps, SOLID violations, coupling, dead code), and Performance/DoS (memory leaks, CPU spikes, blocking I/O, N+1 queries, bundle bloat).
---

# Security Audit: Logging, Architecture & Performance/DoS

Evaluate operational resilience, forensic auditability, structural maintainability, and resource-exhaustion attack surfaces.

## Logging & Audit Security Checklist

- **Sensitive Leakage:** Passwords, API tokens, cookies, session IDs, connection strings, or PII printed to stdout, stderr, crash logs, analytics, or client error payloads.
- **Error Handling & Traces:** Stack traces, internal file paths, SQL queries, or OS usernames returned in production HTTP/IPC responses.
- **Audit Integrity:** Missing audit trail for admin/privilege/config changes, log injection (newlines/ANSI control sequences), mutable/unprotected audit logs.

## Architecture & Code Quality Checklist

- Circular dependencies, tight coupling, low cohesion, SOLID violations, duplicated security/validation logic across routes.
- Dead code, unreachable handlers, magic constants without safety rationale, overly large multi-purpose functions.

## Performance & Resource DoS Checklist

- **Memory & Leaks:** Unbounded in-memory caches/maps/arrays, unclosed DB handles or timers, event listener leaks, huge file reads without size caps.
- **Blocking & Bottlenecks:** Synchronous I/O or CPU-heavy crypto/parsing on main event loop, N+1 DB queries, missing pagination (`LIMIT`/`OFFSET`), missing query indexes, unthrottled UI re-renders, large client bundle bloat.

## Finding Requirements

Report every finding with: Severity, Why vulnerable, Exploit scenario, Business impact, OWASP & CWE mapping (A09, CWE-532, CWE-117, CWE-400, CWE-770), CVSS estimate, PoC, Affected files/functions, and Secure implementation example.
