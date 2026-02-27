/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/types.ts
 * Milestone: 1
 * Task: 1.2
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Shared types for orchestration planning output.
 */

import type { AgentRole } from "../agents/defaultAgents";

export type WorkflowState = "planning" | "executing" | "human_review" | "done";

export type SensitiveActionType = "apply_patch" | "run_command" | "git_write";

export interface ActionProposal {
  id: string;
  type: SensitiveActionType;
  description: string;
  gateRequired: true;
}

export interface PlanStep {
  id: string;
  summary: string;
  owner: AgentRole;
}

export interface OrchestrationPlan {
  state: WorkflowState;
  prompt: string;
  steps: PlanStep[];
  proposedActions: ActionProposal[];
}
