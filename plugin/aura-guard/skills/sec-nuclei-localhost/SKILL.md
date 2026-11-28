---
name: sec-nuclei-localhost
description: Execute localhost-only dynamic vulnerability template scans via sec_nuclei_local against local dev servers.
---

# Security: Localhost Nuclei Template Scan

1. Confirm the target URL uses `127.0.0.1` or `localhost` (`sec_nuclei_local` rejects non-local hosts automatically).
2. Probe common local misconfigurations: exposed `/.env`, `/.git/HEAD`, `/actuator/env`, wildcard CORS + credentials, and missing `Content-Security-Policy` / `X-Content-Type-Options`.
3. Pair with `qa_security_probes` for comprehensive SQLi/XSS/traversal verification before shipping.
4. File confirmed High/Critical findings in `Defects` with exact HTTP endpoint evidence.
