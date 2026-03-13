import { describe, expect, it, vi, beforeEach } from "vitest";
import { executeAgentTeam } from "../src/orchestrator/teamExecutor";
import type { AgentTeamDefinition } from "../src/agents/agentTeam";
import * as planningService from "../src/orchestrator/planningService";
import {
  addDiscoveredFact,
  createWorkingMemory,
} from "../src/orchestrator/workingMemory";

vi.mock("../src/orchestrator/planningService", () => {
  return {
    executeSubAgentTask: vi.fn(),
  };
});

function makeTeam(overrides?: Partial<AgentTeamDefinition>): AgentTeamDefinition {
  return {
    id: "test",
    name: "Test",
    description: "Test Team",
    pipeline: [
      { stageLabel: "plan", agentRole: "planner" },
      { stageLabel: "code", agentRole: "coder", condition: { type: "if_previous_succeeded" } },
    ],
    config: { maxTotalTurns: 10, failurePolicy: "stop", sharedWorkingMemory: false },
    ...overrides,
  };
}

function makeSubAgentResult(overrides?: Partial<planningService.SubAgentResult>): planningService.SubAgentResult {
  return {
    status: "completed",
    turnCount: 1,
    reply: "Done",
    proposedActions: [],
    toolTrace: [],
    ...overrides,
  };
}

