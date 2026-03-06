import { executeSubAgentTask, type SubAgentResult } from "./planningService";
import type { AppSettings, ToolPermissions } from "../lib/settingsStore";
import type { WorkingMemory } from "./workingMemory";
import type { SubAgentProgressEvent } from "./types";
import type { AgentTeamDefinition, AgentTeamStage } from "../agents/agentTeam";

export interface TeamExecutionResult {
  status: "completed" | "failed" | "partial";
  stageResults: Record<string, SubAgentResult>;
  finalReply: string;
}

function shouldExecuteStage(
  stage: AgentTeamStage,
  stageResults: Map<string, SubAgentResult>
): boolean {
  if (!stage.condition) return true;

  if (stage.condition.type === "always") return true;

  if (stage.condition.type === "if_previous_succeeded") {
    // If there is any stage that failed or blocked, we shouldn't execute
    for (const [_, res] of stageResults.entries()) {
      if (res.status === "failed" || res.status === "blocked") {
        return false;
      }
    }
    return true;
  }

  if (stage.condition.type === "if_issues_found") {
    // Example: Only run if debugger found rootCause or reviewer found issues
    let issuesFound = false;
    for (const [_, res] of stageResults.entries()) {
      if (res.structuredOutput?.role === "reviewer" && res.structuredOutput.data.issues.length > 0) {
        issuesFound = true;
      }
      if (res.structuredOutput?.role === "tester" && res.structuredOutput.data.testPlan.some(t => t.passed === false)) {
        issuesFound = true;
      }
    }
    return issuesFound;
  }

  return true;
}

function buildStageDescription(
  initialTaskDescription: string,
  stage: AgentTeamStage,
  stageResults: Map<string, SubAgentResult>
): string {
  let description = `[Team Stage: ${stage.stageLabel}]\n${initialTaskDescription}`;

  if (stage.inputMapping && stageResults.has(stage.inputMapping.fromStage)) {
    const prevResult = stageResults.get(stage.inputMapping.fromStage)!;
    description += `\n\n## Input from previous stage (${stage.inputMapping.fromStage}):\n`;
    
    if (prevResult.structuredOutput) {
      const data = prevResult.structuredOutput.data as Record<string, any>;
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

function aggregateTeamResults(
  team: AgentTeamDefinition,
  stageResults: Map<string, SubAgentResult>
): TeamExecutionResult {
  const resultsObj = Object.fromEntries(stageResults);
  const stagesRun = Array.from(stageResults.keys());
  
  let hasFailure = false;
  let finalReply = `Team [${team.name}] execution finished. Stages run: ${stagesRun.join(" -> ")}.\n\n`;

  for (const [label, res] of stageResults.entries()) {
    if (res.status === "failed" || res.status === "blocked") {
      hasFailure = true;
    }
    finalReply += `### Stage: ${label} (${res.status})\n${res.reply}\n\n`;
  }

  return {
    status: hasFailure ? "failed" : "completed",
    stageResults: resultsObj,
    finalReply: finalReply.trim()
  };
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

  // Group by parallelGroup
  const groups: AgentTeamStage[][] = [];
  let currentGroup: AgentTeamStage[] = [];

  for (const stage of team.pipeline) {
    if (!stage.parallelGroup) {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }
      groups.push([stage]);
    } else {
      if (currentGroup.length === 0 || currentGroup[0].parallelGroup === stage.parallelGroup) {
        currentGroup.push(stage);
      } else {
        groups.push(currentGroup);
        currentGroup = [stage];
      }
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  for (const group of groups) {
    if (params.signal?.aborted) break;

    const stagesToRun = group.filter(s => shouldExecuteStage(s, stageResults));
    if (stagesToRun.length === 0) continue;

    if (stagesToRun.length === 1) {
      const stage = stagesToRun[0];
      const stageDescription = buildStageDescription(taskDescription, stage, stageResults);

      const result = await executeSubAgentTask(
        stage.agentRole,
        stageDescription,
        workspacePath,
        settings,
        toolPermissions,
        workingMemory,
        (event) => params.onStageProgress?.(stage.stageLabel, event),
        params.signal
      );

      stageResults.set(stage.stageLabel, result);

      if (result.status === "failed" && team.config.failurePolicy === "stop") {
        break;
      }
    } else {
      // Parallel execution
      const stagePromises = stagesToRun.map(async (stage) => {
        const stageDescription = buildStageDescription(taskDescription, stage, stageResults);
        const result = await executeSubAgentTask(
          stage.agentRole,
          stageDescription,
          workspacePath,
          settings,
          toolPermissions,
          workingMemory,
          (event) => params.onStageProgress?.(stage.stageLabel, event),
          params.signal
        );
        return { stageLabel: stage.stageLabel, result };
      });

      const parallelResults = await Promise.allSettled(stagePromises);
      let groupFailed = false;

      for (const res of parallelResults) {
        if (res.status === "fulfilled") {
          stageResults.set(res.value.stageLabel, res.value.result);
          if (res.value.result.status === "failed") groupFailed = true;
        } else {
          groupFailed = true;
        }
      }

      if (groupFailed && team.config.failurePolicy === "stop") {
        break;
      }
    }
  }

  return aggregateTeamResults(team, stageResults);
}
