---
name: sec-supplychain-infra
description: Zero-trust audit of Dependencies (package.json, lockfiles, CVEs, supply chain, typosquatting), CI/CD pipelines (GitHub Actions, signing, artifacts), Docker containers (root user, volumes, ports, capabilities), and Configuration (.env, CSP, CORS, HSTS, build configs).
---

# Security Audit: Supply Chain, CI/CD, Docker & Configuration

Audit everything that builds, packages, runs, or configures the software across `package.json`, `Cargo.toml`, lockfiles, CI workflows, containers, and runtime configs.

## Dependency & Supply Chain Checklist

- Unpinned dependencies, missing lockfiles, or floating GitHub/git dependencies without commit SHA pinning.
- Known CVEs across npm, Cargo, pip, NuGet; unused or deprecated packages expanding attack surface.
- Dependency confusion (private package names without scoped registry config), typosquatting, risky `postinstall`/`build.rs` lifecycle scripts.

## CI/CD & Build Pipeline Checklist

- GitHub Actions / Azure Pipelines: `pull_request_target` script injection (`${{ github.event.* }}`), unpinned third-party actions (`@main`/`@v3` instead of commit SHA), excessive `GITHUB_TOKEN` permissions (`write-all`).
- Secret exposure in build logs/artifacts, missing artifact signing/checksum verification, insecure self-hosted runners.

## Docker & Container Checklist

- Running as `root` instead of non-root `USER`; missing multi-stage builds leaving compilers/secrets in final image.
- Dangerous mounts (`/var/run/docker.sock`, host root), `--privileged`, excessive Linux capabilities (`CAP_SYS_ADMIN`), exposed unauthenticated ports, missing `HEALTHCHECK`, missing read-only rootfs (`--read-only`).

## Configuration & Headers Checklist

- `.env`, `next.config.*`, `vite.config.*`, `webpack.config.*`, `tsconfig.json`, `tauri.conf.json`, `eslint`/`prettier`: debug flags enabled in prod, source maps leaked in prod, missing Helmet/CSP/HSTS/CORS strictness.

## Finding Requirements

Report every finding with: Severity, Why vulnerable, Exploit scenario, Business impact, OWASP & CWE mapping (A05/A06/A08, CWE-1104/CWE-250/CWE-829), CVSS estimate, PoC, Affected files, and Secure implementation example.
