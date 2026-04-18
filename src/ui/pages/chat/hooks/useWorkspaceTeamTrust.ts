import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ChatMessageRecord } from "../../../../lib/chatHistoryStore";
import type { Conversation } from "../../../../lib/conversationStore";
import { classifyError, type CategorizedError } from "../../../../lib/errorClassifier";
import type { AskUserRequest } from "../../../../orchestrator/askUserService";
import type { ManualApprovalContext } from "../../../../orchestrator/hitlService";
import {
  saveWorkspaceTeamTrustMode,
  type WorkspaceTeamTrustMode,
} from "../../../../lib/workspaceTeamTrustStore";
import type { OrchestrationPlan } from "../../../../orchestrator/types";
import { TEAM_YOLO_APPROVAL_CONTEXT } from "../constants";
import {
  buildWorkspaceTeamTrustPromptKey,
  collectPendingOrchestrationActionIds,
  resolveWorkspaceTeamTrustMessageAction,
} from "../teamTrust";
import type { WorkspaceTeamTrustPromptState } from "../types";

interface UseWorkspaceTeamTrustOptions {
  wsPath: string;
  workspaceTeamTrustMode: WorkspaceTeamTrustMode | null;
  askUserRequest: AskUserRequest | null;
  latestPendingPlanMessage: ChatMessageRecord | null;
  latestPendingTeamTargetKey: string;
  latestPendingPlanMessageActionStatuses: string;
  currentConversation: Conversation | null;
  messagesRef: MutableRefObject<ChatMessageRecord[]>;
  ensureApprovalInteractionAllowed: (
    messageId: string,
    plan?: OrchestrationPlan,
    options?: { actionIds?: string[]; allowBackgroundBatch?: boolean },
  ) => boolean;
  handleApproveAllActionsThreadRef: MutableRefObject<
    (
      messageId: string,
      plan: OrchestrationPlan,
      options?: {
        actionIds?: string[];
        approvalContext?: ManualApprovalContext;
        allowBackgroundBatch?: boolean;
      },
    ) => Promise<void>
  >;
  setSessionNote: Dispatch<SetStateAction<string>>;
  setCategorizedError: Dispatch<SetStateAction<CategorizedError | null>>;
}

/**
 * Owns workspace team-trust state (first-run prompt, restored prompt key,
 * per-target YOLO bookkeeping refs) + its 3 useEffects (wsPath reset,
 * prompt invariants guard, YOLO auto-approve driver) + the mode-chooser
 * handler. Extracted from ChatPage.tsx (B1.7.6b, see docs/REFACTOR_PLAN.md).
 *
 * `setRestoredTeamTrustPromptKey` is still reached from ChatPage's checkpoint
 * restore effect, so it is returned.
 */
