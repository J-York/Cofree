/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/types.ts
 * Milestone: 2
 * Task: 2.2
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Shared types for orchestration planning output and pending gated actions.
 */

import type { AgentRole } from "../agents/defaultAgents";

export type WorkflowState = "planning" | "executing" | "human_review" | "done";

export type SensitiveActionType = "apply_patch" | "run_command" | "git_write";

export type ActionStatus = "pending" | "running" | "completed" | "failed" | "rejected";

export interface ActionExecutionResult {
  success: boolean;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ApplyPatchPayload {
  patch: string;
}

export interface RunCommandPayload {
  command: string;
  timeoutMs: number;
}

export interface GitWritePayload {
  operation: "stage" | "commit" | "checkout_branch";
  message: string;
  branchName: string;
  allowEmpty: boolean;
}

interface ActionProposalBase {
  id: string;
  description: string;
  gateRequired: true;
  status: ActionStatus;
  executed: boolean;
  executionResult?: ActionExecutionResult;
}

export interface ApplyPatchActionProposal extends ActionProposalBase {
  type: "apply_patch";
  payload: ApplyPatchPayload;
}

export interface RunCommandActionProposal extends ActionProposalBase {
  type: "run_command";
  payload: RunCommandPayload;
}

export interface GitWriteActionProposal extends ActionProposalBase {
  type: "git_write";
  payload: GitWritePayload;
}

export type ActionProposal =
  | ApplyPatchActionProposal
  | RunCommandActionProposal
  | GitWriteActionProposal;

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
  workspacePath?: string;
}
