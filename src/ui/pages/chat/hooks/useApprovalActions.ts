import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  addWorkspaceApprovalRule,
  type ApprovalRuleOption,
} from "../../../../lib/approvalRuleStore";
import type { ChatMessageRecord } from "../../../../lib/chatHistoryStore";
import type { Conversation } from "../../../../lib/conversationStore";
import { classifyError, type CategorizedError } from "../../../../lib/errorClassifier";
import type { AppSettings } from "../../../../lib/settingsStore";
import { cancelShellCommand } from "../../../../lib/tauriBridge";
import { resolveShellExecutionMode } from "../../../../lib/shellCommand";
import type { AskUserRequest } from "../../../../orchestrator/askUserService";
import {
  cancelPendingRequest,
  cleanupOrphanedPendingRequest,
  getPendingRequest,
} from "../../../../orchestrator/askUserService";
import {
  approveAction,
  approveAllPendingActions,
  commentAction,
  markActionRunning,
  markShellActionRunning,
  rejectAction,
  rejectAllPendingActions,
  retryFailedShellAction,
  type ManualApprovalContext,
} from "../../../../orchestrator/hitlService";
import type { OrchestrationPlan } from "../../../../orchestrator/types";
import { resolveApprovalAskUserDecision } from "../approvalGuard";
import { markActionExecutionError } from "../execution";
import type { PendingShellQueue } from "./useApprovalQueue";
import type { RunningShellJobMeta } from "../types";

interface InputDialogState {
  open: boolean;
  title: string;
  placeholder?: string;
  defaultValue?: string;
  onConfirm: (value: string) => void;
}

interface UseApprovalActionsOptions {
  settings: AppSettings;
  currentConversation: Conversation | null;
  askUserRequest: AskUserRequest | null;
  executingActionId: string;
  messagesRef: MutableRefObject<ChatMessageRecord[]>;
  runningShellJobsRef: MutableRefObject<Map<string, RunningShellJobMeta>>;
  pendingShellQueuesRef: MutableRefObject<Map<string, PendingShellQueue>>;
  setExecutingActionId: Dispatch<SetStateAction<string>>;
  setSessionNote: Dispatch<SetStateAction<string>>;
  setCategorizedError: Dispatch<SetStateAction<CategorizedError | null>>;
  setInputDialog: Dispatch<SetStateAction<InputDialogState>>;
  resolveScopedSessionId: (
    conversation?: Conversation | null,
    agentId?: string | null,
  ) => string;
  syncAskUserRequestForSession: (sessionId: string) => void;
  handlePlanUpdate: (
    messageId: string,
    updater: (plan: OrchestrationPlan) => OrchestrationPlan,
    options?: { persist?: boolean },
  ) => void;
  continueAfterHitlIfNeeded: (messageId: string, plan: OrchestrationPlan) => void;
  startShellJobForAction: (params: {
    messageId: string;
    actionId: string;
    plan: OrchestrationPlan;
    approvalContext?: ManualApprovalContext;
  }) => Promise<void>;
  markShellActionsFailed: (
    plan: OrchestrationPlan,
    actionIds: string[],
    reason: string,
  ) => OrchestrationPlan;
}

/**
 * Bundles the approval-interaction guard and 8 approval handlers used by the
 * topbar + per-action chat UI.
 *
 * Extracted from ChatPage.tsx (B1.7.6c, see docs/REFACTOR_PLAN.md). The hook
 * is side-effect-only (it does not introduce its own state): its surface is a
 * bag of callbacks that close over the injected ChatPage state/refs.
 */
