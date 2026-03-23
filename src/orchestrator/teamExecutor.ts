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
  IsolatedInputSpec,
} from "../agents/agentTeam";
import type { ReviewOutput, VerifierOutput } from "../agents/types";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export type TeamStopReason =
  | "completed_normal"
  | "budget_exhausted"
  | "aborted"
  | "stage_failed"
  | "quality_gate_failed";

export interface TeamExecutionResult {
  status: "completed" | "failed" | "partial" | "blocked";
  stageResults: Record<string, SubAgentResult>;
  finalReply: string;
  /** P4-1: Total turns consumed across all stages. */
  totalTurnsUsed: number;
  /** Why the team run ended (for UI, logs, and parent `task` tool payload). */
  stopReason: TeamStopReason;
  /** Optional hint for the concierge / user (e.g. after budget or partial completion). */
  nextRecommendedAction?: string;
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
 * - if_previous_succeeded: run only when ALL previously recorded stages are "completed" or synthetic "skipped".
 *   "partial"/"blocked"/"failed" block progression. Skipped stages do not block (they were not applicable).
 * - if_issues_found: run when any prior reviewer/tester structured output reports issues/failures.
 * - if_issues_from_stage: same as issues check but only for the named `refStageLabel` stage result.
 * - if_stage_executed: true when the named stage exists and was not synthetic-skipped.
 * - if_review_failed: true when the named reviewer stage reported issues or ended failed/blocked.
 * - if_verify_failed: true when the named verifier stage reports !allPassed / failing commands or ended failed/blocked.
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
      return priorStagesAllSucceededForPipeline(stageResults);
    case "if_issues_found":
      return hasIssuesInStageResults(stageResults);
    case "if_issues_from_stage":
      return stageHasStructuredIssues(stageResults.get(condition.refStageLabel ?? ""));
    case "if_stage_executed": {
      const ref = condition.refStageLabel;
      if (!ref) return false;
      const res = stageResults.get(ref);
      return res !== undefined && res.status !== "skipped";
    }
    case "if_review_failed": {
      const ref = condition.refStageLabel;
      if (!ref) return false;
      const res = stageResults.get(ref);
      if (!res || res.status === "skipped") return false;
      if (res.status === "failed" || res.status === "blocked") return true;
      return stageHasReviewerIssues(res);
    }
    case "if_verify_failed": {
      const ref = condition.refStageLabel;
      if (!ref) return false;
      const res = stageResults.get(ref);
      if (!res || res.status === "skipped") return false;
      if (res.status === "failed" || res.status === "blocked") return true;
      return stageVerifierFailed(res);
    }
    default:
      return true;
  }
}

function stageHasReviewerIssues(result: SubAgentResult): boolean {
  const o = result.structuredOutput;
  if (o?.role !== "reviewer") return false;
  return o.data.issues.length > 0;
}

function stageVerifierFailed(result: SubAgentResult): boolean {
  const o = result.structuredOutput;
  if (o?.role !== "verifier") return false;
  if (!o.data.allPassed) return true;
  return o.data.commands.some((c) => !c.passed);
}

/**
 * Stages that may end as `partial` while still allowing the pipeline to continue
 * (e.g. reviewer listed issues → repair stage; tester reported failing cases → fix stage).
 */
function isAcceptablePriorStatusForPipeline(result: SubAgentResult): boolean {
  if (result.status === "completed" || result.status === "skipped") return true;
  if (result.status === "partial") {
    const o = result.structuredOutput;
    if (o?.role === "reviewer" || o?.role === "tester") return true;
  }
  return false;
}

/** All recorded stages are completed, skipped, or reviewer/tester partial with structured output. */
function priorStagesAllSucceededForPipeline(stageResults: Map<string, SubAgentResult>): boolean {
  for (const result of stageResults.values()) {
    if (!isAcceptablePriorStatusForPipeline(result)) {
      return false;
    }
  }
  return true;
}

function stageHasStructuredIssues(result: SubAgentResult | undefined): boolean {
  if (!result?.structuredOutput) return false;
  const output = result.structuredOutput;
  if (output.role === "reviewer" && output.data.issues.length > 0) {
    return true;
  }
  if (
    output.role === "tester" &&
    output.data.testPlan.some((testCase) => testCase.passed === false)
  ) {
    return true;
  }
  return false;
}

function hasIssuesInStageResults(stageResults: Map<string, SubAgentResult>): boolean {
  for (const result of stageResults.values()) {
    if (stageHasStructuredIssues(result)) return true;
  }
  return false;
}

export function computeReviewVerdict(output: ReviewOutput): "pass" | "fail" {
  if (output.issues?.some(i => i.severity === "blocker")) return "fail";
  const dims = output.dimensions;
  if (!dims) {
    return output.issues?.length ? "fail" : "pass";
  }
  const allDims = [dims.correctness, dims.security, dims.maintainability, dims.consistency];
  if (allDims.some(d => d.score <= 2)) return "fail";
  if (dims.correctness.score <= 3) return "fail";
  return "pass";
}

