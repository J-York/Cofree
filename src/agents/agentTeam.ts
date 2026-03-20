import type { SubAgentRole } from "./types";

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
  | "if_stage_executed";

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
}

export const BUILTIN_TEAMS: AgentTeamDefinition[] = [
  {
    id: "team-full-cycle",
    name: "完整开发周期",
    description: "分析 → 实现 → 审查 → 测试",
    pipeline: [
      { agentRole: "planner", stageLabel: "需求分析与任务拆解" },
      {
        agentRole: "coder",
        stageLabel: "代码实现",
        inputMapping: { fromStage: "需求分析与任务拆解", fields: ["tasks"] },
      },
      {
        agentRole: "reviewer",
        stageLabel: "代码审查",
        condition: { type: "if_previous_succeeded" },
        parallelGroup: "review_and_test",
      },
      {
        agentRole: "tester",
        stageLabel: "测试验证",
        condition: { type: "if_previous_succeeded" },
        parallelGroup: "review_and_test",
      },
    ],
    config: { maxTotalTurns: 80, sharedWorkingMemory: true, failurePolicy: "stop" },
  },
  {
    id: "team-debug-fix",
    name: "调试修复",
    description: "调试 → 修复 → 验证",
    pipeline: [
      { agentRole: "debugger", stageLabel: "问题诊断" },
      {
        agentRole: "coder",
        stageLabel: "修复实现",
        inputMapping: { fromStage: "问题诊断", fields: ["rootCause", "fix"] },
      },
      {
        agentRole: "tester",
        stageLabel: "修复验证",
        condition: { type: "if_previous_succeeded" },
      },
    ],
    config: { maxTotalTurns: 60, sharedWorkingMemory: true, failurePolicy: "stop" },
  },
  {
    id: "team-expert-panel",
    name: "专家组流水线",
    description: "需求对齐 → 实现 → 审查（专家组接待推荐路径）",
    pipeline: [
      { agentRole: "planner", stageLabel: "需求对齐与任务拆解" },
      {
        agentRole: "coder",
        stageLabel: "实现与落地",
        inputMapping: {
          fromStage: "需求对齐与任务拆解",
          fields: ["tasks", "riskAssessment", "architectureNotes"],
        },
        condition: { type: "if_previous_succeeded" },
      },
      {
        agentRole: "reviewer",
        stageLabel: "审查与质量把关",
        condition: { type: "if_previous_succeeded" },
      },
    ],
    config: { maxTotalTurns: 72, sharedWorkingMemory: true, failurePolicy: "stop" },
  },
  {
    id: "team-expert-panel-v2",
    name: "专家组流水线（闭环）",
    description:
      "需求对齐 → 实现 → 审查 → 按需修复 → 测试 → 按需修复 → 复验（专家组接待默认推荐）",
    pipeline: [
      { agentRole: "planner", stageLabel: "需求对齐与任务拆解" },
      {
        agentRole: "coder",
        stageLabel: "实现与落地",
        inputMapping: {
          fromStage: "需求对齐与任务拆解",
          fields: ["tasks", "riskAssessment", "architectureNotes"],
        },
        condition: { type: "if_previous_succeeded" },
      },
      {
        agentRole: "reviewer",
        stageLabel: "审查与质量把关",
        condition: { type: "if_previous_succeeded" },
      },
      {
        agentRole: "coder",
        stageLabel: "审查问题修复",
        condition: {
          type: "if_issues_from_stage",
          refStageLabel: "审查与质量把关",
        },
        inputMapping: {
          fromStage: "审查与质量把关",
          fields: ["issues", "summary", "overallAssessment"],
        },
      },
      {
        agentRole: "tester",
        stageLabel: "测试验证",
        condition: { type: "if_previous_succeeded" },
      },
      {
        agentRole: "coder",
        stageLabel: "测试失败修复",
        condition: {
          type: "if_issues_from_stage",
          refStageLabel: "测试验证",
        },
        inputMapping: {
          fromStage: "测试验证",
          fields: ["testPlan", "riskLevel", "coverageGaps"],
        },
      },
      {
        agentRole: "tester",
        stageLabel: "测试复验",
        condition: {
          type: "if_stage_executed",
          refStageLabel: "测试失败修复",
        },
      },
    ],
    config: {
      maxTotalTurns: 96,
      sharedWorkingMemory: true,
      failurePolicy: "stop",
      emitPlanCheckpoint: true,
    },
  },
];
