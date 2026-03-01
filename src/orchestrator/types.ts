/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/types.ts
 * Milestone: 2
 * Task: 2.2
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-03-01
 * Description: Shared types for orchestration planning output and pending gated actions.
 */

import type { AgentRole } from "../agents/defaultAgents";

export type WorkflowState = "planning" | "executing" | "human_review" | "done";

export type SensitiveActionType = "apply_patch" | "shell";

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

export interface ShellPayload {
  shell: string;
  timeoutMs: number;
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

export interface ShellActionProposal extends ActionProposalBase {
  type: "shell";
  payload: ShellPayload;
}

export type ActionProposal =
  | ApplyPatchActionProposal
  | ShellActionProposal;

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