export function computeVerifyVerdict(output: VerifierOutput): "pass" | "fail" {
  if (!output.commands || output.commands.length === 0) return "fail";
  return output.commands.every(c => c.exitCode === 0) ? "pass" : "fail";
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
      const missingFields: string[] = [];
      for (const field of stage.inputMapping.fields) {
        if (data[field] !== undefined) {
          description += `- **${field}**: ${JSON.stringify(data[field])}\n`;
        } else {
          missingFields.push(field);
        }
      }
      if (missingFields.length > 0) {
        description +=
          `\n_(系统提示：上一阶段结构化输出缺少字段 ${missingFields.join(", ")}；请结合工具与上一阶段全文补全上下文。)_\n`;
      }
    } else {
      description += prevResult.reply;
    }
  }

  return description;
}

function assembleIsolatedContext(
  spec: IsolatedInputSpec,
  taskDescription: string,
  workspacePath: string,
  stageResults: Map<string, SubAgentResult>,
): string {
  const sections: string[] = [];

  if (spec.fromOriginalRequest) {
    sections.push(`## 原始需求\n\n${taskDescription}`);
  }

  if (spec.includeGitDiff) {
    try {
      const diff = execSync("git diff HEAD", { cwd: workspacePath, encoding: "utf-8", timeout: 10000 });
      if (diff.trim()) {
        sections.push(`## 代码变更 (git diff)\n\n\`\`\`diff\n${diff}\n\`\`\``);
      }
    } catch { /* ignore git errors */ }
  }

  if (spec.includeFileContents?.length) {
    let filePaths: string[] = [];
    if (spec.includeFileContents.includes("changed")) {
      try {
        const nameOnly = execSync("git diff HEAD --name-only", { cwd: workspacePath, encoding: "utf-8", timeout: 10000 });
        filePaths = nameOnly.trim().split("\n").filter(Boolean);
      } catch { /* ignore */ }
    } else {
      filePaths = spec.includeFileContents;
    }

    const fileContents: string[] = [];
    for (const fp of filePaths.slice(0, 20)) {
      try {
        const abs = path.resolve(workspacePath, fp);
        const content = fs.readFileSync(abs, "utf-8");
        fileContents.push(`### ${fp}\n\n\`\`\`\n${content}\n\`\`\``);
      } catch { /* skip unreadable files */ }
    }
    if (fileContents.length > 0) {
      sections.push(`## 变更文件内容\n\n${fileContents.join("\n\n")}`);
    }
  }

  if (spec.fromStage && spec.fields?.length) {
    const stageResult = stageResults.get(spec.fromStage);
    if (stageResult?.structuredOutput) {
      const data = stageResult.structuredOutput.data as unknown as Record<string, unknown>;
      const subset: Record<string, unknown> = {};
      for (const f of spec.fields) {
        if (f in data) subset[f] = data[f];
      }
      sections.push(`## 上游阶段输出（${spec.fromStage}）\n\n\`\`\`json\n${JSON.stringify(subset, null, 2)}\n\`\`\``);
    }
  }

  return sections.join("\n\n---\n\n");
}

