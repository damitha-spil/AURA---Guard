---
name: sec-threat-model
description: Builds a realistic end-to-end Threat Model and attack path across Initial Access, Privilege Escalation, Persistence, Credential Theft, Lateral Movement, Data Exfiltration, Business Impact, and concrete Mitigations.
---

# Security Audit: End-to-End Threat Model

Synthesize findings across code, dependencies, desktop/web/mobile surfaces, DBs, and CI/CD into concrete attacker kill chains.

## Attack Path Stages to Trace

1. **Initial Access:** How an attacker first enters (e.g., malicious PDF/email prompt injection, exposed local/network port, XSS, compromised npm/Cargo dep, leaked PR token).
2. **Execution & Privilege Escalation:** Moving from unprivileged viewer/renderer/normal user to native OS execution, admin role, or ERP write authority.
3. **Persistence:** Modifying local config, startup scripts, extension/plugin hooks, CI workflows, or stored sessions/allowlists.
4. **Credential Theft:** Harvesting API keys, OAuth/JWT tokens, DB connection strings, WhatsApp/Telegram session keys, or OS keystore entries.
5. **Lateral Movement:** Pivoting from workstation/app into shared QA/prod SQL Server, ERP MCP servers, Azure DevOps, or internal network services.
6. **Data Exfiltration:** Exfiltrating customer PDFs, orders, pricing, source code, or secrets via outbound HTTP, messaging gateways, or unmasked LLM egress.

## Deliverable Structure

- **System Trust Boundaries Diagram (Text/ASCII):** Untrusted inputs -> App/API boundary -> Privileged backend/MCP -> Database/External systems.
- **Top 3 Realistic Kill Chains:** Step-by-step narrative with prerequisites, likelihood, impact, and exact files/functions along each hop.
- **Prioritized Mitigations:** Defense-in-depth controls breaking each chain at multiple hops.
