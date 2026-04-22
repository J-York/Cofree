import { describe, expect, it } from "vitest";
import { normalizeOrchestrationPlan } from "./planGuards";

describe("normalizeOrchestrationPlan", () => {
  it("restores todo step lifecycle fields and linked action ids", () => {
    const plan = normalizeOrchestrationPlan({
      state: "planning",
      prompt: "实现 todo",
      activeStepId: "step-2",
      steps: [
        {
          id: "step-1",
          title: "分析需求",
          summary: "梳理范围",
          owner: "planner",
          status: "completed",
          linkedActionIds: ["action-1"],
          completedAt: "2026-03-09T00:00:00.000Z",
        },
        {
          id: "step-2",
          summary: "执行实现",
          owner: "coder",
          status: "in_progress",
          dependsOn: ["step-1"],
          note: "处理中",
        },
      ],
      proposedActions: [
        {
          id: "action-1",
          type: "shell",
          description: "run tests",
          gateRequired: true,
          status: "pending",
          executed: false,
          planStepId: "step-2",
          payload: {
            shell: "npm test",
            timeoutMs: 120000,
          },
        },
      ],
    });

    expect(plan).not.toBeNull();
    expect(plan?.activeStepId).toBe("step-2");
    expect(plan?.steps[0]).toMatchObject({
      title: "分析需求",
      status: "completed",
      linkedActionIds: ["action-1"],
    });
    expect(plan?.steps[1]).toMatchObject({
      title: "执行实现",
      status: "in_progress",
      dependsOn: ["step-1"],
      note: "处理中",
    });
    expect(plan?.proposedActions[0]).toMatchObject({
      planStepId: "step-2",
    });
  });

  it("normalizes unknown action origins to undefined", () => {
    const plan = normalizeOrchestrationPlan({
      state: "human_review",
      prompt: "恢复审批",
      steps: [],
      proposedActions: [
        {
          id: "action-1",
          type: "apply_patch",
          description: "修改 src/app.ts",
          gateRequired: true,
          status: "pending",
          executed: false,
          origin: "main_agent",
          payload: {
            patch: "*** Begin Patch\n*** End Patch\n",
          },
        },
      ],
    });

    expect(plan?.proposedActions[0]).toMatchObject({
      origin: "main_agent",
    });
  });

  it("normalizes step owners to planner in single-agent mode", () => {
    const plan = normalizeOrchestrationPlan({
      state: "planning",
      prompt: "test",
      steps: [
        {
          id: "step-1",
          title: "分析",
          summary: "分析",
          owner: "coder",
          status: "pending",
        },
      ],
      proposedActions: [],
    });

    expect(plan?.steps[0]?.owner).toBe("planner");
  });
});