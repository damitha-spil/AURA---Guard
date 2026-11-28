---
name: sec-git-secret-audit
description: Scan read-only git commit history and added diffs for leaked tokens or keys using sec_gitleaks_history with mandatory redaction.
---

# Security: Git History Secret Audit

1. Run `sec_gitleaks_history` (read-only `git log -p` / Gitleaks) across configured repositories with bounded commit lookback.
2. Verify matched secret types (`ANTHROPIC_KEY`, `GITHUB_TOKEN`, `AWS_KEY`, `PRIVATE_KEY`, `JWT`); **never print or echo raw credential values** — only show redacted previews.
3. For real credential leaks in commit history, treat rotation/revocation as top priority alongside history purge advice.
4. Pair with REO's `maskOutgoing` gate to guarantee leaks never escape to external APIs, webhooks, or reports.