describe("agentTeam executor", () => {
  const mockSettings: any = {};
  const mockToolPerms: any = {};

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("executes sequential stages and aborts on failure when policy is stop", async () => {
    const teamDef = makeTeam();
    const mock = vi.mocked(planningService.executeSubAgentTask);
    mock.mockResolvedValueOnce(makeSubAgentResult({ status: "failed", reply: "Failed to plan" }));

    const result = await executeAgentTeam({
      team: teamDef,
      taskDescription: "Do a task",
      workspacePath: "/test",
      settings: mockSettings,
      toolPermissions: mockToolPerms,
    });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
    expect(Object.keys(result.stageResults)).toHaveLength(1);
    expect(result.stageResults["plan"].status).toBe("failed");
  });

  it("passes data from previous stages", async () => {
    const teamDef = makeTeam({
      pipeline: [
        { stageLabel: "plan", agentRole: "planner" },
        { stageLabel: "code", agentRole: "coder", inputMapping: { fromStage: "plan", fields: ["tasks"] } },
      ],
    });
    const mock = vi.mocked(planningService.executeSubAgentTask);
    mock.mockResolvedValueOnce(
      makeSubAgentResult({
        reply: "Plan completed",
        structuredOutput: {
          role: "planner",
          data: { tasks: [{ title: "T1" }] },
        } as any,
      }),
    );
    mock.mockResolvedValueOnce(makeSubAgentResult({ reply: "Code completed" }));

    const result = await executeAgentTeam({
      team: teamDef,
      taskDescription: "Do a task",
      workspacePath: "/test",
      settings: mockSettings,
      toolPermissions: mockToolPerms,
    });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    const secondCallPrompt = mock.mock.calls[1][1];
    expect(secondCallPrompt).toContain("Input from previous stage (plan)");
    expect(secondCallPrompt).toContain("T1");
  });

  // --- P4-2: Parallel stage reject enters final aggregation ---
  it("records rejected parallel stage results in stageResults", async () => {
    const teamDef = makeTeam({
      pipeline: [
        { stageLabel: "review", agentRole: "reviewer", parallelGroup: "review_and_test" },
        { stageLabel: "test", agentRole: "tester", parallelGroup: "review_and_test" },
      ],
      config: { maxTotalTurns: 20, failurePolicy: "skip", sharedWorkingMemory: true },
    });

    const mock = vi.mocked(planningService.executeSubAgentTask);
    mock.mockResolvedValueOnce(makeSubAgentResult({ reply: "Review ok" }));
    mock.mockRejectedValueOnce(new Error("Tester crashed"));

    const result = await executeAgentTeam({
      team: teamDef,
      taskDescription: "Do a task",
      workspacePath: "/test",
      settings: mockSettings,
      toolPermissions: mockToolPerms,
    });

    expect(result.stageResults["review"]).toBeDefined();
    expect(result.stageResults["review"].status).toBe("completed");
    expect(result.stageResults["test"]).toBeDefined();
    expect(result.stageResults["test"].status).toBe("failed");
    expect(result.status).toBe("partial");
  });

  // --- P4-1: maxTotalTurns budget enforcement ---
  it("stops execution when maxTotalTurns is exhausted", async () => {
    const teamDef = makeTeam({
      pipeline: [
        { stageLabel: "plan", agentRole: "planner" },
        { stageLabel: "code", agentRole: "coder" },
        { stageLabel: "test", agentRole: "tester" },
      ],
      config: { maxTotalTurns: 5, failurePolicy: "skip", sharedWorkingMemory: true },
    });

    const mock = vi.mocked(planningService.executeSubAgentTask);
    mock.mockResolvedValueOnce(makeSubAgentResult({ turnCount: 3, reply: "Plan done" }));
    mock.mockResolvedValueOnce(makeSubAgentResult({ turnCount: 3, reply: "Code done" }));
    mock.mockResolvedValueOnce(makeSubAgentResult({ turnCount: 1, reply: "Test done" }));

    const result = await executeAgentTeam({
      team: teamDef,
      taskDescription: "Do a task",
      workspacePath: "/test",
      settings: mockSettings,
      toolPermissions: mockToolPerms,
    });

    // 3+3=6 exceeds maxTotalTurns=5, so "test" stage should NOT run
    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.stageResults["plan"]).toBeDefined();
    expect(result.stageResults["code"]).toBeDefined();
    expect(result.stageResults["test"]).toBeUndefined();
    expect(result.totalTurnsUsed).toBe(6);
  });

  // --- P4-3: Skipped stages due to condition ---
  it("records skipped stages when condition evaluates to false", async () => {
    const teamDef = makeTeam({
      pipeline: [
        { stageLabel: "plan", agentRole: "planner" },
        { stageLabel: "code", agentRole: "coder", condition: { type: "if_previous_succeeded" } },
      ],
      config: { maxTotalTurns: 10, failurePolicy: "skip", sharedWorkingMemory: true },
    });

    const mock = vi.mocked(planningService.executeSubAgentTask);
    mock.mockResolvedValueOnce(makeSubAgentResult({ status: "partial", reply: "Partial plan" }));

    const result = await executeAgentTeam({
      team: teamDef,
      taskDescription: "Do a task",
      workspacePath: "/test",
      settings: mockSettings,
      toolPermissions: mockToolPerms,
    });

    // "code" stage should be skipped because plan was partial, not completed
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.stageResults["plan"].status).toBe("partial");
    expect(result.stageResults["code"]).toBeDefined();
    expect(result.stageResults["code"].reply).toContain("skipped");
  });

  // --- P4-3: failurePolicy=skip allows continuation ---
  it("continues after stage failure when failurePolicy is skip", async () => {
    const teamDef = makeTeam({
      pipeline: [
        { stageLabel: "plan", agentRole: "planner" },
        { stageLabel: "code", agentRole: "coder" },
      ],
      config: { maxTotalTurns: 10, failurePolicy: "skip", sharedWorkingMemory: true },
    });

    const mock = vi.mocked(planningService.executeSubAgentTask);
    mock.mockResolvedValueOnce(makeSubAgentResult({ status: "failed", reply: "Plan failed" }));
    mock.mockResolvedValueOnce(makeSubAgentResult({ reply: "Code done anyway" }));

    const result = await executeAgentTeam({
      team: teamDef,
      taskDescription: "Do a task",
      workspacePath: "/test",
      settings: mockSettings,
      toolPermissions: mockToolPerms,
    });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.stageResults["plan"].status).toBe("failed");
    expect(result.stageResults["code"].status).toBe("completed");
    expect(result.status).toBe("partial");
  });

  // --- P4-3: blocked status propagation ---
  it("reports blocked status when all stages are blocked", async () => {
    const teamDef = makeTeam({
      pipeline: [{ stageLabel: "plan", agentRole: "planner" }],
      config: { maxTotalTurns: 10, failurePolicy: "skip", sharedWorkingMemory: true },
    });

    const mock = vi.mocked(planningService.executeSubAgentTask);
    mock.mockResolvedValueOnce(makeSubAgentResult({ status: "blocked", reply: "Blocked" }));

    const result = await executeAgentTeam({
      team: teamDef,
      taskDescription: "Do a task",
      workspacePath: "/test",
      settings: mockSettings,
      toolPermissions: mockToolPerms,
    });

    expect(result.status).toBe("blocked");
  });

  // --- P1-2: Team returns totalTurnsUsed ---
  it("tracks total turns across all stages", async () => {
    const teamDef = makeTeam({
      pipeline: [
        { stageLabel: "plan", agentRole: "planner" },
        { stageLabel: "code", agentRole: "coder" },
      ],
      config: { maxTotalTurns: 100, failurePolicy: "stop", sharedWorkingMemory: true },
    });

    const mock = vi.mocked(planningService.executeSubAgentTask);
    mock.mockResolvedValueOnce(makeSubAgentResult({ turnCount: 5 }));
    mock.mockResolvedValueOnce(makeSubAgentResult({ turnCount: 8 }));

    const result = await executeAgentTeam({
      team: teamDef,
      taskDescription: "Do a task",
      workspacePath: "/test",
      settings: mockSettings,
      toolPermissions: mockToolPerms,
    });

    expect(result.totalTurnsUsed).toBe(13);
    expect(result.status).toBe("completed");
  });

  it("uses fresh isolated memories for parallel stages when sharedWorkingMemory is false", async () => {
    const teamDef = makeTeam({
      pipeline: [
        { stageLabel: "review", agentRole: "reviewer", parallelGroup: "parallel" },
        { stageLabel: "test", agentRole: "tester", parallelGroup: "parallel" },
      ],
      config: { maxTotalTurns: 20, failurePolicy: "skip", sharedWorkingMemory: false },
    });
    const parentMemory = createWorkingMemory({
      maxTokenBudget: 2048,
      projectContext: "Parent project context",
    });
    addDiscoveredFact(parentMemory, {
      category: "architecture",
      content: "Parent-only fact",
      source: "parent.ts",
      confidence: "high",
    });

    const seenMemories: unknown[] = [];
    const mock = vi.mocked(planningService.executeSubAgentTask);
    mock.mockImplementation(async (_role, _description, _workspacePath, _settings, _toolPermissions, memory) => {
      seenMemories.push(memory);
      expect(memory).toBeDefined();
      expect(memory).not.toBe(parentMemory);
      expect(memory?.projectContext).toBe("Parent project context");
      expect(memory?.maxTokenBudget).toBe(2048);
      // sharedWorkingMemory=false should use fresh isolated memory,
      // not a fork pre-populated with parent facts.
      expect(memory?.discoveredFacts).toHaveLength(0);
      addDiscoveredFact(memory!, {
        category: "issue",
        content: `Stage fact ${seenMemories.length}`,
        source: "stage.ts",
        confidence: "high",
      });
      return makeSubAgentResult();
    });

    const result = await executeAgentTeam({
      team: teamDef,
      taskDescription: "Do a task",
      workspacePath: "/test",
      settings: mockSettings,
      toolPermissions: mockToolPerms,
      workingMemory: parentMemory,
    });

    expect(result.status).toBe("completed");
    expect(mock).toHaveBeenCalledTimes(2);
    expect(seenMemories[0]).not.toBe(seenMemories[1]);
    expect(parentMemory.discoveredFacts).toHaveLength(1);
    expect(parentMemory.discoveredFacts[0]?.content).toBe("Parent-only fact");
  });
});
