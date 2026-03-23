import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  buildScopedSessionKey,
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
                owner: "coder",
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
                origin: "team_stage",
                originDetail: "team-full-cycle / 测试验证",
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
            subAgentHistory: [],
            taskProgress: [],
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
      origin: "team_stage",
      originDetail: "team-full-cycle / 测试验证",
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
      subAgentHistory: [],
      taskProgress: [],
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
});
