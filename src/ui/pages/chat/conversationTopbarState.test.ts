import { describe, expect, it } from "vitest";

import type { OrchestrationPlan, PlanStep } from "../../../orchestrator/types";
import type { LiveToolCall } from "./types";
import {
  deriveConversationTopbarState,
  type ConversationTopbarState,
} from "./conversationTopbarState";

const baseAgent = "通用 Agent";

function liveTool(overrides: Partial<LiveToolCall> = {}): LiveToolCall {
  return {
    callId: "t1",
    toolName: "read_file",
    status: "running",
    ...overrides,
  };
}

function planStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "s1",
    title: "Step",
    summary: "",
    status: "pending",
    ...overrides,
  };
}

function orchestrationPlan(overrides: Partial<OrchestrationPlan> = {}): OrchestrationPlan {
  return {
    state: "executing",
    prompt: "p",
    steps: [],
    proposedActions: [],
    ...overrides,
  };
}

function derive(
  partial: Partial<Parameters<typeof deriveConversationTopbarState>[0]> = {},
): ConversationTopbarState {
  return deriveConversationTopbarState({
    agentLabel: baseAgent,
    isStreaming: false,
    liveToolCalls: [],
    activePlan: null,
    hasAskUserPending: false,
    hasRestoreNotice: false,
    sessionNote: "",
    ...partial,
  });
}

