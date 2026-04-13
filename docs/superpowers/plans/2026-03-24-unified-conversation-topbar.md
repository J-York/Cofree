# Unified Conversation Topbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为所有对话落地一个共享的 `ConversationTopbar`，让单 Agent 与编排对话都能以“进度主导、提醒补充”的方式一眼看懂当前状态，同时保留现有 `InlinePlan`、工具轨迹与阶段总结作为下钻细节。

**Architecture:** 先在编排运行时补齐结构化进度元数据，再在 UI 侧增加一个纯派生层，把 `isStreaming`、`liveToolCalls`、`subAgentStatus`、当前 `plan`、`ask-user`/restore 状态统一映射成 `ConversationTopbarState`。随后新增一个渲染层组件与样式，并在 `ChatPage` 中把顶栏挂到消息流上方，再通过稳定锚点把 badge/CTA 导航回现有细节区域。

**Tech Stack:** React 19、TypeScript、Vitest、`@testing-library/react`（如仓库尚未安装则新增）、现有 `ChatPage` / orchestration runtime、feature-scoped CSS

---

## File Structure

### Runtime progress metadata

- Create: `src/orchestrator/teamProgress.ts`
  - 纯函数，负责把 `team.pipeline` + 当前 stage/group + 已完成阶段结果映射成 UI 需要的结构化进度元数据。
- Test: `src/orchestrator/teamProgress.test.ts`
  - 覆盖顺序 stage、并行 group、完成计数、阻塞场景的元数据计算。
- Modify: `src/orchestrator/types.ts`
  - 扩展 `SubAgentProgressMeta`，让所有 team 事件都能携带 `currentStageIndex`、`totalStages`、`completedStageCount`、`activeParallelCount`。
- Modify: `src/orchestrator/teamExecutor.ts`
  - 在 stage 运行时和 `stage_complete` / `team_checkpoint` 发出时注入结构化元数据。
- Reference: `src/agents/agentTeam.ts`

### UI derivation and rendering

- Create: `src/ui/pages/chat/conversationTopbarState.ts`
  - 纯函数，把聊天运行态聚合成 `ConversationTopbarState`，不解析消息正文。
- Test: `src/ui/pages/chat/conversationTopbarState.test.ts`
  - 覆盖 `idle`、单 Agent、编排中、待审批、阻塞、完成态、注意力优先级与降级规则。
- Create: `src/ui/pages/chat/ConversationTopbar.tsx`
  - 只负责渲染 row 1 / row 2 / row 3、badge、CTA、进度轨道与可访问性 live region。
- Test: `src/ui/pages/chat/ConversationTopbar.test.tsx`
  - 用当前代码库常见的 ReactElement 树断言方式验证显示规则和 action 回调。
- Create: `src/styles/features/chat/topbar.css`
  - 新增顶栏样式，保持 row 1 最强、row 2 次之、row 3 提醒但不喧宾夺主。
- Modify: `src/styles.css`
  - 导入 `topbar.css`。
- Modify: `src/styles/features/chat/bubble.css`
  - 弱化专家阶段总结气泡的概览感，确保它回归“历史记录”层级。
- Modify: `src/styles/features/tools/executions.css`
  - 降低 live tool / tool trace 的主视觉强度，避免继续像主状态条。
- Modify: `src/styles/features/tools/plan.css`
  - 保留 `InlinePlan` 可操作性，但在顶栏出现后降低其“总览”视觉优先级。

### Navigation and transcript integration

- Modify: `package.json`
  - 如仓库尚未安装，则新增 `@testing-library/react` 作为 DOM 级集成测试依赖。
- Create: `src/ui/pages/chat/conversationTopbarNavigation.ts`
  - 纯函数，把 badge/CTA/进度轨道动作映射成语义化目标，例如 `tools`、`parallel`、`approval`、`ask_user`、`blocked_output`、`context`、`progress`。
- Test: `src/ui/pages/chat/conversationTopbarNavigation.test.ts`
  - 覆盖有目标、无目标、审批优先定位第一个 pending action、进度轨道跳转、context 跳转的行为。
- Create: `src/ui/pages/chat/ChatThreadSection.tsx`
  - 从 `ChatPage.tsx` 抽出消息线程区，承载 `ConversationTopbar + transcript`，便于做 DOM 级集成测试。
