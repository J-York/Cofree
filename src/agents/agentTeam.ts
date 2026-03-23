import type { SubAgentRole } from "./types";

export interface IsolatedInputSpec {
  fromOriginalRequest: boolean;
  fromStage?: string;
  fields?: string[];
  includeGitDiff?: boolean;
  includeFileContents?: string[];
}

/** True if every stage role in the team is in `allowedRoles` (P0-2 contract). */
export function isTeamAllowedForRoles(
  team: AgentTeamDefinition,
  allowedRoles: readonly SubAgentRole[],
): boolean {
  const allowed = new Set(allowedRoles);
  return team.pipeline.every((stage) => allowed.has(stage.agentRole));
}

export function listTeamIdsAllowedForRoles(
  allowedRoles: readonly SubAgentRole[],
): string[] {
  return BUILTIN_TEAMS.filter((t) => isTeamAllowedForRoles(t, allowedRoles)).map((t) => t.id);
}

export type AgentTeamFailurePolicy = "stop" | "skip";

export type AgentTeamStageConditionType =
  | "always"
  | "if_previous_succeeded"
  | "if_issues_found"
  /** True when the named prior stage's structured output reports reviewer issues or failed tests. */
  | "if_issues_from_stage"
  /** True when the named stage ran (not synthetic skipped). */
  | "if_stage_executed"
  | "if_review_failed"
  | "if_verify_failed";

export interface AgentTeamStageCondition {
  type: AgentTeamStageConditionType;
  /** Pipeline `stageLabel` for `if_issues_from_stage` / `if_stage_executed`. */
  refStageLabel?: string;
}

export interface AgentTeamDefinition {
  id: string;
  name: string;
  description: string;
  /** 按执行顺序排列的 Agent（顺序执行；同一 parallelGroup 的相邻阶段会并行执行） */
  pipeline: AgentTeamStage[];
  /** 团队级配置 */
  config: {
    maxTotalTurns: number;
    sharedWorkingMemory: boolean;
    /**
     * stop: 任一阶段 failed 后停止后续执行。
     * skip: 不因 failed 自动停止；后续阶段仍按自身 condition 决定是否执行。
     * 注意：当前不支持 team 级自动 retry。
     */
    failurePolicy: AgentTeamFailurePolicy;
    /**
     * 当 planner 阶段成功结束后发出 `team_checkpoint` 进度事件，供 UI 提示「计划已产出，可请用户确认后再继续」。
     * 不暂停执行；真正 HITL 门控由后续规划与产品化迭代接入。
     */
    emitPlanCheckpoint?: boolean;
  };
}

export interface AgentTeamStage {
  agentRole: SubAgentRole;
  stageLabel: string;
  /** 可选：前一阶段的哪些输出作为本阶段的输入 */
  inputMapping?: {
    fromStage: string;
    fields: string[];
  };
  /** 可选：执行条件。具体语义由 teamExecutor 中的统一条件求值实现定义。 */
  condition?: AgentTeamStageCondition;
  /** 可选：与相邻且 parallelGroup 相同的阶段并行执行 */
  parallelGroup?: string;
  contextPolicy?: "shared" | "isolated";
  isolatedInputs?: IsolatedInputSpec;
  maxRepairRounds?: number;
}

export const LEGACY_TEAM_ID_MAP: Record<string, string> = {
  "team-full-cycle": "team-build",
  "team-expert-panel": "team-build",
  "team-expert-panel-v2": "team-build",
  "team-debug-fix": "team-fix",
};

export function resolveTeamId(id: string): string {
  return LEGACY_TEAM_ID_MAP[id] ?? id;
}

export const BUILTIN_TEAMS: AgentTeamDefinition[] = [
  {
    id: "team-build",
    name: "构建流水线",
    description: "需求分析 → 实现 → 审查(隔离)+测试(并行) → 门禁修复 → 最终验证",
    pipeline: [
      { agentRole: "planner", stageLabel: "需求分析", contextPolicy: "shared" },
      {
        agentRole: "coder",
        stageLabel: "实现",
        contextPolicy: "shared",
        inputMapping: { fromStage: "需求分析", fields: ["tasks", "riskAssessment"] },
      },
      {
        agentRole: "reviewer",
        stageLabel: "代码审查",
        contextPolicy: "isolated",
        isolatedInputs: {
          fromOriginalRequest: true,
          includeGitDiff: true,
          includeFileContents: ["changed"],
        },
        condition: { type: "if_previous_succeeded" },
        parallelGroup: "review_and_test",
      },
      {
        agentRole: "tester",
        stageLabel: "测试设计与执行",
        contextPolicy: "shared",
        condition: { type: "if_previous_succeeded" },
        parallelGroup: "review_and_test",
      },
      {
        agentRole: "coder",
        stageLabel: "审查问题修复",
        contextPolicy: "shared",
        condition: { type: "if_review_failed", refStageLabel: "代码审查" },
        inputMapping: { fromStage: "代码审查", fields: ["issues"] },
        maxRepairRounds: 2,
      },
      {
        agentRole: "verifier",
        stageLabel: "最终验证",
        contextPolicy: "isolated",
        isolatedInputs: {
          fromOriginalRequest: false,
          includeGitDiff: true,
          fromStage: "实现",
          fields: ["changedFiles"],
        },
        condition: { type: "if_previous_succeeded" },
      },
      {
        agentRole: "coder",
        stageLabel: "验证失败修复",
        contextPolicy: "shared",
        condition: { type: "if_verify_failed", refStageLabel: "最终验证" },
        inputMapping: { fromStage: "最终验证", fields: ["commands", "failureSummary"] },
        maxRepairRounds: 1,
      },
    ],
    config: {
      maxTotalTurns: 96,
      sharedWorkingMemory: true,
      failurePolicy: "stop",
      emitPlanCheckpoint: true,
    },
  },
  {
    id: "team-fix",
    name: "修复流水线",
    description: "调试 → 修复 → 验证(硬门禁)",
    pipeline: [
      { agentRole: "debugger", stageLabel: "问题诊断", contextPolicy: "shared" },
      {
        agentRole: "coder",
        stageLabel: "修复实现",
        contextPolicy: "shared",
        inputMapping: { fromStage: "问题诊断", fields: ["rootCause", "fix"] },
      },
      {
        agentRole: "verifier",
        stageLabel: "修复验证",
        contextPolicy: "isolated",
        isolatedInputs: {
          fromOriginalRequest: false,
          includeGitDiff: true,
          fromStage: "修复实现",
          fields: ["changedFiles"],
        },
        condition: { type: "if_previous_succeeded" },
      },
      {
        agentRole: "coder",
        stageLabel: "验证失败修复",
        contextPolicy: "shared",
        condition: { type: "if_verify_failed", refStageLabel: "修复验证" },
        inputMapping: { fromStage: "修复验证", fields: ["commands", "failureSummary"] },
        maxRepairRounds: 1,
      },
    ],
    config: { maxTotalTurns: 60, sharedWorkingMemory: true, failurePolicy: "stop" },
  },
];