describe("deriveConversationTopbarState", () => {
  it("idle chat uses idle mode with no progress or attention", () => {
    const s = derive();
    expect(s.mode).toBe("idle");
    expect(s.source).toBe("idle");
    expect(s.progress.visible).toBe(false);
    expect(s.attention).toBeNull();
    expect(s.badges).toEqual([]);
  });

  it("active mode streaming without tools is compact row-1-only", () => {
    const s = derive({ isStreaming: true });
    expect(s.mode).toBe("active");
    expect(s.source).toBe("assistant");
    expect(s.progress.visible).toBe(false);
    expect(s.attention).toBeNull();
    expect(s.primaryLabel).toContain("正在回答");
    expect(s.primaryLabel).not.toContain(baseAgent);
    expect(s.agentLabel).toBe(baseAgent);
  });

  it("active mode with live tools uses source tools", () => {
    const s = derive({
      isStreaming: true,
      liveToolCalls: [liveTool(), liveTool({ callId: "t2", toolName: "grep" })],
    });
    expect(s.mode).toBe("active");
    expect(s.source).toBe("tools");
    expect(s.badges.some((b) => b.key === "tools" || b.action === "tools")).toBe(true);
  });

  it("waiting for ask-user keeps active mode and surfaces ask-user attention on row 3", () => {
    const s = derive({ isStreaming: true, hasAskUserPending: true });
    expect(s.mode).toBe("active");
    expect(s.attention).not.toBeNull();
    expect(s.attention?.level).toBe("warning");
    expect(s.attention?.ctaAction).toBe("ask_user");
    expect(s.attention?.message).toMatch(/输入|回复/);
  });

  it("suppresses row-1 approval badge when approval attention is shown", () => {
    const s = derive({
      activePlan: orchestrationPlan({
        state: "human_review",
        proposedActions: [
          {
            id: "a1",
            type: "shell",
            description: "Run",
            gateRequired: true,
            status: "pending",
            executed: false,
            payload: { shell: "pnpm test", timeoutMs: 1 },
          },
        ],
      }),
    });
    expect(s.attention?.ctaAction).toBe("approval");
    expect(s.badges.some((b) => b.key === "approval" || b.label.includes("审批"))).toBe(false);
  });

  it("approval-only activePlan stays in active mode", () => {
    const s = derive({
      activePlan: orchestrationPlan({
        state: "human_review",
        proposedActions: [
          {
            id: "a1",
            type: "shell",
            description: "Run",
            gateRequired: true,
            status: "pending",
            executed: false,
            payload: { shell: "pnpm test", timeoutMs: 1 },
          },
        ],
      }),
    });
    expect(s.mode).toBe("active");
    expect(s.source).toBe("assistant");
    expect(s.attention?.ctaAction).toBe("approval");
  });

  it("unresolved executing plan stays active instead of idle", () => {
    const s = derive({
      activePlan: orchestrationPlan({
        state: "executing",
      }),
    });
    expect(s.mode).toBe("active");
    expect(s.source).toBe("assistant");
    expect(s.attention).toBeNull();
    expect(s.primaryLabel).toBe("正在处理");
  });

  it("executing plan with running actions stays active", () => {
    const s = derive({
      activePlan: orchestrationPlan({
        state: "executing",
        proposedActions: [
          {
            id: "a1",
            type: "shell",
            description: "Run",
            gateRequired: true,
            status: "running",
            executed: true,
            payload: { shell: "pnpm test", timeoutMs: 1 },
          },
        ],
      }),
    });
    expect(s.mode).toBe("active");
  });

  it("collapses multiple attention candidates with priority and extraCount", () => {
    const s = derive({
      activePlan: orchestrationPlan({
        state: "human_review",
        proposedActions: [
          {
            id: "a1",
            type: "shell",
            description: "Run",
            gateRequired: true,
            status: "pending",
            executed: false,
            payload: { shell: "x", timeoutMs: 1 },
          },
        ],
      }),
      hasRestoreNotice: true,
      hasAskUserPending: false,
    });
    expect(s.attention?.message).toMatch(/审批/);
    expect(s.attention?.extraCount).toBeGreaterThanOrEqual(1);
  });

  it("ask_user beats approval; approval appears as extra", () => {
    const s = derive({
      hasAskUserPending: true,
      activePlan: orchestrationPlan({
        state: "human_review",
        proposedActions: [
          {
            id: "a1",
            type: "shell",
            description: "Run",
            gateRequired: true,
            status: "pending",
            executed: false,
            payload: { shell: "x", timeoutMs: 1 },
          },
        ],
      }),
    });
    expect(s.attention?.ctaAction).toBe("ask_user");
    expect(s.attention?.extraCount).toBeGreaterThanOrEqual(1);
  });

  it("blocked beats ask_user and approval", () => {
    const s = derive({
      hasAskUserPending: true,
      activePlan: orchestrationPlan({
        state: "human_review",
        steps: [planStep({ id: "x", title: "验证", status: "failed" })],
        proposedActions: [
          {
            id: "a1",
            type: "shell",
            description: "Run",
            gateRequired: true,
            status: "pending",
            executed: false,
            payload: { shell: "x", timeoutMs: 1 },
          },
        ],
      }),
    });
    expect(s.attention?.level).toBe("blocked");
    expect(s.attention?.ctaAction).toBe("blocked_output");
    expect(s.attention?.extraCount).toBeGreaterThanOrEqual(1);
  });

  it("non-team done plan does not use orchestration completion copy", () => {
    const s = derive({
      activePlan: orchestrationPlan({
        state: "done",
      }),
    });
    expect(s.mode).toBe("idle");
    expect(s.primaryLabel).toBe("已就绪");
    expect(s.primaryLabel).not.toBe("本轮编排已完成");
  });

  it("never drops to idle while attention is visible", () => {
    const s = derive({ hasRestoreNotice: true });
    expect(s.attention).not.toBeNull();
    expect(s.mode).not.toBe("idle");
  });

  it("trimmed sessionNote alone uses active mode so informational attention shows on row 3", () => {
    const s = derive({ sessionNote: "  会话提示  " });
    expect(s.mode).toBe("active");
    expect(s.source).toBe("assistant");
    expect(s.primaryLabel).toBe("已就绪");
    expect(s.attention?.level).toBe("info");
    expect(s.attention?.message).toBe("会话提示");
    expect(s.attention?.ctaAction).toBeUndefined();
  });

  it("suppresses sessionNote informational when restore notice is active", () => {
    const s = derive({
      sessionNote: "应被忽略",
      hasRestoreNotice: true,
    });
    expect(s.attention?.ctaAction).toBe("restore");
    expect(s.attention?.message).toMatch(/恢复|进度/);
    expect(s.attention?.message).not.toContain("应被忽略");
  });

  it("failed plan steps produce blocked attention", () => {
    const s = derive({
      activePlan: orchestrationPlan({
        state: "executing",
        steps: [planStep({ title: "验证", status: "failed" })],
      }),
    });
    expect(s.primaryLabel).toBe("正在处理");
    expect(s.attention?.level).toBe("blocked");
    expect(s.attention?.ctaAction).toBe("blocked_output");
  });
});