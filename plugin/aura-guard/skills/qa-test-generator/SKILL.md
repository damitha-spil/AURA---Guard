---
name: qa-test-generator
description: Autonomously synthesize unit, integration, API, and E2E test cases (positive, negative, boundary, edge cases) grounded in the PR diff, OpenAPI specs, and Guard knowledge base rules.
---

# QA: Autonomous Test Case Generator

Generate sharp, high-signal test suites directly from code changes, API contracts, and Vault rules without inventing non-existent files or endpoints.

## Steps

1. **Gather Grounded Context:** Read the diff, `get_blast_radius`, `co_changed`, active Vault rules, and past incidents (`advise_architecture`).
2. **Design Balanced Test Matrix:**
   - **Functional (P0):** Core happy path and business invariants.
   - **Negative & Error Paths (P0/P1):** Invalid inputs, missing permissions, failed IPC/API calls, empty/null states.
   - **Boundary & Edge Cases (P1):** Width extremes (`800` px), max lengths, unicode, concurrent clicks, stale tokens.
   - **Regression (P0/P1):** Affected callers from blast radius and historically buggy modules.
3. **Output Format:** Emit declarative `qa-steps` journeys for UI flows or framework-native unit/integration test outlines citing real files and symbols only.
