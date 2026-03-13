import { executeSubAgentTask, type SubAgentResult } from "./planningService";
import type { AppSettings, ToolPermissions } from "../lib/settingsStore";
import {
  createWorkingMemory,
  forkWorkingMemory,
  mergeForkedMemories,
  type WorkingMemory,
} from "./workingMemory";
import type { SubAgentProgressEvent } from "./types";
import type {
  AgentTeamDefinition,
  AgentTeamStage,
  AgentTeamStageCondition,
} from "../agents/agentTeam";

export interface TeamExecutionResult {
  status: "completed" | "failed" | "partial" | "blocked";
  stageResults: Record<string, SubAgentResult>;
  finalReply: string;
  /** P4-1: Total turns consumed across all stages. */
  totalTurnsUsed: number;
}

type TeamStageFailureStatus = Extract<SubAgentResult["status"], "failed" | "blocked">;
type TeamStageNonSuccessStatus = Exclude<SubAgentResult["status"], "completed">;

interface TeamAggregationSummary {
  hasFailure: boolean;
  hasPartial: boolean;
  hasBlocked: boolean;
  hasCompletedStage: boolean;
  totalTurns: number;
}

/**
 * Team stage condition semantics (P4-3 — centralized and documented):
 *
 * - always: unconditionally run this stage.
 * - if_previous_succeeded: run only when ALL previously executed stages are "completed".
 *   "partial" is treated as NOT succeeded (conservative). "blocked"/"failed" are also NOT succeeded.
 * - if_issues_found: run when a previously executed reviewer/tester stage reported issues/failures.
 *   A stage that failed or was blocked does NOT count as "issues found" — it must produce structured output.
 */
function evaluateStageCondition(
  condition: AgentTeamStageCondition | undefined,
  stageResults: Map<string, SubAgentResult>,
): boolean {
  if (!condition || condition.type === "always") {
    return true;
  }

  switch (condition.type) {
    case "if_previous_succeeded":
      return getPriorExecutionStatuses(stageResults).every((status) => status === "completed");
    case "if_issues_found":
      return hasIssuesInStageResults(stageResults);
    default:
      return true;
  }
}

function getPriorExecutionStatuses(
  stageResults: Map<string, SubAgentResult>,
): SubAgentResult["status"][] {
  return Array.from(stageResults.values(), (result) => result.status);
}

function hasIssuesInStageResults(stageResults: Map<string, SubAgentResult>): boolean {
  for (const result of stageResults.values()) {
    const output = result.structuredOutput;
    if (!output) continue;

    if (output.role === "reviewer" && output.data.issues.length > 0) {
      return true;
    }

    if (
      output.role === "tester" &&
      output.data.testPlan.some((testCase) => testCase.passed === false)
    ) {
      return true;
    }
  }

  return false;
}

function groupStagesByExecutionOrder(pipeline: AgentTeamStage[]): AgentTeamStage[][] {
  const groups: AgentTeamStage[][] = [];
  let currentGroup: AgentTeamStage[] = [];

  for (const stage of pipeline) {
    if (!stage.parallelGroup) {
      flushCurrentGroup(groups, currentGroup);
      currentGroup = [];
      groups.push([stage]);
      continue;
    }

    if (
      currentGroup.length === 0 ||
      currentGroup[0]?.parallelGroup === stage.parallelGroup
    ) {
      currentGroup.push(stage);
      continue;
    }

    flushCurrentGroup(groups, currentGroup);
    currentGroup = [stage];
  }

  flushCurrentGroup(groups, currentGroup);
  return groups;
}

function flushCurrentGroup(groups: AgentTeamStage[][], currentGroup: AgentTeamStage[]): void {
  if (currentGroup.length > 0) {
    groups.push([...currentGroup]);
  }
}

function shouldContinueAfterStageFailure(
  team: AgentTeamDefinition,
  status: SubAgentResult["status"],
): boolean {
  return !isFailureStatus(status) || team.config.failurePolicy !== "stop";
}

function shouldContinueAfterGroup(team: AgentTeamDefinition, groupResults: SubAgentResult[]): boolean {
  return !groupResults.some((result) => isFailureStatus(result.status)) || team.config.failurePolicy !== "stop";
}

function isFailureStatus(status: SubAgentResult["status"]): status is TeamStageFailureStatus {
  return status === "failed" || status === "blocked";
}

function isPartialStatus(status: SubAgentResult["status"]): status is TeamStageNonSuccessStatus {
  return status === "partial" || status === "need_clarification";
}

