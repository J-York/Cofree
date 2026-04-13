import { describe, expect, it } from "vitest";

import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { OrchestrationPlan, SubAgentProgressEvent } from "../../../orchestrator/types";
import type { ConversationTopbarAction } from "./ConversationTopbar";
import { resolveConversationTopbarTarget } from "./conversationTopbarNavigation";
import type { LiveToolCall, SubAgentStatusItem } from "./types";

function baseInput(
  overrides: Partial<Parameters<typeof resolveConversationTopbarTarget>[0]> = {},
): Parameters<typeof resolveConversationTopbarTarget>[0] {
  return {
    action: "context",
    messages: [],
    activePlan: null,
    liveToolCalls: [],
    subAgentStatus: [],
    hasAskUserPending: false,
    askUserAnchorMessageId: null,
    hasRestoreNotice: false,
    restoreAnchorMessageId: null,
    sessionNote: "",
    ...overrides,
  };
}

function assistantMsg(
  id: string,
  partial: Partial<ChatMessageRecord> = {},
): ChatMessageRecord {
  return {
    id,
    role: "assistant",
    content: "hi",
    createdAt: "2026-01-01T00:00:00.000Z",
    plan: null,
    ...partial,
  };
}

describe("resolveConversationTopbarTarget", () => {
  it("tools resolves to latest visible tool-status anchor", () => {
    const calls: LiveToolCall[] = [
      { callId: "c-old", toolName: "a", status: "running" },
      { callId: "c-new", toolName: "b", status: "running" },
    ];
    const messages: ChatMessageRecord[] = [
      assistantMsg("m1", {
        toolTrace: [
          {
            callId: "c-old",
            name: "a",
            arguments: "{}",
            startedAt: "t0",
            finishedAt: "t1",
            attempts: 1,
            status: "success",
            retried: false,
          },
        ],
      }),
      assistantMsg("m2", {
        toolTrace: [
          {
            callId: "c-new",
            name: "b",
            arguments: "{}",
            startedAt: "t0",
            finishedAt: "t1",
            attempts: 1,
            status: "waiting_for_user",
            retried: false,
          },
        ],
      }),
    ];
    const r = resolveConversationTopbarTarget(
      baseInput({ action: "tools", messages, liveToolCalls: calls }),
    );
    expect(r).toEqual({ anchor: "tools", messageId: "m2" });
  });

  it("parallel resolves to latest sub-agent activity anchor", () => {
    const event: SubAgentProgressEvent = {
      kind: "stage_complete",
      stageLabel: "Review",
      agentRole: "reviewer",
      summary: "done",
      stageStatus: "completed",
      teamId: "team-a",
    };
    const expert = assistantMsg("expert-1", {
      assistantSpeaker: {
        id: "team-a:Review:reviewer",
        label: "[team-a] Review · reviewer",
      },
    });
    const items: SubAgentStatusItem[] = [
      {
        id: "team-a:Review",
        label: "r",
        role: "reviewer",
        lastEvent: { kind: "thinking", partialContent: "…" },
        updatedAt: 1,
      },
      {
        id: "team-a:Review",
        label: "r",
        role: "reviewer",
        lastEvent: event,
        updatedAt: 100,
      },
    ];
    const r = resolveConversationTopbarTarget(
      baseInput({ action: "parallel", messages: [expert], subAgentStatus: items }),
    );
    expect(r).toEqual({ anchor: "parallel", messageId: "expert-1" });
  });

  it("approval CTA resolves to first pending action in active plan", () => {
    const plan: OrchestrationPlan = {
      state: "human_review",
      prompt: "p",
      steps: [],
      proposedActions: [
        {
          id: "act-done",
          type: "shell",
          description: "d0",
          gateRequired: true,
          status: "completed",
          executed: true,
          payload: { shell: "x", timeoutMs: 1 },
        },
        {
          id: "act-pending",
          type: "shell",
          description: "d1",
          gateRequired: true,
          status: "pending",
          executed: false,
          payload: { shell: "y", timeoutMs: 1 },
        },
      ],
    };
    const messages = [assistantMsg("plan-msg", { plan })];
    const r = resolveConversationTopbarTarget(
      baseInput({ action: "approval", messages, activePlan: plan }),
    );
    expect(r).toEqual({
      anchor: "approval",
      actionId: "act-pending",
      messageId: "plan-msg",
    });
  });

  it("progress resolves to active plan target first, else stage_summary", () => {
    const plan: OrchestrationPlan = {
      state: "executing",
      prompt: "p",
      steps: [{ id: "s1", title: "t", summary: "", owner: "coder", status: "in_progress" }],
      proposedActions: [],
    };
    const withPlan = assistantMsg("with-plan", { plan });
    const stageOnly = assistantMsg("stage-only", {
      assistantSpeaker: { id: "task:Build:coder", label: "Build · coder" },
    });
    const r1 = resolveConversationTopbarTarget(
      baseInput({ action: "progress", messages: [stageOnly, withPlan], activePlan: plan }),
    );
    expect(r1).toEqual({ anchor: "plan", messageId: "with-plan" });

    const r2 = resolveConversationTopbarTarget(
      baseInput({
        action: "progress",
        messages: [stageOnly],
        activePlan: null,
      }),
    );
    expect(r2).toEqual({ anchor: "stage_summary", messageId: "stage-only" });
  });

  it("progress falls back to the current stage-summary label before unrelated later summaries", () => {
    const messages: ChatMessageRecord[] = [
      assistantMsg("build-summary", {
        assistantSpeaker: {
          id: "team-a:Build:coder",
          label: "[team-a] Build · coder",
        },
      }),
      assistantMsg("review-summary", {
        assistantSpeaker: {
          id: "team-a:Review:reviewer",
          label: "[team-a] Review · reviewer",
        },
      }),
    ];
    const subAgentStatus: SubAgentStatusItem[] = [
      {
        id: "team-a:Build",
        label: "Build",
        role: "coder",
        updatedAt: 20,
        lastEvent: {
          kind: "thinking",
          partialContent: "working",
          teamId: "team-a",
          stageLabel: "Build",
          currentStageIndex: 1,
          totalStages: 2,
        },
      },
      {
        id: "team-a:Review",
        label: "Review",
        role: "reviewer",
        updatedAt: 10,
        lastEvent: {
          kind: "stage_complete",
          stageLabel: "Review",
          agentRole: "reviewer",
          summary: "done",
          stageStatus: "completed",
          teamId: "team-a",
        },
      },
    ];

    const result = resolveConversationTopbarTarget(
      baseInput({
        action: "progress",
        messages,
        subAgentStatus,
      }),
    );

    expect(result).toEqual({ anchor: "stage_summary", messageId: "build-summary" });
  });

  it("context resolves to composer/token target", () => {
    const r = resolveConversationTopbarTarget(baseInput({ action: "context" }));
    expect(r).toEqual({ anchor: "context" });
  });

  it("ask_user resolves when anchor exists, else null", () => {
    const ok = resolveConversationTopbarTarget(
      baseInput({
        action: "ask_user",
        hasAskUserPending: true,
        askUserAnchorMessageId: "u1",
      }),
    );
    expect(ok).toEqual({ anchor: "ask_user", messageId: "u1" });

    const missingId = resolveConversationTopbarTarget(
      baseInput({
        action: "ask_user",
        hasAskUserPending: true,
        askUserAnchorMessageId: null,
      }),
    );
    expect(missingId).toBeNull();

    const missingFlag = resolveConversationTopbarTarget(
      baseInput({
        action: "ask_user",
        hasAskUserPending: false,
        askUserAnchorMessageId: "u1",
      }),
    );
    expect(missingFlag).toBeNull();
  });

  it("restore resolves when anchor exists, else null", () => {
    const ok = resolveConversationTopbarTarget(
      baseInput({
        action: "restore",
        hasRestoreNotice: true,
        restoreAnchorMessageId: "r1",
      }),
    );
    expect(ok).toEqual({ anchor: "restore", messageId: "r1" });

    const missingId = resolveConversationTopbarTarget(
      baseInput({
        action: "restore",
        hasRestoreNotice: true,
        restoreAnchorMessageId: null,
      }),
    );
    expect(missingId).toBeNull();
  });

  it("blocked CTA resolves to failed step / output target when present", () => {
    const event: SubAgentProgressEvent = {
      kind: "stage_complete",
      stageLabel: "Test",
      agentRole: "coder",
      summary: "failed",
      stageStatus: "failed",
      teamId: "t1",
    };
    const expert = assistantMsg("ex-fail", {
      assistantSpeaker: {
        id: "t1:Test:coder",
        label: "x",
      },
    });
    const r = resolveConversationTopbarTarget(
      baseInput({
        action: "blocked_output",
        messages: [expert],
        subAgentStatus: [
          {
            id: "t1:Test",
            label: "l",
            role: "coder",
            lastEvent: event,
            updatedAt: 1,
          },
        ],
        activePlan: null,
      }),
    );
    expect(r).toEqual({
      anchor: "blocked_output",
      messageId: "ex-fail",
      stageLabel: "Test",
    });
  });

  it("missing targets return null", () => {
    expect(resolveConversationTopbarTarget(baseInput({ action: "tools" }))).toBeNull();
    expect(
      resolveConversationTopbarTarget(
        baseInput({ action: "parallel", subAgentStatus: [] }),
      ),
    ).toBeNull();
    expect(
      resolveConversationTopbarTarget(
        baseInput({
          action: "approval",
          activePlan: {
            state: "executing",
            prompt: "p",
            steps: [],
            proposedActions: [],
          },
        }),
      ),
    ).toBeNull();
    expect(
      resolveConversationTopbarTarget(
        baseInput({ action: "progress", messages: [], activePlan: null }),
      ),
    ).toBeNull();
    const noTrace = resolveConversationTopbarTarget(
      baseInput({
        action: "tools",
        liveToolCalls: [{ callId: "orphan", toolName: "x", status: "running" }],
        messages: [assistantMsg("m")],
      }),
    );
    expect(noTrace).toBeNull();
  });

  it("exercises ConversationTopbarAction union for type coverage", () => {
    const actions: ConversationTopbarAction[] = [
      "tools",
      "parallel",
      "ask_user",
      "context",
      "progress",
      "approval",
      "blocked_output",
      "restore",
    ];
    for (const action of actions) {
      resolveConversationTopbarTarget(baseInput({ action }));
    }
    expect(actions).toHaveLength(8);
  });
});
