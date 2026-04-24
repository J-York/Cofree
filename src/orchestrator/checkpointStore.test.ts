import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  buildScopedSessionKey,
  deleteWorkflowCheckpointsByPrefix,
  deleteWorkflowCheckpointsForConversation,
  loadLatestWorkflowCheckpoint,
  saveWorkflowCheckpoint,
} from "./checkpointStore";
import type { OrchestrationPlan } from "./types";
import type { WorkingMemorySnapshot } from "./workingMemory";

describe("checkpointStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds scoped session keys from conversation and agent ids", () => {
    expect(buildScopedSessionKey("conv-1", "agent-general")).toBe(
      "csess:conv-1:agent-general",
    );
    expect(buildScopedSessionKey("conv-1")).toBe("csess:conv-1");
  });

  it("restores working memory and action origin fields from checkpoints", async () => {
    vi.mocked(invoke).mockResolvedValue({
      found: true,
      checkpoint: {
        checkpoint_id: "cp-1",
        session_id: "csess:conv-1:agent-general",
        message_id: "msg-1",
        workflow_state: "human_review",
        payload_json: JSON.stringify({
          plan: {
            state: "human_review",
            prompt: "继续执行",
            steps: [
              {
                id: "step-1",
                title: "代码实现",
                summary: "完成主实现",
                status: "in_progress",
              },
            ],
            proposedActions: [
              {
                id: "action-1",
                type: "shell",
                description: "运行测试",
                gateRequired: true,
                status: "pending",
                executed: false,
                payload: {
                  shell: "pnpm test",
                  timeoutMs: 120000,
                },
              },
            ],
          },
          workingMemory: {
            fileKnowledge: [["src/main.ts", { summary: "入口文件", confidence: "high" }]],
            discoveredFacts: [],
            projectContext: "project context",
            maxTokenBudget: 2048,
          },
        }),
        created_at: "2026-03-19T00:00:00.000Z",
        updated_at: "2026-03-19T00:00:00.000Z",
      },
    });

    const restored = await loadLatestWorkflowCheckpoint("csess:conv-1:agent-general");

    expect(restored).not.toBeNull();
    expect(restored?.payload.plan.proposedActions[0]).toMatchObject({
      type: "shell",
    });
    expect(restored?.payload.workingMemory).toMatchObject({
      projectContext: "project context",
      maxTokenBudget: 2048,
    });
    expect(restored?.payload.workingMemory?.fileKnowledge[0]?.[0]).toBe("src/main.ts");
  });

  it("saveWorkflowCheckpoint sanitizes working memory in the invoke payload", async () => {
    const plan: OrchestrationPlan = {
      state: "human_review",
      prompt: "t",
      steps: [],
      proposedActions: [],
      workspacePath: "/w",
    };
    const wm: WorkingMemorySnapshot = {
      fileKnowledge: [
        [
          "a.ts",
          {
            relativePath: "a.ts",
            summary: "s".repeat(5000),
            totalLines: 1,
            lastReadAt: "2026-01-01T00:00:00Z",
            lastReadTurn: 0,
            readByAgent: "test",
          },
        ],
      ],
      discoveredFacts: [],
      projectContext: "",
      maxTokenBudget: 4000,
    };
    await saveWorkflowCheckpoint("csess:c1", "m1", plan, [], undefined, wm);
    expect(vi.mocked(invoke)).toHaveBeenCalled();
    const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "save_workflow_checkpoint");
    expect(call).toBeDefined();
    const payloadJson = (call![1] as { payloadJson: string }).payloadJson;
    const parsed = JSON.parse(payloadJson) as {
      workingMemory?: { fileKnowledge: Array<[string, { summary?: string }]> };
    };
    const firstEntry = parsed.workingMemory?.fileKnowledge?.[0];
    expect(firstEntry?.[1]?.summary?.length).toBeLessThanOrEqual(2002);
  });

  it("deleteWorkflowCheckpointsByPrefix forwards trimmed prefix to invoke", async () => {
    vi.mocked(invoke).mockResolvedValue(3);
    const deleted = await deleteWorkflowCheckpointsByPrefix("  csess:conv-xyz  ");
    expect(deleted).toBe(3);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("delete_workflow_checkpoints", {
      sessionPrefix: "csess:conv-xyz",
    });
  });

  it("deleteWorkflowCheckpointsByPrefix short-circuits empty input", async () => {
    const deleted = await deleteWorkflowCheckpointsByPrefix("   ");
    expect(deleted).toBe(0);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it("deleteWorkflowCheckpointsForConversation uses csess:<id> prefix", async () => {
    vi.mocked(invoke).mockResolvedValue(2);
    await deleteWorkflowCheckpointsForConversation("conv-42");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("delete_workflow_checkpoints", {
      sessionPrefix: "csess:conv-42",
    });
  });

  it("deleteWorkflowCheckpointsForConversation returns 0 on empty id", async () => {
    const deleted = await deleteWorkflowCheckpointsForConversation("   ");
    expect(deleted).toBe(0);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });
});
