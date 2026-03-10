import { describe, expect, it } from "vitest";

import {
  appendRunningShellOutput,
  commentAction,
  completeRunningShellAction,
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

function createSingleShellStepPlan(): OrchestrationPlan {
  return {
    state: "human_review",
    prompt: "clear workspace",
    steps: [
      {
        id: "step-clean",
        title: "清空工作区",
        summary: "删除当前目录下所有文件",
        owner: "coder",
        status: "pending",
      },
    ],
    proposedActions: [
      {
        id: "shell-clean",
        type: "shell",
        description: "删除当前目录下所有文件",
        gateRequired: true,
        status: "pending",
        executed: false,
        planStepId: "step-clean",
        payload: {
          shell: "rm -rf ./* ./.??*",
          timeoutMs: 120000,
        },
      },
    ],
  };
}

function createMultiActionSingleStepPlan(): OrchestrationPlan {
  return {
    state: "human_review",
    prompt: "apply patch and run tests",
    steps: [
      {
        id: "step-ship",
        title: "完成交付",
        summary: "修改代码并验证",
        owner: "coder",
        status: "pending",
      },
    ],
    proposedActions: [
      {
        id: "patch-ship",
        type: "apply_patch",
        description: "更新实现",
        gateRequired: true,
        status: "pending",
        executed: false,
        planStepId: "step-ship",
        payload: {
          patch: "diff --git a/src/app.ts b/src/app.ts\n",
        },
      },
      {
        id: "shell-ship",
        type: "shell",
        description: "运行验证命令",
        gateRequired: true,
        status: "pending",
        executed: false,
        planStepId: "step-ship",
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

  it("appends running shell output without leaving executing state", () => {
    const runningPlan = markActionRunning(createTodoLinkedPlan(), "shell-1");
    const withStdout = appendRunningShellOutput(runningPlan, "shell-1", {
      command: "npm test",
      stream: "stdout",
      chunk: "line 1\n",
    });
    const withBoth = appendRunningShellOutput(withStdout, "shell-1", {
      command: "npm test",
      stream: "stderr",
      chunk: "warn\n",
    });

    const shellAction = withBoth.proposedActions.find((action) => action.id === "shell-1");
    expect(withBoth.state).toBe("executing");
    expect(shellAction?.status).toBe("running");
    expect(shellAction?.executionResult?.message).toBe("命令执行中…");
    expect(shellAction?.executionResult?.metadata).toMatchObject({
      command: "npm test",
      stdout: "line 1\n",
      stderr: "warn\n",
    });
  });

  it("completes a running shell action from an externally supplied result", () => {
    const runningPlan = markActionRunning(createTodoLinkedPlan(), "shell-1");
    const completedPlan = completeRunningShellAction(
      runningPlan,
      "shell-1",
      "/tmp/workspace",
      {
        success: true,
        command: "npm test",
        timed_out: false,
        status: 0,
        stdout: "ok",
        stderr: "",
      },
    );

    const shellAction = completedPlan.proposedActions.find((action) => action.id === "shell-1");
    expect(completedPlan.state).toBe("human_review");
    expect(shellAction?.status).toBe("completed");
    expect(shellAction?.executed).toBe(true);
    expect(shellAction?.executionResult?.metadata).toMatchObject({
      stdout: "ok",
      status: 0,
      timedOut: false,
      timed_out: false,
    });
  });

  it("marks a single-action shell step completed after success", () => {
    const runningPlan = markActionRunning(createSingleShellStepPlan(), "shell-clean");
    const completedPlan = completeRunningShellAction(
      runningPlan,
      "shell-clean",
      "/tmp/workspace",
      {
        success: true,
        command: "rm -rf ./* ./.??*",
        timed_out: false,
        status: 0,
        stdout: "",
        stderr: "",
      },
    );

    expect(completedPlan.state).toBe("done");
    expect(completedPlan.activeStepId).toBeUndefined();
    expect(completedPlan.steps[0].status).toBe("completed");
    expect(completedPlan.steps[0].note).toContain("审批动作执行成功：命令执行成功");
  });

  it("keeps the step in progress when sibling actions are still pending", () => {
    const runningPlan = markActionRunning(
      createMultiActionSingleStepPlan(),
      "shell-ship",
    );
    const completedPlan = completeRunningShellAction(
      runningPlan,
      "shell-ship",
      "/tmp/workspace",
      {
        success: true,
        command: "npm test",
        timed_out: false,
        status: 0,
        stdout: "ok",
        stderr: "",
      },
    );

    expect(completedPlan.state).toBe("human_review");
    expect(completedPlan.activeStepId).toBe("step-ship");
    expect(completedPlan.steps[0].status).toBe("in_progress");
    expect(completedPlan.steps[0].note).toContain("审批动作执行成功：命令执行成功");
  });
});
