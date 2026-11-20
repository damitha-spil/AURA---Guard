# Thinking behind AURA Guard

The brainstorm of 2026-11-20 between the owner and Claude, recorded so later
readers know why the design looks the way it does.

## The starting idea

The owner wants a bot that, for the first few weeks, is only fed and taught:
what Aura is, how the owner codes it, how features are added each day. Later it
should work as a QA agent, a support agent and a code review agent. Ideas
raised: open-source agent tools, a paid model for thinking, Obsidian, graphify,
SQLite, pattern recognition, small local model weights, a separate repo,
plugins, connectors, an MCP server, data in and out, and a good interface.

## Name

- Considered: Facet, Kiln, Vitra, Lens, Temper, Prism, Pane, Compass, Beacon and
  others. Glass-related names were favoured because SPIL works in glass.
- **Chosen by the owner: AURA Guard.** Repo folder: `D:\AURA - Guard`.
- Suggested slug for code, CLI and MCP: `aura-guard` (no spaces).
- Note: "Guard" sounds like it blocks things. It should only advise until
  measured results earn more.
- Other departments: AURA Guard Dev, Finance, HR, all on one engine.

## Decisions and why

| Decision | Why |
|---|---|
| Memory first, fine-tuning later | Training on unchecked data teaches noise and goes stale with every commit. A paid model plus good knowledge works from day one. |
| Obsidian vault is the truth; SQLite is a rebuildable index | Two stores that both hold facts drift apart. The vault is readable, editable and versioned in git. |
| What the owner rejected is the main learning signal | Commits show only the final result. Taste shows in corrections: Claude Code sessions, AI draft vs final commit, PR comments. |
| Rules need the owner's approval | Silent rules spread mistakes. |
| Notes are tied to code (`code_anchors`) and go stale automatically | The most common failure of note-based bots is answering from old notes after a refactor. |
| Fixed checks before AI checks | Cheaper, instant, same answer every time; the paid model is kept for judgment. |
| Audience tag on every note; scoped MCP access | Internal code and bugs must never reach customer-facing text. |
| Small state machine plus one config file per role, not CrewAI/AutoGen | Free agent-to-agent chat is unpredictable, costly and hides failures. |
| Read-only, advise-only, no ERP writes | Same boundary as Aura: the AI never gets a create tool for SPIL Glass. |
| Resource guard | This PC runs out of memory during builds. |
| Separate repo | Guard is internal tooling, not part of the product fabricators install. |

## Ideas from the second-round review (pasted by the owner)

The owner pasted a longer "industrial" version of the design. Kept from it:

- Six layers with clear contracts (ingest, memory, search, router, roles,
  interfaces).
- Note frontmatter with `code_anchors` and stale-note detection.
- Fixed checks (Tier 0) promoted from patterns.
- Choice records (context, rejected, chosen, why) as few-shot examples, later
  as training data.
- Four-way search in one SQLite file, merged by rank fusion.
- Resource guard with on-demand model loading and hash-based re-indexing.
- Audience tags and scoped MCP access.
- Shadow mode, past-PR replay and measured release gates.

Changed or dropped:

- **Support helper querying Guard live: dropped.** Aura is installed at
  fabricators; they must not depend on a machine in SPIL's office. Guard drafts
  support docs, people review them, Aura ships them.
- **"Cryptographically enforced" scopes: simplified** to separate scopes and
  tokens.
- **Reversible masking (put real names back): moved later.** Block and mask
  first.
- **Gates on the model's own confidence score: dropped.** Gates use measured
  precision and recall.
- **Specific numbers** (cost savings, RAM and VRAM figures): treated as targets
  to measure, not facts. Model names to be chosen at build time.
- **Six layers in two weeks: too much.** Built in phases; each layer arrives
  when needed.

## Crow

The owner pointed to two different projects called Crow.

- **Crow CI** (docs.crowci.com): a CI system with a server and worker agents,
  `.crow.yaml` pipelines, Docker/Kubernetes/Hyper-V/local backends, Windows
  support and shared per-machine memory budgets. It looks like a Woodpecker
  fork; Azure DevOps support was not seen and must be checked.
  **Use:** a possible runner for heavy Guard jobs on a self-run office machine.
  Azure Pipelines is first choice because the repos already live in Azure
  DevOps.
- **Crow ADE / crow-cli** (crow-ai.dev): an MIT-licensed coding agent and editor
  using the Agent Client Protocol (ACP), with live tool-call display,
  cancellation, delegation and a versioned skills catalog. The agent has the
  same system access as the user and installs by `curl | bash`.
  **Use:** add ACP as a planned interface so Guard's roles work from ACP
  editors; borrow the skills catalog and live tool-call view as ideas. Do not
  run Guard's roles inside an all-access agent.

## Still open

1. Language: TypeScript first (recommended) or Rust from day one.
2. Where it runs: this PC first (recommended), office machine later.
3. Paid model: Guard's own client (recommended) or Aura's provider layer.
4. Repos on day one: Aura and ERP-MCP (recommended).
5. Rename the folder to `aura-guard` and create the Azure DevOps remote?
