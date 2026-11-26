---
name: sec-desktop-frontend
description: Zero-trust audit of Desktop apps (Electron/Tauri main process, renderer, IPC, preload, contextBridge, sandbox, native APIs, filesystem, RCE) and Frontend apps (React/Next.js XSS, dangerouslySetInnerHTML, markdown, CSP, cookies, browser storage).
---

# Security Audit: Desktop (Electron/Tauri) & Frontend Security

Assume untrusted external content (emails, PDFs, chat replies, web pages, MCP responses) can reach the renderer and attempt XSS-to-RCE escalation.

## Desktop (Electron / Tauri) Checklist

- **Process Isolation:** Electron `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `enableRemoteModule: false`; Tauri capabilities/ACL least-privilege scoping per window.
- **IPC & Preload Bridges:** Exposed `contextBridge` or `#[tauri::command]` handlers accepting arbitrary paths, shell commands, URLs, or SQL; missing sender/origin validation on IPC calls.
- **Navigation & Links:** `shell.openExternal` / Tauri opener invoked with unvalidated schemes (`file://`, `ms-msdt:`, `javascript:`); unrestricted `will-navigate` / `setWindowOpenHandler` / webview redirects.
- **Local Filesystem & Native APIs:** Symlink/path-traversal escapes on file read/write/preview; spawning child processes via shell strings; unpinned sidecar binaries or writable PATH lookups.

## Frontend (React / Next.js / Vanilla Web) Checklist

- **XSS & DOM Injection:** `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `document.write`, unsafe markdown/HTML renderers, SVG script injection, `eval` / `new Function`.
- **CSP & Headers:** Missing or weak Content-Security-Policy (`unsafe-inline`, `unsafe-eval`, wildcard `script-src`), missing `X-Content-Type-Options: nosniff`, `Referrer-Policy`.
- **State, Cookies & Storage:** Sensitive tokens/PII in `localStorage`/`sessionStorage`, Next.js SSR/hydration state leakage (`__NEXT_DATA__`), missing `HttpOnly`/`SameSite=Strict` on auth cookies, client-only auth guards hiding unprotected APIs.

## Finding Requirements

Report every finding with: Severity, Why vulnerable, Exploit scenario, Business impact, OWASP & CWE mapping (CWE-79, CWE-94, CWE-250, CWE-1021), CVSS estimate, PoC, Affected files/functions, and Secure implementation example.
