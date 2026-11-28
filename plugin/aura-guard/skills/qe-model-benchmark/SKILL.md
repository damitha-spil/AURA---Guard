---
name: qe-model-benchmark
description: Benchmark configured LLM providers side-by-side in Evaluation Lab (Promptfoo pattern) on QA prompts for accuracy, grounding, secret safety, and latency.
---

# QE: Multi-Model Evaluation Lab Benchmark

1. Formulate a representative QA/review prompt and list expected domain keywords in **QA Harness -> Evaluation Lab** (`/api/reo/benchmarks/run`).
2. Compare configured providers (`antigravity-cli`, `claude-cli`, `opencode-cli`) cleanly — outgoing prompts always pass `maskOutgoing`.
3. Inspect side-by-side `citationScore`, `secretSafetyPass`, `completenessScore`, `overallScore`, `latencyMs`, and estimated cost.
4. Use benchmark results to tune agent `modelOverride` settings in **Agent Team** rather than guessing model quality.