export function useWorkspaceTeamTrust(options: UseWorkspaceTeamTrustOptions) {
  const {
    wsPath,
    workspaceTeamTrustMode,
    askUserRequest,
    latestPendingPlanMessage,
    latestPendingTeamTargetKey,
    latestPendingPlanMessageActionStatuses,
    currentConversation,
    messagesRef,
    ensureApprovalInteractionAllowed,
    handleApproveAllActionsThreadRef,
    setSessionNote,
    setCategorizedError,
  } = options;

  const [workspaceTeamTrustPrompt, setWorkspaceTeamTrustPrompt] =
    useState<WorkspaceTeamTrustPromptState | null>(null);
  /** Suppress expert-team first-run dialog after checkpoint restore. */
  const [restoredTeamTrustPromptKey, setRestoredTeamTrustPromptKey] = useState<
    string | null
  >(null);

  const workspaceTeamYoloExecutionKeyRef = useRef<string | null>(null);
  const seenManualPendingTeamTargetKeyRef = useRef<string | null>(null);
  const promptApprovedTeamTargetKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const promptKey = buildWorkspaceTeamTrustPromptKey(wsPath);
    setWorkspaceTeamTrustPrompt((current) =>
      current?.key === promptKey ? current : null,
    );
    setRestoredTeamTrustPromptKey(null);
    workspaceTeamYoloExecutionKeyRef.current = null;
    seenManualPendingTeamTargetKeyRef.current = null;
    promptApprovedTeamTargetKeyRef.current = null;
  }, [wsPath]);

  useEffect(() => {
    if (!workspaceTeamTrustPrompt) {
      return;
    }

    const currentPromptKey = buildWorkspaceTeamTrustPromptKey(wsPath);
    if (
      !currentPromptKey ||
      workspaceTeamTrustPrompt.key !== currentPromptKey ||
      workspaceTeamTrustMode !== null
    ) {
      setWorkspaceTeamTrustPrompt(null);
      return;
    }

    const promptMessage = messagesRef.current.find(
      (message) => message.id === workspaceTeamTrustPrompt.messageId,
    );
    if (!promptMessage?.plan) {
      setWorkspaceTeamTrustPrompt(null);
      return;
    }

    if (collectPendingOrchestrationActionIds(promptMessage.plan).length === 0) {
      setWorkspaceTeamTrustPrompt(null);
    }
  }, [
    workspaceTeamTrustMode,
    workspaceTeamTrustPrompt,
    wsPath,
    latestPendingPlanMessage?.id,
    latestPendingPlanMessageActionStatuses,
    messagesRef,
  ]);

  const handleChooseWorkspaceTeamTrustMode = (
    mode: WorkspaceTeamTrustMode,
  ): void => {
    if (!wsPath.trim()) {
      setSessionNote("未选择工作区，无法保存编排执行模式。");
      return;
    }

    const saved = saveWorkspaceTeamTrustMode(wsPath, mode);
    if (!saved) {
      setSessionNote("保存当前工作区的编排执行模式失败。");
      return;
    }

    promptApprovedTeamTargetKeyRef.current =
      mode === "team_yolo" && workspaceTeamTrustPrompt
        ? `${workspaceTeamTrustPrompt.messageId}:${workspaceTeamTrustPrompt.teamActionIds.join(",")}`
        : null;
    setWorkspaceTeamTrustPrompt(null);
    workspaceTeamYoloExecutionKeyRef.current = null;
    setSessionNote(
      mode === "team_yolo"
        ? "已为当前工作区启用编排 YOLO 模式"
        : "当前工作区将继续使用编排审批模式",
    );
  };

  useEffect(() => {
    if (workspaceTeamTrustMode !== "team_yolo" && latestPendingTeamTargetKey) {
      seenManualPendingTeamTargetKeyRef.current = latestPendingTeamTargetKey;
    }

    if (askUserRequest) {
      return;
    }

    const messageAction = resolveWorkspaceTeamTrustMessageAction({
      message: latestPendingPlanMessage,
      workspacePath: wsPath,
      mode: workspaceTeamTrustMode,
      activePromptKey: workspaceTeamTrustPrompt?.key ?? null,
      restoredPromptKey: restoredTeamTrustPromptKey,
    });

    if (messageAction.kind === "prompt") {
      setWorkspaceTeamTrustPrompt((current) => {
        if (
          current?.key === messageAction.promptKey &&
          current.messageId === messageAction.messageId
        ) {
          return current;
        }
        return {
          key: messageAction.promptKey,
          messageId: messageAction.messageId,
          teamActionIds: messageAction.teamActionIds,
        };
      });
      if (workspaceTeamTrustPrompt?.key !== messageAction.promptKey) {
        setSessionNote("当前工作区首次进入编排模式，请先选择执行模式。");
      }
      return;
    }

    if (messageAction.kind !== "yolo" || !latestPendingPlanMessage?.plan) {
      return;
    }

    const currentTeamTargetKey = `${messageAction.messageId}:${messageAction.teamActionIds.join(",")}`;
    const canAutoRunCurrentPendingTeamActions =
      seenManualPendingTeamTargetKeyRef.current !== currentTeamTargetKey ||
      promptApprovedTeamTargetKeyRef.current === currentTeamTargetKey;
    if (!canAutoRunCurrentPendingTeamActions) {
      return;
    }

    if (
      !ensureApprovalInteractionAllowed(
        messageAction.messageId,
        latestPendingPlanMessage.plan,
        {
          actionIds: messageAction.teamActionIds,
          allowBackgroundBatch: true,
        },
      )
    ) {
      return;
    }

    const executionKey = [
      messageAction.messageId,
      messageAction.teamActionIds.join(","),
      latestPendingPlanMessageActionStatuses,
    ].join("::");
    if (workspaceTeamYoloExecutionKeyRef.current === executionKey) {
      return;
    }

    workspaceTeamYoloExecutionKeyRef.current = executionKey;
    promptApprovedTeamTargetKeyRef.current = null;
    setSessionNote(
      `编排 YOLO 已自动开始 ${messageAction.teamActionIds.length} 个动作`,
    );
    void handleApproveAllActionsThreadRef.current(
      messageAction.messageId,
      latestPendingPlanMessage.plan,
      {
        actionIds: messageAction.teamActionIds,
        approvalContext: TEAM_YOLO_APPROVAL_CONTEXT,
        allowBackgroundBatch: true,
      },
    ).catch((error) => {
      workspaceTeamYoloExecutionKeyRef.current = null;
      setCategorizedError(classifyError(error));
      setSessionNote(
        `编排 YOLO 自动执行失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    });
  }, [
    askUserRequest,
    latestPendingPlanMessage,
    latestPendingPlanMessageActionStatuses,
    latestPendingTeamTargetKey,
    workspaceTeamTrustMode,
    workspaceTeamTrustPrompt?.key,
    wsPath,
    currentConversation,
    restoredTeamTrustPromptKey,
    ensureApprovalInteractionAllowed,
    handleApproveAllActionsThreadRef,
    setCategorizedError,
    setSessionNote,
  ]);

  return {
    workspaceTeamTrustPrompt,
    setRestoredTeamTrustPromptKey,
    handleChooseWorkspaceTeamTrustMode,
  };
}
