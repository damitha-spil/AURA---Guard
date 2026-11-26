---
name: sec-api-input
description: Zero-trust audit of every API endpoint and input boundary (body, query, URL params, headers, cookies, JSON, uploads, WebSockets) for injection, SSRF, CSRF, CORS, RCE, path traversal, prototype pollution, race conditions, DoS, and ReDoS.
---

# Security Audit: API Security & Input Validation

Inspect every HTTP route, RPC/MCP tool, and WebSocket handler assuming attackers send oversized, malformed, encoded, or concurrent payloads.

## API Security Checklist

- **Injections & Execution:** SQL/NoSQL injection, OS command injection (shell strings vs. `execFile` arg arrays), RCE, template injection, LDAP/header injection.
- **Request Forgery & Origins:** SSRF (unvalidated URLs, redirects, internal metadata/localhost access), CSRF, overly permissive CORS (`*` with credentials), Host header attacks, unsafe open redirects, cache poisoning.
- **Object & File Abuse:** Mass assignment (`...req.body` spread into DB/config), unsafe deserialization, path traversal (`../`, symlinks, missing `realpath` jail), arbitrary file inclusion/upload.
- **Availability & Concurrency:** Missing rate limiting, large payload DoS (missing body caps), race conditions (TOCTOU on balances, approvals, tokens), prototype pollution (`__proto__`, `constructor.prototype`), verbose stack/system info disclosure.

## Input Validation Checklist

- **Every Boundary:** Request body, URL path params, query params, forms, file uploads (MIME/magic bytes/size), JSON, cookies, HTTP headers, WebSocket frames.
- **Bypass Vectors:** Unicode normalization/homoglyph tricks, double URL/encoding attacks, null byte (`\0`) injection, integer/buffer overflow, unsafe regex / catastrophic backtracking (ReDoS).

## Finding Requirements

Report every finding with: Severity, Why vulnerable, Exploit scenario, Business impact, OWASP & CWE mapping (e.g. A03/A10, CWE-20/CWE-22/CWE-78/CWE-918/CWE-1333), CVSS estimate, PoC, Affected files/functions, and Secure implementation example.
