/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/hitlService.ts
 * Milestone: 3
 * Task: 3.1
 * Status: In Progress
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Human-in-the-loop approval utilities and guarded action execution.
 */

import { invoke } from "@tauri-apps/api/core";
import { recordSensitiveActionAudit } from "../lib/auditLog";
import type {
  ActionExecutionResult,
  ActionProposal,
  OrchestrationPlan,
  WorkflowState
} from "./types";

interface PatchApplyResult {
  success: boolean;
  message: string;
  files: string[];
}

interface SnapshotResult {
  success: boolean;
  snapshot_id: string;
  status: string;
  diff: string;
  untracked_files: string[];
}

interface CommandExecutionResult {
  success: boolean;
  command: string;
  timed_out: boolean;
  status: number;
  stdout: string;
  stderr: string;
}

interface GitWriteResult {
  success: boolean;
  operation: string;
  message: string;
  branch?: string;
  commit_oid?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapActions(
  plan: OrchestrationPlan,
  actionId: string,
  updater: (action: ActionProposal) => ActionProposal
): ActionProposal[] {
  return plan.proposedActions.map((action) => (action.id === actionId ? updater(action) : action));
}

function canRejectOrComment(action: ActionProposal): boolean {
  return action.status === "pending" || action.status === "failed";
}

function createExecutionResult(
  success: boolean,
  message: string,
  metadata?: Record<string, unknown>
): ActionExecutionResult {
  return {
    success,
    message,
    timestamp: nowIso(),
    metadata
  };
}

export function deriveWorkflowState(actions: ActionProposal[]): WorkflowState {
  if (actions.some((action) => action.status === "running")) {
    return "executing";
  }

  if (
    actions.some(
      (action) =>
        action.status === "pending" || action.status === "failed" || action.status === "rejected"
    )
  ) {
    return "human_review";
  }

  return "done";
}

export function markActionRunning(plan: OrchestrationPlan, actionId: string): OrchestrationPlan {
  const nextActions = mapActions(plan, actionId, (action) => ({
    ...action,
    status: "running",
    executed: false
  }));

  return {
    ...plan,
    state: "executing",
    proposedActions: nextActions
  };
}

export function rejectAction(
  plan: OrchestrationPlan,
  actionId: string,
  reason: string
): OrchestrationPlan {
  const normalizedReason = reason.trim() || "Rejected by reviewer";
  const targetAction = plan.proposedActions.find((action) => action.id === actionId);
  if (!targetAction || !canRejectOrComment(targetAction)) {
    return plan;
  }

  const nextActions = mapActions(plan, actionId, (action) => ({
    ...action,
    status: "rejected",
    executed: false,
    executionResult: createExecutionResult(false, normalizedReason)
  }));

  return {
    ...plan,
    state: deriveWorkflowState(nextActions),
    proposedActions: nextActions
  };
}

export function commentAction(
  plan: OrchestrationPlan,
  actionId: string,
  comment: string
): OrchestrationPlan {
  const normalizedComment = comment.trim();
  if (!normalizedComment) {
    return plan;
  }

  const targetAction = plan.proposedActions.find((action) => action.id === actionId);
  if (!targetAction || !canRejectOrComment(targetAction)) {
    return plan;
  }

  const nextActions = mapActions(plan, actionId, (action) => ({
    ...action,
    executionResult: createExecutionResult(true, normalizedComment, {
      commentOnly: true
    })
  }));

  return {
    ...plan,
    state: deriveWorkflowState(nextActions),
    proposedActions: nextActions
  };
}

export function updateActionPayload(
  plan: OrchestrationPlan,
  actionId: string,
  payloadPatch: Record<string, unknown>
): OrchestrationPlan {
  const nextActions = mapActions(plan, actionId, (action) => {
    if (action.type === "apply_patch") {
      return {
        ...action,
        payload: {
          ...action.payload,
          patch:
            typeof payloadPatch.patch === "string" ? payloadPatch.patch : action.payload.patch
        }
      };
    }

    if (action.type === "run_command") {
      return {
        ...action,
        payload: {
          ...action.payload,
          command:
            typeof payloadPatch.command === "string"
              ? payloadPatch.command
              : action.payload.command,
          timeoutMs:
            typeof payloadPatch.timeoutMs === "number"
              ? payloadPatch.timeoutMs
              : action.payload.timeoutMs
        }
      };
    }

    return {
      ...action,
      payload: {
        ...action.payload,
        operation:
          typeof payloadPatch.operation === "string"
            ? (payloadPatch.operation as typeof action.payload.operation)
            : action.payload.operation,
        message:
          typeof payloadPatch.message === "string"
            ? payloadPatch.message
            : action.payload.message,
        branchName:
          typeof payloadPatch.branchName === "string"
            ? payloadPatch.branchName
            : action.payload.branchName,
        allowEmpty:
          typeof payloadPatch.allowEmpty === "boolean"
            ? payloadPatch.allowEmpty
            : action.payload.allowEmpty
      }
    };
  });

  return {
    ...plan,
    proposedActions: nextActions
  };
}

export async function approveAction(
  plan: OrchestrationPlan,
  actionId: string,
  workspacePath: string
): Promise<OrchestrationPlan> {
  const action = plan.proposedActions.find((entry) => entry.id === actionId);
  if (!action) {
    return plan;
  }
  if (!workspacePath.trim()) {
    throw new Error("未选择工作区，无法执行审批动作。");
  }

  const startedAt = nowIso();
  const executor = "human_reviewer";
  let result: ActionExecutionResult;

  if (action.type === "apply_patch") {
    const snapshot = await invoke<SnapshotResult>("create_workspace_snapshot", {
      workspacePath
    });
    const payload = await invoke<PatchApplyResult>("apply_workspace_patch", {
      workspacePath,
      patch: action.payload.patch
    });
    if (!payload.success && snapshot.success) {
      const rollback = await invoke<PatchApplyResult>("restore_workspace_snapshot", {
        workspacePath,
        diff: snapshot.diff,
        snapshotId: snapshot.snapshot_id
      });
      result = createExecutionResult(
        false,
        `${payload.message}${rollback.success ? "（已自动回滚）" : "（自动回滚失败）"}`,
        {
          files: payload.files,
          snapshotId: snapshot.snapshot_id,
          snapshotUntrackedFiles: snapshot.untracked_files,
          rollbackSuccess: rollback.success,
          rollbackMessage: rollback.message
        }
      );
    } else {
      result = createExecutionResult(payload.success, payload.message, {
        files: payload.files,
        snapshotId: snapshot.snapshot_id,
        snapshotUntrackedFiles: snapshot.untracked_files
      });
    }
  } else if (action.type === "run_command") {
    const payload = await invoke<CommandExecutionResult>("run_workspace_command", {
      workspacePath,
      command: action.payload.command,
      timeoutMs: action.payload.timeoutMs
    });
    result = createExecutionResult(payload.success, payload.success ? "命令执行成功" : "命令执行失败", {
      command: payload.command,
      timedOut: payload.timed_out,
      status: payload.status,
      stdout: payload.stdout,
      stderr: payload.stderr
    });
  } else {
    const payload = await invoke<GitWriteResult>("git_write_workspace", {
      workspacePath,
      operation: action.payload.operation,
      message: action.payload.message,
      branchName: action.payload.branchName,
      allowEmpty: action.payload.allowEmpty
    });
    result = createExecutionResult(payload.success, payload.message, {
      operation: payload.operation,
      branch: payload.branch ?? null,
      commitOid: payload.commit_oid ?? null
    });
  }

  result = {
    ...result,
    metadata: {
      ...(result.metadata ?? {}),
      executor
    }
  };

  const nextActions = mapActions(plan, actionId, (entry) => ({
    ...entry,
    status: result.success ? "completed" : "failed",
    executed: result.success,
    executionResult: result
  }));

  recordSensitiveActionAudit({
    actionId: action.id,
    actionType: action.type,
    status: result.success ? "success" : "failed",
    startedAt,
    finishedAt: nowIso(),
    executor,
    reason: result.message,
    workspacePath,
    details: result.metadata ?? {}
  });

  return {
    ...plan,
    state: deriveWorkflowState(nextActions),
    proposedActions: nextActions
  };
}
