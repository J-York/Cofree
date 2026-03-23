# Expert Team YOLO Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为当前工作区引入专家团专属的 YOLO / 审批双模式，在首次遇到专家团敏感动作时一次性提醒用户，并让 `team_yolo` 通过现有审批执行路径自动执行团队动作。

**Architecture:** 新增一个独立的工作区级信任存储，和现有 `approvalRuleStore` 分离；用纯函数解析 `team_stage` 动作来源并判断是否命中专家团 YOLO 作用域；在 `ChatPage` 中以“首次提醒 -> 记忆选择 -> 复用 approveAction/approveAllPendingActions 自动执行”的方式接线，同时在设置页暴露当前工作区的切换入口。

**Tech Stack:** React 19、TypeScript、Vitest、Tauri localStorage 持久化、现有 HITL / orchestration helpers

---

### Task 1: Workspace Team Trust Store And Pure Team Classification

**Files:**
- Create: `src/lib/workspaceTeamTrustStore.ts`
- Test: `src/lib/workspaceTeamTrustStore.test.ts`
- Create: `src/ui/pages/chat/teamTrust.ts`
- Test: `src/ui/pages/chat/teamTrust.test.ts`
- Reference: `src/lib/workspaceStorage.ts`, `src/lib/approvalRuleStore.ts`, `src/orchestrator/types.ts`

- [ ] **Step 1: Write failing storage tests**

Add tests that prove:
- empty workspace returns no trust mode
- `team_yolo` persists and reloads
- `team_manual` persists and reloads
- different workspaces stay isolated
- clearing a workspace record resets back to unset
- persisted records include `decidedAt`

Run: `pnpm test -- src/lib/workspaceTeamTrustStore.test.ts`
Expected: FAIL because the store does not exist yet.

- [ ] **Step 2: Implement the minimal trust store**

Add:
- `WorkspaceTeamTrustMode = "team_yolo" | "team_manual"`
- `WorkspaceTeamTrustRecord`
- `getWorkspaceTeamTrustStorageKey(workspacePath)`
- `loadWorkspaceTeamTrustMode(workspacePath)`
- `saveWorkspaceTeamTrustMode(workspacePath, mode)`
- `clearWorkspaceTeamTrustMode(workspacePath)`

Implementation notes:
- use `workspaceHash()` for the namespace
- no-op when browser storage is unavailable
- normalize empty workspace paths to “unset”
- store and preserve `decidedAt` for audit/debug visibility

- [ ] **Step 3: Run storage tests to green**

Run: `pnpm test -- src/lib/workspaceTeamTrustStore.test.ts`
Expected: PASS.

- [ ] **Step 4: Write failing pure team-trust decision tests**

Add tests that prove:
- `team_stage` + `originDetail: "team-expert-panel-v2 / 代码实现"` resolves to expert-team-owned
- missing / malformed `originDetail` falls back to non-team
- non-`team-*` ids do not opt into YOLO
- only approval-required expert-team action types enter the YOLO scope
- existing `team_yolo` skips prompt
- existing `team_manual` skips prompt
- no trust record + team-owned pending action requests a first-run prompt
- mixed pending lists only return team-owned pending action ids for auto-execution

Run: `pnpm test -- src/ui/pages/chat/teamTrust.test.ts`
Expected: FAIL because the helper does not exist yet.

- [ ] **Step 5: Implement the minimal pure helper layer**

Add pure helpers for:
- parsing team id from `originDetail`
- checking whether an action is expert-team-owned
- deciding `prompt_first_run | manual | yolo | disabled_no_workspace`
- collecting only team-owned pending action ids from a plan
- deriving a settings label such as `未设置（首次使用时询问）`

Keep all UI-free logic here so `ChatPage` and `SettingsPage` stay thin.

- [ ] **Step 6: Run helper tests to green**

Run: `pnpm test -- src/ui/pages/chat/teamTrust.test.ts`
Expected: PASS.

### Task 2: First-Run Reminder Flow In ChatPage

**Files:**
- Modify: `src/ui/pages/ChatPage.tsx`
- Create: `src/ui/pages/chat/WorkspaceTeamTrustDialog.tsx`
- Test: `src/ui/pages/chat/WorkspaceTeamTrustDialog.test.tsx`
- Reference: `src/ui/pages/chat/approvalGuard.ts`, `src/ui/pages/chat/checkpointRecovery.ts`

- [ ] **Step 1: Write failing reminder dialog tests**

Add tests that prove:
- the first-run dialog renders the approved copy
- it exposes only the two persistent choices
- there is no implicit dismiss action
- `YOLO` and `审批` button callbacks fire with the expected mode

Run: `pnpm test -- src/ui/pages/chat/WorkspaceTeamTrustDialog.test.tsx`
Expected: FAIL because the dialog component does not exist yet.

- [ ] **Step 2: Implement the minimal reminder dialog**

Build a focused component for:
- title `当前工作区首次使用专家团`
- body explaining expert-team-only auto-execution scope
- buttons `启用该工作区专家团 YOLO` and `继续使用审批模式`

Do not add backdrop or Escape-dismiss behavior into this component contract.

- [ ] **Step 3: Run dialog tests to green**

Run: `pnpm test -- src/ui/pages/chat/WorkspaceTeamTrustDialog.test.tsx`
Expected: PASS.

- [ ] **Step 4: Write failing ChatPage first-run flow tests or helper-driven regression tests**