function buildStageDescription(
  initialTaskDescription: string,
  stage: AgentTeamStage,
  stageResults: Map<string, SubAgentResult>,
): string {
  let description = `[Team Stage: ${stage.stageLabel}]\n${initialTaskDescription}`;

  if (stage.inputMapping && stageResults.has(stage.inputMapping.fromStage)) {
    const prevResult = stageResults.get(stage.inputMapping.fromStage)!;
    description += `\n\n## Input from previous stage (${stage.inputMapping.fromStage}):\n`;

    if (prevResult.structuredOutput) {
      const data = prevResult.structuredOutput.data as unknown as Record<string, unknown>;
      for (const field of stage.inputMapping.fields) {
        if (data[field] !== undefined) {
          description += `- **${field}**: ${JSON.stringify(data[field])}\n`;
        }
      }
    } else {
      description += prevResult.reply;
    }
  }

  return description;
}

function summarizeTeamExecution(stageResults: Map<string, SubAgentResult>): TeamAggregationSummary {
  let hasFailure = false;
  let hasPartial = false;
  let hasBlocked = false;
  let hasCompletedStage = false;
  let totalTurns = 0;

  for (const result of stageResults.values()) {
    totalTurns += result.turnCount ?? 0;
    if (result.status === "blocked") {
      hasBlocked = true;
      continue;
    }
    if (isFailureStatus(result.status)) {
      hasFailure = true;
      continue;
    }
    if (result.status === "completed") {
      hasCompletedStage = true;
      continue;
    }
    if (isPartialStatus(result.status)) {
      hasPartial = true;
    }
  }

  return { hasFailure, hasPartial, hasBlocked, hasCompletedStage, totalTurns };
}

function resolveTeamStatus(summary: TeamAggregationSummary): TeamExecutionResult["status"] {
  if (summary.hasBlocked && !summary.hasCompletedStage && !summary.hasPartial) {
    return "blocked";
  }
  if (summary.hasFailure) {
    return summary.hasCompletedStage || summary.hasPartial ? "partial" : "failed";
  }
  if (summary.hasPartial) {
    return "partial";
  }
  return "completed";
}

function aggregateTeamResults(
  team: AgentTeamDefinition,
  stageResults: Map<string, SubAgentResult>,
): TeamExecutionResult {
  const resultsObj = Object.fromEntries(stageResults);
  const stagesRun = Array.from(stageResults.keys());
  const summary = summarizeTeamExecution(stageResults);
  const resolvedStatus = resolveTeamStatus(summary);

  let finalReply = `Team [${team.name}] execution finished with status: ${resolvedStatus}. Stages run: ${stagesRun.join(" -> ")}.\n\n`;

  for (const [label, res] of stageResults.entries()) {
    finalReply += `### Stage: ${label} (${res.status})\n${res.reply}\n\n`;
  }

  return {
    status: resolvedStatus,
    stageResults: resultsObj,
    finalReply: finalReply.trim(),
    totalTurnsUsed: summary.totalTurns,
  };
}

async function executeStage(
  params: {
    stage: AgentTeamStage;
    taskDescription: string;
    workspacePath: string;
    settings: AppSettings;
    toolPermissions: ToolPermissions;
    workingMemory?: WorkingMemory;
    focusedPaths?: string[];
    onStageProgress?: (stage: string, event: SubAgentProgressEvent) => void;
    signal?: AbortSignal;
  },
  stageResults: Map<string, SubAgentResult>,
): Promise<SubAgentResult> {
  const stageDescription = buildStageDescription(
    params.taskDescription,
    params.stage,
    stageResults,
  );

  return executeSubAgentTask(
    params.stage.agentRole,
    stageDescription,
    params.workspacePath,
    params.settings,
    params.toolPermissions,
    params.workingMemory,
    (event) => params.onStageProgress?.(params.stage.stageLabel, event),
    params.signal,
    params.focusedPaths,
  );
}

