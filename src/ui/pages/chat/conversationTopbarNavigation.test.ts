import { describe, expect, it } from "vitest";

import type { OrchestrationPlan } from "../../../orchestrator/types";
import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { ConversationTopbarAction } from "./ConversationTopbar";
import { resolveConversationTopbarTarget } from "./conversationTopbarNavigation";
import type { LiveToolCall } from "./types";

function baseInput(
  overrides: Partial<Parameters<typeof resolveConversationTopbarTarget>[0]> = {},
): Parameters<typeof resolveConversationTopbarTarget>[0] {
  return {
    action: "context",
    messages: [],
    activePlan: null,
    liveToolCalls: [],
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

  it("progress resolves to active plan target when present, else null", () => {
    const plan: OrchestrationPlan = {
      state: "executing",
      prompt: "p",
      steps: [{ id: "s1", title: "t", summary: "", owner: "coder", status: "in_progress" }],
      proposedActions: [],
    };
    const withPlan = assistantMsg("with-plan", { plan });
    const r1 = resolveConversationTopbarTarget(
      baseInput({ action: "progress", messages: [withPlan], activePlan: plan }),
    );
    expect(r1).toEqual({ anchor: "plan", messageId: "with-plan" });

    const r2 = resolveConversationTopbarTarget(
      baseInput({
        action: "progress",
        messages: [],
        activePlan: null,
      }),
    );
    expect(r2).toBeNull();
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
    const plan: OrchestrationPlan = {
      state: "executing",
      prompt: "p",
      steps: [{ id: "s1", title: "Test", summary: "", owner: "coder", status: "failed" }],
      proposedActions: [],
    };
    const planMsg = assistantMsg("plan-msg", { plan });
    const r = resolveConversationTopbarTarget(
      baseInput({
        action: "blocked_output",
        messages: [planMsg],
        activePlan: plan,
      }),
    );
    expect(r).toEqual({
      anchor: "blocked_output",
      messageId: "plan-msg",
    });
  });

  it("missing targets return null", () => {
    expect(resolveConversationTopbarTarget(baseInput({ action: "tools" }))).toBeNull();
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
    expect(actions).toHaveLength(7);
  });
});