- Test: `src/ui/pages/chat/ChatThreadSection.test.tsx`
  - 用 Vitest + `@testing-library/react` 覆盖顶栏与线程区的联动、切换与跳转。
- Modify: `src/ui/pages/chat/ChatPresentational.tsx`
  - 给 `LiveToolStatus`、`SubAgentStatusPanel`、`InlinePlan`、pending action 卡增加稳定锚点，并允许 `InlinePlan` 被外部强制展开。
- Modify: `src/ui/pages/ChatPage.tsx`
  - 计算顶栏状态、把状态和 handlers 传给 `ChatThreadSection`，并在点击 badge/CTA 后展开目标面板并滚动到对应锚点。
- Reference: `src/ui/pages/chat/sessionState.ts`
- Reference: `docs/superpowers/specs/2026-03-24-unified-conversation-topbar-design.md`

### Notes on boundaries

- 不新增持久化的 topbar 专属 session state；顶栏状态必须由现有聊天运行态即时派生。
- 不把 `InlinePlan`、工具轨迹、专家阶段总结替换掉；顶栏只做 overview。
- 不在 UI 侧根据“`当前：代码实现 4/6`”这类文案解析进度；只消费结构化字段。

---

### Task 1: Structured Team Progress Metadata

**Files:**
- Create: `src/orchestrator/teamProgress.ts`
- Test: `src/orchestrator/teamProgress.test.ts`
- Modify: `src/orchestrator/types.ts`
- Modify: `src/orchestrator/teamExecutor.ts`
- Reference: `src/agents/agentTeam.ts`
- Reference: `docs/superpowers/specs/2026-03-24-unified-conversation-topbar-design.md`

- [ ] **Step 1: Write the failing progress metadata tests**

Add tests that prove:

- a sequential pipeline reports 1-based `currentStageIndex`
- `totalStages` always equals `team.pipeline.length`
- `completedStageCount` counts `completed` and `skipped`, but not `blocked`
- a parallel stage group reports `activeParallelCount` equal to the group size
- the second stage in a 6-stage pipeline reports `currentStageIndex = 2` and `totalStages = 6`
- an unknown stage label returns no trusted numeric progress metadata

Run: `pnpm test -- src/orchestrator/teamProgress.test.ts`
Expected: FAIL because the helper does not exist yet.

- [ ] **Step 2: Implement the pure progress helper**

Create a focused helper shaped like:

```ts
export interface TeamStageProgressMeta {
  currentStageIndex: number;
  totalStages: number;
  completedStageCount: number;
  activeParallelCount: number;
}

export function buildTeamStageProgressMeta(params: {
  team: AgentTeamDefinition;
  stage: AgentTeamStage;
  activeGroup: AgentTeamStage[];
  stageResults: Map<string, SubAgentResult>;
}): TeamStageProgressMeta | null {
  const rawStageIndex = params.team.pipeline.findIndex(
    (candidate) => candidate.stageLabel === params.stage.stageLabel,
  );

  if (rawStageIndex < 0) {
    return null;
  }

  const completedStageCount = Array.from(params.stageResults.values()).filter(
    (result) => result.status === "completed" || result.status === "skipped",
  ).length;

  return {
    currentStageIndex: rawStageIndex + 1,
    totalStages: params.team.pipeline.length,
    completedStageCount,
    activeParallelCount: params.activeGroup.length,
  };
}
```

Implementation notes:

- keep it UI-free and orchestration-only
- prefer 1-based indices so the UI can render `4/6` directly
- do not guess totals from grouped stages; use the raw pipeline length
- keep the helper deterministic and free of `Date.now()` / side effects
- if the stage is unknown, return `null` and let the caller omit numeric fields so the UI degrades to the non-numeric `正在编排` path

- [ ] **Step 3: Extend event types and annotate team progress events**

Update `src/orchestrator/types.ts` so `SubAgentProgressMeta` includes optional fields:

```ts
export interface SubAgentProgressMeta {
  teamId?: string;
  stageLabel?: string;
  agentRole?: string;
  sourceLabel?: string;
  currentStageIndex?: number;
  totalStages?: number;
  completedStageCount?: number;
  activeParallelCount?: number;
}
```

