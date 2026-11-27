# SPIL AURA QA Bot

SPIL AURA QA Bot is SPIL's internal engineering assistant. It learns what Aura is,
how the owner builds it, and how features are added day to day. Later it acts
as a code reviewer, a QA planner and a source of support knowledge.

It is **not** part of the Aura product that fabricators install. It reads
Aura's repositories and suggests; people decide and commit.

It is built for one project: SPIL Aura.

## Documents

| File | What it holds |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The design: parts, data, rules, safety |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | What to build, in what order, and how we prove each step |
| [THINKING.md](THINKING.md) | The brainstorm: ideas we kept, changed or dropped, and why |
| [AI_HANDOFF.md](AI_HANDOFF.md) | Current state for the next person or assistant |
| [CHANGES.md](CHANGES.md) | Log of changes to this repository |

## Status

Working engine, chat window, reviewer, QA planner and Claude Code plugin, all
read-only and advisory. About 65% of the plan is built; much less is proven
(the reviewer has no measured bug-finding yet). See [STATUS.md](STATUS.md) for
the full picture.

## Quick start

```
npm install
npm run guard -- index          # read the vault and repos (about 5 s)
npm run desktop                 # launch the native Tauri 2 desktop app
npm run ui                      # fallback: open in Edge/Chrome --app mode
npm run guard -- help           # every command
```

### Run as Native Desktop App (Tauri 2)

SPIL REO ships with a lightweight **Tauri 2** (`src-tauri/`) native desktop shell:

```
npm run desktop                 # dev mode: spawns the Node engine + opens native WebView2 window
npm run desktop:build           # builds a standalone Windows installer/executable
```

**Prerequisites:** Node.js 26+, Rust (`cargo`), and Tauri CLI 2 (`cargo install tauri-cli` or `npm i -D @tauri-apps/cli`).

### Tech Stack & Architecture

| Layer | Technology | Role |
|---|---|---|
| Desktop Shell | **Tauri 2** (Rust + WebView2) | Native window, process lifecycle, hidden Node sidecar |
| Core Engine | **Node.js 26 + TypeScript** (`--experimental-strip-types`) | Zero-build QA, QE, DevSecOps, MCP server, HTTP/SSE server |
| Knowledge & Memory | **SQLite (`node:sqlite` FTS5)** + Obsidian Vault + `graphify` (Python) | Full-text search, AST code graph, blast radius |
| Control Room UI | **Vanilla JS + HTML + CSS** (CSP-strict, zero-build) | 4-zone IDE workstation, live telemetry, triage |
| UI & Desktop Drivers | **Windows UIA** (`win-uia-crawler.ps1`), `cua-driver`, **Playwright CDP** | Background/live desktop & web automation |

## Developer activity capture (VS Code)

An opt-in VS Code extension records masked activity locally and drafts reviewable ai-log
entries. See [docs/vscode-extension.md](docs/vscode-extension.md) and
[docs/capture-privacy.md](docs/capture-privacy.md). Introduce it to the team before rolling out.

## Names

The platform name is **SPIL REO** (*Review · Evaluate · Optimize — Autonomous Engineering Intelligence, Powered by SPIL Labs*). The CLI command is still `aura-guard`, and the
plugin and extension ids still start with `aura-guard`, so existing setups keep working.

## Use it from Claude Code (plugin)

This repo is a Claude Code plugin marketplace (`spil-aura-tools`) with one
plugin, `aura-guard`. It gives Claude Code:

- the `aura-guard` MCP server (read-only): `search_knowledge`, `get_doc`,
  `trace_history`, `co_changed`, `get_blast_radius`, `list_rules`,
  `stale_notes`
- skills: `ask-guard` (consult Guard before changing code) and `ai-log`
  (write the repo's AI activity log)
- a commit hook that adds an entry to `ai-log/` after every `git commit` in
  repos that have `ai-log/README.md`

Setup, once per developer:

1. Clone this repo, then in it: `npm install` and `npm run guard -- index`.
2. Aura's `.claude/settings.json` already lists the marketplace and enables
   the plugin. Open Aura in Claude Code, accept the folder trust prompt, then:
   `claude plugin install aura-guard@spil-aura-tools --scope project`
   (or `/plugin install aura-guard --marketplace damitha-spil/AURA---Guard`).
3. Set your Guard folder: `claude plugin configure aura-guard@spil-aura-tools`
   (`guard_home`), then restart Claude Code.

You need read access to this GitHub repo with working git credentials (SSH
agent or `gh auth setup-git`). Check with `claude plugin validate . --strict`.
