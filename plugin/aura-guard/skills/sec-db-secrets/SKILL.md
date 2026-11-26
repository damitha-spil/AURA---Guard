---
name: sec-db-secrets
description: Zero-trust audit of Database security (raw SQL, ORM, transactions, locking, privilege separation, migrations, backups, pooling) and full-repo Secret scanning (API/JWT/cloud/DB/SMTP/webhook keys, env leakage, debug/test credentials).
---

# Security Audit: Database Security & Secret Scanning

Trace all data persistence layers and scan every file, config, fixture, test, and log path for credential exposure.

## Database Security Checklist

- **Query Safety:** Raw SQL string concatenation/interpolation vs. parameterized queries; dynamic `ORDER BY` / table/column allowlisting; ORM escape hatches.
- **Isolation & Concurrency:** Missing transactions around multi-step writes, race conditions / missing row locking (`SELECT ... FOR UPDATE`), inconsistent error rollback.
- **Privilege & Operations:** Over-privileged DB accounts (app running as `sa`/superuser), shared QA/prod boundary enforcement (e.g., Cobalt-only QA DB rule), missing indexes causing table-scan DoS, unsafe/destructive migrations, unencrypted backups, connection pool exhaustion.
- **Secret Handling:** Connection strings stored in plaintext config, logs, or UI responses instead of encrypted OS secret stores.

## Repository Secret Scanning Checklist

Search all files (including scripts, fixtures, tests, docs, CI files, and comments) for:
- API keys, JWT signing secrets, private keys (`-----BEGIN ... PRIVATE KEY-----`), OAuth client secrets.
- Cloud & SaaS tokens: AWS, Azure, GCP, Supabase, Firebase, Stripe, GitHub/GitLab PATs.
- Infrastructure credentials: SMTP passwords, Database passwords/connection strings, Webhook signing secrets.
- Leakage paths: `.env` files tracked in git, `process.env` serialized to client/logs, debug secrets, hardcoded test credentials left in production code paths.

## Finding Requirements

Report every finding with: Severity, Why vulnerable, Exploit scenario, Business impact, OWASP & CWE mapping (e.g. A02/A03, CWE-89/CWE-798/CWE-312), CVSS estimate, PoC (never print raw real secrets in reports — redact middle bytes), Affected files/functions, and Secure implementation example.
