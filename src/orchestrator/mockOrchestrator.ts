/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/mockOrchestrator.ts
 * Milestone: 1
 * Task: 1.2
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Milestone 1 mock orchestration that returns plan + gated actions.
 */

import type { OrchestrationPlan } from "./types";

function createPlanSteps(prompt: string): OrchestrationPlan["steps"] {
  return [
    {
      id: "step-plan",
      owner: "planner",
      summary: `分析需求并拆解执行步骤: ${prompt}`
    },
    {
      id: "step-patch",
      owner: "coder",
      summary: "基于需求生成内存 patch（不写盘）"
    },
    {
      id: "step-validate",
      owner: "tester",
      summary: "生成测试建议与风险摘要，等待人工审批"
    }
  ];
}

export function draftPlanFromPrompt(prompt: string): OrchestrationPlan {
  const normalized = prompt.trim() || "实现用户提出的功能";

  return {
    state: "planning",
    prompt: normalized,
    steps: createPlanSteps(normalized),
    proposedActions: [
      {
        id: "gate-apply",
        type: "apply_patch",
        description: "Apply generated patch to workspace",
        gateRequired: true
      },
      {
        id: "gate-command",
        type: "run_command",
        description: "Run allowlisted validation command",
        gateRequired: true
      },
      {
        id: "gate-git",
        type: "git_write",
        description: "Stage and commit approved workspace changes",
        gateRequired: true
      }
    ]
  };
}
