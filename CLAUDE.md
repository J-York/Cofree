# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cofree is a **local-first AI programming assistant** built as a Tauri 2 desktop app. React 19 + TypeScript frontend, Rust backend. AI reads code, generates patches, and runs commands — all executed locally with human-in-the-loop (HITL) approval gates.

## Key Commands

```bash
pnpm install              # Install dependencies
pnpm dev                  # Vite dev server (port 1420, standalone browser UI)
pnpm tauri:dev            # Full Tauri desktop app (Vite + native window)
pnpm test                 # Run Vitest tests (jsdom env, no external services)
pnpm test -- --run <path>            # Run a single test file
pnpm test -- --run -t "<name>"       # Run tests matching a name
pnpm build                # Type-check + production build (tsc && vite build)

cd src-tauri && cargo check  # Rust type-check
```

## Architecture

```
Tauri Desktop App
├── React + TypeScript (frontend)
│   ├── src/App.tsx          — Root: settings, session context, layout, shortcuts
│   ├── src/ui/pages/        — Page components (ChatPage, SettingsPage, etc.)
│   ├── src/orchestrator/    — Tool loop, HITL gating, planning, checkpoint recovery
│   ├── src/agents/          — Agent role definition, prompt assembly, tool policy
│   ├── src/lib/             — Settings store, concurrency, audit log, etc.
│   └── src/hooks/           — Theme, updater error handling
│
└── Rust backend (src-tauri/src/)
    ├── main.rs              — Tauri entry, plugin setup, command registration
    ├── commands/            — Tauri invoke handlers (workspace, patch, shell, etc.)
    ├── application/         — Business logic layer
    ├── domain/              — Core domain models
    ├── infrastructure/      — Persistence, HTTP, file I/O
    ├── config.rs            — App configuration
    └── secure_store.rs      — Encrypted API key storage
```

## Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `src/orchestrator/planningService.ts` | Core orchestration — assembles prompts, manages tool call loop, HITL gating, checkpoint recovery |
| `src/orchestrator/hitlService.ts` | Human-in-the-loop approval flow for patches and shell commands |
| `src/orchestrator/toolExecutor.ts` | Tool execution engine |
| `src/agents/builtinChatAgents.ts` | Built-in agent role (general-purpose); user-defined agents can be added via settings |
| `src/agents/resolveAgentRuntime.ts` | Runtime agent resolution (system prompt, tool policy, model binding) |
| `src/lib/piAiBridge.ts` | LLM gateway adapter — routes OpenAI/Anthropic requests through `@mariozechner/pi-ai`, proxied via Rust in Tauri |
| `src/lib/skillStore.ts` | Skill discovery/registry (global + workspace); skills are context-aware capability extensions selectable via `@`-mention |
| `src/lib/settingsStore.ts` | Settings persistence (localStorage + secure key storage via Rust) |
| `src/lib/sessionContext.ts` | Workflow state (planning, executing, human_review, done, error) |

## Tool Set & Permissions

| Tool | Default | Purpose |
|------|---------|---------|
| `list_files`, `read_file`, `grep`, `glob`, `git_status`, `git_diff`, `diagnostics`, `check_shell_job` | `auto` | Read-only / polling workspace ops |
| `propose_file_edit`, `propose_apply_patch`, `propose_shell`, `fetch` | `ask` | Write/external ops requiring approval |
| `update_plan`, `ask_user` | internal | Always-available internal tools (TODO plan maintenance, pause-and-ask) |

## Data Storage

- **localStorage**: Settings, session metadata, audit logs (namespaced by workspace hash)
- **`~/.cofree/checkpoints.db`**: SQLite checkpoint persistence
- **`~/.cofree/snapshots/`**: File snapshots for patch rollback
- **`~/.cofree/keystore.key` / `keystore.json`**: Encrypted API key storage

## Workflow Stages

`idle` → `planning` → `executing` → `human_review` → `done` / `error`

## Non-obvious Caveats

- **Rust toolchain**: Dependencies require Rust >= 1.85. `rustup default stable` if the system version is too old.
- **Tauri APIs in browser**: `pnpm dev` in a browser will log `__TAURI__` errors — expected since IPC is unavailable outside the desktop shell.
- **Vite port**: Strict port 1420.
- **Workspace config**: `.cofreerc` / `.cofreerc.json` in workspace root customizes system prompts, ignore patterns, tool permissions, and workspace refresh behavior.
- **Model requests**: All LLM calls funnel through `src/lib/piAiBridge.ts` (pi-ai gateway). In Tauri, HTTP is proxied through Rust so system proxy settings apply; in the browser `pnpm dev`, requests go direct and may hit CORS.
- **Skills**: Global skills live under `~/.cofree/skills/`, workspace skills under `<workspace>/.cofree/skills/`. Users can `@`-mention a skill to force explicit selection (bypasses keyword auto-matching in `resolveMatchedSkills`).

## Documentation Index

| Document | Content |
|----------|---------|
| `docs/PRD.md` | Product requirements |
| `docs/ARCHITECTURE.md` | Technical architecture |
| `docs/BUILD.md` | Build and release |
