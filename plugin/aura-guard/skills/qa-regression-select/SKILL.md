---
name: qa-regression-select
description: Select the minimal high-impact regression and smoke test suite for a PR or commit range using git diff, code-graph blast radius, and historical co-change coupling.
---

# QA: Risk-Based Regression Suite Selection

Avoid blind full-suite slowdowns by selecting the exact tests and journeys that cover what changed and what depends on it.

## Steps

1. **Inspect Changed Surface:** Read changed files from git diff (`qa_plan_for_diff` or `qa plan spil-aura --no-model`).
2. **Expand Impact Radius:** Query `get_blast_radius` (2 hops of dependents) and `co_changed` partners to find indirect breakage zones.
3. **Rank & Select:**
   - **Must-Run (P0):** Journeys and unit tests directly touching changed files or high-centrality dependents.
   - **Targeted (P1):** Adjacent areas sharing state, config, or MCP schemas.
   - **Coverage Gaps:** Flag changed UI/service areas that have zero existing journeys so `/qa-explore` or `/qa-record` can cover them.
