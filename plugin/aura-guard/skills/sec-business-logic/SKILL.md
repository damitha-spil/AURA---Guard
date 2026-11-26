---
name: sec-business-logic
description: Zero-trust audit of Business Logic flows (payments, subscriptions, orders, ERP write boundaries, admin functions, downloads, licenses, credits, refunds, discounts, file/data ownership) to break invariants and bypass workflow gates.
---

# Security Audit: Business Logic & Domain Abuse

Think like a malicious insider or fraudulent customer attempting to violate domain invariants without triggering syntax or crash errors.

## Business Logic Attack Checklist

- **Orders, Pricing & Financial Flows:** Negative quantities, integer overflow/precision rounding, client-supplied prices/totals/discounts, race conditions on coupon/credit/refund redemption, skipping draft/approval states directly to final save/settlement.
- **ERP & AI Safety Boundaries:** AI/agent helpers gaining direct write/create/delete tools instead of passing through backend validation and explicit human/admin approval gates; unguarded GUI automation clicking ERP commit controls.
- **Access, Licenses & Entitlements:** Bypassing subscription/premium feature flags, forging or replaying offline license files, accessing downloads or attachments belonging to another tenant/customer, exporting unredacted data via preview/print/report endpoints.
- **Admin & Multi-Step Workflows:** Skipping mandatory verification steps (e.g., jumping from step 1 to step 4), replaying approval callbacks from unauthorized accounts/devices, modifying protected admin settings without re-authentication.

## Finding Requirements

Report every finding with: Severity, Why vulnerable, Exploit scenario, Business impact, OWASP & CWE mapping (A04 Insecure Design, CWE-840, CWE-841, CWE-362), CVSS estimate, PoC, Affected files/functions, and Secure implementation example.