Then wire `src/orchestrator/teamExecutor.ts` so every team-stage progress event merges in the helper output:

```ts
const progressMeta = buildTeamStageProgressMeta({
  team,
  stage,
  activeGroup: group,
  stageResults,
});

params.onStageProgress?.(stage.stageLabel, {
  ...event,
  ...(progressMeta ?? {}),
  teamId: params.teamId,
  stageLabel: stage.stageLabel,
  agentRole: stage.agentRole,
});
```

Apply the same metadata to:

- stage-level runtime events forwarded during `executeStage()`
- `stage_complete`
- `team_checkpoint`

Keep all fields optional so existing consumers remain source-compatible.

- [ ] **Step 4: Run metadata tests to green**

Run: `pnpm test -- src/orchestrator/teamProgress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/teamProgress.ts src/orchestrator/teamProgress.test.ts src/orchestrator/types.ts src/orchestrator/teamExecutor.ts
git commit -m "feat: add structured team progress metadata"
```

### Task 2: Pure Conversation Topbar State Derivation

**Files:**
- Create: `src/ui/pages/chat/conversationTopbarState.ts`
- Test: `src/ui/pages/chat/conversationTopbarState.test.ts`
- Reference: `src/ui/pages/chat/types.ts`
- Reference: `src/ui/pages/chat/sessionState.ts`
- Reference: `src/orchestrator/types.ts`
- Reference: `docs/superpowers/specs/2026-03-24-unified-conversation-topbar-design.md`

- [ ] **Step 1: Write the failing derivation tests**

Add tests that prove:

- idle chats derive `mode = "idle"` with no progress or attention row
- single-agent streaming without tools uses a compact row-1-only state
- single-agent with running tools prefers `source = "tools"`
- single-agent waiting for ask-user input keeps compact single-agent structure while surfacing row 3 attention
- orchestrated team progress uses structured metadata to produce row 2 `current/total`
- active team orchestration stays in `mode = "orchestrating"` even when numeric progress metadata is temporarily unavailable
- when team execution signals and live tools coexist, `mode` stays `orchestrating` and `source` stays `team`
- orchestrated `primaryLabel` never contains `4/6`
- if `primaryLabel` is unavailable, row 2 may temporarily carry a non-numeric fallback sentence instead of duplicating row 1
- approval attention suppresses any row-1 approval badge
- multiple simultaneous attention candidates collapse to the highest-priority message plus `extraCount`
- attention priority follows the exact order `blocked > ask_user > approval > restore > informational`
- simultaneous `approval + restore` and `ask_user + approval` cases resolve to the expected primary attention and `+N`
- completed workflows use `primaryLabel = "本轮编排已完成"` while numeric completion stays in row 2 or badges
- completed workflows hide or downgrade in-progress badges and only keep explicit completion-oriented badges/CTA
- if an attention state is visible, `mode` must not fall back to `idle`
- interrupted orchestration uses `编排已中断` or `上次阶段：...`, hides unreliable numeric progress, and emits a row-3 `blocked` attention with `blocked_output` CTA
- missing structured metadata degrades to `正在编排` instead of guessing `current/total`
- checkpoint restore appears as an informational row-3 state without permanently taking over the primary row
- progress segments derive the expected `completed | active | pending | blocked` sequence, including a blocked segment case

Run: `pnpm test -- src/ui/pages/chat/conversationTopbarState.test.ts`
Expected: FAIL because the derivation helper does not exist yet.

- [ ] **Step 2: Implement the topbar state helper**

Create a pure API shaped like:

```ts
export type ConversationTopbarMode = "idle" | "single_agent" | "orchestrating";
export type ConversationTopbarAttentionLevel = "info" | "warning" | "blocked";

export interface ConversationTopbarBadge { /* align exactly with spec */ }
export interface ConversationTopbarProgress { /* align exactly with spec */ }
export interface ConversationTopbarAttention { /* align exactly with spec */ }
export interface ConversationTopbarState { /* single source of truth */ }

export function deriveConversationTopbarState(input: {
  agentLabel: string;
  isStreaming: boolean;
  liveToolCalls: LiveToolCall[];
  subAgentStatus: SubAgentStatusItem[];
  activePlan: OrchestrationPlan | null;
  hasAskUserPending: boolean;
  hasRestoreNotice: boolean;
  sessionNote: string;
}): ConversationTopbarState {
  // mode precedence:
  // 1. active team execution => orchestrating/team
  // 2. visible attention may prevent idle, but does not outrank team
  // 3. otherwise single-agent activity
  // 4. otherwise idle
}
```

