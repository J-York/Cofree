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
│   ├── src/agents/          — ChatAgent roles, prompt assembly, tool policy
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
| `src/agents/builtinChatAgents.ts` | Built-in agent roles (engineer, reviewer, architect, QA, expert concierge) |
| `src/agents/resolveAgentRuntime.ts` | Runtime agent resolution and task delegation |
| `src/lib/settingsStore.ts` | Settings persistence (localStorage + secure key storage via Rust) |
| `src/lib/sessionContext.ts` | Workflow state (planning, executing, human_review, done, error) |

## Tool Set & Permissions

| Tool | Default | Purpose |
|------|---------|---------|
| `list_files`, `read_file`, `grep`, `glob`, `git_status`, `git_diff`, `diagnostics` | `auto` | Read-only workspace ops |
| `propose_file_edit`, `propose_apply_patch`, `propose_shell`, `fetch` | `ask` | Write/external ops requiring approval |
| `task` | delegate | Sub-agent delegation (planner, coder, tester) |

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
- **2 known test failures** in `planningService.test.ts` (approval-flow fingerprint blocking).
- **Vite port**: Strict port 1420.
- **Workspace config**: `.cofreerc` / `.cofreerc.json` in workspace root customizes system prompts, ignore patterns, tool permissions, and workspace refresh behavior.

## Documentation Index

| Document | Content |
|----------|---------|
| `docs/INDEX.md` | Documentation overview |
| `docs/PRD.md` | Product requirements |
| `docs/ARCHITECTURE.md` | Technical architecture |
| `docs/GUARDRAILS.md` | Approval gates, tool permissions, path boundaries |
| `docs/SECURITY_PRIVACY.md` | Data egress boundaries, API key storage |
| `docs/BUILD.md` | Build and release |
