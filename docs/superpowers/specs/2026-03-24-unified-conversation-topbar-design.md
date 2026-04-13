# Unified Conversation Topbar Design

## Summary

Add a single page-level `ConversationTopbar` to `ChatPage` so every conversation gets one stable, high-signal status summary above the message list.

This topbar must:

- use one shared structure for both single-agent chats and orchestrated team chats
- stay progress-led rather than warning-led
- surface approval, blocked, ask-user, and restore states without replacing the primary progress summary
- aggregate existing runtime state instead of parsing message prose
- keep detailed execution history in the existing message stream, plan cards, and tool panels

## Goals

- Make the current conversation state understandable at a glance.
- Give users a stronger sense of forward motion during long-running agent orchestration.
- Reduce the need to reconstruct global state from tool traces, stage messages, and approval cards.
- Keep the interaction model consistent across all chats instead of introducing a separate orchestration-only layout.
- Preserve current detail surfaces while demoting them from "global overview" to "drill-down details".

## Non-Goals

- Replacing the existing chat message stream with a workflow dashboard.
- Hiding or removing `InlinePlan`, tool traces, stage summaries, or approval cards.
- Making warnings or approvals the primary visual state in progress-led conversations.
- Deriving orchestration progress from assistant message text.
- Introducing a right-side cockpit or a separate page mode for orchestrated chats.

## User Experience

### Core behavior

`ConversationTopbar` lives above the chat transcript and below the page header. It is not a message bubble and does not enter history as a chat turn.

The topbar always answers two different questions:

- primary state: "What is the conversation doing right now?"
- attention state: "Do I need to intervene right now?"

Those two channels must remain visually distinct.

### Single-agent chats

Single-agent conversations use the same component but in a compact shape.

Expected examples:

- `通用 Agent · 正在回答`
- `通用 Agent · 正在读取工作区文件`
- `通用 Agent · 等待你的输入`
- `通用 Agent · 回复中断`

Single-agent mode may show compact badges such as:

- `工具 2`
- `等待输入`
- `上下文 62%`

Single-agent mode does not show stage progress tracks.

### Orchestrated chats

When the active conversation enters agent orchestration, the same topbar expands to show:

- the current team or orchestration mode label
- the active stage summary as the primary sentence
- a lightweight progress track
- compact badges for parallelism and runtime counts
- an optional attention row for warning/blocked states

Expected examples:

- row 1: `编排 Agent · 当前：代码实现`
- row 2: `4/6` plus the visual progress track
- row 1: `编排 Agent · 当前：测试验证`
- row 2: `5/6` plus the visual progress track
- row 1: `编排 Agent · 当前：修复阶段`
- row 2: `3/4` plus the visual progress track

### Progress-led warning behavior

The topbar must remain progress-led even when the user needs to intervene.

When approvals or failures appear:

- the first row still shows the main workflow position
- a secondary attention row appears underneath
- the attention row never replaces the primary row

Examples:

- primary: `当前：测试验证`
- progress: `5/6`
- attention: `提醒：有 2 个动作待你审批`

- primary: `当前：验证阶段`
- progress: `5/6`
- attention: `阻塞：pnpm test 失败，请查看结果`

### Conversation-wide consistency

All chats use the same topbar skeleton:

- row 1: primary summary and high-priority badges
- row 2: optional progress row
- row 3: optional attention row

Only density changes by state. The component must feel like one unified system, not different widgets stapled together for different modes.

## Information Architecture

### Row 1: Primary state row

This row is always visible.

Contents:

- left: agent identity and mode label
- center: one primary sentence that describes what is happening now
- right: compact badges for counts and high-signal state

Recommended badge types:

- tool count
- parallel stage count
- context usage
- completion summary when the run is done

This row should remain low-noise. Only one primary sentence is allowed.

Hard rule for row ownership:

- row 1 owns the human-readable primary sentence
- row 1 must not repeat numeric stage progress such as `4/6`
- row 2 owns numeric progress and the track
- row 3 owns approval, blocked, restore, and ask-user attention
- this rule also applies to completed workflows: `current/total` may appear in row 2 or a completion badge, but never inside `primaryLabel`

This separation is required to avoid duplicate sources of truth between `primaryLabel`, `progress`, and `attention`.

### Row 2: Progress row

This row is conditional.

Single-agent chats:

- keep row 2 hidden by default
- only show row 2 when a long-running or secondary activity needs extra context
- use lightweight activity text only
- do not render stage tracks
- do not restate the row 1 sentence or the same underlying proposition

Orchestrated chats:

- show current/total progress
- show a compact track for completed, active, pending, and blocked segments
- do not repeat approval counts or blocked summaries here
- do not repeat the row 1 sentence unless the row 1 sentence is unavailable