Implementation rules:

- any active team execution signal keeps the mode in `orchestrating`, even if precise numeric progress is unavailable
- numeric row-2 progress only appears when the structured metadata is trustworthy
- parallel-count badges must not be guessed when `activeParallelCount` is absent or unreliable
- row 1 owns the human-readable sentence only, not numeric progress
- row 2 owns `current/total` plus track segments
- row 2 may only use fallback explanatory text when row 1 has no trustworthy primary sentence; otherwise it must not repeat row 1’s proposition
- row 3 owns approval / blocked / ask-user / restore summaries
- approval navigation lives only in row 3, never as a duplicated row-1 approval badge
- single-agent row 2 stays hidden by default unless a clearly secondary long-running activity is intentionally elevated
- interrupted orchestration must prefer truthful interruption language over stale `4/6`, and must set `attention.level = "blocked"` with the correct CTA
- completed workflows should hide or downgrade running-state badges such as live tools / parallel counts unless product-specific post-run badges are explicitly intended

Type-location rule:

- define and export the full `ConversationTopbarState` family from `conversationTopbarState.ts`
- do not duplicate these interfaces in `ConversationTopbar.tsx`, `ChatPage.tsx`, or `types.ts`

Suggested helper splits:

```ts
function deriveMode(...)
function derivePrimaryLabel(...)
function deriveProgress(...)
function collectAttentionCandidates(...)
function pickAttentionCandidate(...)
function buildBadges(...)
```

- [ ] **Step 3: Run derivation tests to green**

Run: `pnpm test -- src/ui/pages/chat/conversationTopbarState.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ui/pages/chat/conversationTopbarState.ts src/ui/pages/chat/conversationTopbarState.test.ts
git commit -m "feat: derive unified conversation topbar state"
```

### Task 3: ConversationTopbar Component And Styles

**Files:**
- Create: `src/ui/pages/chat/ConversationTopbar.tsx`
- Test: `src/ui/pages/chat/ConversationTopbar.test.tsx`
- Create: `src/styles/features/chat/topbar.css`
- Modify: `src/styles.css`
- Modify: `src/styles/features/chat/bubble.css`
- Modify: `src/styles/features/tools/executions.css`
- Modify: `src/styles/features/tools/plan.css`
- Reference: `src/ui/pages/chat/WorkspaceTeamTrustDialog.test.tsx`
- Reference: `src/styles/features/chat/bubble.css`

- [ ] **Step 1: Write the failing component tests**

Follow the existing small-component testing style used in `WorkspaceTeamTrustDialog.test.tsx`.

Cover:

- row 1 always renders
- row 2 renders only when `progress.visible === true`
- row 3 renders only when `attention !== null`
- approval attention uses row 3 CTA and does not render approval count in row 1
- clicking `tools`, `parallel`, `context`, `ask_user`, `restore`, or `blocked_output` invokes `onAction`
- clicking the progress row / progress track invokes the dedicated progress action
- progress segments render in the expected order and include a visible blocked state when provided
- primary summary uses `aria-live="polite"`
- attention row uses a separate polite live announcement path
- warning / blocked rows include visible text or icon-label semantics and do not rely on color alone
- completion states hide or downgrade running badges and keep only completion-appropriate affordances

Run: `pnpm test -- src/ui/pages/chat/ConversationTopbar.test.tsx`
Expected: FAIL because the component does not exist yet.

- [ ] **Step 2: Implement the render-only topbar component**

Build a focused component contract:

```tsx
export type ConversationTopbarAction =
  | NonNullable<ConversationTopbarBadge["action"]>
  | NonNullable<ConversationTopbarAttention["ctaAction"]>
  | "progress";

export interface ConversationTopbarProps {
  state: ConversationTopbarState;
  onAction?: (action: ConversationTopbarAction) => void;
}
```