function summarizeTeamExecution(stageResults: Map<string, SubAgentResult>): TeamAggregationSummary {
  let hasFailure = false;
  let hasPartial = false;
  let hasBlocked = false;
  let hasCompletedStage = false;
  let totalTurns = 0;

  for (const result of stageResults.values()) {
    totalTurns += result.turnCount ?? 0;
    if (result.status === "skipped") {
      continue;
    }
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
  stopReason: TeamStopReason,
): TeamExecutionResult {
  const resultsObj = Object.fromEntries(stageResults);
  const stagesRun = Array.from(stageResults.keys());
  const summary = summarizeTeamExecution(stageResults);
  let resolvedStatus = resolveTeamStatus(summary);

  if (stopReason === "budget_exhausted" && resolvedStatus === "completed") {
    resolvedStatus = "partial";
  }
  if (stopReason === "aborted" && resolvedStatus === "completed") {
    resolvedStatus = "partial";
  }

  let nextRecommendedAction: string | undefined;
  if (stopReason === "budget_exhausted") {
    nextRecommendedAction =
      "团队轮次预算已用尽：可缩小任务范围、提高模型能力，或手动继续未完成阶段。";
  } else if (stopReason === "aborted") {
    nextRecommendedAction = "执行被中断：可在需要时重新发起 task(team=...) 或从当前进度向用户说明。";
  } else if (stopReason === "quality_gate_failed") {
    nextRecommendedAction = "质量门禁未通过：审查或验证阶段的评估结果不满足最低要求，请查看 verdict 和 structuredOutput 了解具体原因。";
  } else if (stopReason === "stage_failed") {
    nextRecommendedAction = "某阶段失败：请查看 stage_results 中的失败阶段与错误信息，再决定是否重试或拆分任务。";
  } else if (resolvedStatus === "partial") {
    nextRecommendedAction = "流水线部分完成：请根据各阶段状态与结构化输出决定是否需要额外一轮修复或测试。";
  }

  let finalReply = `Team [${team.name}] execution finished with status: ${resolvedStatus}. stop_reason: ${stopReason}. Stages run: ${stagesRun.join(" -> ")}.\n\n`;

  for (const [label, res] of stageResults.entries()) {
    finalReply += `### Stage: ${label} (${res.status})\n${res.reply}\n\n`;
  }

  return {
    status: resolvedStatus,
    stageResults: resultsObj,
    finalReply: finalReply.trim(),
    totalTurnsUsed: summary.totalTurns,
    stopReason,
    nextRecommendedAction,
  };
}

function truncateExpertStageSummary(reply: string, maxChars: number): string {
  const t = reply.trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}…`;
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
    teamId: string;
  },
  stageResults: Map<string, SubAgentResult>,
): Promise<SubAgentResult> {
  const useIsolated = params.stage.contextPolicy === "isolated" && params.stage.isolatedInputs;

  const stageDescription = useIsolated
    ? assembleIsolatedContext(
        params.stage.isolatedInputs!,
        params.taskDescription,
        params.workspacePath,
        stageResults,
      )
    : buildStageDescription(
        params.taskDescription,
        params.stage,
        stageResults,
      );

  const stageMemory = useIsolated ? undefined : params.workingMemory;

  const result = await executeSubAgentTask(
    params.stage.agentRole,
    stageDescription,
    params.workspacePath,
    params.settings,
    params.toolPermissions,
    stageMemory,
    (event) => params.onStageProgress?.(params.stage.stageLabel, event),
    params.signal,
    params.focusedPaths,
  );

  const summary =
    truncateExpertStageSummary(result.reply, 1200) ||
    `（阶段结束 · ${result.status}）`;

  params.onStageProgress?.(params.stage.stageLabel, {
    kind: "stage_complete",
    teamId: params.teamId,
    stageLabel: params.stage.stageLabel,
    agentRole: params.stage.agentRole,
    summary,
    stageStatus: result.status,
  });

  return result;
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
  let stopReason: TeamStopReason = "completed_normal";

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
      stopReason = "aborted";
      break;
    }

    // P4-1: Enforce total turn budget across all stages
    if (totalTurnsConsumed >= maxTotalTurns) {
      console.warn(
        `[TeamExecutor] Total turn budget exhausted (${totalTurnsConsumed}/${maxTotalTurns}), stopping team.`
      );
      stopReason = "budget_exhausted";
      break;
    }

    const stagesToRun = group.filter((stage) => evaluateStageCondition(stage.condition, stageResults));
    if (stagesToRun.length === 0) {
      // P4-3: Record skipped stages so they appear in final aggregation
      for (const stage of group) {
        if (!stageResults.has(stage.stageLabel)) {
          stageResults.set(stage.stageLabel, {
            reply: `Stage skipped: condition "${stage.condition?.type ?? "always"}" evaluated to false.`,
            status: "skipped",
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
          teamId: team.id,
        },
        stageResults,
      );

      if (result.structuredOutput?.role === "reviewer") {
        result.verdict = computeReviewVerdict(result.structuredOutput.data as ReviewOutput);
      } else if (result.structuredOutput?.role === "verifier") {
        result.verdict = computeVerifyVerdict(result.structuredOutput.data as VerifierOutput);
      }

      stageResults.set(stage.stageLabel, result);
      totalTurnsConsumed += result.turnCount ?? 0;

      if (
        team.config.emitPlanCheckpoint &&
        stage.agentRole === "planner" &&
        result.status === "completed"
      ) {
        params.onStageProgress?.(stage.stageLabel, {
          kind: "team_checkpoint",
          checkpointId: "plan_ready",
          message: "需求分析与任务拆解已完成；建议在进入实现前请用户确认范围、风险与验收标准。",
          teamId: team.id,
          stageLabel: stage.stageLabel,
          agentRole: stage.agentRole,
        });
      }

      if (!shouldContinueAfterStageFailure(team, result.status)) {
        stopReason = "stage_failed";
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
                teamId: team.id,
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
        const stageResult = result.value.result;
        if (stageResult.structuredOutput?.role === "reviewer") {
          stageResult.verdict = computeReviewVerdict(stageResult.structuredOutput.data as ReviewOutput);
        } else if (stageResult.structuredOutput?.role === "verifier") {
          stageResult.verdict = computeVerifyVerdict(stageResult.structuredOutput.data as VerifierOutput);
        }
        stageResults.set(result.value.stageLabel, stageResult);
        settledGroupResults.push(stageResult);
        totalTurnsConsumed += stageResult.turnCount ?? 0;
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
      stopReason = "stage_failed";
      break;
    }
  }

  return aggregateTeamResults(team, stageResults, stopReason);
}
