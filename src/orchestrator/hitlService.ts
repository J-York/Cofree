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
  PlanStep,
  WorkflowState,
} from "./types";
import {
  actionFingerprint,
  derivePlanWorkflowState,
  setActivePlanStep,
  setPlanStepStatus,
  syncPlanStateWithActions,
  type TodoPlanState,
} from "./planningService";

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

export interface ManualApprovalContext {
  approvalMode?: "manual" | "remember_workspace_rule";
  approvalRuleLabel?: string;
  approvalRuleKind?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapActions(
  plan: OrchestrationPlan,
  actionId: string,
  updater: (action: ActionProposal) => ActionProposal
): ActionProposal[] {
  return plan.proposedActions.map((action) =>
    action.id === actionId ? updater(action) : action
  );
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
    metadata,
  };
}

function pickShellFailureMessage(payload: CommandExecutionResult): string {
  const stderr = payload.stderr.trim();
  const stdout = payload.stdout.trim();
  const preferredOutput = stderr || stdout;

  if (payload.timed_out) {
    return preferredOutput
      ? `命令执行超时：${preferredOutput}`
      : `命令执行超时（exit ${payload.status}）`;
  }

  if (preferredOutput) {
    return preferredOutput;
  }

  return `命令执行失败（exit ${payload.status}）`;
}

function nextShellRetryAttempt(action: ActionProposal): number {
  if (action.type !== "shell") {
    return 0;
  }
  return typeof action.payload.retryAttempt === "number"
    ? action.payload.retryAttempt + 1
    : 1;
}

function createPlanState(plan: OrchestrationPlan): TodoPlanState {
  return {
    steps: plan.steps,
    activeStepId: plan.activeStepId,
  };
}

function appendPlanStepNote(step: PlanStep | undefined, note?: string): void {
  if (!step) {
    return;
  }
  const normalized = note?.trim();
  if (!normalized) {
    return;
  }
  step.note = step.note?.trim()
    ? `${step.note.trim()}\n${normalized}`
    : normalized;
}

function applyPlanStateUpdate(
  plan: OrchestrationPlan,
  nextActions: ActionProposal[],
  updater?: (planState: TodoPlanState) => void,
): OrchestrationPlan {
  const planState = syncPlanStateWithActions(
    createPlanState(plan),
    nextActions,
    { promoteNextRunnable: false },
  );
  updater?.(planState);
  return {
    ...plan,
    state: derivePlanWorkflowState(nextActions, planState),
    steps: planState.steps,
    activeStepId: planState.activeStepId,
    proposedActions: nextActions,
  };
}

function linkedPlanStep(planState: TodoPlanState, action?: ActionProposal): PlanStep | undefined {
  if (!action?.planStepId) {
    return undefined;
  }
  return planState.steps.find((step) => step.id === action.planStepId);
}