Render:

- row 1: agent label, primary label, compact badges
- row 2: numeric progress + track segments
- row 3: attention tone, message, optional `+N`, optional CTA

Accessibility rules:

- blocked / warning states must expose visible text or icon+label semantics, not just color changes
- keep the primary and attention live-region announcements separate so they do not overwrite each other

Keep the component dumb:

- no runtime state derivation inside JSX
- no DOM querying
- no scroll logic

- [ ] **Step 3: Add topbar styles and import them**

Create `src/styles/features/chat/topbar.css` with classes for:

- `.conversation-topbar`
- `.conversation-topbar-row`
- `.conversation-topbar-primary`
- `.conversation-topbar-progress`
- `.conversation-topbar-attention`
- `.conversation-topbar-badge`
- `.conversation-topbar-track`
- `.conversation-topbar-cta`

Then adjust the pre-existing detail surfaces so they visibly move from “overview” to “detail”:

- in `bubble.css`, reduce the emphasis of expert-stage summary wrappers relative to the new topbar
- in `executions.css`, tone down live-tool and tool-trace panel headings / borders so they no longer compete with row 1
- in `plan.css`, preserve action clarity but reduce the collapsed plan header’s resemblance to a global status bar

Visual rules:

- row 1 strongest
- row 2 lighter and progress-oriented
- row 3 noticeable but smaller than row 1
- compact single-agent states should not look heavier than the current chat header area

Import it from `src/styles.css`.

- [ ] **Step 4: Run component tests to green**

Run: `pnpm test -- src/ui/pages/chat/ConversationTopbar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/pages/chat/ConversationTopbar.tsx src/ui/pages/chat/ConversationTopbar.test.tsx src/styles/features/chat/topbar.css src/styles/features/chat/bubble.css src/styles/features/tools/executions.css src/styles/features/tools/plan.css src/styles.css
git commit -m "feat: add conversation topbar component"
```

### Task 4: Navigation Targets And Chat Integration

**Files:**
- Modify: `package.json`
- Create: `src/ui/pages/chat/conversationTopbarNavigation.ts`
- Test: `src/ui/pages/chat/conversationTopbarNavigation.test.ts`
- Create: `src/ui/pages/chat/ChatThreadSection.tsx`
- Test: `src/ui/pages/chat/ChatThreadSection.test.tsx`
- Modify: `src/ui/pages/chat/ChatPresentational.tsx`
- Modify: `src/ui/pages/ChatPage.tsx`
- Reference: `src/ui/pages/chat/ConversationTopbar.tsx`
- Reference: `src/ui/pages/chat/conversationTopbarState.ts`

- [ ] **Step 1: Add the DOM test dependency if it is missing**

If `@testing-library/react` is not already present, add it before writing DOM-level integration tests:

Run: `pnpm add -D @testing-library/react`
Expected: the dependency is added to `package.json` and lockfile.

- [ ] **Step 2: Write the failing navigation-target and thread integration tests**

Add tests that prove:

- `tools` resolves to the latest visible tool-status anchor
- `parallel` resolves to the latest sub-agent activity anchor
- approval CTA resolves to the first pending action in the active plan
- progress-track clicks resolve to the active `plan` target first and fall back to `stage_summary`
- `context` resolves to the composer/token area target
- `ask_user` resolves to the current ask-user target when it exists, otherwise returns `null`
- `restore` resolves to the current restore/info target when it exists, otherwise returns `null`
- blocked CTA resolves to the failed step / output target when present
- missing targets return `null` so the UI can disable the affordance instead of silently no-oping
- rerendering the thread with a different conversation clears stale orchestrated progress
- approval clicks expand a collapsed `InlinePlan` before attempting to scroll
- the topbar updates when `liveToolCalls` or `subAgentStatus` props change
- current plan prop updates refresh the row-3 attention state without stale carry-over
- delayed team summary messages do not regress the current topbar state
- expert stage summary messages still remain visible and readable in the transcript after the topbar is added
- ask-user and restore actions disable themselves cleanly when no stable target exists

Use two test files:

- `src/ui/pages/chat/conversationTopbarNavigation.test.ts` for the pure target-resolution logic
- `src/ui/pages/chat/ChatThreadSection.test.tsx` for DOM-level integration around topbar + transcript + rerender behavior

