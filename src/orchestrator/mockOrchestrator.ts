/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/mockOrchestrator.ts
 * Milestone: 2
 * Task: 2.2
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Mock orchestration helper that returns a pending-only plan.
 */

import type { OrchestrationPlan } from "./types";
import { inferSensitiveActions } from "./actionInference";

function createPlanSteps(prompt: string): OrchestrationPlan["steps"] {
  return [
    {
      id: "step-plan",
      title: "分析需求",
      owner: "planner",
      status: "in_progress",
      summary: `分析需求并拆解执行步骤: ${prompt}`,
    },
    {
      id: "step-patch",
      title: "生成补丁",
      owner: "coder",
      status: "pending",
      summary: "基于需求生成内存 patch（不写盘）",
    },
    {
      id: "step-validate",
      title: "验证风险",
      owner: "tester",
      status: "pending",
      summary: "生成测试建议与风险摘要，等待人工审批",
    },
  ];
}

export function draftPlanFromPrompt(prompt: string): OrchestrationPlan {
  const normalized = prompt.trim() || "实现用户提出的功能";
  const steps = createPlanSteps(normalized);

  return {
    state: "planning",
    prompt: normalized,
    steps,
    proposedActions: inferSensitiveActions(normalized)
  };
}
