import { createElement, createRef, type ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { OrchestrationPlan, SubAgentProgressEvent } from "../../../orchestrator/types";
import type { ConversationTopbarState } from "./conversationTopbarState";
import { ChatThreadSection } from "./ChatThreadSection";

type StageCompleteEvent = Omit<SubAgentProgressEvent, "kind"> & { kind: "stage_complete" };

function assistantMessage(
  id: string,
  partial: Partial<ChatMessageRecord> = {},
): ChatMessageRecord {
  return {
    id,
    role: "assistant",
    content: "assistant content",
    createdAt: "2026-03-24T10:00:00.000Z",
    plan: null,
    ...partial,
  };
}

function userMessage(id: string, content = "user content"): ChatMessageRecord {
  return {
    id,
    role: "user",
    content,
    createdAt: "2026-03-24T10:00:00.000Z",
    plan: null,
  };
}

function topbarState(
  overrides: Partial<ConversationTopbarState> = {},
): ConversationTopbarState {
  return {
    mode: "idle",
    source: "idle",
    primaryLabel: "已就绪",
    agentLabel: "测试 Agent",
    badges: [],
    progress: { visible: false },
    attention: null,
    ...overrides,
  };
}

function pendingPlan(overrides: Partial<OrchestrationPlan> = {}): OrchestrationPlan {
  return {
    state: "human_review",
    prompt: "审核命令",
    steps: [
      {
        id: "step-1",
        title: "运行测试",
        summary: "执行回归测试",
        owner: "coder",
        status: "in_progress",
      },
    ],
    proposedActions: [
      {
        id: "action-1",
        type: "shell",
        description: "Run tests",
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: { shell: "pnpm test", timeoutMs: 1000 },
      },
    ],
    ...overrides,
  };
}

function stageCompleteEvent(
  overrides: Partial<StageCompleteEvent> = {},
): StageCompleteEvent {
  return {
    kind: "stage_complete",
    stageLabel: "Review",
    agentRole: "reviewer",
    summary: "done",
    stageStatus: "completed",
    teamId: "team-a",
    ...overrides,
  };
}

function renderThread(
  overrides: Partial<ComponentProps<typeof ChatThreadSection>> = {},
) {
  const onTopbarAction = vi.fn();
  const threadRef = createRef<HTMLDivElement>();
  const props: ComponentProps<typeof ChatThreadSection> = {
    threadRef,
    onThreadScroll: vi.fn(),
    messages: [],
    assistantDisplayName: "测试 Agent",
    assistantDescription: "测试描述",
    debugMode: false,
    isStreaming: false,
    liveToolCalls: [],
    subAgentStatus: [],
    executingActionId: "",
    getActiveShellActionIds: () => [],
    onPlanUpdate: vi.fn(),
    onApprove: vi.fn(async () => {}),
    onRetry: vi.fn(async () => {}),
    onReject: vi.fn(),
    onComment: vi.fn(),
    onCancel: vi.fn(async () => {}),
    onApproveAll: vi.fn(async () => {}),
    onRejectAll: vi.fn(),
    onSuggestionClick: vi.fn(),
    topbarState: topbarState(),
    onTopbarAction,
    expandedPlanMessageId: null,
    expandedPlanActionId: null,
    askUserAnchorMessageId: null,
    restoreAnchorMessageId: null,
    ...overrides,
  };
  return { ...render(<ChatThreadSection {...props} />), props, onTopbarAction };
}

describe("ChatThreadSection", () => {
  it("renders stable transcript anchors for topbar navigation surfaces", () => {
    const planMessage = assistantMessage("plan-msg", {
      content: "等待审批",
      plan: pendingPlan(),
    });
    const expertMessage = assistantMessage("expert-msg", {
      content: "专家总结",
      assistantSpeaker: {
        id: "team-a:Review:reviewer",
        label: "[team-a] Review · reviewer",
      },
    });
    const restoreMessage = assistantMessage("restore-msg", {
      content: "已从审批点恢复上一轮工作流状态。",
    });

    const { container } = renderThread({
      isStreaming: true,
      messages: [expertMessage, restoreMessage, planMessage],
      liveToolCalls: [
        {
          callId: "tool-1",
          toolName: "ask_user",
          status: "waiting_for_user",
        },
      ],
      subAgentStatus: [
        {
          id: "stage-1",
          label: "Review",
          role: "reviewer",
          lastEvent: stageCompleteEvent(),
          updatedAt: 10,
        },
      ],
      topbarState: topbarState({
        mode: "orchestrating",
        source: "team",
        primaryLabel: "当前：Review",
      }),
      askUserAnchorMessageId: "plan-msg",
      restoreAnchorMessageId: "restore-msg",
    });

    expect(screen.getByText("专家总结")).not.toBeNull();
    expect(container.querySelector('[data-topbar-anchor="tools"]')).not.toBeNull();
    expect(container.querySelector('[data-topbar-anchor="parallel"]')).not.toBeNull();
    expect(container.querySelector('[data-topbar-anchor="plan"]')).not.toBeNull();
    expect(container.querySelector('[data-topbar-anchor="ask_user"]')).not.toBeNull();
    expect(container.querySelector('[data-topbar-anchor="restore"]')).not.toBeNull();
    expect(container.querySelector('[data-topbar-anchor="stage_summary"]')).not.toBeNull();
    expect(container.querySelector('[data-topbar-action-id="action-1"]')).not.toBeNull();
  });

  it("reopens a manually collapsed inline plan when external expansion props target an action", () => {
    const message = assistantMessage("plan-msg", {
      content: "等待审批",
      plan: pendingPlan(),
    });

    const view = renderThread({
      messages: [message],
      topbarState: topbarState({
        mode: "orchestrating",
        source: "team",
        primaryLabel: "当前：实现",
        attention: {
          visible: true,
          level: "warning",
          message: "提醒：有 1 个动作待你审批",
          ctaLabel: "查看待审批",
          ctaAction: "approval",
        },
      }),
    });

    expect(screen.getByText("Run tests")).not.toBeNull();
    fireEvent.click(screen.getByText(/执行计划/));
    expect(screen.queryByText("Run tests")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看待审批" }));
    expect(view.onTopbarAction).toHaveBeenCalledWith("approval");

    view.rerender(
      <ChatThreadSection
        {...view.props}
        expandedPlanMessageId="plan-msg"
        expandedPlanActionId="action-1"
      />,
    );

    expect(screen.getByText("Run tests")).not.toBeNull();
    expect(view.container.querySelector('[data-topbar-action-id="action-1"]')).not.toBeNull();
  });

  it("can reopen the same plan target when the expansion request repeats", () => {
    const message = assistantMessage("plan-msg", {
      content: "等待审批",
      plan: pendingPlan(),
    });

    const view = renderThread({
      messages: [message],
      expandedPlanMessageId: "plan-msg",
      expandedPlanActionId: "action-1",
    });

    expect(screen.getByText("Run tests")).not.toBeNull();
    fireEvent.click(screen.getByText(/执行计划/));
    expect(screen.queryByText("Run tests")).toBeNull();

    const threadWithRequestKey = ChatThreadSection as unknown as (
      props: ComponentProps<typeof ChatThreadSection> & { expandedPlanRequestKey?: number },
    ) => ReturnType<typeof createElement>;

    view.rerender(
      createElement(threadWithRequestKey, {
        ...view.props,
        expandedPlanMessageId: "plan-msg",
        expandedPlanActionId: "action-1",
        expandedPlanRequestKey: 2,
      }),
    );

    expect(screen.getByText("Run tests")).not.toBeNull();
  });

  it("rerendering with a different conversation clears stale progress", () => {
    const { rerender } = renderThread({
      messages: [assistantMessage("plan-msg", { plan: pendingPlan() })],
      topbarState: topbarState({
        mode: "orchestrating",
        source: "team",
        primaryLabel: "当前：实现",
        progress: {
          visible: true,
          label: "2/4",
          current: 2,
          total: 4,
        },
      }),
    });

    expect(screen.getByText("2/4")).not.toBeNull();

    rerender(
      <ChatThreadSection
        threadRef={createRef<HTMLDivElement>()}
        onThreadScroll={vi.fn()}
        messages={[userMessage("user-2", "新的对话")]}
        assistantDisplayName="测试 Agent"
        assistantDescription="测试描述"
        debugMode={false}
        isStreaming={false}
        liveToolCalls={[]}
        subAgentStatus={[]}
        executingActionId=""
        getActiveShellActionIds={() => []}
        onPlanUpdate={vi.fn()}
        onApprove={vi.fn(async () => {})}
        onRetry={vi.fn(async () => {})}
        onReject={vi.fn()}
        onComment={vi.fn()}
        onCancel={vi.fn(async () => {})}
        onApproveAll={vi.fn(async () => {})}
        onRejectAll={vi.fn()}
        onSuggestionClick={vi.fn()}
        topbarState={topbarState()}
        onTopbarAction={vi.fn()}
        expandedPlanMessageId={null}
        expandedPlanActionId={null}
        askUserAnchorMessageId={null}
        restoreAnchorMessageId={null}
      />,
    );

    expect(screen.queryByText("2/4")).toBeNull();
    expect(screen.getByText("新的对话")).not.toBeNull();
  });

  it("keeps invalid ask_user and restore affordances disabled", () => {
    const { onTopbarAction } = renderThread({
      topbarState: topbarState({
        badges: [
          { key: "tools", label: "工具 1", action: "tools" },
          { key: "ask", label: "等待输入", action: "ask_user", disabled: true },
        ],
        attention: {
          visible: true,
          level: "info",
          message: "已恢复到上次进度",
          ctaLabel: "知道了",
          ctaAction: "restore",
          ctaDisabled: true,
        },
      }),
    });

    fireEvent.click(screen.getByText("工具 1"));
    expect(screen.getByText("等待输入").closest("button")?.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("知道了").closest("button")?.hasAttribute("disabled")).toBe(true);
    expect(onTopbarAction).toHaveBeenCalledTimes(1);
    expect(onTopbarAction).toHaveBeenCalledWith("tools");
  });

  it("keeps a stable ask_user anchor even when historical tool trace is collapsed", () => {
    const message = assistantMessage("ask-msg", {
      content: "等待输入",
      toolTrace: [
        {
          callId: "ask-1",
          name: "ask_user",
          arguments: "{}",
          startedAt: "2026-03-24T10:00:00.000Z",
          finishedAt: "2026-03-24T10:00:01.000Z",
          attempts: 1,
          status: "waiting_for_user",
          retried: false,
        },
      ],
    });

    const { container } = renderThread({
      messages: [message],
      askUserAnchorMessageId: "ask-msg",
      topbarState: topbarState({
        mode: "single_agent",
        source: "tools",
        primaryLabel: "等待你的输入以继续回复",
        attention: {
          visible: true,
          level: "warning",
          message: "等待你的输入以继续回复",
          ctaLabel: "继续回答",
          ctaAction: "ask_user",
        },
      }),
    });

    expect(screen.getByText(/工具调用/)).not.toBeNull();
    expect(container.querySelector('[data-topbar-anchor="ask_user"]')).not.toBeNull();
  });
});
