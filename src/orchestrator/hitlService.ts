/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/hitlService.ts
 * Milestone: 3
 * Task: 3.1
 * Status: In Progress
 * Owner: Codex-GPT-5
 * Last Modified: 2026-03-01
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
import { actionFingerprint } from "./planningService";

interface PatchApplyResult {
  success: boolean;
  message: string;
  files: string[];
}

interface SnapshotResult {
  success: boolean;
  snapshot_id: string;
  files: string[];
}

interface CommandExecutionResult {
  success: boolean;
  command: string;
  timed_out: boolean;
  status: number;
  stdout: string;
  stderr: string;
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

function ensureFingerprint(action: ActionProposal): string {
  if (typeof action.fingerprint === "string" && action.fingerprint.trim()) {
    return action.fingerprint;
  }
  return actionFingerprint(action);
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
    fingerprint: ensureFingerprint(action),
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
    fingerprint: ensureFingerprint(action),
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
      const nextAction: ActionProposal = {
        ...action,
        payload: {
          ...action.payload,
          patch:
            typeof payloadPatch.patch === "string" ? payloadPatch.patch : action.payload.patch
        }
      };
      return {
        ...nextAction,
        fingerprint: ensureFingerprint(nextAction)
      };
    }

    if (action.type === "shell") {
      const nextAction: ActionProposal = {
        ...action,
        payload: {
          ...action.payload,
          shell:
            typeof payloadPatch.shell === "string" ? payloadPatch.shell : action.payload.shell,
          timeoutMs:
            typeof payloadPatch.timeoutMs === "number"
              ? payloadPatch.timeoutMs
              : action.payload.timeoutMs
        }
      };
      return {
        ...nextAction,
        fingerprint: ensureFingerprint(nextAction)
      };
    }

    return action;
  });

  return {
    ...plan,
    proposedActions: nextActions
  };
}

export function rejectAllPendingActions(
  plan: OrchestrationPlan,
  reason: string
): OrchestrationPlan {
  const normalizedReason = reason.trim() || "Batch rejected by reviewer";
  const nextActions = plan.proposedActions.map((action) => {
    if (action.status !== "pending" && action.status !== "failed") {
      return action;
    }
    return {
      ...action,
      fingerprint: ensureFingerprint(action),
      status: "rejected" as const,
      executed: false,
      executionResult: createExecutionResult(false, normalizedReason)
    };
  });

  return {
    ...plan,
    state: deriveWorkflowState(nextActions),
    proposedActions: nextActions
  };
}