This row exists to explain forward motion, not to enumerate all details of the workflow.

### Row 3: Attention row

This row is conditional and only appears when the user should notice something beyond the normal flow.

Supported attention states:

- approval needed
- blocked or failed stage
- ask-user waiting
- checkpoint restore notice

Attention ownership rule:

- approvals, ask-user waits, restore notices, and blocked summaries belong in row 3
- row 1 should not render those items as warning-toned badges
- if an approval reminder is active, do not duplicate the same approval count as a warning badge in row 1
- if `attention` is `approval needed`, row 1 must not render any approval-count badge at all
- row 1 may still keep neutral runtime badges such as tool count or parallel count while row 3 is visible

Priority order when multiple attention candidates exist:

1. blocked / failed
2. ask-user waiting
3. approval needed
4. checkpoint restore notice
5. informational reminders

Only one attention item is rendered as the main row 3 message at a time. If additional lower-priority items exist, show a muted `+N` indicator but do not add a second CTA or a second attention sentence.

The attention row may include one compact CTA, for example:

- `查看待审批`
- `查看失败输出`
- `继续回答`

## Architecture

### Component split

Keep raw runtime state where it already lives. Add one view-model layer instead of pushing aggregation logic into the component tree.

Suggested files:

- create `src/ui/pages/chat/conversationTopbarState.ts`
- create `src/ui/pages/chat/ConversationTopbar.tsx`
- create `src/ui/pages/chat/conversationTopbarState.test.ts`
- add topbar-specific styles in `src/styles/features/chat/topbar.css` or a similarly scoped feature stylesheet

Existing integration points:

- `src/ui/pages/ChatPage.tsx`
- `src/ui/pages/chat/ChatPresentational.tsx`
- `src/ui/pages/chat/types.ts`
- `src/orchestrator/types.ts`

Responsibilities:

- `conversationTopbarState.ts`
  - pure derivation from existing runtime state into one `ConversationTopbarState`
- `ConversationTopbar.tsx`
  - render-only component
- `ChatPage.tsx`
  - collect raw inputs and wire click handlers to existing detail surfaces

### View-model shape

Suggested structure:

```ts
type ConversationTopbarMode = "idle" | "single_agent" | "orchestrating";

type ConversationTopbarAttentionLevel = "info" | "warning" | "blocked";

interface ConversationTopbarBadge {
  key: string;
  label: string;
  tone?: "default" | "info" | "warning" | "blocked" | "success";
  action?: "tools" | "parallel" | "ask_user" | "context";
}

interface ConversationTopbarProgress {
  visible: boolean;
  label?: string;
  current?: number;
  total?: number;
  segments?: Array<"completed" | "active" | "pending" | "blocked">;
}

interface ConversationTopbarAttention {
  visible: boolean;
  level: ConversationTopbarAttentionLevel;
  message: string;
  ctaLabel?: string;
  ctaAction?: "approval" | "blocked_output" | "ask_user" | "restore";
  extraCount?: number;
}

interface ConversationTopbarState {
  mode: ConversationTopbarMode;
  source: "idle" | "assistant" | "tools" | "team";
  primaryLabel: string;
  agentLabel: string;
  badges: ConversationTopbarBadge[];
  progress: ConversationTopbarProgress;
  attention: ConversationTopbarAttention | null;
}
```

The topbar component should receive this view-model directly and avoid business-specific inference.

### Mode and source semantics

`mode` defines the structural density of the topbar.

- `idle`
  - nothing is actively running and there is no unresolved attention state worth elevating
- `single_agent`
  - the current conversation is not in team orchestration mode
- `orchestrating`
  - structured team progress or active team execution is present; this mode wins over single-agent runtime activity

`source` defines which runtime channel authored the current primary sentence.

- `idle`
  - ready state with no active work
- `assistant`
  - the assistant is streaming or has just transitioned through a non-tool single-agent phase
- `tools`
  - one or more live tool calls are the best explanation of current work
- `team`
  - structured orchestration state is active and should drive the summary

Recommended precedence:

1. if active team execution exists, set `mode = "orchestrating"` and `source = "team"`
2. else if any user-visible attention state exists (`approval`, `blocked`, `ask-user`, `restore`), `mode` must not be `idle`; keep the last trustworthy structural mode, or fall back to `single_agent` when no team mode is active
3. else if the conversation is active, set `mode = "single_agent"`
4. within `single_agent`, prefer `source = "tools"` when live tools exist, otherwise `source = "assistant"`
5. otherwise use `mode = "idle"` and `source = "idle"`

For this purpose, "conversation is active" includes any of:

- assistant streaming
- one or more live tool calls
- unresolved plan activity
- ask-user waiting
- visible blocked or approval attention

## Data Flow

### Existing raw inputs

Continue using current sources of truth:

- `isStreaming`
- `liveToolCalls`
- `subAgentStatus`
- current message `plan`
- `sessionNote`
- ask-user request state
- conversation / agent metadata

Do not use message body text as a primary state source.

### Derivation rules

Recommended source mapping:

- single-agent primary state
  - derive from `isStreaming` plus `liveToolCalls`
- orchestrated primary state
  - derive from structured sub-agent progress
- pending-approval attention
  - derive from active plan pending actions
- blocked attention
  - derive from failed or blocked actions / stages
- ask-user attention
  - derive from active ask-user request
- restore notice
  - derive from checkpoint/session restore state

Primary state and attention must be derived independently so warnings never overwrite the main workflow summary.

For orchestrated chats:

- `primaryLabel` contains the human-readable current-stage sentence without numeric progress
- `progress.current` and `progress.total` own the numeric `4/6` style summary
- `attention` owns approval, blocked, ask-user, and restore summaries

### Structured progress requirements

Do not infer stage progress by parsing assistant summaries inserted into the message list.

Current stage summary messages are useful for historical review, but the topbar needs structured status.

Recommended extension to `SubAgentProgressEvent`:

```ts
type SubAgentProgressEvent = (
  | {
      kind: "stage_complete";
      stageLabel: string;
      agentRole: string;
      summary: string;
      stageStatus: SubAgentCompletionStatus;
      currentStageIndex?: number;
      totalStages?: number;
      completedStageCount?: number;
      activeParallelCount?: number;
    }
  | {
      kind: "team_checkpoint";
      checkpointId: string;
      message: string;
      currentStageIndex?: number;
      totalStages?: number;
      activeParallelCount?: number;
    }
  // ... other cases unchanged
) & SubAgentProgressMeta;
```

If richer progress metadata is more naturally produced elsewhere in the orchestration pipeline, that is acceptable. The key requirement is that topbar progress must come from structured runtime data rather than formatted prose.

## Interaction Model

### Default behavior

The topbar is a strong summary, not a second dashboard.

It should not expand into a large inline control panel by default.

### Click behavior

Badges and CTAs may navigate to existing detail surfaces:

- click `工具 2`
  - scroll to the current tool activity / tool trace area
- click `并行 2`
  - scroll to the current sub-agent activity area
- click `等待输入`
  - focus the current ask-user dialog or corresponding message
- click approval CTA in row 3
  - scroll to the first pending action in `InlinePlan`
- click blocked CTA
  - scroll to failed output or failed step details

Navigation fallback rules:

- if the target panel is collapsed, expand it before scrolling
- if the target section is not yet mounted, first reveal the current assistant turn or active plan container
- if no valid target exists, render the badge or CTA disabled instead of letting it no-op silently

### Progress track behavior

The progress track may be clickable, but only as a navigation affordance.

Recommended behavior:

- jump to the latest stage summary related to the active stage
- or focus the active step in the current plan

Do not make the progress row open a large custom panel that duplicates existing detail UIs.

## Relationship To Existing UI

The new hierarchy should be:

1. `ConversationTopbar`
   - global overview
2. `InlinePlan`
   - actionable approval and execution detail
3. `LiveToolStatus` / `SubAgentStatusPanel` / `ToolTracePanel`
   - activity stream and debugging detail
4. expert stage summary messages
   - historical review and audit trail

This means:

- keep `InlinePlan`
- keep tool traces
- keep expert stage summaries
- visually demote those elements from "overview" to "drill-down detail"

## Visual Design Principles

- Keep the primary row visually strongest.
- Use one sentence, not multiple competing summaries.
- Keep badges compact and count-oriented.
- Use the progress row to show movement, not narrative explanation.
- Use the attention row sparingly and only when there is something actionable or abnormal.
- Keep blocked and warning colors noticeable but lower in area and weight than the primary progress state.
- Make the component feel like one stable piece of page furniture across all chat modes.

## Error Handling And Degradation

### Missing structured progress

If exact stage metadata is unavailable:

- show `正在编排`
- do not show `4/6`
- do not guess parallel counts

Graceful degradation is preferred over inaccurate precision.

### Orchestration runtime failure

If the orchestration runtime itself is interrupted, times out, disconnects, or stops emitting trustworthy state before the workflow resolves:

- explicit orchestration failure takes priority over "missing structured progress"
- if the last trustworthy stage is known, keep row 1 as `上次阶段：<stage>`
- if no trustworthy stage is known, use a neutral primary summary such as `编排已中断`
- hide row 2 numeric progress unless the current/total values are still trustworthy
- show row 3 as `blocked` with the best available failure summary and CTA to inspect detail

This is the one case where the product may no longer have a truthful "current progress" statement, so neutral interruption language is preferred over stale precision.

### Temporary mismatch with message stream

