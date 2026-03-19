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

/** P5-2: Tracks where an action originated for audit/debugging. */
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
  /** P5-2: Which agent layer proposed this action. */
  origin?: ActionOrigin;
  /** P5-2: For sub_agent/team_stage origins, the role or stage label. */
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
  owner: AgentRole;
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
// Sub-Agent progress events (Phase 5)
// ---------------------------------------------------------------------------

export interface SubAgentProgressMeta {
  teamId?: string;
  stageLabel?: string;
  agentRole?: string;
  sourceLabel?: string;
}

export type SubAgentProgressEvent = (
  | { kind: "tool_start"; toolName: string; turn: number; maxTurns: number }
  | { kind: "tool_complete"; toolName: string; success: boolean; durationMs: number }
  | { kind: "thinking"; partialContent: string }
  | { kind: "action_proposed"; actionType: SensitiveActionType; description: string }
  | { kind: "summary"; message: string }
) & SubAgentProgressMeta;