export async function approveAllPendingActions(
  plan: OrchestrationPlan,
  workspacePath: string
): Promise<OrchestrationPlan> {
  if (!workspacePath.trim()) {
    throw new Error("未选择工作区，无法执行审批动作。");
  }

  const pendingActions = plan.proposedActions.filter(
    (action) => action.status === "pending"
  );

  if (pendingActions.length === 0) {
    return plan;
  }

  const patchActions = pendingActions.filter((a) => a.type === "apply_patch");
  const shellActions = pendingActions.filter((a) => a.type === "shell");

  // ── Atomic batch: create a single snapshot covering all patch actions ──
  // If any patch fails, we rollback ALL patches applied in this batch.
  let batchSnapshotId: string | null = null;
  const batchSnapshotFiles: string[] = [];

  if (patchActions.length > 1) {
    // Merge all patches into one combined patch for a single snapshot
    const combinedPatch = patchActions
      .map((a) => a.payload.patch)
      .join("\n");
    try {
      const snapshot = await invoke<SnapshotResult>("create_workspace_snapshot", {
        workspacePath,
        patch: combinedPatch
      });
      if (snapshot.success) {
        batchSnapshotId = snapshot.snapshot_id;
        batchSnapshotFiles.push(...snapshot.files);
      }
    } catch {
      // Snapshot creation failed — proceed without atomic guarantee
      // (falls back to per-action snapshots via approveAction)
    }
  }

  let currentPlan = plan;
  let batchFailed = false;
  const appliedPatchIds: string[] = [];

  // Apply patch actions first (they form the atomic unit)
  for (const action of patchActions) {
    currentPlan = await approveAction(currentPlan, action.id, workspacePath);
    const updatedAction = currentPlan.proposedActions.find(
      (a) => a.id === action.id
    );
    if (updatedAction?.executionResult?.success) {
      appliedPatchIds.push(action.id);
    } else {
      batchFailed = true;
      break;
    }
  }

  // If any patch failed and we have a batch snapshot, rollback everything
  if (batchFailed && batchSnapshotId) {
    try {
      const rollback = await invoke<PatchApplyResult>("restore_workspace_snapshot", {
        workspacePath,
        snapshotId: batchSnapshotId
      });
      const rollbackMsg = rollback.success
        ? "批量补丁中有失败项，已原子回滚全部已应用的补丁。"
        : "批量补丁中有失败项，原子回滚失败，部分补丁可能已生效。";

      // Mark all patch actions in the batch as failed with rollback info
      const nextActions = currentPlan.proposedActions.map((a) => {
        if (a.type !== "apply_patch" || !pendingActions.find((p) => p.id === a.id)) {
          return a;
        }
        return {
          ...a,
          fingerprint: ensureFingerprint(a),
          status: "failed" as const,
          executed: false,
          executionResult: createExecutionResult(false, rollbackMsg, {
            atomicRollback: true,
            batchSnapshotId,
            rollbackSuccess: rollback.success
          })
        };
      });
      currentPlan = {
        ...currentPlan,
        state: deriveWorkflowState(nextActions),
        proposedActions: nextActions
      };
    } catch {
      // Rollback invocation failed — leave current state as-is
    }
  }

  // Apply shell actions (not part of the atomic patch unit)
  for (const action of shellActions) {
    currentPlan = await approveAction(currentPlan, action.id, workspacePath);
  }

  return currentPlan;
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
    const preflight = await invoke<PatchApplyResult>("check_workspace_patch", {
      workspacePath,
      patch: action.payload.patch
    });
    if (!preflight.success) {
      result = createExecutionResult(false, `Patch 预检失败: ${preflight.message}`, {
        files: preflight.files
      });
    } else {
      const snapshot = await invoke<SnapshotResult>("create_workspace_snapshot", {
        workspacePath,
        patch: action.payload.patch
      });
      const payload = await invoke<PatchApplyResult>("apply_workspace_patch", {
        workspacePath,
        patch: action.payload.patch
      });
      if (!payload.success && snapshot.success) {
        const rollback = await invoke<PatchApplyResult>("restore_workspace_snapshot", {
          workspacePath,
          snapshotId: snapshot.snapshot_id
        });
        result = createExecutionResult(
          false,
          `${payload.message}${rollback.success ? "（已自动回滚）" : "（自动回滚失败）"}`,
          {
            files: payload.files,
            snapshotId: snapshot.snapshot_id,
            snapshotFiles: snapshot.files,
            rollbackSuccess: rollback.success,
            rollbackMessage: rollback.message
          }
        );
      } else {
        result = createExecutionResult(payload.success, payload.message, {
          files: payload.files,
          snapshotId: snapshot.snapshot_id,
          snapshotFiles: snapshot.files
        });
      }
    }
  } else {
    const payload = await invoke<CommandExecutionResult>("run_shell_command", {
      workspacePath,
      shell: action.payload.shell,
      timeoutMs: action.payload.timeoutMs
    });
    result = createExecutionResult(payload.success, payload.success ? "命令执行成功" : "命令执行失败", {
      command: action.payload.shell,
      timedOut: payload.timed_out,
      status: payload.status,
      stdout: payload.stdout,
      stderr: payload.stderr
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
    fingerprint: ensureFingerprint(entry),
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
