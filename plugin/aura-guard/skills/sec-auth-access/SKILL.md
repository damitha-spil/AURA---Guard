---
name: sec-auth-access
description: Zero-trust audit of Authentication (JWT, OAuth, sessions, token storage, replay, reset, bypass) and Authorization (Broken Access Control, IDOR, horizontal/vertical privilege escalation, admin/role bypass, missing ownership checks).
---

# Security Audit: Authentication & Authorization

Assume every unauthenticated and authenticated caller is hostile. Trace every route, middleware, IPC handler, and token lifecycle from issuance to revocation.

## Authentication Checklist

- **JWT Flaws:** `alg: none` or HS/RS algorithm confusion, weak secrets, missing `exp`/`iss`/`aud` verification, unvalidated claims.
- **Token Lifecycle:** Token leakage in URLs/logs/referrers, missing expiration, missing refresh token rotation/revocation, session fixation, token replay.
- **Storage & Transport:** Insecure `localStorage` tokens vs. `HttpOnly; SameSite=Strict; Secure` cookies, missing OS secret-store encryption.
- **Auth Providers & Flows:** OAuth state/PKCE/redirect-URI bypass, Google/Supabase Auth misconfigurations, login bypass, password reset token predictability/reuse, email verification bypass, magic-link abuse, account takeover, session hijacking.

## Authorization Checklist

- **Broken Access Control & IDOR:** User-supplied object IDs (`orderId`, `userId`, `chatId`) accessed without server-side ownership checks.
- **Privilege Escalation:** Horizontal (user A reads/modifies user B) and vertical (standard user invokes admin/staff endpoints or config writes).
- **Bypass Vectors:** Admin/role bypass via missing middleware, client-side-only route guards, hidden/undocumented routes, HTTP verb tampering, or mismatched backend vs. UI permission checks.

## Finding Requirements

Report every finding with: Severity (`Critical|High|Medium|Low|Informational`), Why vulnerable, Exploit scenario, Business impact, OWASP & CWE mapping (e.g. OWASP A01/A07, CWE-287/CWE-639/CWE-862), CVSS estimate, PoC, Affected files/functions, and Secure implementation example.
