import { describe, expect, it } from "vitest";

import { markActionExecutionError } from "./execution";
import type { OrchestrationPlan } from "../../../orchestrator/types";

describe("markActionExecutionError", () => {
  it("syncs linked todo steps when action execution throws", () => {
    const plan: OrchestrationPlan = {
      state: "executing",
      prompt: "run linked action",
      steps: [
        {
          id: "step-1",
          title: "执行审批动作",
          summary: "执行审批动作",
          status: "in_progress",
        },
      ],
      activeStepId: "step-1",
      proposedActions: [
        {
          id: "shell-1",
          type: "shell",
          description: "Run command",
          gateRequired: true,
          status: "running",
          executed: false,
          planStepId: "step-1",
          payload: {
            shell: "npm test",
            timeoutMs: 1000,
          },
        },
      ],
    };

    const nextPlan = markActionExecutionError(plan, "shell-1", "spawn failed");

    expect(nextPlan.state).toBe("human_review");
    expect(nextPlan.activeStepId).toBeUndefined();
    expect(nextPlan.proposedActions[0].status).toBe("failed");
    expect(nextPlan.steps[0].status).toBe("failed");
    expect(nextPlan.steps[0].note).toContain("spawn failed");
  });
});
