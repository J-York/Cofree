import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  buildScopedSessionKey,
  loadLatestWorkflowCheckpoint,
} from "./checkpointStore";

describe("checkpointStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds scoped session keys from conversation and agent ids", () => {
    expect(buildScopedSessionKey("conv-1", "agent-fullstack")).toBe(
      "csess:conv-1:agent-fullstack",
    );
    expect(buildScopedSessionKey("conv-1")).toBe("csess:conv-1");
  });

  it("restores working memory and action origin fields from checkpoints", async () => {
    vi.mocked(invoke).mockResolvedValue({
      found: true,
      checkpoint: {
        checkpoint_id: "cp-1",
        session_id: "csess:conv-1:agent-fullstack",
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

    const restored = await loadLatestWorkflowCheckpoint("csess:conv-1:agent-fullstack");

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
});
