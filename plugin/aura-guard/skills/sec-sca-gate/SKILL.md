---
name: sec-sca-gate
description: Scan package lockfiles (OSV-Scanner / Trivy / lockfile SCA) via sec_dependency_cves and trigger BLOCK_RELEASE on Critical or High CVEs.
---

# Security: SCA Dependency CVE Release Gate

1. Execute `sec_dependency_cves` on `on_commit` and `on_release_candidate` triggers inside QA Harness.
2. Inspect reported `package-lock.json` / `Cargo.lock` vulnerabilities (`installedVersion` vs `fixedIn`).
3. Any Critical or High CVE returns `releaseGate: "BLOCK_RELEASE"` and records deduplicated SHA-256 defects in `Defects`.
4. Recommend exact minimal safe version upgrades (`npm install pkg@^fixedIn`) without broad unpinned updates.