Run: `pnpm test -- src/ui/pages/chat/conversationTopbarNavigation.test.ts src/ui/pages/chat/ChatThreadSection.test.tsx`
Expected: FAIL because the helper, extracted thread section, and anchors do not exist yet.

- [ ] **Step 3: Implement the pure navigation helper**

Create a semantic helper like:

```ts
export interface ConversationTopbarTarget {
  anchor:
    | "tools"
    | "parallel"
    | "approval"
    | "ask_user"
    | "blocked_output"
    | "context"
    | "plan"
    | "stage_summary";
  messageId?: string;
  actionId?: string;
  stageLabel?: string;
}

export function resolveConversationTopbarTarget(input: {
  action: ConversationTopbarAction;
  messages: ChatMessageRecord[];
  activePlan: OrchestrationPlan | null;
  liveToolCalls: LiveToolCall[];
  subAgentStatus: SubAgentStatusItem[];
  hasAskUserPending: boolean;
  askUserAnchorMessageId?: string | null;
  hasRestoreNotice: boolean;
  restoreAnchorMessageId?: string | null;
  sessionNote: string;
}): ConversationTopbarTarget | null {
  // return null when there is nothing stable to scroll to
}
```

Rules:

- `approval` targets the first pending action in the active plan
- `progress` the action resolves to a `plan` anchor first; if no plan target exists, it falls back to `stage_summary`
- `context` targets the composer/footer token area
- `ask_user` uses the current ask-user anchor or message id when available
- `restore` uses the active restore/info anchor or message id when available
- keep the helper pure; it should not query the DOM directly

- [ ] **Step 4: Extract `ChatThreadSection` into its own file**

Move the inline `ChatThreadSection` component out of `ChatPage.tsx` into `src/ui/pages/chat/ChatThreadSection.tsx` so it can be rendered directly in tests.

Keep the first extraction minimal:

- preserve the existing props contract first
- add only the new `topbarState`, `onTopbarAction`, and expansion/anchor props needed for integration
- keep `ChatPage.tsx` focused on state derivation and handlers, not large render trees

- [ ] **Step 5: Add stable anchors to the presentational transcript**

Modify `ChatPresentational.tsx` so the detail surfaces the topbar must jump to have stable selectors, for example:

```tsx
<div data-topbar-anchor="tools">...</div>
<div data-topbar-anchor="parallel">...</div>
<div data-topbar-anchor="plan">...</div>
<div data-topbar-anchor="stage_summary">...</div>
<div data-topbar-anchor="ask_user">...</div>
<div data-topbar-anchor="restore">...</div>
<li data-topbar-action-id={action.id}>...</li>
```

Also make `InlinePlan` externally openable so a topbar approval click can expand a collapsed plan before scrolling. A small optional prop such as `forcedExpandedActionId?: string | null` or `forceExpanded?: boolean` is enough; do not redesign the whole plan component.

- [ ] **Step 6: Wire ChatPage to derive, render, and navigate**

In `ChatPage.tsx`:

- derive `activePlan` from the latest visible assistant turn with a live plan
- compute `topbarState` with `useMemo`
- include `messages`, `liveToolCalls`, `subAgentStatus`, `isStreaming`, `sessionNote`, and the active conversation identity in the memo dependencies
- add a stable `data-topbar-anchor="context"` wrapper around the composer/token usage area near `TokenUsageRing`
- render `<ConversationTopbar state={topbarState} onAction={handleTopbarAction} />` inside `ChatThreadSection`, above the empty state / transcript messages
- use `resolveConversationTopbarTarget()` to find the semantic target
- pass the same restore / ask-user signals used by the derivation layer into `resolveConversationTopbarTarget()`
- expand collapsed targets before scrolling
- keep buttons disabled when there is no valid target
- after navigation, move keyboard focus to the target region or the first focusable control inside it when practical

Be explicit about the current code locations:

- keep `activePlan` derivation aligned with the same visible assistant-plan logic that currently feeds `InlinePlan`
- keep scrolling scoped to the existing `threadRef` container
- if `progress` has no active plan target, fall back to the latest stage-summary anchor for the current structured stage label

