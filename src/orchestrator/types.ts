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

export type ActionOrigin = "main_agent" | "sub_agent" | "team_stage";

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
  origin?: ActionOrigin;
  originDetail?: string;
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
  owner: string;
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

// ---------------------------------------------------------------------------
// Sub-agent progress types (retained for UI backward compatibility;
// no longer emitted by the orchestrator)
// ---------------------------------------------------------------------------

export type SubAgentProgressKind =
  | "summary"
  | "tool_start"
  | "tool_complete"
  | "action_proposed"
  | "stage_complete"
  | "team_checkpoint"
  | "thinking";

export interface SubAgentProgressEvent {
  kind: SubAgentProgressKind;
  message?: string;
  toolName?: string;
  turn?: number;
  maxTurns?: number;
  success?: boolean;
  durationMs?: number;
  actionType?: string;
  description?: string;
  stageLabel?: string;
  stageIndex?: number;
  currentStageIndex?: number;
  totalStages?: number;
  teamId?: string;
  agentRole?: string;
  sourceLabel?: string;
  stageStatus?: "running" | "completed" | "failed" | "skipped" | "blocked";
  completedStageCount?: number;
  activeParallelCount?: number;
  summary?: string;
  partialContent?: string;
}

export interface SubAgentProgressMeta {
  role: string;
  events: SubAgentProgressEvent[];
}
