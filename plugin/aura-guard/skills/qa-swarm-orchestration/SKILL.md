---
name: qa-swarm-orchestration
description: Coordinate parallel REO specialist agents (@qa, @a11y, @perf, @release, @architect, @triage, @security) with live chat-in steering (stop, skip, @agent).
---

# QA: Parallel Agent Swarm Orchestration

1. Route prompts across REO's 12 specialist agents (and any active custom agents) using regex + learned routing weights.
2. Execute up to 3 specialist agents concurrently (`MAX_PARALLEL_AGENTS = 3`), streaming live `agent`, `tool`, `chat`, `defect`, and `verdict` events into the conversation card.
3. Steer an active running swarm directly from chat without interrupting Q&A:
   - `stop` / `abort`: halts queued steps safely.
   - `skip <agent>`: skips the named specialist step.
   - `@<agent>`: adds another specialist agent into the live execution queue.
4. Keep every active agent bounded by its profile `maxTimeSeconds` timeout and strict risk tier.