Keep the integration minimal:

- do not add a second dashboard
- do not move the existing detail panels out of the transcript
- do not persist topbar state separately from the live chat state

- [ ] **Step 7: Run the navigation and thread integration tests to green**

Run:

- `pnpm test -- src/ui/pages/chat/conversationTopbarNavigation.test.ts src/ui/pages/chat/ChatThreadSection.test.tsx`
- `pnpm test -- src/ui/pages/chat/conversationTopbarState.test.ts src/ui/pages/chat/ConversationTopbar.test.tsx`

Expected:

- navigation helper PASS
- thread integration PASS
- topbar state/component tests still PASS after integration-oriented prop changes

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml src/ui/pages/chat/conversationTopbarNavigation.ts src/ui/pages/chat/conversationTopbarNavigation.test.ts src/ui/pages/chat/ChatThreadSection.tsx src/ui/pages/chat/ChatThreadSection.test.tsx src/ui/pages/chat/ChatPresentational.tsx src/ui/pages/ChatPage.tsx
git commit -m "feat: integrate unified conversation topbar into chat"
```

### Task 5: Final Regression Coverage And Verification

**Files:**
- Test: `src/orchestrator/teamProgress.test.ts`
- Test: `src/ui/pages/chat/conversationTopbarState.test.ts`
- Test: `src/ui/pages/chat/ConversationTopbar.test.tsx`
- Test: `src/ui/pages/chat/conversationTopbarNavigation.test.ts`
- Test: `src/ui/pages/chat/ChatThreadSection.test.tsx`
- Reference: `docs/superpowers/specs/2026-03-24-unified-conversation-topbar-design.md`

- [ ] **Step 1: Add final regression tests for the spec-review edge cases**

Make sure the new or existing tests explicitly assert:

- completed workflows keep `6/6` out of `primaryLabel`
- approval attention suppresses row-1 approval badges
- row 1 and row 2 never duplicate the same numeric progress text
- multiple attention states collapse to one row-3 message plus `+N`
- conversation switches clear stale orchestrated progress
- missing structured team metadata degrades to `正在编排` instead of guessing numbers
- missing structured team metadata also suppresses guessed parallel-count badges
- checkpoint restore shows an informational row-3 state without permanently taking over the primary row
- progress-track clicks route to the expected progress target
- `context` badge routes to the composer/token area target
- the expected topbar/detail-surface classes are present so manual visual QA can verify the hierarchy change
- completion states remove or downgrade running-state badges
- navigation moves focus predictably to the resolved target or first focusable control

Run: `pnpm test -- src/orchestrator/teamProgress.test.ts src/ui/pages/chat/conversationTopbarState.test.ts src/ui/pages/chat/ConversationTopbar.test.tsx src/ui/pages/chat/conversationTopbarNavigation.test.ts src/ui/pages/chat/ChatThreadSection.test.tsx`
Expected: PASS after the assertions are added and implementation is stable.

- [ ] **Step 2: Run the focused verification suite**

Run:

- `pnpm test -- src/orchestrator/teamProgress.test.ts src/ui/pages/chat/conversationTopbarState.test.ts src/ui/pages/chat/ConversationTopbar.test.tsx src/ui/pages/chat/conversationTopbarNavigation.test.ts src/ui/pages/chat/ChatThreadSection.test.tsx`
- `pnpm build`

Expected:

- all new focused tests PASS
- type-check and Vite build PASS

- [ ] **Step 3: Review residual risks before closing**

Document any remaining limitations, especially:

- no full browser E2E around native `scrollIntoView` timing
- single-agent row 2 remains intentionally conservative in v1
- topbar depends on structured team metadata for precise `current/total` values
- visual de-emphasis of legacy detail panels still requires manual visual QA in addition to automated tests

If any of these stay unresolved, note them in the final implementation handoff instead of silently ignoring them.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/teamProgress.test.ts src/ui/pages/chat/conversationTopbarState.test.ts src/ui/pages/chat/ConversationTopbar.test.tsx src/ui/pages/chat/conversationTopbarNavigation.test.ts src/ui/pages/chat/ChatThreadSection.test.tsx
git commit -m "test: cover unified conversation topbar regressions"
```