export function useApprovalActions(options: UseApprovalActionsOptions) {
  const {
    settings,
    currentConversation,
    askUserRequest,
    executingActionId,
    messagesRef,
    runningShellJobsRef,
    pendingShellQueuesRef,
    setExecutingActionId,
    setSessionNote,
    setCategorizedError,
    setInputDialog,
    resolveScopedSessionId,
    syncAskUserRequestForSession,
    handlePlanUpdate,
    continueAfterHitlIfNeeded,
    startShellJobForAction,
    markShellActionsFailed,
  } = options;

  const ensureApprovalInteractionAllowed = (
    messageId: string,
    plan?: OrchestrationPlan,
    guardOptions?: {
      actionIds?: string[];
      allowBackgroundBatch?: boolean;
    },
  ): boolean => {
    const targetMessage = messagesRef.current.find(
      (message) => message.id === messageId,
    );
    const sessionId = resolveScopedSessionId(
      currentConversation,
      targetMessage?.agentId,
    );
    const pendingAskUserRequest = getPendingRequest(sessionId);
    const askUserDecision = resolveApprovalAskUserDecision(
      sessionId,
      pendingAskUserRequest,
      askUserRequest,
      resolveScopedSessionId(currentConversation),
    );
    if (askUserDecision === "clear_hidden" && pendingAskUserRequest) {
      const orphanedAskUserCleaned = cleanupOrphanedPendingRequest(sessionId, 0);
      if (!orphanedAskUserCleaned) {
        cancelPendingRequest(sessionId);
      }
      syncAskUserRequestForSession(sessionId);
      setSessionNote("检测到未显示的待回答问题，已自动清理并继续审批。");
    }
    if (askUserDecision === "block_visible") {
      setSessionNote("当前有待回答的问题，请先完成 ask_user 请求后再继续审批。");
      syncAskUserRequestForSession(sessionId);
      return false;
    }
    const actionIdSet =
      guardOptions?.actionIds && guardOptions.actionIds.length > 0
        ? new Set(guardOptions.actionIds)
        : null;
    const pendingActions =
      plan?.proposedActions.filter(
        (action) =>
          action.status === "pending" &&
          (!actionIdSet || actionIdSet.has(action.id)),
      ) ?? [];
    const hasBackgroundPendingShell = pendingActions.some(
      (action) =>
        action.type === "shell" &&
        resolveShellExecutionMode(
          action.payload.shell,
          action.payload.executionMode,
        ) === "background",
    );
    if (
      !guardOptions?.allowBackgroundBatch &&
      pendingActions.length > 1 &&
      hasBackgroundPendingShell
    ) {
      setSessionNote("包含后台命令时暂不支持批量审批，请逐项批准相关动作。");
      return false;
    }
    return true;
  };

  const handleApproveAction = async (
    messageId: string,
    actionId: string,
    plan: OrchestrationPlan,
    rememberOption?: ApprovalRuleOption,
    executionOptions?: {
      approvalContext?: ManualApprovalContext;
      skipInteractionGuard?: boolean;
    },
  ): Promise<void> => {
    if (
      executingActionId ||
      (!executionOptions?.skipInteractionGuard &&
        !ensureApprovalInteractionAllowed(messageId, plan, { actionIds: [actionId] }))
    ) {
      return;
    }
    setExecutingActionId(actionId);
    setCategorizedError(null);
    const targetAction = plan.proposedActions.find(
      (action) => action.id === actionId,
    );
    const runningPlan =
      targetAction?.type === "shell"
        ? markShellActionRunning(plan, actionId, { message: "命令启动中…" })
        : markActionRunning(plan, actionId);
    handlePlanUpdate(messageId, () => runningPlan);
    try {
      let rememberMessage = "";
      let approvalContext: ManualApprovalContext | undefined =
        executionOptions?.approvalContext;
      if (rememberOption) {
        try {
          const { added } = addWorkspaceApprovalRule(
            settings.workspacePath,
            rememberOption.rule,
          );
          rememberMessage = added
            ? `，并已在当前工作区记住“${rememberOption.label}”`
            : `；当前工作区规则“${rememberOption.label}”已存在`;
          approvalContext = {
            approvalMode: "remember_workspace_rule",
            approvalRuleLabel: rememberOption.label,
            approvalRuleKind: rememberOption.rule.kind,
          };
        } catch (error) {
          rememberMessage = `；规则保存失败：${error instanceof Error ? error.message : "未知错误"}`;
        }
      }
      const runningAction = runningPlan.proposedActions.find(
        (action) => action.id === actionId,
      );
      if (runningAction?.type === "shell") {
        await startShellJobForAction({
          messageId,
          actionId,
          plan: runningPlan,
          approvalContext,
        });
        const executionMode = resolveShellExecutionMode(
          runningAction.payload.shell,
          runningAction.payload.executionMode,
        );
        setSessionNote(
          executionMode === "background"
            ? `动作 ${actionId} 已启动${rememberMessage} · 等待后台服务就绪…`
            : `动作 ${actionId} 已启动${rememberMessage} · 命令执行中…`,
        );
        return;
      }
      const nextPlan = await approveAction(
        runningPlan,
        actionId,
        settings.workspacePath,
        approvalContext,
      );
      handlePlanUpdate(messageId, () => nextPlan);
      setSessionNote(
        `动作 ${actionId} 已执行${rememberMessage} · 状态：${nextPlan.state}`,
      );
      continueAfterHitlIfNeeded(messageId, nextPlan);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error || "动作执行失败");
      const errorPlan = markActionExecutionError(runningPlan, actionId, reason);
      handlePlanUpdate(messageId, () => errorPlan);
      setCategorizedError(classifyError(error));
      continueAfterHitlIfNeeded(messageId, errorPlan);
    } finally {
      setExecutingActionId("");
    }
  };

  const handleRetryAction = async (
    messageId: string,
    actionId: string,
    plan: OrchestrationPlan,
  ): Promise<void> => {
    const retryPlan = retryFailedShellAction(plan, actionId);
    const retryAction = retryPlan.proposedActions.find(
      (action) =>
        action.type === "shell" && action.payload.retryFromActionId === actionId,
    );
    if (!retryAction) {
      return;
    }
    await handleApproveAction(messageId, retryAction.id, retryPlan);
  };

  const handleRejectAction = (messageId: string, actionId: string): void => {
    if (!ensureApprovalInteractionAllowed(messageId)) {
      return;
    }
    setInputDialog({
      open: true,
      title: "请输入拒绝原因",
      placeholder: "说明为什么拒绝这个操作...",
      defaultValue: "需要修改",
      onConfirm: (reason) => {
        setInputDialog((prev) => ({ ...prev, open: false }));
        if (!reason.trim()) return;
        let newPlan: OrchestrationPlan | null = null;
        handlePlanUpdate(messageId, (p) => {
          newPlan = rejectAction(p, actionId, reason);
          return newPlan;
        });
        setSessionNote(`动作 ${actionId} 已拒绝`);

        setTimeout(() => {
          if (newPlan) {
            const plan = newPlan as OrchestrationPlan;
            continueAfterHitlIfNeeded(messageId, plan);
          }
        }, 100);
      },
    });
  };

  const handleCommentAction = (messageId: string, actionId: string): void => {
    if (!ensureApprovalInteractionAllowed(messageId)) {
      return;
    }
    setInputDialog({
      open: true,
      title: "添加备注",
      placeholder: "添加说明或修改建议...",
      defaultValue: "",
      onConfirm: (comment) => {
        setInputDialog((prev) => ({ ...prev, open: false }));
        if (!comment.trim()) return;
        handlePlanUpdate(messageId, (p) => commentAction(p, actionId, comment));
      },
    });
  };

  const handleApproveAllActions = async (
    messageId: string,
    plan: OrchestrationPlan,
    approveOptions?: {
      actionIds?: string[];
      approvalContext?: ManualApprovalContext;
      allowBackgroundBatch?: boolean;
    },
  ): Promise<void> => {
    if (
      executingActionId ||
      !ensureApprovalInteractionAllowed(messageId, plan, {
        actionIds: approveOptions?.actionIds,
        allowBackgroundBatch: approveOptions?.allowBackgroundBatch,
      })
    ) {
      return;
    }
    const actionIdSet =
      approveOptions?.actionIds && approveOptions.actionIds.length > 0
        ? new Set(approveOptions.actionIds)
        : null;
    const pendingActions = plan.proposedActions.filter(
      (action) =>
        action.status === "pending" &&
        (!actionIdSet || actionIdSet.has(action.id)),
    );
    if (pendingActions.length === 0) {
      return;
    }
    if (pendingActions.length === 1) {
      await handleApproveAction(
        messageId,
        pendingActions[0].id,
        plan,
        undefined,
        {
          approvalContext: approveOptions?.approvalContext,
          skipInteractionGuard: true,
        },
      );
      return;
    }
    setExecutingActionId("batch-approve");
    setCategorizedError(null);
    let nextPlan = plan;
    const pendingPatchIds = pendingActions
      .filter((action) => action.type === "apply_patch")
      .map((action) => action.id);
    const pendingShellIds = pendingActions
      .filter((action) => action.type === "shell")
      .map((action) => action.id);
    try {
      if (pendingShellIds.length > 0) {
        nextPlan = pendingShellIds.reduce(
          (currentPlan, actionId, index) =>
            markShellActionRunning(currentPlan, actionId, {
              message:
                pendingPatchIds.length > 0
                  ? "等待前置变更完成…"
                  : index === 0
                    ? "命令启动中…"
                    : "命令排队中…",
              metadata: { queued: index > 0 || pendingPatchIds.length > 0 },
            }),
          nextPlan,
        );
        handlePlanUpdate(messageId, () => nextPlan);
      }

      if (pendingPatchIds.length > 0) {
        nextPlan = await approveAllPendingActions(
          nextPlan,
          settings.workspacePath,
          {
            actionIds: pendingPatchIds,
            approvalContext: approveOptions?.approvalContext,
          },
        );
        handlePlanUpdate(messageId, () => nextPlan);
        const patchFailed = nextPlan.proposedActions.some(
          (action) =>
            pendingPatchIds.includes(action.id) && action.status === "failed",
        );
        if (patchFailed && pendingShellIds.length > 0) {
          nextPlan = markShellActionsFailed(
            nextPlan,
            pendingShellIds,
            "未执行：前序补丁失败",
          );
          handlePlanUpdate(messageId, () => nextPlan);
          setSessionNote("批量补丁失败，后续命令未执行");
          continueAfterHitlIfNeeded(messageId, nextPlan);
          return;
        }
      }

      if (pendingShellIds.length > 0) {
        const [firstShellId, ...queuedShellIds] = pendingShellIds;
        if (!firstShellId) {
          return;
        }
        nextPlan = markShellActionRunning(nextPlan, firstShellId, {
          message: "命令启动中…",
          metadata: { queued: false },
        });
        handlePlanUpdate(messageId, () => nextPlan);
        if (queuedShellIds.length > 0) {
          pendingShellQueuesRef.current.set(messageId, {
            messageId,
            actionIds: queuedShellIds,
            approvalContext: approveOptions?.approvalContext,
          });
          nextPlan = queuedShellIds.reduce(
            (currentPlan, actionId) =>
              markShellActionRunning(currentPlan, actionId, {
                message: "命令排队中…",
                metadata: { queued: true },
              }),
            nextPlan,
          );
          handlePlanUpdate(messageId, () => nextPlan);
        } else {
          pendingShellQueuesRef.current.delete(messageId);
        }

        try {
          await startShellJobForAction({
            messageId,
            actionId: firstShellId,
            plan: nextPlan,
            approvalContext: approveOptions?.approvalContext,
          });
          const patchCompletedCount = nextPlan.proposedActions.filter(
            (action) =>
              pendingPatchIds.includes(action.id) &&
              action.status === "completed",
          ).length;
          setSessionNote(
            `已批准批量动作：${patchCompletedCount} 个补丁已执行，${pendingShellIds.length} 个命令已进入执行队列`,
          );
          return;
        } catch (error) {
          const reason =
            error instanceof Error
              ? error.message
              : String(error || "命令启动失败");
          nextPlan = markActionExecutionError(nextPlan, firstShellId, reason);
          if (queuedShellIds.length > 0) {
            nextPlan = markShellActionsFailed(
              nextPlan,
              queuedShellIds,
              `未执行：前序命令启动失败：${reason}`,
            );
          }
          pendingShellQueuesRef.current.delete(messageId);
          handlePlanUpdate(messageId, () => nextPlan);
          setCategorizedError(classifyError(error));
          continueAfterHitlIfNeeded(messageId, nextPlan);
          return;
        }
      }

      const completedCount = nextPlan.proposedActions.filter(
        (a) => a.status === "completed",
      ).length;
      setSessionNote(
        `已批量执行 ${completedCount} 个动作 · 状态：${nextPlan.state}`,
      );
      continueAfterHitlIfNeeded(messageId, nextPlan);
    } catch (error) {
      if (pendingShellIds.length > 0) {
        pendingShellQueuesRef.current.delete(messageId);
        nextPlan = markShellActionsFailed(
          nextPlan,
          pendingShellIds.filter((actionId) =>
            nextPlan.proposedActions.some(
              (action) =>
                action.id === actionId &&
                (action.status === "pending" || action.status === "running"),
            ),
          ),
          error instanceof Error ? error.message : "批量执行失败",
        );
        handlePlanUpdate(messageId, () => nextPlan);
      }
      setCategorizedError(classifyError(error));
    } finally {
      setExecutingActionId("");
    }
  };

  const handleCancelAction = async (
    messageId: string,
    actionId: string,
  ): Promise<void> => {
    const runningEntry = Array.from(runningShellJobsRef.current.entries()).find(
      ([, meta]) => meta.messageId === messageId && meta.actionId === actionId,
    );
    if (!runningEntry) {
      return;
    }

    setExecutingActionId(`cancel:${actionId}`);
    setCategorizedError(null);
    try {
      const [jobId] = runningEntry;
      const cancelled = await cancelShellCommand(jobId);
      setSessionNote(
        cancelled ? `已发送取消请求：${actionId}` : `命令已结束：${actionId}`,
      );
    } catch (error) {
      setCategorizedError(classifyError(error));
    } finally {
      setExecutingActionId("");
    }
  };

  const handleRejectAllActions = (messageId: string): void => {
    if (!ensureApprovalInteractionAllowed(messageId)) {
      return;
    }
    setInputDialog({
      open: true,
      title: "批量拒绝所有待审批动作",
      placeholder: "说明为什么拒绝这些操作...",
      defaultValue: "需要修改",
      onConfirm: (reason) => {
        setInputDialog((prev) => ({ ...prev, open: false }));
        if (!reason.trim()) return;
        let newPlan: OrchestrationPlan | null = null;
        handlePlanUpdate(messageId, (p) => {
          newPlan = rejectAllPendingActions(p, reason);
          return newPlan;
        });
        setSessionNote("已批量拒绝所有待审批动作");
        setTimeout(() => {
          if (newPlan) {
            continueAfterHitlIfNeeded(messageId, newPlan as OrchestrationPlan);
          }
        }, 100);
      },
    });
  };

  return {
    ensureApprovalInteractionAllowed,
    handleApproveAction,
    handleRetryAction,
    handleRejectAction,
    handleCommentAction,
    handleApproveAllActions,
    handleCancelAction,
    handleRejectAllActions,
  };
}
