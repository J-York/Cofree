import { describe, expect, it, vi, beforeEach } from "vitest";
import { executeAgentTeam } from "../src/orchestrator/teamExecutor";
import type { AgentTeamDefinition } from "../src/agents/agentTeam";
import * as planningService from "../src/orchestrator/planningService";

vi.mock("../src/orchestrator/planningService", () => {
  return {
    executeSubAgentTask: vi.fn(),
  };
});

describe("agentTeam executor", () => {
  const mockSettings: any = {};
  const mockToolPerms: any = {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes sequential stages and aborts on failure when policy is stop", async () => {
    const teamDef: AgentTeamDefinition = {
      id: "test",
      name: "Test",
      description: "Test Team",
      pipeline: [
        { stageLabel: "plan", agentRole: "planner" },
        { stageLabel: "code", agentRole: "coder", condition: { type: "if_previous_succeeded" } },
      ],
      config: { maxTotalTurns: 10, failurePolicy: "stop", sharedWorkingMemory: false }
    };

    const executeSubAgentTaskMock = vi.mocked(planningService.executeSubAgentTask);
    
    executeSubAgentTaskMock.mockResolvedValueOnce({
      status: "failed",
      turnCount: 1,
      reply: "Failed to plan",
      proposedActions: [],
      toolTrace: []
    });

    const result = await executeAgentTeam({
      team: teamDef,
      taskDescription: "Do a task",
      workspacePath: "/test",
      settings: mockSettings,
      toolPermissions: mockToolPerms
    });

    expect(executeSubAgentTaskMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
    expect(Object.keys(result.stageResults)).toHaveLength(1);
    expect(result.stageResults["plan"].status).toBe("failed");
  });

  it("passes data from previous stages", async () => {
    const teamDef: AgentTeamDefinition = {
      id: "test",
      name: "Test",
      description: "Test Team",
      pipeline: [
        { stageLabel: "plan", agentRole: "planner" },
        { stageLabel: "code", agentRole: "coder", inputMapping: { fromStage: "plan", fields: ["tasks"] } },
      ],
      config: { maxTotalTurns: 10, failurePolicy: "stop", sharedWorkingMemory: false }
    };

    const executeSubAgentTaskMock = vi.mocked(planningService.executeSubAgentTask);
    
    executeSubAgentTaskMock.mockResolvedValueOnce({
      status: "completed",
      turnCount: 1,
      reply: "Plan completed",
      proposedActions: [],
      toolTrace: [],
      structuredOutput: {
        role: "planner",
        data: {
          tasks: [{ title: "T1" }]
        }
      } as any
    });

    executeSubAgentTaskMock.mockResolvedValueOnce({
      status: "completed",
      turnCount: 1,
      reply: "Code completed",
      proposedActions: [],
      toolTrace: []
    });

    const result = await executeAgentTeam({
      team: teamDef,
      taskDescription: "Do a task",
      workspacePath: "/test",
      settings: mockSettings,
      toolPermissions: mockToolPerms
    });

    expect(executeSubAgentTaskMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    
    const secondCallPrompt = executeSubAgentTaskMock.mock.calls[1][1];
    expect(secondCallPrompt).toContain("Input from previous stage (plan)");
    expect(secondCallPrompt).toContain("T1");
  });
});
