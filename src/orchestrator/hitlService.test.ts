import { describe, expect, it } from "vitest";

import {
  commentAction,
  deriveWorkflowState,
  markActionRunning,
  rejectAction,
  rejectAllPendingActions,
} from "./hitlService";
import type { OrchestrationPlan } from "./types";

function createTodoLinkedPlan(): OrchestrationPlan {
  return {
    state: "human_review",
    prompt: "implement todo-linked approvals",
    steps: [
      {
        id: "step-edit",
        title: "编辑文件",
        summary: "修改代码并准备补丁",
        owner: "coder",
        status: "pending",
      },
      {
        id: "step-verify",
        title: "验证结果",
        summary: "运行验证命令",
        owner: "tester",
        status: "pending",
        dependsOn: ["step-edit"],
      },
    ],
    proposedActions: [
      {
        id: "patch-1",
        type: "apply_patch",
        description: "更新主实现文件",
        gateRequired: true,
        status: "pending",
        executed: false,
        planStepId: "step-edit",
        payload: {
          patch: "diff --git a/src/app.ts b/src/app.ts\n",
        },
      },
      {
        id: "shell-1",
        type: "shell",
        description: "运行验证命令",
        gateRequired: true,
        status: "pending",
        executed: false,
        planStepId: "step-verify",
        payload: {
          shell: "npm test",
          timeoutMs: 1000,
        },
      },
    ],
  };
}

describe("hitlService todo synchronization", () => {
  it("marks the linked step in progress when an action starts running", () => {
    const nextPlan = markActionRunning(createTodoLinkedPlan(), "patch-1");

    expect(nextPlan.state).toBe("executing");
    expect(nextPlan.activeStepId).toBe("step-edit");
    expect(nextPlan.steps[0].status).toBe("in_progress");
    expect(nextPlan.steps[0].linkedActionIds).toEqual(["patch-1"]);
  });

  it("marks the linked step blocked when an action is rejected", () => {
    const nextPlan = rejectAction(createTodoLinkedPlan(), "patch-1", "需要先补测试");

    expect(nextPlan.state).toBe("human_review");
    expect(nextPlan.activeStepId).toBeUndefined();
    expect(nextPlan.steps[0].status).toBe("blocked");
    expect(nextPlan.steps[0].note).toContain("需要先补测试");
  });

  it("appends reviewer comments to the linked step note", () => {
    const nextPlan = commentAction(
      createTodoLinkedPlan(),
      "patch-1",
      "先拆出 helper，再提交 patch",
    );

    expect(nextPlan.state).toBe("human_review");
    expect(nextPlan.steps[0].status).toBe("pending");
    expect(nextPlan.steps[0].note).toContain("先拆出 helper");
  });

  it("blocks all linked steps when rejecting all pending actions", () => {
    const nextPlan = rejectAllPendingActions(createTodoLinkedPlan(), "方案需要重做");

    expect(nextPlan.state).toBe("planning");
    expect(nextPlan.activeStepId).toBeUndefined();
    expect(nextPlan.steps[0].status).toBe("blocked");
    expect(nextPlan.steps[1].status).toBe("blocked");
    expect(nextPlan.steps[0].note).toContain("方案需要重做");
    expect(nextPlan.steps[1].note).toContain("方案需要重做");
  });

  it("derives workflow state from todo steps when there are no pending actions", () => {
    expect(
      deriveWorkflowState([], {
        steps: [
          {
            id: "step-active",
            title: "继续执行",
            summary: "继续执行",
            owner: "coder",
            status: "in_progress",
          },
        ],
        activeStepId: "step-active",
      }),
    ).toBe("executing");

    expect(
      deriveWorkflowState([], {
        steps: [
          {
            id: "step-blocked",
            title: "等待修正",
            summary: "等待修正",
            owner: "coder",
            status: "blocked",
          },
        ],
      }),
    ).toBe("planning");
  });
});
