import { describe, expect, it } from "vitest";

import type { OrchestrationPlan, PlanStep } from "../../../orchestrator/types";
import type { LiveToolCall, SubAgentStatusItem } from "./types";
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
    owner: "coder",
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

function subAgentItem(
  lastEvent: SubAgentStatusItem["lastEvent"],
  overrides: Partial<SubAgentStatusItem> = {},
): SubAgentStatusItem {
  return {
    id: "team:stage",
    label: "Stage",
    role: "coder",
    lastEvent,
    updatedAt: 1,
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
    subAgentStatus: [],
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

  it("single-agent streaming without tools is compact row-1-only", () => {
    const s = derive({ isStreaming: true });
    expect(s.mode).toBe("single_agent");
    expect(s.source).toBe("assistant");
    expect(s.progress.visible).toBe(false);
    expect(s.attention).toBeNull();
    expect(s.primaryLabel).toContain("正在回答");
    expect(s.primaryLabel).not.toContain(baseAgent);
    expect(s.agentLabel).toBe(baseAgent);
  });

  it("primaryLabel never mixes in the agent label prefix", () => {
    const s = derive({
      subAgentStatus: [
        subAgentItem({
          kind: "thinking",
          partialContent: "",
          currentStageIndex: 2,
          totalStages: 4,
          completedStageCount: 1,
          activeParallelCount: 1,
          stageLabel: "实现",
        }),
      ],
    });
    expect(s.primaryLabel).toBe("当前：实现");
    expect(s.primaryLabel).not.toContain(baseAgent);
    expect(s.agentLabel).toBe(baseAgent);
  });

  it("single-agent with live tools uses source tools", () => {
    const s = derive({
      isStreaming: true,
      liveToolCalls: [liveTool(), liveTool({ callId: "t2", toolName: "grep" })],
    });
    expect(s.mode).toBe("single_agent");
    expect(s.source).toBe("tools");
    expect(s.badges.some((b) => b.key === "tools" || b.action === "tools")).toBe(true);
  });

  it("single-agent waiting for ask-user keeps single_agent and surfaces ask-user attention on row 3", () => {
    const s = derive({ isStreaming: true, hasAskUserPending: true });
    expect(s.mode).toBe("single_agent");
    expect(s.attention).not.toBeNull();
    expect(s.attention?.level).toBe("warning");
    expect(s.attention?.ctaAction).toBe("ask_user");
    expect(s.attention?.message).toMatch(/输入|回复/);
  });

  it("orchestrated team progress uses structured metadata for row-2 current/total", () => {
    const s = derive({
      activePlan: orchestrationPlan(),
      subAgentStatus: [
        subAgentItem({
          kind: "thinking",
          partialContent: "",
          currentStageIndex: 4,
          totalStages: 6,
          completedStageCount: 3,
          activeParallelCount: 1,
          stageLabel: "代码实现",
        }),
      ],
    });
    expect(s.mode).toBe("orchestrating");
    expect(s.source).toBe("team");
    expect(s.progress.visible).toBe(true);
    expect(s.progress.current).toBe(4);
    expect(s.progress.total).toBe(6);
    expect(s.primaryLabel).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(s.primaryLabel).toMatch(/当前：代码实现/);
  });

  it("active team execution stays orchestrating without trustworthy numeric progress", () => {
    const s = derive({
      subAgentStatus: [
        subAgentItem({
          kind: "thinking",
          partialContent: "",
          stageLabel: "模糊阶段",
        }),
      ],
    });
    expect(s.mode).toBe("orchestrating");
    expect(s.source).toBe("team");
    expect(s.progress.current).toBeUndefined();
    expect(s.progress.total).toBeUndefined();
    expect(s.primaryLabel).toMatch(/正在编排/);
  });

  it("prefers orchestrating team source when team execution and live tools coexist", () => {
    const s = derive({
      isStreaming: true,
      liveToolCalls: [liveTool()],
      subAgentStatus: [
        subAgentItem({
          kind: "tool_start",
          toolName: "x",
          turn: 1,
          maxTurns: 4,
          currentStageIndex: 2,
          totalStages: 5,
          completedStageCount: 1,
          activeParallelCount: 1,
          stageLabel: "实现",
        }),
      ],
    });
    expect(s.mode).toBe("orchestrating");
    expect(s.source).toBe("team");
  });

  it("never embeds numeric stage fraction in primaryLabel", () => {
    const s = derive({
      activePlan: orchestrationPlan(),
      subAgentStatus: [
        subAgentItem({
          kind: "summary",
          message: "ok",
          currentStageIndex: 4,
          totalStages: 6,
          completedStageCount: 3,
          activeParallelCount: 1,
          stageLabel: "测试验证",
        }),
      ],
    });
    expect(s.primaryLabel).not.toContain("4/6");
  });

  it("uses non-numeric row-2 fallback that does not repeat row 1 when primary is degraded", () => {
    const s = derive({
      activePlan: orchestrationPlan(),
      subAgentStatus: [
        subAgentItem({
          kind: "thinking",
          partialContent: "",
          stageLabel: "实现",
        }),
      ],
    });
    expect(s.primaryLabel).toMatch(/正在编排/);
    expect(s.progress.visible).toBe(true);
    expect(s.progress.label).toBeTruthy();
    expect(s.progress.label).not.toBe(s.primaryLabel);
    expect(s.progress.label).not.toMatch(/\d+\s*\/\s*\d+/);
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

  it("single-agent approval-only activePlan stays single_agent", () => {
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
            origin: "main_agent",
            payload: { shell: "pnpm test", timeoutMs: 1 },
          },
        ],
      }),
    });
    expect(s.mode).toBe("single_agent");
    expect(s.source).toBe("assistant");
    expect(s.attention?.ctaAction).toBe("approval");
  });

  it("unresolved non-team executing plan stays active single_agent instead of idle", () => {
    const s = derive({
      activePlan: orchestrationPlan({
        state: "executing",
      }),
    });
    expect(s.mode).toBe("single_agent");
    expect(s.mode).not.toBe("idle");
    expect(s.source).toBe("assistant");
    expect(s.attention).toBeNull();
    expect(s.primaryLabel).toBe("正在处理");
  });

  it("executing plan without subAgentStatus or team-origin actions is not orchestrating", () => {
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
            origin: "main_agent",
            payload: { shell: "pnpm test", timeoutMs: 1 },
          },
        ],
      }),
    });
    expect(s.mode).toBe("single_agent");
    expect(s.mode).not.toBe("orchestrating");
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
      subAgentStatus: [
        subAgentItem({
          kind: "stage_complete",
          stageLabel: "验证",
          agentRole: "tester",
          summary: "fail",
          stageStatus: "failed",
        }),
      ],
    });
    expect(s.attention?.level).toBe("blocked");
    expect(s.attention?.ctaAction).toBe("blocked_output");
    expect(s.attention?.extraCount).toBeGreaterThanOrEqual(1);
  });

  it("completed workflow uses completion primary and keeps fraction in progress or badge", () => {
    const s = derive({
      liveToolCalls: [liveTool()],
      activePlan: orchestrationPlan({
        state: "done",
        steps: Array.from({ length: 6 }, (_, i) =>
          planStep({ id: `s${i}`, title: `S${i}`, status: "completed" }),
        ),
      }),
      subAgentStatus: [
        subAgentItem(
          {
            kind: "stage_complete",
            stageLabel: "末阶段",
            agentRole: "verifier",
            summary: "done",
            stageStatus: "completed",
            currentStageIndex: 6,
            totalStages: 6,
            completedStageCount: 6,
            activeParallelCount: 1,
          },
          { updatedAt: 10 },
        ),
      ],
    });
    expect(s.primaryLabel).toMatch(/本轮编排已完成/);
    expect(s.primaryLabel).not.toMatch(/\d+\s*\/\s*\d+/);
    const numericInProgressOrBadge =
      (s.progress.current === 6 && s.progress.total === 6) ||
      s.badges.some((b) => /\d+\s*\/\s*\d+/.test(b.label));
    expect(numericInProgressOrBadge).toBe(true);
    expect(s.badges.some((b) => b.action === "parallel")).toBe(false);
    expect(s.badges.some((b) => b.key === "tools" || b.action === "tools")).toBe(false);
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

  it("completed orchestrating state without trustworthy numeric does not show in-progress row 2 fallback", () => {
    const s = derive({
      activePlan: orchestrationPlan({
        state: "done",
        proposedActions: [
          {
            id: "a1",
            type: "shell",
            description: "Run",
            gateRequired: true,
            status: "completed",
            executed: true,
            origin: "team_stage",
            payload: { shell: "pnpm test", timeoutMs: 1 },
          },
        ],
      }),
    });
    expect(s.mode).toBe("orchestrating");
    expect(s.primaryLabel).toBe("本轮编排已完成");
    expect(s.progress.visible).toBe(false);
    expect(s.progress.label).toBeUndefined();
  });

  it("never drops to idle while attention is visible", () => {
    const s = derive({ hasRestoreNotice: true });
    expect(s.attention).not.toBeNull();
    expect(s.mode).not.toBe("idle");
  });

  it("trimmed sessionNote alone uses single_agent so informational attention shows on row 3", () => {
    const s = derive({ sessionNote: "  会话提示  " });
    expect(s.mode).toBe("single_agent");
    expect(s.source).toBe("assistant");
    expect(s.primaryLabel).toBe("已就绪");
    expect(s.attention?.level).toBe("info");
    expect(s.attention?.message).toBe("会话提示");
    expect(s.attention?.ctaAction).toBeUndefined();
  });

  it("does not add sessionNote as informational attention during orchestrating context", () => {
    const s = derive({
      sessionNote: "编排时不显示此条",
      activePlan: orchestrationPlan(),
      subAgentStatus: [
        subAgentItem({
          kind: "thinking",
          partialContent: "",
          currentStageIndex: 1,
          totalStages: 3,
          completedStageCount: 0,
          activeParallelCount: 1,
          stageLabel: "阶段一",
        }),
      ],
    });
    expect(s.mode).toBe("orchestrating");
    expect(s.attention).toBeNull();
    expect(s.primaryLabel).toMatch(/当前：阶段一/);
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

  it("interrupted orchestration hides untrusted numeric progress and shows blocked row 3", () => {
    const s = derive({
      activePlan: orchestrationPlan({
        state: "executing",
        steps: [planStep({ title: "验证", status: "failed" })],
      }),
      subAgentStatus: [
        subAgentItem({
          kind: "stage_complete",
          stageLabel: "验证",
          agentRole: "tester",
          summary: "boom",
          stageStatus: "failed",
          currentStageIndex: 4,
          totalStages: 6,
        }),
      ],
    });
    expect(s.primaryLabel).toMatch(/上次阶段：验证|编排已中断/);
    expect(s.progress.current).toBeUndefined();
    expect(s.progress.total).toBeUndefined();
    expect(s.attention?.level).toBe("blocked");
    expect(s.attention?.ctaAction).toBe("blocked_output");
  });

  it("missing structured metadata degrades to orchestrating copy without guessed current/total", () => {
    const s = derive({
      activePlan: orchestrationPlan({
        proposedActions: [
          {
            id: "a1",
            type: "shell",
            description: "Run",
            gateRequired: true,
            status: "running",
            executed: true,
            origin: "team_stage",
            payload: { shell: "pnpm test", timeoutMs: 1 },
          },
        ],
      }),
    });
    expect(s.mode).toBe("orchestrating");
    expect(s.primaryLabel).toMatch(/正在编排/);
    expect(s.progress.current).toBeUndefined();
    expect(s.progress.total).toBeUndefined();
  });

  it("subAgentStatus without trustworthy team signal does not force orchestrating", () => {
    const s = derive({
      subAgentStatus: [
        subAgentItem({
          kind: "summary",
          message: "普通摘要",
        }),
      ],
    });
    expect(s.mode).toBe("idle");
    expect(s.source).toBe("idle");
    expect(s.progress.visible).toBe(false);
  });

  it("subAgentStatus item with only loose numeric meta does not alone force orchestrating", () => {
    const looseNumeric = derive({
      subAgentStatus: [
        subAgentItem({
          kind: "summary",
          message: "普通摘要",
          completedStageCount: 2,
          activeParallelCount: 1,
        }),
      ],
    });
    expect(looseNumeric.mode).toBe("idle");
    expect(looseNumeric.mode).not.toBe("orchestrating");

    const looseParallelOnly = derive({
      subAgentStatus: [
        subAgentItem({
          kind: "thinking",
          partialContent: "thinking…",
          activeParallelCount: 2,
        }),
      ],
    });
    expect(looseParallelOnly.mode).toBe("idle");
    expect(looseParallelOnly.mode).not.toBe("orchestrating");
  });

  it("completed orchestration with live tools hides tools badge and row-2 in-progress copy when numeric is untrusted", () => {
    const s = derive({
      liveToolCalls: [liveTool()],
      activePlan: orchestrationPlan({
        state: "done",
        proposedActions: [
          {
            id: "a1",
            type: "shell",
            description: "Run",
            gateRequired: true,
            status: "completed",
            executed: true,
            origin: "team_stage",
            payload: { shell: "pnpm test", timeoutMs: 1 },
          },
        ],
      }),
      subAgentStatus: [
        subAgentItem({
          kind: "thinking",
          partialContent: "",
          stageLabel: "收尾",
        }),
      ],
    });
    expect(s.primaryLabel).toBe("本轮编排已完成");
    expect(s.progress.visible).toBe(false);
    expect(s.progress.label).toBeUndefined();
    expect(s.badges.some((b) => b.key === "tools" || b.action === "tools")).toBe(false);
  });

  it("restore notice stays informational row 3 without replacing primary orchestration summary", () => {
    const s = derive({
      activePlan: orchestrationPlan(),
      hasRestoreNotice: true,
      subAgentStatus: [
        subAgentItem({
          kind: "thinking",
          partialContent: "",
          stageLabel: "实现",
          currentStageIndex: 2,
          totalStages: 4,
          completedStageCount: 1,
          activeParallelCount: 1,
        }),
      ],
    });
    expect(s.primaryLabel).toMatch(/当前：实现/);
    expect(s.attention?.level).toBe("info");
    expect(s.attention?.ctaAction).toBe("restore");
    expect(s.attention?.message).toMatch(/恢复|进度/);
  });

  it("emits progress segments completed/active/pending and can mark blocked", () => {
    const s = derive({
      activePlan: orchestrationPlan(),
      subAgentStatus: [
        subAgentItem({
          kind: "thinking",
          partialContent: "",
          currentStageIndex: 3,
          totalStages: 5,
          completedStageCount: 2,
          activeParallelCount: 1,
          stageLabel: "审查",
        }),
      ],
    });
    expect(s.progress.segments).toEqual([
      "completed",
      "completed",
      "active",
      "pending",
      "pending",
    ]);

    const blocked = derive({
      activePlan: orchestrationPlan({
        steps: [planStep({ id: "b", title: "坏阶段", status: "blocked" })],
      }),
      subAgentStatus: [
        subAgentItem({
          kind: "thinking",
          partialContent: "",
          currentStageIndex: 2,
          totalStages: 4,
          completedStageCount: 1,
          activeParallelCount: 1,
          stageLabel: "坏阶段",
        }),
      ],
    });
    expect(blocked.progress.segments?.some((x) => x === "blocked")).toBe(true);
  });

  it("keeps current/total but does not guess parallel width when activeParallelCount is missing", () => {
    const s = derive({
      subAgentStatus: [
        subAgentItem({
          kind: "thinking",
          partialContent: "",
          currentStageIndex: 2,
          totalStages: 5,
          completedStageCount: 1,
          stageLabel: "实现",
        }),
      ],
    });
    expect(s.mode).toBe("orchestrating");
    expect(s.progress.current).toBe(2);
    expect(s.progress.total).toBe(5);
    expect(s.progress.segments).toBeUndefined();
    expect(s.badges.some((badge) => badge.key === "parallel")).toBe(false);
  });
});
