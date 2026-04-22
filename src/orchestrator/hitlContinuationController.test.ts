import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./checkpointStore", () => ({
  saveWorkflowCheckpoint: vi.fn(),
}));

import { saveWorkflowCheckpoint } from "./checkpointStore";
import {
  advanceAfterHitl,
  resetHitlContinuationMemory,
} from "./hitlContinuationController";
import type { OrchestrationPlan } from "./types";

function createCompletedShellPlan(): OrchestrationPlan {
  return {
    state: "done",
    prompt: "new a music app frontend",
    steps: [
      {
        id: "step-scaffold",
        title: "Scaffold project",
        summary: "Initialize the frontend project",
        status: "completed",
      },
    ],
    proposedActions: [
      {
        id: "shell-1",
        type: "shell",
        description: "Initialize project",
        gateRequired: true,
        status: "completed",
        executed: true,
        planStepId: "step-scaffold",
        toolName: "propose_shell",
        toolCallId: "tool-shell-1",
        executionResult: {
          success: true,
          message: "命令执行成功",
          timestamp: "2026-03-10T12:00:00.000Z",
          metadata: {
            command: "pnpm create vite@latest . -- --template react-ts",
            status: 0,
            stdout: "done",
            stderr: "",
          },
        },
        payload: {
          shell: "pnpm create vite@latest . -- --template react-ts",
          timeoutMs: 600000,
        },
      },
    ],
  };
}

describe("hitlContinuationController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHitlContinuationMemory("session-test");
  });

  it("still returns a continuation decision when checkpoint persistence fails", async () => {
    vi.mocked(saveWorkflowCheckpoint).mockRejectedValue(
      new Error("sqlite is locked"),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const decision = await advanceAfterHitl({
      sessionId: "session-test",
      messageId: "assistant-1",
      plan: createCompletedShellPlan(),
      toolTrace: [],
    });

    expect(decision.kind).toBe("continue");
    expect(warnSpy).toHaveBeenCalledWith(
      "[HITL] Failed to persist continuation checkpoint",
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });
});
