import type { SubAgentRole } from "./types";

export type AgentTeamFailurePolicy = "stop" | "skip";

export type AgentTeamStageConditionType =
  | "always"
  | "if_previous_succeeded"
  | "if_issues_found";

export interface AgentTeamStageCondition {
  type: AgentTeamStageConditionType;
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
];
