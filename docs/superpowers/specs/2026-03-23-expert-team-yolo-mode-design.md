# Expert Team YOLO Mode Design

## Summary

Add a workspace-scoped trust mode for expert teams so that `team-*` actions can run in YOLO mode without per-action approval after a one-time reminder in each workspace.

This mode must:

- apply only to expert-team execution paths
- remember the user's choice per workspace
- support both `team_yolo` and `team_manual`
- leave normal single-agent chats unchanged
- remain reversible from Settings

## Goals

- Remove repeated approval friction when users intentionally use expert teams.
- Keep the trust decision local to a workspace.
- Preserve existing execution, status, retry, and continuation behavior.
- Avoid leaking auto-execution into non-team flows.

## Non-Goals

- Changing the global `toolPermissions` model.
- Replacing existing approval-rule storage.
- Making all agents in a workspace fully YOLO by default.
- Removing runtime visibility into shell/file actions and failures.

## User Experience

### First-time reminder

When the current workspace first reaches an expert-team action that would normally require approval, show a one-time reminder dialog:

- Title: `当前工作区首次使用专家团`
- Body: explain that expert-team YOLO mode will auto-execute expert-team shell and file actions in this workspace without per-action approval, while normal single-agent flows remain unchanged.
- Actions:
  - `启用该工作区专家团 YOLO`
  - `继续使用审批模式`

Both choices are remembered, so the user is not asked again in that workspace unless they later change the setting.

The reminder must be an explicit decision point:

- no backdrop-dismiss
- no Escape-to-close shortcut
- no implicit "ask me later" branch

If multiple expert-team actions arrive while the reminder is unresolved, the UI must keep a single in-flight reminder for that workspace and delay further team-action handling until the user chooses one of the two persistent options.

### After the choice

- `team_yolo`
  - expert-team `propose_shell`, `propose_file_edit`, and `propose_apply_patch` no longer stop on approval cards
  - they auto-enter the existing approval execution path
  - execution progress, background-job state, errors, and retries remain visible
- `team_manual`
  - current approval-card behavior remains unchanged for expert teams

### Settings

Add a workspace-scoped Settings control:

- `专家团执行模式`
  - `YOLO`
  - `审批`
  - if the workspace has not yet made a choice, show `未设置（首次使用时询问）`

This gives users a reversible way to change the remembered choice for the current workspace.

## Architecture

### New storage

Add a dedicated store, e.g. `src/lib/workspaceTeamTrustStore.ts`, separate from:

- `settingsStore`
- `approvalRuleStore`

Reasoning:

- this is not a global app preference
- this is not a command/path approval rule
- the semantics are simpler if stored as one explicit workspace trust state

Suggested persisted shape:

```ts
type WorkspaceTeamTrustMode = "team_yolo" | "team_manual";

interface WorkspaceTeamTrustRecord {
  workspaceHash: string;
  mode: WorkspaceTeamTrustMode;
  decidedAt: string;
}
```

Use the same workspace-hash strategy already used by workspace-scoped local stores.

### Decision boundary

The trust check must only apply to expert-team actions.

Recommended rule:

- determine team ownership from action metadata, not UI copy or label text
- current implementation should key off `action.origin === "team_stage"`
- and use `action.originDetail` as the canonical team identifier source populated by `planningService`
- parse `originDetail` with an explicit rule:
  - if it contains `" / "`, treat the substring before the first separator as the team id
  - otherwise, treat the full trimmed string as the team id
- if future code introduces an explicit `teamId` on actions, prefer that field over parsing `originDetail`
- if `originDetail` is missing, empty, or cannot be parsed into a stable team id, treat the action as non-team for trust purposes and keep the existing manual approval path
- only if the resolved team id starts with `team-`, evaluate workspace expert-team trust
- otherwise, keep the existing approval flow

This prevents normal chats or non-team agents from inheriting expert-team YOLO behavior.

## Execution Flow

### Manual mode

No change from current behavior:

1. Team action is proposed.
2. Approval card is shown.
3. User approves or rejects.
4. Existing HITL continuation proceeds.

### YOLO mode

Reuse the current HITL execution code instead of introducing a second executor:

1. Team action is proposed.
2. Workspace trust is checked.
3. If trust is `team_yolo`, skip the approval-card stop.
4. Call the existing approval execution helpers directly, but only for the filtered team-owned action set:
   - use `approveAction()` for a single team-owned action
   - use `approveAllPendingActions()` only on a prefiltered set that contains team-owned pending actions and nothing else
   - never bulk-approve a mixed pending list that could contain non-team actions
5. Preserve current continuation, status rendering, background command monitoring, and failure handling.

This keeps one execution path and reduces behavior drift between manual and YOLO modes.