export async function executeAgentTeam(params: {
  team: AgentTeamDefinition;
  taskDescription: string;
  workspacePath: string;
  settings: AppSettings;
  toolPermissions: ToolPermissions;
  workingMemory?: WorkingMemory;
  focusedPaths?: string[];
  onStageProgress?: (stage: string, event: SubAgentProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<TeamExecutionResult> {
  const { team, taskDescription, workspacePath, settings, toolPermissions, workingMemory, focusedPaths } = params;
  const stageResults: Map<string, SubAgentResult> = new Map();
  const groups = groupStagesByExecutionOrder(team.pipeline);
  let totalTurnsConsumed = 0;
  const maxTotalTurns = team.config.maxTotalTurns;

  // P4-1: Resolve the working memory strategy per team config.
  // - sharedWorkingMemory=true: sequential stages share the parent memory,
  //   parallel stages use fork-join to avoid concurrent mutation.
  // - sharedWorkingMemory=false: every stage gets a fresh isolated memory.
  function resolveStageMemory(forceIsolate = false): WorkingMemory | undefined {
    if (!workingMemory) return undefined;
    if (forceIsolate) {
      if (team.config.sharedWorkingMemory) {
        return forkWorkingMemory(workingMemory);
      }
      return createWorkingMemory({
        maxTokenBudget: workingMemory.maxTokenBudget,
        projectContext: workingMemory.projectContext,
      });
    }
    if (team.config.sharedWorkingMemory) return workingMemory;
    return createWorkingMemory({
      maxTokenBudget: workingMemory.maxTokenBudget,
      projectContext: workingMemory.projectContext,
    });
  }

  for (const group of groups) {
    if (params.signal?.aborted) {
      break;
    }

    // P4-1: Enforce total turn budget across all stages
    if (totalTurnsConsumed >= maxTotalTurns) {
      console.warn(
        `[TeamExecutor] Total turn budget exhausted (${totalTurnsConsumed}/${maxTotalTurns}), stopping team.`
      );
      break;
    }

    const stagesToRun = group.filter((stage) => evaluateStageCondition(stage.condition, stageResults));
    if (stagesToRun.length === 0) {
      // P4-3: Record skipped stages so they appear in final aggregation
      for (const stage of group) {
        if (!stageResults.has(stage.stageLabel)) {
          stageResults.set(stage.stageLabel, {
            reply: `Stage skipped: condition "${stage.condition?.type ?? "always"}" evaluated to false.`,
            status: "partial",
            proposedActions: [],
            toolTrace: [],
            turnCount: 0,
          });
        }
      }
      continue;
    }

    if (stagesToRun.length === 1) {
      const stage = stagesToRun[0];
      const stageMemory = resolveStageMemory();
      const result = await executeStage(
        {
          stage,
          taskDescription,
          workspacePath,
          settings,
          toolPermissions,
          workingMemory: stageMemory,
          focusedPaths,
          onStageProgress: params.onStageProgress,
          signal: params.signal,
        },
        stageResults,
      );

      stageResults.set(stage.stageLabel, result);
      totalTurnsConsumed += result.turnCount ?? 0;

      if (!shouldContinueAfterStageFailure(team, result.status)) {
        break;
      }

      continue;
    }

    // Parallel stage group:
    // - sharedWorkingMemory=true: fork-join against the parent memory
    // - sharedWorkingMemory=false: fresh isolated memories, no merge-back
    const stageMemories: WorkingMemory[] = [];
    const parallelResults = await Promise.allSettled(
      stagesToRun.map(async (stage) => {
        const stageMemory = resolveStageMemory(true);
        if (stageMemory && team.config.sharedWorkingMemory) {
          stageMemories.push(stageMemory);
        }
        return {
          stageLabel: stage.stageLabel,
          result: await executeStage(
            {
              stage,
              taskDescription,
              workspacePath,
              settings,
              toolPermissions,
              workingMemory: stageMemory,
              focusedPaths,
              onStageProgress: params.onStageProgress,
              signal: params.signal,
            },
            stageResults,
          ),
        };
      }),
    );

    // Merge forked memories back into the shared parent
    if (workingMemory && team.config.sharedWorkingMemory && stageMemories.length > 0) {
      mergeForkedMemories(workingMemory, stageMemories);
    }

    const settledGroupResults: SubAgentResult[] = [];

    for (let i = 0; i < parallelResults.length; i++) {
      const result = parallelResults[i];
      if (result.status === "fulfilled") {
        stageResults.set(result.value.stageLabel, result.value.result);
        settledGroupResults.push(result.value.result);
        totalTurnsConsumed += result.value.result.turnCount ?? 0;
        continue;
      }

      // P4-2: Rejected stages MUST enter stageResults so they appear in final aggregation
      const failedStageLabel = stagesToRun[i].stageLabel;
      const syntheticFailure: SubAgentResult = {
        reply: `Stage execution failed before completion: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        status: "failed",
        proposedActions: [],
        toolTrace: [],
        turnCount: 0,
      };
      stageResults.set(failedStageLabel, syntheticFailure);
      settledGroupResults.push(syntheticFailure);
    }

    if (!shouldContinueAfterGroup(team, settledGroupResults)) {
      break;
    }
  }

  return aggregateTeamResults(team, stageResults);
}
