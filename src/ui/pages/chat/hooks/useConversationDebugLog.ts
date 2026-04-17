import { type MutableRefObject, useCallback, useRef, useState } from "react";
import type { ChatAgentDefinition } from "../../../../agents/types";
import { copyTextToClipboard } from "../../../../lib/clipboard";
import type { ChatMessageRecord } from "../../../../lib/chatHistoryStore";
import type { Conversation } from "../../../../lib/conversationStore";
import type { CategorizedError } from "../../../../lib/errorClassifier";
import type { AppSettings } from "../../../../lib/settingsStore";
import {
  readLLMAuditRecords,
  readSensitiveActionAuditRecords,
} from "../../../../lib/auditLog";
import { saveFileDialog } from "../../../../lib/tauriBridge";
import { loadLatestWorkflowCheckpoint } from "../../../../orchestrator/checkpointStore";
import type { SessionState } from "../../../../lib/sessionContext";
import { DEBUG_EXPORT_HISTORY_LIMIT } from "../constants";
import {
  buildConversationDebugExport,
  buildConversationDebugExportFileName,
  resolveConversationDebugKey,
  type ConversationDebugEntry,
} from "../debugExport";
import type { LiveToolCall, SubAgentStatusItem } from "../types";

export interface ConversationDebugDownloadSnapshot {
  settings: AppSettings;
  currentConversation: Conversation | null;
  activeConversationId: string | null;
  messages: ChatMessageRecord[];
  activeAgent: ChatAgentDefinition;
  activeModelLabel: string;
  sessionState: SessionState;
  categorizedError: CategorizedError | null;
  sessionNote: string;
  isStreaming: boolean;
  executingActionId: string;
  liveContextTokens: number | null;
  liveToolCalls: LiveToolCall[];
  subAgentStatus: SubAgentStatusItem[];
  chatSessionId: string;
}

interface UseConversationDebugLogOptions {
  setSessionNote: (note: string) => void;
  activeConversationIdRef: MutableRefObject<string | null>;
  getDownloadSnapshot: () => ConversationDebugDownloadSnapshot;
}

/**
 * Owns debug-export state (failed LLM request log, export-in-progress flag,
 * per-conversation debug entry buffer) and the two handlers that read them.
 *
 * Extracted from ChatPage.tsx (B1.7.3, see docs/REFACTOR_PLAN.md). The
 * download handler needs a snapshot of many ChatPage fields — rather than
 * threading 14 individual params, the caller supplies a lazy getter.
 */
export function useConversationDebugLog(options: UseConversationDebugLogOptions) {
  const { setSessionNote, activeConversationIdRef, getDownloadSnapshot } = options;

  const [failedLlmRequestLog, setFailedLlmRequestLog] = useState<string | null>(
    null,
  );
  const [isExportingDebugBundle, setIsExportingDebugBundle] = useState(false);
  const conversationDebugEntriesRef = useRef(
    new Map<string, ConversationDebugEntry[]>(),
  );

  const appendConversationDebugEntry = useCallback(
    (
      conversationId: string | null | undefined,
      entry: ConversationDebugEntry,
    ): void => {
      const key = resolveConversationDebugKey(
        conversationId ?? activeConversationIdRef.current,
      );
      const existing = conversationDebugEntriesRef.current.get(key) ?? [];
      conversationDebugEntriesRef.current.set(
        key,
        [...existing, entry].slice(-DEBUG_EXPORT_HISTORY_LIMIT),
      );
    },
    [activeConversationIdRef],
  );

  const handleCopyFailedRequestLog = useCallback(async (): Promise<void> => {
    if (!failedLlmRequestLog) {
      return;
    }
    try {
      await copyTextToClipboard(failedLlmRequestLog);
      setSessionNote("已复制本次请求日志到剪贴板");
    } catch (error) {
      setSessionNote(
        `复制日志失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
  }, [failedLlmRequestLog, setSessionNote]);

  const handleDownloadConversationDebugBundle = useCallback(async (): Promise<void> => {
    const snapshot = getDownloadSnapshot();
    if (!snapshot.settings.debugMode || isExportingDebugBundle) {
      return;
    }

    const conversationId =
      snapshot.currentConversation?.id ?? snapshot.activeConversationId;
    if (!conversationId && snapshot.messages.length === 0) {
      setSessionNote("当前没有可导出的对话日志");
      return;
    }

    setIsExportingDebugBundle(true);
    setSessionNote("正在导出调试日志…");
    const exportedAt = new Date().toISOString();
    const chatSessionId = snapshot.chatSessionId;
    const conversationSnapshot = snapshot.currentConversation
      ? {
          ...snapshot.currentConversation,
          messages: snapshot.messages,
          updatedAt: exportedAt,
          lastTokenCount:
            snapshot.liveContextTokens ??
            snapshot.currentConversation.lastTokenCount ??
            null,
        }
      : null;

    let checkpointRecovery = null;
    let checkpointError: string | null = null;
    try {
      checkpointRecovery = await loadLatestWorkflowCheckpoint(chatSessionId);
    } catch (error) {
      checkpointError = error instanceof Error ? error.message : "未知错误";
    }

    try {
      const bundle = buildConversationDebugExport({
        exportedAt,
        chatSessionId,
        activeConversationId: snapshot.activeConversationId,
        conversation: conversationSnapshot,
        messages: snapshot.messages,
        activeAgent: snapshot.activeAgent,
        activeModelLabel: snapshot.activeModelLabel,
        settings: snapshot.settings,
        sessionState: snapshot.sessionState,
        categorizedError: snapshot.categorizedError,
        failedLlmRequestLog,
        sessionNote: snapshot.sessionNote,
        isStreaming: snapshot.isStreaming,
        executingActionId: snapshot.executingActionId,
        liveContextTokens: snapshot.liveContextTokens,
        liveToolCalls: snapshot.liveToolCalls,
        subAgentStatus: snapshot.subAgentStatus,
        debugEntries:
          conversationDebugEntriesRef.current.get(
            resolveConversationDebugKey(
              conversationSnapshot?.id ?? snapshot.activeConversationId,
            ),
          ) ?? [],
        llmAuditRecords: readLLMAuditRecords(),
        actionAuditRecords: readSensitiveActionAuditRecords(),
        checkpointRecovery,
        checkpointError,
      });
      const path = await saveFileDialog(
        buildConversationDebugExportFileName({
          conversation: conversationSnapshot,
          activeConversationId: snapshot.activeConversationId,
          exportedAt,
        }),
        JSON.stringify(bundle, null, 2),
      );
      setSessionNote(`已导出调试日志：${path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      if (message.includes("用户取消了保存")) {
        setSessionNote("已取消导出调试日志");
      } else {
        setSessionNote(`导出调试日志失败：${message}`);
      }
    } finally {
      setIsExportingDebugBundle(false);
    }
  }, [
    failedLlmRequestLog,
    getDownloadSnapshot,
    isExportingDebugBundle,
    setSessionNote,
  ]);

  return {
    failedLlmRequestLog,
    setFailedLlmRequestLog,
    isExportingDebugBundle,
    conversationDebugEntriesRef,
    appendConversationDebugEntry,
    handleCopyFailedRequestLog,
    handleDownloadConversationDebugBundle,
  };
}
