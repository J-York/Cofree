/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/types.ts
 * Description: Shared types for orchestration planning output and pending gated actions.
 */

export type WorkflowState = "planning" | "executing" | "human_review" | "done";

export type SensitiveActionType = "apply_patch" | "shell";

export type ActionStatus =
  | "pending"
  | "running"
  | "background"
  | "completed"
  | "failed"
  | "rejected";

export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed"
  | "failed"
  | "skipped";

export type ActionGroupMeta = {
  groupId: string;
  title?: string;
  atomicIntent?: boolean;
  createdAt: string;
};

export type BatchExecutionMeta = {
  snapshotId?: string;
  atomicEnabled: boolean;
  atomicRollbackAttempted?: boolean;
  atomicRollbackSuccess?: boolean;
  degradedReason?: string;
};

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
  blockUntilMs?: number;
  executionMode?: "foreground" | "background";
  readyUrl?: string;
  readyTimeoutMs?: number;
  retryFromActionId?: string;
  retryAttempt?: number;
}


interface ActionProposalBase {
  id: string;
  description: string;
  gateRequired: true;
  status: ActionStatus;
  executed: boolean;
  executionResult?: ActionExecutionResult;
  toolCallId?: string;
  toolName?: string;
  fingerprint?: string;
  planStepId?: string;
}

export interface ApplyPatchActionProposal extends ActionProposalBase {
  type: "apply_patch";
  payload: ApplyPatchPayload;
  group?: ActionGroupMeta;
  batchExec?: BatchExecutionMeta;
}

export interface ShellActionProposal extends ActionProposalBase {
  type: "shell";
  payload: ShellPayload;
}

export type ActionProposal = ApplyPatchActionProposal | ShellActionProposal;

export interface PlanStep {
  id: string;
  title: string;
  summary: string;
  status: PlanStepStatus;
  dependsOn?: string[];
  linkedActionIds?: string[];
  note?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface OrchestrationPlan {
  state: WorkflowState;
  prompt: string;
  steps: PlanStep[];
  activeStepId?: string;
  proposedActions: ActionProposal[];
  workspacePath?: string;
}
