# Refactor: Shell Command → Full Shell Execution with HITL

## Core Design Change

Replace the current restricted `propose_run_command` (single executable + args, no shell operators) with a new `propose_shell` tool that accepts a full shell command string. Execution happens via `sh -c "..."` (macOS/Linux) or `powershell -Command "..."` (Windows) after human approval.

Safety model shifts from "restrict what LLM can express" to "let human see and approve the full command".

## Tools After Refactoring

### Removed Tools
- `propose_run_command` — replaced by `propose_shell`
- `propose_file_edit` — replaced by `propose_shell` (LLM can just write `cat > file` or use `propose_apply_patch`)
  - **Wait**: `propose_file_edit` generates deterministic patches with preflight validation. This is still valuable for structured edits where the LLM knows exactly what to change. Keep it.

### Final Tool Set
| Tool | Purpose | Keep/Remove |
|------|---------|-------------|
| `list_files` | Read-only directory listing | Keep |
| `read_file` | Read-only file content | Keep |
| `git_status` | Read-only git status | Keep |
| `git_diff` | Read-only git diff | Keep |
| `propose_apply_patch` | Propose unified diff patch | Keep |
| `propose_file_edit` | Propose structured file edit | Keep |
| `propose_shell` | **NEW** — Propose full shell command | Add |
| `propose_run_command` | Restricted single-executable command | **Remove** |
| `propose_git_write` | Propose git stage/commit/checkout | **Remove** (subsumed by `propose_shell`: `git add .`, `git commit -m "..."`) |

## Changes by File

### 1. `src/orchestrator/types.ts`
- Rename `SensitiveActionType`: replace `"run_command"` with `"shell"`, remove `"git_write"`
- Replace `RunCommandPayload` with `ShellPayload { shell: string; timeoutMs: number }`
- Remove `GitWritePayload`
- Replace `RunCommandActionProposal` with `ShellActionProposal`
- Remove `GitWriteActionProposal`
- Update `ActionProposal` union type

### 2. `src/orchestrator/planningService.ts`
- **TOOL_DEFINITIONS**: Remove `propose_run_command` and `propose_git_write`. Add `propose_shell` with params: `{ shell: string, timeout_ms?: number, description?: string }`
- **ASSISTANT_SYSTEM_PROMPT**: Simplify — remove all the shell operator restriction rules. Add: "Use propose_shell for any command execution (build, test, delete, git, etc.). The command will be shown to the user for approval before execution."
- **Tool routing**: Simplify — remove command/git-specific routing. Any write/command/git intent → expose `propose_shell` + `propose_file_edit` + `propose_apply_patch`
- **executeToolCall**: Remove `propose_run_command` and `propose_git_write` handlers. Add `propose_shell` handler that creates a `ShellActionProposal`. Only pre-validate: non-empty command, timeout range. No shell operator blocking.
- **Remove**: `getCommandPatchPolicyViolation` import and usage
- **Remove**: delete hint repair rounds for `propose_run_command` (no longer needed)
- **Simplify**: `validateProposedAction` — remove git intent check, simplify run_command to shell

### 3. `src/orchestrator/commandPayload.ts`
- Remove `getCommandPatchPolicyViolation` and all its helper functions (shell operator checks, blocked executables, etc.)
- Remove `ParsedCommandPayload`, `parseCommandPayload`, `normalizeCommandArgs`, `tokenizeCommandText` — no longer needed since we pass raw shell strings
- Keep `formatCommandPayload` temporarily for backward compat during migration, or remove if no longer referenced
- Actually: check all consumers. If `planGuards.ts` and `hitlService.ts` still need parsing for persisted old plans, keep the parsing functions but remove the guardrail validation.

### 4. `src-tauri/src/main.rs`
- Add new Tauri command `run_shell_command`:
  ```rust
  fn run_shell_command(
      workspace_path: String,
      shell: String,
      timeout_ms: Option<u64>,
  ) -> Result<CommandExecutionResult, String>
  ```
  - Validates workspace path
  - Executes via `sh -c "<shell>"` on Unix, `powershell -Command "<shell>"` on Windows
  - Only hard-blocks catastrophic commands: `rm -rf /`, `mkfs`, `shutdown`, `reboot`, fork bomb
  - Same timeout/stdout/stderr capture as current `run_workspace_command`
- Keep `run_workspace_command` for backward compat with old persisted plans (or remove if we migrate)
- Remove `validate_command_guardrails`, `validate_command_token`, `command_basename` — no longer needed
- Remove blocked executables list, shell operator checks, interpreter inline eval checks

### 5. `src/orchestrator/hitlService.ts`
- Replace `run_command` handler with `shell` handler:
  - Invoke `run_shell_command` instead of `run_workspace_command`
  - Pass `action.payload.shell` directly
  - Remove `getCommandPatchPolicyViolation` pre-check (no longer needed)
- Remove `git_write` handler (git commands go through `propose_shell` now)
- Remove imports: `getCommandPatchPolicyViolation`, `parseCommandPayload`, `normalizeCommandArgs`
- Keep `formatCommandPayload` import only if still used elsewhere

### 6. `src/ui/pages/ChatPage.tsx`
- Update `ActionPayloadFields` component:
  - Replace `run_command` rendering with `shell` rendering: display `action.payload.shell` directly
  - Remove `git_write` rendering
  - Remove `formatCommandPayload` import (display raw shell string instead)
- Update `buildActionSummaryText` if it references action types

### 7. `src/orchestrator/planGuards.ts`
- Update `normalizeAction` to handle `"shell"` type instead of `"run_command"`
- Remove `"git_write"` normalization
- Remove `parseCommandPayload`/`normalizeCommandArgs` imports if no longer needed
- Add backward compat: if persisted plan has `type: "run_command"`, convert to `"shell"` by joining command + args

### 8. `src/orchestrator/checkpointStore.ts`
- Update `run_command` redaction to `shell` redaction
- Remove `git_write` specific handling (or keep generic)

### 9. `src/orchestrator/actionInference.ts`
- Replace `run_command` action inference with `shell` type
- Remove `git_write` action inference (or convert to `shell` with `git ...` command)
- Simplify: any command/git intent → propose shell action

### 10. `src/agents/defaultAgents.ts`
- Replace `"propose_run_command"` with `"propose_shell"` in agent tool lists
- Replace `"propose_git_write"` with `"propose_shell"`

## Migration Strategy
- Old persisted plans with `type: "run_command"` → `planGuards.ts` converts to `shell` by joining `command + args`
- Old persisted plans with `type: "git_write"` → convert to `shell` with equivalent git command
- Keep `run_workspace_command` Rust command temporarily, remove in next release

## What We're NOT Changing
- `propose_apply_patch` — still valuable for structured patch review
- `propose_file_edit` — still valuable for deterministic edits with preflight validation
- Read-only tools (`list_files`, `read_file`, `git_status`, `git_diff`) — unchanged
- HITL approval flow — unchanged, just displaying shell command instead of command+args
