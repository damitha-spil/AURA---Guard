---
name: qe-self-learning
description: Continuous self-learning loop for routing weights, tool reliability telemetry, user correction lessons, and autonomous REO asset creation.
---

# QE: REO Continuous Self-Learning Loop

1. After every mission completes, REO records keyword-to-agent weights (`learning.json`), tool run counts/errors/avg latency, and repeated multi-agent/tool execution patterns.
2. User thumbs-up/down feedback adjusts keyword routing weights immediately (`+0.5` / `-0.75` clamped `0..3`), while user corrections mentioning rule language become `hypothesis` lessons and promote to verified `procedural` memory on confirmation (`confirmations >= 2` or positive feedback).
3. When repeated patterns succeed `>= 3` times, `maybeSelfCreate` synthesizes a `status: active` composite tool, combined custom agent, or generated skill in `cfg.dataDir` tagged `createdBy: "reo"` (capped at `MAX_SELF_CREATED = 20`).
4. Review, inspect, delete individual lessons, or reset learned state any time from **QA Harness -> Self-Learning** or disable/delete generated items in **Agents**.