export function retryFailedShellAction(
  plan: OrchestrationPlan,
  actionId: string
): OrchestrationPlan {
  const sourceAction = plan.proposedActions.find(
    (action) => action.id === actionId && action.type === "shell" && action.status === "failed"
  );
  if (!sourceAction || sourceAction.type !== "shell") {
    return plan;
  }

  const retryAttempt = nextShellRetryAttempt(sourceAction);
  const retryAction: ActionProposal = {
    ...sourceAction,
    id: `retry-${sourceAction.id}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    status: "pending",
    executed: false,
    executionResult: undefined,
    payload: {
      ...sourceAction.payload,
      retryFromActionId: sourceAction.id,
      retryAttempt,
    },
  };

  const nextActions = plan.proposedActions.map((action) =>
    action.id === actionId ? retryAction : action
  );

  return applyPlanStateUpdate(plan, nextActions, (planState) => {
    if (retryAction.planStepId) {
      setActivePlanStep(planState, retryAction.planStepId);
      appendPlanStepNote(
        linkedPlanStep(planState, retryAction),
        "已重新创建重试动作，等待再次执行。",
      );
    }
  });
}

export function deriveWorkflowState(
  actions: ActionProposal[],
  planState?: TodoPlanState,
): WorkflowState {
  if (planState) {
    const syncedPlanState = syncPlanStateWithActions(
      planState,
      actions,
      { promoteNextRunnable: false },
    );
    return derivePlanWorkflowState(actions, syncedPlanState);
  }

  if (actions.some((action) => action.status === "running")) {
    return "executing";
  }

  if (
    actions.some(
      (action) =>
        action.status === "pending" ||
        action.status === "failed"
    )
  ) {
    return "human_review";
  }

  return "done";
}

export function markActionRunning(
  plan: OrchestrationPlan,
  actionId: string
): OrchestrationPlan {
  const nextActions = mapActions(plan, actionId, (action) => ({
    ...action,
    status: "running",
    executed: false,
  }));

  const nextAction = nextActions.find((action) => action.id === actionId);
  return applyPlanStateUpdate(plan, nextActions, (planState) => {
    if (nextAction?.planStepId) {
      setActivePlanStep(planState, nextAction.planStepId);
    }
  });
}

export function rejectAction(
  plan: OrchestrationPlan,
  actionId: string,
  reason: string
): OrchestrationPlan {
  const normalizedReason = reason.trim() || "Rejected by reviewer";
  const targetAction = plan.proposedActions.find(
    (action) => action.id === actionId
  );
  if (!targetAction || !canRejectOrComment(targetAction)) {
    return plan;
  }

  const nextActions = mapActions(plan, actionId, (action) => ({
    ...action,
    fingerprint: ensureFingerprint(action),
    status: "rejected",
    executed: false,
    executionResult: createExecutionResult(false, normalizedReason),
  }));

  const nextAction = nextActions.find((action) => action.id === actionId);
  return applyPlanStateUpdate(plan, nextActions, (planState) => {
    if (nextAction?.planStepId) {
      setPlanStepStatus(planState, nextAction.planStepId, "blocked", normalizedReason);
    }
  });
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

  const targetAction = plan.proposedActions.find(
    (action) => action.id === actionId
  );
  if (!targetAction || !canRejectOrComment(targetAction)) {
    return plan;
  }

  const nextActions = mapActions(plan, actionId, (action) => ({
    ...action,
    fingerprint: ensureFingerprint(action),
    executionResult: createExecutionResult(true, normalizedComment, {
      commentOnly: true,
    }),
  }));

  const nextAction = nextActions.find((action) => action.id === actionId);
  return applyPlanStateUpdate(plan, nextActions, (planState) => {
    appendPlanStepNote(linkedPlanStep(planState, nextAction), normalizedComment);
  });
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
            typeof payloadPatch.patch === "string"
              ? payloadPatch.patch
              : action.payload.patch,
        },
      };
      return {
        ...nextAction,
        fingerprint: ensureFingerprint(nextAction),
      };
    }

    if (action.type === "shell") {
      const nextAction: ActionProposal = {
        ...action,
        payload: {
          ...action.payload,
          shell:
            typeof payloadPatch.shell === "string"
              ? payloadPatch.shell
              : action.payload.shell,
          timeoutMs:
            typeof payloadPatch.timeoutMs === "number"
              ? payloadPatch.timeoutMs
              : action.payload.timeoutMs,
        },
      };
      return {
        ...nextAction,
        fingerprint: ensureFingerprint(nextAction),
      };
    }

    return action;
  });

  return {
    ...plan,
    proposedActions: nextActions,
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
      executionResult: createExecutionResult(false, normalizedReason),
    };
  });

  return applyPlanStateUpdate(plan, nextActions, (planState) => {
    const blockedStepIds = new Set(
      nextActions
        .filter(
          (action) =>
            (action.status === "rejected" || action.status === "failed") &&
            action.planStepId,
        )
        .map((action) => action.planStepId as string),
    );
    for (const stepId of blockedStepIds) {
      setPlanStepStatus(planState, stepId, "blocked", normalizedReason);
    }
  });
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

  let currentPlan = plan;

  // ── Atomic batch: create a single snapshot covering all patch actions ──
  // If any patch fails, we rollback ALL patches applied in this batch.
  let batchSnapshotId: string | null = null;
  const batchSnapshotFiles: string[] = [];
  let atomicEnabled = false;
  let degradedReason: string | undefined;

  const patchGroupId =
    patchActions.length > 0 ? patchActions[0].group?.groupId : undefined;
  const allSameGroup =
    patchGroupId &&
    patchActions.every(
      (a) => a.group?.groupId && a.group.groupId === patchGroupId
    );
  const treatAsAtomicBatch = patchActions.length > 1 && allSameGroup;

  if (treatAsAtomicBatch) {
    // Merge all patches into one combined patch for a single snapshot
    const combinedPatch = patchActions.map((a) => a.payload.patch).join("\n");
    try {
      const snapshot = await invoke<SnapshotResult>(
        "create_workspace_snapshot",
        {
          workspacePath,
          patch: combinedPatch,
        }
      );
      if (snapshot.success) {
        batchSnapshotId = snapshot.snapshot_id;
        batchSnapshotFiles.push(...snapshot.files);
        atomicEnabled = true;
      } else {
        degradedReason = "snapshot failed";
      }
    } catch {
      // Snapshot creation failed — proceed without atomic guarantee
      degradedReason = "snapshot threw";
    }

    // Persist batch execution metadata to all patch actions in the group.
    const batchMeta = {
      snapshotId: batchSnapshotId ?? undefined,
      atomicEnabled,
      degradedReason,
    };
    currentPlan = {
      ...currentPlan,
      proposedActions: currentPlan.proposedActions.map((a) => {
        if (a.type !== "apply_patch") return a;
        if (!a.group?.groupId || a.group.groupId !== patchGroupId) return a;
        return {
          ...a,
          batchExec: {
            ...(a.batchExec ?? { atomicEnabled: false }),
            ...batchMeta,
          },
        };
      }),
    };
  }

  let batchFailed = false;
  const appliedPatchIds: string[] = [];

  if (treatAsAtomicBatch) {
    // Combine all patches into a single git-apply call so that sequential
    // patches targeting the same file don't conflict with each other.
    const combinedPatch = patchActions.map((a) => a.payload.patch).join("\n");

    const preflight = await invoke<PatchApplyResult>("check_workspace_patch", {
      workspacePath,
      patch: combinedPatch,
    });

    if (!preflight.success) {
      batchFailed = true;
      const failMsg = `Patch 预检失败: ${preflight.message}`;
      currentPlan = {
        ...currentPlan,
        proposedActions: currentPlan.proposedActions.map((a) => {
          if (a.type !== "apply_patch") return a;
          if (!patchActions.find((p) => p.id === a.id)) return a;
          return {
            ...a,
            fingerprint: ensureFingerprint(a),
            status: "failed" as const,
            executed: false,
            executionResult: createExecutionResult(false, failMsg, {
              files: preflight.files,
            }),
          };
        }),
      };
    } else {
      const applyResult = await invoke<PatchApplyResult>(
        "apply_workspace_patch",
        { workspacePath, patch: combinedPatch },
      );

      if (!applyResult.success) {
        batchFailed = true;
        currentPlan = {
          ...currentPlan,
          proposedActions: currentPlan.proposedActions.map((a) => {
            if (a.type !== "apply_patch") return a;
            if (!patchActions.find((p) => p.id === a.id)) return a;
            return {
              ...a,
              fingerprint: ensureFingerprint(a),
              status: "failed" as const,
              executed: false,
              executionResult: createExecutionResult(
                false,
                applyResult.message,
                { files: applyResult.files },
              ),
            };
          }),
        };
      } else {
        // All patches applied successfully — mark each action as completed
        const allFiles = applyResult.files;
        currentPlan = {
          ...currentPlan,
          proposedActions: currentPlan.proposedActions.map((a) => {
            if (a.type !== "apply_patch") return a;
            if (!patchActions.find((p) => p.id === a.id)) return a;
            appliedPatchIds.push(a.id);
            return {
              ...a,
              fingerprint: ensureFingerprint(a),
              status: "completed" as const,
              executed: true,
              executionResult: createExecutionResult(
                true,
                `Patch 已应用（${allFiles.length} files）`,
                {
                  files: allFiles,
                  snapshotId: batchSnapshotId,
                  snapshotFiles: batchSnapshotFiles,
                },
              ),
            };
          }),
        };
      }
    }
  } else {
    // Non-atomic: apply patches one-by-one (single patch or no group)
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
  }

  // If any patch failed and we have a batch snapshot, rollback everything
  if (batchFailed && batchSnapshotId) {
    try {
      const rollback = await invoke<PatchApplyResult>(
        "restore_workspace_snapshot",
        {
          workspacePath,
          snapshotId: batchSnapshotId,
        }
      );
      const rollbackMsg = rollback.success
        ? "批量补丁中有失败项，已原子回滚全部已应用的补丁。"
        : "批量补丁中有失败项，原子回滚失败，部分补丁可能已生效。";

      // Mark all patch actions in the batch as failed with rollback info
      const nextActions = currentPlan.proposedActions.map((a) => {
        if (
          a.type !== "apply_patch" ||
          !pendingActions.find((p) => p.id === a.id)
        ) {
          return a;
        }

        const groupId = a.group?.groupId;
        const nextBatchExec = groupId
          ? {
            ...(a.batchExec ?? { atomicEnabled: false }),
            atomicRollbackAttempted: true,
            atomicRollbackSuccess: rollback.success,
          }
          : a.batchExec;

        return {
          ...a,
          batchExec: nextBatchExec,
          fingerprint: ensureFingerprint(a),
          status: "failed" as const,
          executed: false,
          executionResult: createExecutionResult(false, rollbackMsg, {
            atomicRollback: true,
            batchSnapshotId,
            rollbackSuccess: rollback.success,
          }),
        };
      });
      currentPlan = applyPlanStateUpdate(currentPlan, nextActions, (planState) => {
        const failedStepIds = new Set(
          nextActions
            .filter(
              (action) =>
                action.type === "apply_patch" &&
                pendingActions.some((pendingAction) => pendingAction.id === action.id) &&
                action.planStepId,
            )
            .map((action) => action.planStepId as string),
        );
        for (const stepId of failedStepIds) {
          setPlanStepStatus(planState, stepId, "failed", rollbackMsg);
        }
      });
    } catch {
      // Rollback invocation failed — leave current state as-is
      currentPlan = {
        ...currentPlan,
        proposedActions: currentPlan.proposedActions.map((a) => {
          if (a.type !== "apply_patch") return a;
          if (!a.group?.groupId) return a;
          return {
            ...a,
            batchExec: {
              ...(a.batchExec ?? { atomicEnabled: false }),
              atomicRollbackAttempted: true,
              atomicRollbackSuccess: false,
            },
          };
        }),
      };
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
  workspacePath: string,
  approvalContext?: ManualApprovalContext,
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
      patch: action.payload.patch,
    });
    if (!preflight.success) {
      result = createExecutionResult(
        false,
        `Patch 预检失败: ${preflight.message}`,
        {
          files: preflight.files,
        }
      );
    } else {
      const snapshot = await invoke<SnapshotResult>(
        "create_workspace_snapshot",
        {
          workspacePath,
          patch: action.payload.patch,
        }
      );
      const payload = await invoke<PatchApplyResult>("apply_workspace_patch", {
        workspacePath,
        patch: action.payload.patch,
      });
      if (!payload.success && snapshot.success) {
        const rollback = await invoke<PatchApplyResult>(
          "restore_workspace_snapshot",
          {
            workspacePath,
            snapshotId: snapshot.snapshot_id,
          }
        );
        result = createExecutionResult(
          false,
          `${payload.message}${rollback.success ? "（已自动回滚）" : "（自动回滚失败）"
          }`,
          {
            files: payload.files,
            snapshotId: snapshot.snapshot_id,
            snapshotFiles: snapshot.files,
            rollbackSuccess: rollback.success,
            rollbackMessage: rollback.message,
          }
        );
      } else {
        result = createExecutionResult(payload.success, payload.message, {
          files: payload.files,
          snapshotId: snapshot.snapshot_id,
          snapshotFiles: snapshot.files,
        });
      }
    }
  } else {
    const payload = await invoke<CommandExecutionResult>("run_shell_command", {
      workspacePath,
      shell: action.payload.shell,
      timeoutMs: action.payload.timeoutMs,
    });
    result = createExecutionResult(
      payload.success,
      payload.success ? "命令执行成功" : pickShellFailureMessage(payload),
      {
        command: action.payload.shell,
        timedOut: payload.timed_out,
        status: payload.status,
        stdout: payload.stdout,
        stderr: payload.stderr,
        retryFromActionId: action.payload.retryFromActionId,
        retryAttempt: action.payload.retryAttempt,
      }
    );
  }

  result = {
    ...result,
    metadata: {
      ...(result.metadata ?? {}),
      executor,
      approvalMode: approvalContext?.approvalMode ?? "manual",
      approvalRuleLabel: approvalContext?.approvalRuleLabel ?? null,
      approvalRuleKind: approvalContext?.approvalRuleKind ?? null,
    },
  };

  const nextActions = mapActions(plan, actionId, (entry) => ({
    ...entry,
    fingerprint: ensureFingerprint(entry),
    status: result.success ? "completed" : "failed",
    executed: result.success,
    executionResult: result,
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
    details: result.metadata ?? {},
  });

  const nextAction = nextActions.find((entry) => entry.id === actionId);
  return applyPlanStateUpdate(plan, nextActions, (planState) => {
    if (!nextAction?.planStepId) {
      return;
    }
    if (result.success) {
      setActivePlanStep(planState, nextAction.planStepId);
      appendPlanStepNote(
        linkedPlanStep(planState, nextAction),
        `审批动作执行成功：${result.message}`,
      );
      return;
    }
    setPlanStepStatus(planState, nextAction.planStepId, "failed", result.message);
  });
}