Cover the first-run orchestration boundary:
- only one in-flight reminder is created per workspace
- team actions wait for a choice instead of immediately showing approval cards in the unset case
- non-team actions do not trigger the reminder
- no-workspace mode stays on the existing manual path
- checkpoint restore does not create duplicate reminders for the same workspace
- a restored conversation does not turn already auto-executed team actions back into manual approval stops

Prefer extracting any tricky state transitions into a pure helper rather than forcing a brittle giant component test.

Run: `pnpm test -- src/ui/pages/chat/teamTrust.test.ts`
Expected: FAIL on the new reminder-state cases.

- [ ] **Step 5: Wire ChatPage to the reminder flow**

Add state and callbacks that:
- inspect pending actions with the new helper
- open a single first-run dialog when the current workspace is unset
- persist `team_yolo` / `team_manual` immediately when the user chooses
- resume handling only for actions proposed after the choice
- keep existing ask_user / approval guard behavior intact
- keep reminder orchestration ahead of approval-card rendering so the guard does not race the first-run prompt
- dedupe against checkpoint/session restore so a pending reminder is not recreated on resume

- [ ] **Step 6: Run targeted tests to green**

Run: `pnpm test -- src/ui/pages/chat/teamTrust.test.ts src/ui/pages/chat/WorkspaceTeamTrustDialog.test.tsx`
Expected: PASS.

### Task 3: Expert-Team YOLO Auto-Execution Through Existing HITL Helpers

**Files:**
- Modify: `src/ui/pages/ChatPage.tsx`
- Test: `src/ui/pages/chat/teamTrust.test.ts`
- Reference: `src/orchestrator/hitlService.ts`, `src/ui/pages/chat/execution.ts`

- [ ] **Step 1: Write failing auto-execution regression tests**

Cover:
- `team_yolo` auto-executes a single team-owned action through the existing approve path
- `team_manual` leaves team-owned actions pending for manual approval
- non-team actions remain unchanged even when workspace mode is `team_yolo`
- mixed pending lists only auto-approve the team-owned subset
- pre-existing workspace approval rules still matter only in `team_manual`
- pre-existing approval rules do not broaden `team_yolo` into non-team actions
- team-owned YOLO actions do not present misleading “pending approval” UI after auto-start

Run: `pnpm test -- src/ui/pages/chat/teamTrust.test.ts`
Expected: FAIL because `ChatPage` has not been wired to apply these decisions.

- [ ] **Step 2: Implement minimal YOLO execution wiring**

In `ChatPage`:
- route team-owned actions through the pure trust decision helper
- for a single team-owned pending action, call the same path as `handleApproveAction()`
- for multiple team-owned pending actions, only batch the filtered team-owned set
- annotate approval context with a distinct source such as `workspace_team_yolo`
- keep restore-time validation, failure states, shell queueing, and continuation logic unchanged
- keep the YOLO scope limited to the current approval-required expert-team action set (`shell`, `file`, `apply_patch`) unless the helper is intentionally expanded

- [ ] **Step 3: Run regression tests to green**

Run: `pnpm test -- src/ui/pages/chat/teamTrust.test.ts`
Expected: PASS.

### Task 4: Workspace Settings Entry And Final Verification

**Files:**
- Modify: `src/ui/pages/SettingsPage.tsx`
- Test: `src/ui/pages/SettingsPage.test.ts`
- Modify: `src/ui/pages/ChatPage.tsx`
- Reference: `src/lib/settingsStore.ts`, `src/lib/workspaceTeamTrustStore.ts`, `docs/superpowers/specs/2026-03-23-expert-team-yolo-mode-design.md`

- [ ] **Step 1: Write failing settings tests**

Add tests that prove:
- current workspace with no decision shows `未设置（首次使用时询问）`
- current workspace with `team_yolo` shows `YOLO`
- current workspace with `team_manual` shows `审批`
- no-workspace state is disabled with an explanatory hint
- setting `YOLO` or `审批` before the first expert-team run suppresses the later first-run dialog

Run: `pnpm test -- src/ui/pages/SettingsPage.test.ts`
Expected: FAIL because the new setting is not rendered yet.

- [ ] **Step 2: Implement the settings control**

Add a workspace-scoped settings card that:
- reads the current workspace trust mode
- allows switching between `YOLO` and `审批`
- allows an unset state before first use when a workspace exists
- disables itself when there is no workspace path

Make sure changes affect only future actions and do not silently auto-run already-rendered pending cards.

- [ ] **Step 2.5: Re-run the ChatPage reminder/decision tests after settings wiring**

Run: `pnpm test -- src/ui/pages/chat/teamTrust.test.ts`
Expected: PASS, including the “Settings 预选抑制首次提醒” cases.

- [ ] **Step 3: Run focused UI tests to green**

Run: `pnpm test -- src/ui/pages/SettingsPage.test.ts`
Expected: PASS.

- [ ] **Step 4: Run full verification for touched files**

Run:
- `pnpm test -- src/lib/workspaceTeamTrustStore.test.ts src/ui/pages/chat/teamTrust.test.ts src/ui/pages/chat/WorkspaceTeamTrustDialog.test.tsx src/ui/pages/SettingsPage.test.ts`
- `pnpm build`

Expected:
- new targeted tests PASS
- type-check/build succeeds, or only pre-existing known failures remain and are documented

- [ ] **Step 5: Review and document any residual risk**

Before closing:
- confirm no normal single-agent flow opted into YOLO
- confirm no-workspace flow still requires manual approval
- note any missing full-component integration coverage if targeted helper tests were used instead
- confirm checkpoint restore cannot duplicate the reminder or regress auto-started team actions into manual pending state
