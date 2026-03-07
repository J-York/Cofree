import { executeSubAgentTask, type SubAgentResult } from "./planningService";
import type { AppSettings, ToolPermissions } from "../lib/settingsStore";
import type { WorkingMemory } from "./workingMemory";
import type { SubAgentProgressEvent } from "./types";
import type {
  AgentTeamDefinition,
  AgentTeamStage,
  AgentTeamStageCondition,
} from "../agents/agentTeam";

export interface TeamExecutionResult {
  status: "completed" | "failed" | "partial";
  stageResults: Record<string, SubAgentResult>;
  finalReply: string;
}

type TeamStageFailureStatus = Extract<SubAgentResult["status"], "failed" | "blocked">;
type TeamStageNonSuccessStatus = Exclude<SubAgentResult["status"], "completed">;

interface TeamAggregationSummary {
  hasFailure: boolean;
  hasPartial: boolean;
  hasCompletedStage: boolean;
}

/**
 * Team stage condition semantics are centralized here:
 * - if_previous_succeeded: all previously executed stages must have status === "completed"
 * - if_issues_found: a previously executed reviewer/tester stage must report issues/failures
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
  let hasCompletedStage = false;

  for (const result of stageResults.values()) {
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

  return { hasFailure, hasPartial, hasCompletedStage };
}

function resolveTeamStatus(summary: TeamAggregationSummary): TeamExecutionResult["status"] {
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
  );
}

export async function executeAgentTeam(params: {
  team: AgentTeamDefinition;
  taskDescription: string;
  workspacePath: string;
  settings: AppSettings;
  toolPermissions: ToolPermissions;
  workingMemory?: WorkingMemory;
  onStageProgress?: (stage: string, event: SubAgentProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<TeamExecutionResult> {
  const { team, taskDescription, workspacePath, settings, toolPermissions, workingMemory } = params;
  const stageResults: Map<string, SubAgentResult> = new Map();
  const groups = groupStagesByExecutionOrder(team.pipeline);

  for (const group of groups) {
    if (params.signal?.aborted) {
      break;
    }

    const stagesToRun = group.filter((stage) => evaluateStageCondition(stage.condition, stageResults));
    if (stagesToRun.length === 0) {
      continue;
    }

    if (stagesToRun.length === 1) {
      const stage = stagesToRun[0];
      const result = await executeStage(
        {
          stage,
          taskDescription,
          workspacePath,
          settings,
          toolPermissions,
          workingMemory,
          onStageProgress: params.onStageProgress,
          signal: params.signal,
        },
        stageResults,
      );

      stageResults.set(stage.stageLabel, result);

      if (!shouldContinueAfterStageFailure(team, result.status)) {
        break;
      }

      continue;
    }

    const parallelResults = await Promise.allSettled(
      stagesToRun.map(async (stage) => ({
        stageLabel: stage.stageLabel,
        result: await executeStage(
          {
            stage,
            taskDescription,
            workspacePath,
            settings,
            toolPermissions,
            workingMemory,
            onStageProgress: params.onStageProgress,
            signal: params.signal,
          },
          stageResults,
        ),
      })),
    );

    const settledGroupResults: SubAgentResult[] = [];

    for (const result of parallelResults) {
      if (result.status === "fulfilled") {
        stageResults.set(result.value.stageLabel, result.value.result);
        settledGroupResults.push(result.value.result);
        continue;
      }

      const syntheticFailure: SubAgentResult = {
        reply: `Stage execution failed before completion: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        status: "failed",
        proposedActions: [],
        toolTrace: [],
        turnCount: 0,
      };
      settledGroupResults.push(syntheticFailure);
    }

    if (!shouldContinueAfterGroup(team, settledGroupResults)) {
      break;
    }
  }

  return aggregateTeamResults(team, stageResults);
}