### Priority relative to existing auto-execution paths

The order of evaluation should be explicit:

1. Determine whether the action is expert-team-owned.
2. If not team-owned, use the existing permission/rule flow unchanged.
3. If team-owned and workspace trust is `team_yolo`, auto-execute via the existing approval helpers and annotate execution metadata with a distinct source such as `workspace_team_yolo`.
4. If team-owned and workspace trust is `team_manual`, fall back to the existing approval pipeline, including remembered workspace rules and normal manual approval.

This avoids double-application or confusing interactions between:

- workspace expert-team trust
- existing per-command/per-path approval rules
- global tool permission defaults

For expert-team-owned actions:

- `team_yolo` is the sole approval gate decision
- existing remembered allow-rules must not broaden the scope beyond team-owned actions
- existing rule matches may still be used for audit/debug display if desired, but not as the primary trust source
- restore-time safety checks, stale fingerprint checks, and invalid-pending guards must still run before execution

## UI Integration Notes

### Where to prompt

Do not prompt at workspace selection time.

Prompt lazily at the first expert-team action that would otherwise require approval. This ensures:

- only users who actually reach team execution see the reminder
- the reminder appears with clear context
- normal browsing and planning flows are not interrupted

If the user opens Settings before the first expert-team run in a workspace, the Settings UI should show the unset state and allow preselecting `YOLO` or `审批`. That choice should suppress the first-run reminder later.

If the user changes the setting mid-session:

- the new mode applies only to actions that have not yet been executed
- already-running YOLO actions continue unchanged
- already-rendered manual pending cards are not silently auto-executed by a Settings toggle
- newly proposed expert-team actions follow the updated mode

### Approval UI behavior in YOLO mode

In `team_yolo`:

- do not require the user to click per-action approval buttons
- avoid rendering misleading "pending approval" states for team actions
- keep status output visible after auto-start

### No-workspace behavior

If there is no active workspace, or a stable workspace hash cannot be derived:

- do not read or write expert-team trust state
- do not show the expert-team trust reminder
- keep the existing manual approval path
- show the Settings control as disabled with a clear explanation that the mode is workspace-scoped

## Testing Plan

### Storage tests

Add tests for the new workspace trust store:

- empty workspace has no trust record
- `team_yolo` persists and loads correctly
- `team_manual` persists and loads correctly
- different workspaces do not affect each other

### Reminder decision tests

Add tests for the first-time prompt logic:

- first expert-team action with no record prompts
- existing `team_yolo` does not prompt
- existing `team_manual` does not prompt
- non-team actions do not prompt
- Settings preselection suppresses the first-run reminder
- only one reminder is shown when multiple team actions arrive while the choice is unresolved
- the reminder cannot be dismissed without writing one of the two persistent choices
- malformed or missing `originDetail` falls back to manual approval

### Execution regression tests

Add regression coverage for:

- expert-team actions auto-executing in `team_yolo`
- expert-team actions staying manual in `team_manual`
- non-team actions remaining unchanged regardless of expert-team trust
- mixed pending lists do not cause non-team actions to be auto-approved
- existing remembered workspace approval rules still work in `team_manual`
- existing remembered workspace approval rules do not broaden `team_yolo` beyond team-owned actions
- Settings toggles only affect newly proposed actions, not already-visible pending cards

### Continuation and visibility tests

Verify:

- auto-executed team actions still drive continuation correctly
- background shell actions still surface running/completed status
- failures are still visible and retryable
- checkpoint restore does not reintroduce a manual stop for already auto-executed team actions
- a pending first-run reminder and a restored conversation do not create duplicate reminders
- no-workspace mode cleanly falls back to manual approval without trust-state writes

## Risks

### Risk: scope leak into normal chats

Mitigation:

- gate strictly on expert-team action origin
- avoid reusing global tool permissions

### Risk: hidden auto-execution surprises users

Mitigation:

- one-time explicit reminder per workspace
- reversible current-workspace setting

### Risk: diverging execution behavior

Mitigation:

- reuse current approval execution helpers rather than introducing a second code path

## Recommended Implementation Order

1. Add workspace team trust storage and tests.
2. Add pure decision helpers for trust lookup and first-time prompting.
3. Add the first-time reminder UI flow.
4. Route expert-team approval-required actions through trust evaluation.
5. Auto-execute expert-team actions in `team_yolo` using current approval helpers.
6. Add Settings entry for current-workspace mode switching.
7. Add regression tests for manual vs YOLO behavior.

## Decision

Approved design direction:

- scope: expert teams only
- first-time reminder: one-time per workspace
- both choices remembered
- implementation strategy: dedicated workspace-scoped expert-team trust state