When message rendering and structured events arrive at different times:

- topbar represents current runtime state
- transcript represents historical detail

The topbar should not regress just because a summary message arrives later.

### Checkpoint restore

On restore:

- briefly show `已恢复到上次进度` as an informational attention row
- continue to surface approval, ask-user, or blocked states if they still apply
- do not let restore messaging permanently replace the normal primary row

### Completed state

When the current workflow fully completes:

- switch the primary row to a completion summary such as `本轮编排已完成`
- keep `6/6` in row 2 progress or a completion badge, not in `primaryLabel`
- keep a compact summary badge or CTA such as `查看总结`
- remove running-state affordances

### Single-agent failures

Single-agent errors should use natural language instead of fake stage semantics:

- `回复中断`
- `工具执行失败`
- `等待你的输入`

### Idle state

When a conversation is ready but nothing is running:

- show a minimal ready state such as `已就绪`
- avoid implying that work is still in progress

## Accessibility

- Use semantic buttons for badges and CTAs that are clickable.
- Provide `aria-live="polite"` for the primary status sentence so important progress updates are announced without being overly disruptive.
- When row 3 attention appears or changes severity, announce it with a separate polite live region or equivalent one-shot accessible status update so blocked/approval states are not silent to screen-reader users.
- Ensure warning and blocked states do not rely on color alone; pair color with labels/icons.
- Keep keyboard focus predictable when badge clicks jump to detail sections.

## Testing Plan

### Pure derivation tests

Add unit coverage for `conversationTopbarState.ts`:

- idle conversation
- single-agent streaming without tools
- single-agent with running tools
- single-agent waiting for ask-user input
- orchestrated progress with structured stage metadata
- orchestrated progress with missing stage counts
- pending approvals while orchestration continues
- blocked stage while keeping the primary progress row
- checkpoint restore informational row
- completed workflow state
- multiple attention candidates collapsing to one main message plus `+N`
- mode/source precedence when team and tool activity overlap
- row 1 sentence staying free of numeric `4/6` progress

### Component rendering tests

Add render tests for `ConversationTopbar.tsx`:

- row 1 always visible
- row 2 hidden for compact single-agent states
- row 2 visible for orchestration progress
- row 2 stays hidden for ordinary single-agent streaming unless explicitly elevated for secondary context
- row 3 hidden when no attention state exists
- row 3 visible for warning and blocked states
- badges and CTAs render expected labels
- blocked, warning, info, and completion tones render correctly
- row 1 and row 2 do not duplicate the same numeric progress text
- attention rows show only one CTA and optionally `+N`
- approval attention suppresses any row 1 approval-count badge

### ChatPage integration tests

Verify:

- the topbar receives updates as `liveToolCalls` and `subAgentStatus` change
- clicking `工具` navigates to tool detail
- clicking `并行` navigates to sub-agent detail
- clicking the row 3 approval CTA navigates to the first pending action
- current plan updates refresh the attention row correctly
- restore flows do not permanently pin restore notices
- expert stage summary messages still appear in the transcript and remain readable
- switching conversations resets the topbar without stale carry-over
- delayed team summary messages do not regress the current topbar state
- clicking badges expands collapsed targets before scrolling
- disabled navigation affordances appear when a target detail section does not exist

## Risks

### Risk: too much information in the topbar

Mitigation:

- enforce a single primary sentence
- cap badges to the highest-signal items
- push deeper detail into existing panels

### Risk: inaccurate progress display

Mitigation:

- use structured runtime state only
- degrade gracefully when precision is unavailable

### Risk: duplicate status surfaces feel redundant

Mitigation:

- topbar owns overview
- existing panels own detail
- style secondary surfaces with lower visual weight

### Risk: single-agent chats become visually heavy

Mitigation:

- compact single-agent mode with only row 1 by default
- reserve progress and attention rows for states that need them

## Recommended Implementation Order

1. Define `ConversationTopbarState` and derivation helpers.
2. Add a render-only `ConversationTopbar` component and styles.
3. Integrate the topbar into `ChatPage`.
4. Wire badge and CTA navigation to existing detail surfaces.
5. Extend orchestration progress metadata so stage counts and parallel counts are structured.
6. Visually demote redundant overview elements while preserving detail visibility.
7. Add pure, component, and integration tests.

## Decision

Approved design direction:

- global pattern: one shared topbar for all conversations
- layout model: `A1` adaptive single topbar, meaning one shared `ConversationTopbar` region for all chats whose density changes by state rather than splitting into separate topbar layouts or a separate orchestration page mode
- priority model: progress-led, not warning-led
- warning behavior: attention row supplements progress rather than replacing it
- detail strategy: keep existing plan/tool/stage surfaces as drill-down destinations
- data strategy: derive from structured runtime state, not message text
