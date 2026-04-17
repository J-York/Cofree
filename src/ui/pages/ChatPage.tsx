import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  clearChatHistory,
  loadChatHistory,
  type ChatMessageRecord,
} from "../../lib/chatHistoryStore";
import {
  loadConversationList,
  loadConversation,
  createConversation,
  deleteConversation,
  updateConversationTitle,
  saveConversation,
  getActiveConversationId,
  setActiveConversationId,
  migrateOldChatHistory,
  generateConversationTitle,
  type ConversationMetadata,
  type Conversation,
} from "../../lib/conversationStore";
import { migrateGlobalToWorkspace } from "../../lib/conversationMaintenance";
import {
  addWorkspaceApprovalRule,
  type ApprovalRuleOption,
} from "../../lib/approvalRuleStore";
import {
  loadWorkspaceTeamTrustMode,
  saveWorkspaceTeamTrustMode,
  type WorkspaceTeamTrustMode,
} from "../../lib/workspaceTeamTrustStore";
import {
  dedupeContextAttachments,
  type ChatContextAttachment,
} from "../../lib/contextAttachments";
import { copyTextToClipboard } from "../../lib/clipboard";
import {
  buildCheckpointRestoreRecord,
  buildCheckpointRestoreScopeKey,
  getCheckpointRestoreScope,
  shouldApplyCheckpointRecovery,
} from "./chat/checkpointRecovery";
import { ConversationSidebar } from "../components/ConversationSidebar";
import { getActiveManagedModel, isActiveModelLocal, resolveManagedModelSelection } from "../../lib/settingsStore";
import type { AppSettings } from "../../lib/settingsStore";
import {
  cancelShellCommand,
  fetchUrl,
  globWorkspaceFiles,
  saveFileDialog,
  startShellCommand,
} from "../../lib/tauriBridge";
import type { ShellCommandEvent } from "../../lib/tauriTypes";
import type { ChatAgentDefinition } from "../../agents/types";
import {
  classifyError,
  type CategorizedError,
} from "../../lib/errorClassifier";
import { ErrorBanner } from "../components/ErrorBanner";
import { InputDialog } from "../components/InputDialog";
import { AskUserDialog } from "../components/AskUserDialog";
import type { AskUserRequest } from "../../orchestrator/askUserService";
import {
  cancelPendingRequest,
  cleanupOrphanedPendingRequest,
  getPendingRequest,
  submitUserResponse,
} from "../../orchestrator/askUserService";
import { resolveApprovalAskUserDecision } from "./chat/approvalGuard";
import { WorkspaceTeamTrustDialog } from "./chat/WorkspaceTeamTrustDialog";
import {
  buildWorkspaceTeamTrustPromptKey,
  collectPendingOrchestrationActionIds,
  resolveWorkspaceTeamTrustMessageAction,
} from "./chat/teamTrust";
import {
  readLLMAuditRecords,
  readSensitiveActionAuditRecords,
} from "../../lib/auditLog";
import {
  approveAction,
  approveAllPendingActions,
  appendRunningShellOutput,
  completeBackgroundShellAction,
  commentAction,
  completeRunningShellAction,
  markActionRunning,
  markShellActionBackground,
  markShellActionRunning,
  rejectAction,
  rejectAllPendingActions,
  retryFailedShellAction,
  type ManualApprovalContext,
} from "../../orchestrator/hitlService";
import {
  buildScopedSessionKey,
  loadLatestWorkflowCheckpoint,
  saveWorkflowCheckpoint,
} from "../../orchestrator/checkpointStore";
import { type ToolReplayMessage } from "../../orchestrator/hitlContinuationMachine";
import {
  advanceAfterHitl,
  getHitlContinuationMemory,
  hydrateHitlContinuationMemory,
  resetHitlContinuationMemory,
} from "../../orchestrator/hitlContinuationController";
import {
  runPlanningSession,
  initializePlan,
  type ToolCallEvent,
} from "../../orchestrator/planningService";
import type { WorkingMemorySnapshot } from "../../orchestrator/workingMemory";
import type {
  OrchestrationPlan,
} from "../../orchestrator/types";
import { useSession } from "../../lib/sessionContext";
import {
  createMessageId,
  buildToolCallsFromPlan,
  deriveCarryForwardPlan,
  toConversationHistory,
} from "./chat/helpers";
import {
  createBackgroundStreamState,
  createClearedConversation,
  createConversationViewState,
  createEmptyChatViewState,
  resetChatSessionState,
  resolvePreferredConversationId,
  type ChatViewState,
} from "./chat/sessionState";
import { type ConversationTopbarAction } from "./chat/ConversationTopbar";
import { ChatThreadSection } from "./chat/ChatThreadSection";
import {
  buildDraftConversationBindingUpdate,
  resolveConversationAssistantDisplayName,
} from "./chat/conversationAgentDisplay";
import {
  focusTopbarTarget,
  resolveTopbarTargetElement,
  scrollThreadTargetIntoView,
} from "./chat/conversationTopbarDom";
import {
  resolveConversationTopbarTarget,
  type ConversationTopbarTarget,
} from "./chat/conversationTopbarNavigation";
import {
  deriveConversationTopbarState,
} from "./chat/conversationTopbarState";
import {
  buildExecutionSettings,
  createConversationAgentBinding,
  ensureConversationAgentBinding,
  collectBlockedActionFingerprints,
  markActionExecutionError,
  type RunChatCycleOptions,
} from "./chat/execution";
import {
  applyMentionSuggestion,
  buildDefaultMentionSuggestions,
  buildFolderSuggestionsFromFiles,
  buildMentionSearchPattern,
  buildRecentAttachmentSuggestions,
  buildSkillMentionSuggestions,
  buildSubmittedPrompt,
  createAttachmentFromSuggestion,
  findActiveMention,
  rankMentionSuggestions,
  type MentionRankingSignals,
  type MentionSuggestion,
} from "./chat/mentions";
import {
  type SkillEntry,
} from "../../lib/skillStore";
import type {
  BackgroundStreamState,
  LiveToolCall,
  RunningShellJobMeta,
  ShellOutputBuffer,
  SubAgentStatusItem,
  WorkspaceTeamTrustPromptState,
} from "./chat/types";
import {
  CHAT_AUTO_SCROLL_THRESHOLD_PX,
  CHECKPOINT_RESTORE_SESSION_NOTE,
  DEBUG_EXPORT_HISTORY_LIMIT,
  TEAM_YOLO_APPROVAL_CONTEXT,
} from "./chat/constants";
import {
  applyTopbarActionAvailability,
  buildFailedLlmRequestLog,
  findLatestAskUserAnchorMessageId,
  findLatestRestoreAnchorMessageId,
  findLatestVisibleAssistantPlanMessage,
  isLlmResponseFailureCategory,
  measureShellChunkBytes,
  summarizeConversationHistoryForDebug,
  truncateDebugLogText,
  waitForDelay,
} from "./chat/chatPageHelpers";
import { useChatStreaming } from "./chat/hooks/useChatStreaming";
import { useApprovalQueue } from "./chat/hooks/useApprovalQueue";
import { useSkillDiscovery } from "./chat/hooks/useSkillDiscovery";
import { useMentionSuggestions } from "./chat/hooks/useMentionSuggestions";
import { ChatComposer } from "./chat/composer/ChatComposer";
import {
  buildConversationDebugExport,
  buildConversationDebugExportFileName,
  resolveConversationDebugKey,
  type ConversationDebugEntry,
} from "./chat/debugExport";
import {
  DEFAULT_BACKGROUND_READY_TIMEOUT_MS,
  DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
  DEFAULT_SHELL_OUTPUT_FLUSH_INTERVAL_MS,
  extractShellReadyUrlFromText,
  resolveShellExecutionMode,
  resolveShellReadyTimeoutMs,
  resolveShellReadyUrl,
} from "../../lib/shellCommand";

interface ChatPageProps {
  settings: AppSettings;
  activeAgent: ChatAgentDefinition;
  isVisible?: boolean;
  sidebarCollapsed?: boolean;
}

/* ── Main ChatPage ────────────────────────────────────────── */
export function ChatPage({ settings, activeAgent, isVisible, sidebarCollapsed }: ChatPageProps): ReactElement {
  const { actions: session, state: sessionState } = useSession();

  const wsPath = settings.workspacePath;
  const workspaceTeamTrustMode = loadWorkspaceTeamTrustMode(wsPath);

  // Multi-conversation state
  const [conversations, setConversations] = useState<ConversationMetadata[]>(
    () => {
      migrateGlobalToWorkspace(wsPath);
      const list = loadConversationList(wsPath);
      if (list.length === 0 && wsPath) {
        createConversation(wsPath, []);
        return loadConversationList(wsPath);
      }
      return list;
    }
  );
  const [activeConversationId, setActiveConversationIdState] = useState<
    string | null
  >(() => getActiveConversationId(wsPath));
  const [currentConversation, setCurrentConversation] =
    useState<Conversation | null>(() => {
      const activeId = getActiveConversationId(wsPath);
      if (activeId) {
        return loadConversation(wsPath, activeId);
      }
      // Migrate old chat history if exists
      const oldHistory = loadChatHistory();
      if (oldHistory.length > 0) {
        migrateOldChatHistory(wsPath, oldHistory);
        clearChatHistory();
        const newList = loadConversationList(wsPath);
        if (newList.length > 0) {
          const firstConv = loadConversation(wsPath, newList[0].id);
          return firstConv;
        }
      }
      return null;
    });

  const [prompt, setPrompt] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<ChatContextAttachment[]>([]);
  const {
    activeMention,
    setActiveMention,
    mentionSuggestions,
    setMentionSuggestions,
    mentionSelectionIndex,
    setMentionSelectionIndex,
    mentionIgnorePatterns,
    rootDirectorySuggestions,
    gitMentionSuggestions,
  } = useMentionSuggestions(wsPath);
  const availableSkills = useSkillDiscovery(wsPath, settings.skills);
  const [selectedSkills, setSelectedSkills] = useState<SkillEntry[]>([]);
  const [messages, setMessages] = useState<ChatMessageRecord[]>(
    currentConversation?.messages ?? []
  );
  const [categorizedError, setCategorizedError] =
    useState<CategorizedError | null>(null);
  const [failedLlmRequestLog, setFailedLlmRequestLog] = useState<string | null>(null);
  const [isExportingDebugBundle, setIsExportingDebugBundle] = useState(false);
  const [sessionNote, setSessionNote] = useState<string>(
    currentConversation?.messages.length ? "已恢复历史会话" : ""
  );
  const {
    isStreaming,
    setIsStreaming,
    abortControllerRef,
    abortControllersRef,
    backgroundStreamsRef,
  } = useChatStreaming();
  const { executingActionId, setExecutingActionId, pendingShellQueuesRef } =
    useApprovalQueue();
  const [_sidebarOpenLegacy] = useState<boolean>(false);
  const [liveToolCalls, setLiveToolCalls] = useState<LiveToolCall[]>([]);
  const [subAgentStatus, setSubAgentStatus] = useState<SubAgentStatusItem[]>([]);
  const [liveContextTokens, setLiveContextTokens] = useState<number | null>(
    () => currentConversation?.lastTokenCount ?? null
  );
  const [inputDialog, setInputDialog] = useState<{
    open: boolean;
    title: string;
    placeholder?: string;
    defaultValue?: string;
    onConfirm: (value: string) => void;
  }>({
    open: false,
    title: "",
    onConfirm: () => { },
  });
  const [askUserRequest, setAskUserRequest] = useState<AskUserRequest | null>(null);
  const [workspaceTeamTrustPrompt, setWorkspaceTeamTrustPrompt] =
    useState<WorkspaceTeamTrustPromptState | null>(null);
  /** Suppress expert-team first-run dialog after checkpoint restore (teamTrust restoredPromptKey). */
  const [restoredTeamTrustPromptKey, setRestoredTeamTrustPromptKey] = useState<
    string | null
  >(null);
  const messagesRef = useRef<ChatMessageRecord[]>(
    currentConversation?.messages ?? []
  );
  const lastPromptRef = useRef<string>("");
  const lastContextAttachmentsRef = useRef<ChatContextAttachment[]>([]);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const contextAnchorRef = useRef<HTMLDivElement | null>(null);
  const shouldStickThreadToBottomRef = useRef(true);
  const forceThreadScrollRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [expandedPlanMessageId, setExpandedPlanMessageId] = useState<string | null>(null);
  const [expandedPlanActionId, setExpandedPlanActionId] = useState<string | null>(null);
  const [expandedPlanRequestKey, setExpandedPlanRequestKey] = useState(0);

  const activeConversationIdRef = useRef<string | null>(activeConversationId);
  const skipNextTimestampRef = useRef(true);
  const runningShellJobsRef = useRef(new Map<string, RunningShellJobMeta>());
  const shellOutputBuffersRef = useRef(new Map<string, ShellOutputBuffer>());
  const workingMemoryBySessionRef = useRef(
    new Map<string, WorkingMemorySnapshot | null>(),
  );
  const lastRestoredCheckpointRecordRef = useRef<string | null>(null);
  const workspaceTeamYoloExecutionKeyRef = useRef<string | null>(null);
  const seenManualPendingTeamTargetKeyRef = useRef<string | null>(null);
  const promptApprovedTeamTargetKeyRef = useRef<string | null>(null);

  // Refs to keep the latest versions of callbacks used inside the shell-command-event
  // useEffect (which has an empty dependency array). Without these refs the listener
  // captures stale closures from the initial render, causing continuation after HITL
  // approval to silently fail because runChatCycle sees outdated state.
  const handlePlanUpdateRef = useRef<typeof handlePlanUpdate>(null!);
  const flushShellOutputBufferRef = useRef<(jobId: string) => void>(null!);
  const continueAfterHitlIfNeededRef = useRef<typeof continueAfterHitlIfNeeded>(null!);
  const startShellJobForActionRef = useRef<typeof startShellJobForAction>(null!);
  const completeBackgroundShellStartupRef = useRef<(jobId: string) => Promise<void>>(null!);
  const monitorBackgroundShellJobRef = useRef<(jobId: string) => Promise<void>>(null!);
  const conversationDebugEntriesRef = useRef(new Map<string, ConversationDebugEntry[]>());
  const handleApproveActionThreadRef = useRef<
    (
      messageId: string,
      actionId: string,
      plan: OrchestrationPlan,
      rememberOption?: ApprovalRuleOption,
    ) => Promise<void>
  >(async () => {});
  const handleRetryActionThreadRef = useRef<
    (messageId: string, actionId: string, plan: OrchestrationPlan) => Promise<void>
  >(async () => {});
  const handleRejectActionThreadRef = useRef<
    (messageId: string, actionId: string) => void
  >(() => {});
  const handleCommentActionThreadRef = useRef<
    (messageId: string, actionId: string) => void
  >(() => {});
  const handleCancelActionThreadRef = useRef<
    (messageId: string, actionId: string) => Promise<void>
  >(async () => {});
  const handleApproveAllActionsThreadRef = useRef<
    (
      messageId: string,
      plan: OrchestrationPlan,
      options?: {
        actionIds?: string[];
        approvalContext?: ManualApprovalContext;
        allowBackgroundBatch?: boolean;
      },
    ) => Promise<void>
  >(async () => {});
  const handleRejectAllActionsThreadRef = useRef<(messageId: string) => void>(
    () => {},
  );
  const handleSuggestionClickThreadRef = useRef<(text: string) => void>(() => {});

  const isThreadNearBottom = useCallback((thread: HTMLDivElement): boolean => {
    const distanceFromBottom =
      thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    return distanceFromBottom <= CHAT_AUTO_SCROLL_THRESHOLD_PX;
  }, []);

  const syncThreadAutoScrollState = useCallback((): void => {
    const thread = threadRef.current;
    if (!thread) {
      return;
    }
    shouldStickThreadToBottomRef.current = isThreadNearBottom(thread);
  }, [isThreadNearBottom]);

  const scrollThreadToBottom = useCallback((): void => {
    const thread = threadRef.current;
    if (!thread) {
      return;
    }
    thread.scrollTop = thread.scrollHeight;
    shouldStickThreadToBottomRef.current = true;
    forceThreadScrollRef.current = false;
  }, []);

  const requestThreadScrollToBottom = useCallback((): void => {
    shouldStickThreadToBottomRef.current = true;
    forceThreadScrollRef.current = true;
  }, []);

  const handleThreadScroll = useCallback((): void => {
    syncThreadAutoScrollState();
  }, [syncThreadAutoScrollState]);

  const activeManagedModel = getActiveManagedModel(settings);
  const activeModelLabel = activeManagedModel?.name || settings.model;
  const localOnlyBlocked =
    !settings.allowCloudModels && !isActiveModelLocal(settings);
  const noWorkspaceSelected = !settings.workspacePath;
  const chatBlocked = localOnlyBlocked || noWorkspaceSelected;
  const getActiveShellActionIdsForThread = useCallback((messageId: string): string[] => {
    return Array.from(runningShellJobsRef.current.values())
      .filter((meta) => meta.messageId === messageId)
      .map((meta) => meta.actionId);
  }, []);
  const handlePlanUpdateForThread = useCallback(
    (
      messageId: string,
      updater: (plan: OrchestrationPlan) => OrchestrationPlan,
    ): void => {
      handlePlanUpdateRef.current(messageId, updater);
    },
    [],
  );
  const handleApproveActionForThread = useCallback(
    (
      messageId: string,
      actionId: string,
      plan: OrchestrationPlan,
      rememberOption?: ApprovalRuleOption,
    ): Promise<void> =>
      handleApproveActionThreadRef.current(
        messageId,
        actionId,
        plan,
        rememberOption,
      ),
    [],
  );
  const handleRetryActionForThread = useCallback(
    (
      messageId: string,
      actionId: string,
      plan: OrchestrationPlan,
    ): Promise<void> =>
      handleRetryActionThreadRef.current(messageId, actionId, plan),
    [],
  );
  const handleRejectActionForThread = useCallback(
    (messageId: string, actionId: string): void => {
      handleRejectActionThreadRef.current(messageId, actionId);
    },
    [],
  );
  const handleCommentActionForThread = useCallback(
    (messageId: string, actionId: string): void => {
      handleCommentActionThreadRef.current(messageId, actionId);
    },
    [],
  );
  const handleCancelActionForThread = useCallback(
    (messageId: string, actionId: string): Promise<void> =>
      handleCancelActionThreadRef.current(messageId, actionId),
    [],
  );
  const handleApproveAllActionsForThread = useCallback(
    (messageId: string, plan: OrchestrationPlan): Promise<void> =>
      handleApproveAllActionsThreadRef.current(messageId, plan),
    [],
  );
  const handleRejectAllActionsForThread = useCallback((messageId: string): void => {
    handleRejectAllActionsThreadRef.current(messageId);
  }, []);
  const handleSuggestionClickForThread = useCallback((text: string): void => {
    handleSuggestionClickThreadRef.current(text);
  }, []);

  const handleCopyFailedRequestLog = async (): Promise<void> => {
    if (!failedLlmRequestLog) {
      return;
    }
    try {
      await copyTextToClipboard(failedLlmRequestLog);
      setSessionNote("已复制本次请求日志到剪贴板");
    } catch (error) {
      setSessionNote(
        `复制日志失败：${error instanceof Error ? error.message : "未知错误"}`
      );
    }
  };

  const handleDownloadConversationDebugBundle = async (): Promise<void> => {
    if (!settings.debugMode || isExportingDebugBundle) {
      return;
    }

    const conversationId = currentConversation?.id ?? activeConversationId;
    if (!conversationId && messagesRef.current.length === 0) {
      setSessionNote("当前没有可导出的对话日志");
      return;
    }

    setIsExportingDebugBundle(true);
    setSessionNote("正在导出调试日志…");
    const exportedAt = new Date().toISOString();
    const chatSessionId = resolveScopedSessionId(currentConversation);
    const conversationSnapshot = currentConversation
      ? {
        ...currentConversation,
        messages: messagesRef.current,
        updatedAt: exportedAt,
        lastTokenCount: liveContextTokens ?? currentConversation.lastTokenCount ?? null,
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
        activeConversationId,
        conversation: conversationSnapshot,
        messages: messagesRef.current,
        activeAgent,
        activeModelLabel,
        settings,
        sessionState,
        categorizedError,
        failedLlmRequestLog,
        sessionNote,
        isStreaming,
        executingActionId,
        liveContextTokens,
        liveToolCalls,
        subAgentStatus,
        debugEntries:
          conversationDebugEntriesRef.current.get(
            resolveConversationDebugKey(conversationSnapshot?.id ?? activeConversationId),
          ) ?? [],
        llmAuditRecords: readLLMAuditRecords(),
        actionAuditRecords: readSensitiveActionAuditRecords(),
        checkpointRecovery,
        checkpointError,
      });
      const path = await saveFileDialog(
        buildConversationDebugExportFileName({
          conversation: conversationSnapshot,
          activeConversationId,
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
  };

  const appendConversationDebugEntry = (
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
  };

  const appendAssistantStatusMessage = (content: string): void => {
    const normalized = content.trim();
    if (!normalized) {
      return;
    }

    const message: ChatMessageRecord = {
      id: createMessageId("assistant"),
      role: "assistant",
      content: normalized,
      createdAt: new Date().toISOString(),
      plan: null,
      agentId: activeAgent.id,
    };

    setMessages((prev) => {
      const lastMessage = prev[prev.length - 1];
      if (
        lastMessage?.role === "assistant" &&
        lastMessage.content.trim() === normalized &&
        lastMessage.plan === null
      ) {
        messagesRef.current = prev;
        return prev;
      }
      const next = [...prev, message];
      messagesRef.current = next;
      return next;
    });
  };

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  const resolveScopedSessionId = useCallback(
    (
      conversation?: Conversation | null,
      agentId?: string | null,
    ): string =>
      buildScopedSessionKey(
        conversation?.id,
        agentId ?? conversation?.agentBinding?.agentId ?? activeAgent.id,
      ),
    [activeAgent.id],
  );
  const checkpointRestoreScope = getCheckpointRestoreScope(
    currentConversation,
    activeAgent.id,
  );
  const checkpointRestoreScopeKey = buildCheckpointRestoreScopeKey(
    checkpointRestoreScope,
  );

  const syncAskUserRequestForSession = useCallback((sessionId: string): void => {
    setAskUserRequest(getPendingRequest(sessionId));
  }, []);

  const applyChatViewState = (viewState: ChatViewState): void => {
    requestThreadScrollToBottom();
    setMessages(viewState.messages);
    messagesRef.current = viewState.messages;
    setLiveContextTokens(viewState.liveContextTokens);
    setIsStreaming(viewState.isStreaming);
    setSessionNote(viewState.sessionNote);
    setLiveToolCalls(viewState.liveToolCalls);
    setCategorizedError(viewState.categorizedError);
    setSubAgentStatus(viewState.subAgentStatus);
  };

  const clearMentionUi = (): void => {
    setActiveMention(null);
    setMentionSuggestions([]);
    setMentionSelectionIndex(0);
  };

  const syncActiveMention = (nextText: string, caretIndex?: number): void => {
    const resolvedCaret =
      typeof caretIndex === "number"
        ? caretIndex
        : textareaRef.current?.selectionStart ?? nextText.length;
    const mention = findActiveMention(nextText, resolvedCaret);
    setActiveMention(mention);
    setMentionSelectionIndex(0);
    if (!mention || mention.query.trim().length === 0) {
      setMentionSuggestions([]);
    }
  };

  const getLatestUserContextAttachments = (): ChatContextAttachment[] => {
    for (let index = messagesRef.current.length - 1; index >= 0; index -= 1) {
      const record = messagesRef.current[index];
      if (record.role === "user" && (record.contextAttachments?.length ?? 0) > 0) {
        return dedupeContextAttachments(record.contextAttachments ?? []);
      }
    }
    return [];
  };

  const getRecentContextAttachments = (): ChatContextAttachment[] => {
    const attachments: ChatContextAttachment[] = [...composerAttachments];
    for (let index = messagesRef.current.length - 1; index >= 0; index -= 1) {
      const record = messagesRef.current[index];
      if (!record.contextAttachments?.length) {
        continue;
      }
      attachments.push(...record.contextAttachments);
      if (attachments.length >= 24) {
        break;
      }
    }
    return dedupeContextAttachments(attachments).slice(0, 12);
  };

  const getMentionRankingSignals = (): MentionRankingSignals => {
    const recentAttachments = getRecentContextAttachments();
    const recentPaths = recentAttachments.slice(0, 6).map((attachment) => attachment.relativePath);
    const relatedPaths = recentAttachments.map((attachment) => attachment.relativePath);
    const gitModifiedPaths = gitMentionSuggestions
      .filter((suggestion) => suggestion.kind === "file")
      .map((suggestion) => suggestion.relativePath);

    return {
      recentPaths,
      relatedPaths,
      gitModifiedPaths,
    };
  };

  const activateConversation = (
    conversation: Conversation | null,
    options: {
      persistActiveId?: boolean;
      backgroundStream?: BackgroundStreamState;
      idleSessionNote?: string;
    } = {},
  ): void => {
    activeConversationIdRef.current = conversation?.id ?? null;
    setCurrentConversation(conversation);
    setActiveConversationIdState(conversation?.id ?? null);
    if (conversation && options.persistActiveId) {
      setActiveConversationId(wsPath, conversation.id);
    }
    applyChatViewState(
      conversation
        ? createConversationViewState({
          conversation,
          backgroundStream: options.backgroundStream,
          idleSessionNote: options.idleSessionNote,
        })
        : createEmptyChatViewState(options.idleSessionNote),
    );
  };

  const takeBackgroundStream = (
    conversationId: string,
  ): BackgroundStreamState | undefined => {
    const backgroundStream = backgroundStreamsRef.current.get(conversationId);
    if (backgroundStream) {
      backgroundStreamsRef.current.delete(conversationId);
    }
    return backgroundStream;
  };

  // Recover from invalid/missing active conversation on startup.
  // Without this, the first submit may clear input but not send.
  useEffect(() => {
    if (currentConversation || conversations.length === 0) {
      return;
    }

    const preferredId = resolvePreferredConversationId(
      conversations,
      activeConversationId,
    );
    if (!preferredId) {
      return;
    }
    const recoveredConversation = loadConversation(wsPath, preferredId);
    if (!recoveredConversation) {
      return;
    }

    skipNextTimestampRef.current = true;
    activateConversation(recoveredConversation, {
      persistActiveId: true,
      idleSessionNote: recoveredConversation.messages.length ? "已恢复历史会话" : "",
    });
  }, [wsPath, conversations, activeConversationId, currentConversation]);

  const handleCancel = (): void => {
    if (activeConversationId) {
      abortControllersRef.current.get(activeConversationId)?.abort();
    }
  };

  // Save conversation when messages change
  useEffect(() => {
    messagesRef.current = messages;
    if (currentConversation) {
      const skipTimestamp = skipNextTimestampRef.current;
      skipNextTimestampRef.current = false;

      let title = currentConversation.title;
      if (title === "新对话" && messages.length > 0) {
        const generated = generateConversationTitle(messages);
        if (generated !== "新对话") title = generated;
      }

      const updatedConversation: Conversation = {
        ...currentConversation,
        title,
        messages,
        lastTokenCount: liveContextTokens,
        updatedAt: skipTimestamp
          ? currentConversation.updatedAt
          : new Date().toISOString(),
      };
      saveConversation(wsPath, updatedConversation);
      setCurrentConversation(updatedConversation);
      setConversations(loadConversationList(wsPath));
    }
  }, [messages, currentConversation?.id]);

  // Sync agentBinding when the user switches the global model via TitleBar
  useEffect(() => {
    if (!currentConversation?.agentBinding) return;
    const { vendorId, modelId } = currentConversation.agentBinding;
    if (vendorId === settings.activeVendorId && modelId === settings.activeModelId) return;

    const resolved = resolveManagedModelSelection(settings, {
      vendorId: settings.activeVendorId,
      modelId: settings.activeModelId,
    });
    if (!resolved) return;

    const updatedBinding = {
      ...currentConversation.agentBinding,
      vendorId: resolved.vendor.id,
      modelId: resolved.managedModel.id,
      vendorNameSnapshot: resolved.vendor.name,
      modelNameSnapshot: resolved.managedModel.name,
    };
    const updatedConversation: Conversation = {
      ...currentConversation,
      agentBinding: updatedBinding,
    };
    setCurrentConversation(updatedConversation);
    saveConversation(wsPath, updatedConversation);
  }, [settings.activeModelId, settings.activeVendorId]);

  useEffect(() => {
    const updatedConversation = buildDraftConversationBindingUpdate({
      conversation: currentConversation,
      messageCount: messages.length,
      nextBinding: createConversationAgentBinding(settings, activeAgent),
    });
    if (!updatedConversation) {
      return;
    }
    setCurrentConversation(updatedConversation);
    saveConversation(wsPath, updatedConversation);
    setConversations(loadConversationList(wsPath));
  }, [activeAgent, currentConversation, messages.length, settings, wsPath]);

  // React to workspace path changes: migrate, reload conversations
  const prevWsPathRef = useRef(wsPath);
  useEffect(() => {
    const leavingWorkspacePath = prevWsPathRef.current;
    if (leavingWorkspacePath === wsPath) return;
    prevWsPathRef.current = wsPath;

    // Capture before activateConversation() overwrites activeConversationIdRef (scoped HITL cleanup).
    const leavingConversationId = activeConversationIdRef.current;
    const leavingConv =
      leavingWorkspacePath && leavingConversationId
        ? loadConversation(leavingWorkspacePath, leavingConversationId)
        : null;

    // Abort all in-flight streams (foreground + background)
    for (const ctrl of abortControllersRef.current.values()) {
      ctrl.abort();
    }
    abortControllersRef.current.clear();
    backgroundStreamsRef.current.clear();
    abortControllerRef.current?.abort();

    // Migrate global data if needed
    migrateGlobalToWorkspace(wsPath);

    // Load workspace-scoped conversations
    const list = loadConversationList(wsPath);
    setConversations(list);

    skipNextTimestampRef.current = true;
    const activeId = getActiveConversationId(wsPath);
    const activeConversation = activeId ? loadConversation(wsPath, activeId) : null;

    if (activeConversation) {
      activateConversation(activeConversation, {
        idleSessionNote: activeConversation.messages.length ? "已切换工作区" : "",
      });
    } else {
      const firstConversation =
        list.length > 0 ? loadConversation(wsPath, list[0].id) : null;

      if (firstConversation) {
        activateConversation(firstConversation, {
          persistActiveId: true,
          idleSessionNote: "已切换工作区",
        });
      } else if (wsPath) {
        const newConversation = createConversation(wsPath, []);
        setConversations(loadConversationList(wsPath));
        activateConversation(newConversation);
      } else {
        activateConversation(null);
      }
    }

    resetChatSessionState(
      leavingConversationId && leavingConv
        ? {
            conversationId: leavingConversationId,
            agentId: leavingConv.agentBinding?.agentId ?? undefined,
          }
        : undefined,
    );
    session.resetSession();
    setPrompt("");
    setComposerAttachments([]);
    clearMentionUi();
  }, [wsPath]);

  const visibleMessages = messages.filter((message) => message.role !== "tool");
  const lastVisibleMessage = visibleMessages[visibleMessages.length - 1];
  const activePlanMessage = findLatestVisibleAssistantPlanMessage(visibleMessages);
  const activePlan = activePlanMessage?.plan ?? null;
  const hasAskUserPending = askUserRequest !== null;
  const hasRestoreNotice = sessionNote === CHECKPOINT_RESTORE_SESSION_NOTE;
  const latestPendingPlanMessage =
    [...visibleMessages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          message.plan?.state === "human_review" &&
          message.plan.proposedActions.some((action) => action.status === "pending"),
      ) ?? null;
  const latestPendingTeamActionIds = latestPendingPlanMessage?.plan
    ? collectPendingOrchestrationActionIds(latestPendingPlanMessage.plan)
    : [];
  const latestPendingTeamTargetKey =
    latestPendingPlanMessage && latestPendingTeamActionIds.length > 0
      ? `${latestPendingPlanMessage.id}:${latestPendingTeamActionIds.join(",")}`
      : "";
  const latestPendingPlanMessageActionStatuses =
    latestPendingPlanMessage?.plan?.proposedActions
      ?.map((action) => `${action.id}:${action.status}:${action.executed ? "1" : "0"}`)
      .join("|") ?? "";
  const lastVisiblePlanState = lastVisibleMessage?.plan?.state ?? "";
  const lastVisibleActionStatuses =
    lastVisibleMessage?.plan?.proposedActions
      ?.map((action) => `${action.id}:${action.status}:${action.executed ? "1" : "0"}`)
      .join("|") ?? "";
  const lastVisibleStepStatuses =
    lastVisibleMessage?.plan?.steps
      ?.map((step) => `${step.id}:${step.status}`)
      .join("|") ?? "";
  const lastVisibleToolTraceStatuses =
    lastVisibleMessage?.toolTrace
      ?.map((trace) => `${trace.callId}:${trace.status}:${trace.retried ? "1" : "0"}`)
      .join("|") ?? "";
  const liveToolStatusKey = liveToolCalls
    .map(
      (call) =>
        `${call.callId}:${call.status}:${call.argsPreview?.length ?? 0}:${call.resultPreview?.length ?? 0}`,
    )
    .join("|");
  const subAgentStatusKey = subAgentStatus
    .map(
      (item) =>
        `${item.id}:${item.updatedAt}:${item.lastEvent.kind}:${item.label}:${item.role}`,
    )
    .join("|");

  useEffect(() => {
    if (isVisible === false) {
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      if (
        !forceThreadScrollRef.current &&
        !shouldStickThreadToBottomRef.current
      ) {
        return;
      }
      scrollThreadToBottom();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [
    activeConversationId,
    isStreaming,
    isVisible,
    lastVisibleActionStatuses,
    lastVisibleMessage?.content,
    lastVisibleMessage?.id,
    lastVisibleMessage?.tool_calls?.length,
    lastVisiblePlanState,
    lastVisibleStepStatuses,
    lastVisibleToolTraceStatuses,
    liveToolStatusKey,
    scrollThreadToBottom,
    subAgentStatusKey,
    visibleMessages.length,
  ]);

  useEffect(() => {
    let cancelled = false;
    const mention = activeMention;
    if (!mention || !wsPath) {
      setMentionSuggestions([]);
      return () => {
        cancelled = true;
      };
    }

    const rankingSignals = getMentionRankingSignals();
    const recentSuggestions = buildRecentAttachmentSuggestions(
      getRecentContextAttachments(),
    );
    if (mention.query.trim().length === 0) {
      const skillSuggestions = buildSkillMentionSuggestions(availableSkills, "");
      const defaults = buildDefaultMentionSuggestions({
        recentSuggestions,
        gitSuggestions: gitMentionSuggestions,
        rootDirectorySuggestions,
        skillSuggestions,
        signals: rankingSignals,
      }).filter(
        (entry) =>
          !(entry.kind === "skill" && selectedSkills.some((s) => s.id === entry.skillId)) &&
          !composerAttachments.some(
            (attachment) =>
              attachment.relativePath === entry.relativePath &&
              attachment.kind === entry.kind,
          ),
      );
      setMentionSuggestions(defaults);
      return () => {
        cancelled = true;
      };
    }

    const timer = window.setTimeout(() => {
      void globWorkspaceFiles({
        workspacePath: wsPath,
        pattern: buildMentionSearchPattern(mention.query),
        maxResults: 80,
        ignorePatterns: mentionIgnorePatterns,
      })
        .then((entries) => {
          if (cancelled) return;
          const fileSuggestions = entries.map((entry) => ({
            kind: "file" as const,
            relativePath: entry.path.replace(/\\/g, "/"),
            displayName: entry.path.split(/[\\/]/).filter(Boolean).pop() ?? entry.path,
            modified: entry.modified,
            size: entry.size,
            source: "search" as const,
          }));
          const folderSuggestions = buildFolderSuggestionsFromFiles(
            mention.query,
            entries,
          );
          const skillSuggestions = buildSkillMentionSuggestions(availableSkills, mention.query);
          const suggestions = rankMentionSuggestions(
            mention.query,
            [
              ...skillSuggestions,
              ...fileSuggestions,
              ...folderSuggestions,
              ...rootDirectorySuggestions,
              ...recentSuggestions,
              ...gitMentionSuggestions,
            ],
            rankingSignals,
          ).filter(
            (entry) =>
              !(entry.kind === "skill" && selectedSkills.some((s) => s.id === entry.skillId)) &&
              !composerAttachments.some(
                (attachment) =>
                  attachment.relativePath === entry.relativePath &&
                  attachment.kind === entry.kind,
              ),
          );
          setMentionSuggestions(suggestions);
          setMentionSelectionIndex(0);
        })
        .catch(() => {
          if (!cancelled) {
            setMentionSuggestions([]);
          }
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeMention,
    availableSkills,
    composerAttachments,
    gitMentionSuggestions,
    mentionIgnorePatterns,
    rootDirectorySuggestions,
    selectedSkills,
    wsPath,
  ]);

  /* Restore checkpoint */
  useEffect(() => {
    let cancelled = false;
    if (!checkpointRestoreScope.conversationId) {
      lastRestoredCheckpointRecordRef.current = null;
      setRestoredTeamTrustPromptKey(null);
      return () => {
        cancelled = true;
      };
    }
    const sessionId = buildScopedSessionKey(
      checkpointRestoreScope.conversationId,
      checkpointRestoreScope.agentId,
    );
    const restore = async () => {
      try {
        const latest = await loadLatestWorkflowCheckpoint(sessionId);
        if (cancelled) return;
        if (!latest) {
          lastRestoredCheckpointRecordRef.current = null;
          setRestoredTeamTrustPromptKey(null);
          workingMemoryBySessionRef.current.delete(sessionId);
          resetHitlContinuationMemory(sessionId);
          return;
        }
        const checkpointRecord = buildCheckpointRestoreRecord(
          sessionId,
          latest.messageId,
        );
        if (
          !shouldApplyCheckpointRecovery(
            lastRestoredCheckpointRecordRef.current,
            checkpointRecord,
          )
        ) {
          return;
        }
        lastRestoredCheckpointRecordRef.current = checkpointRecord;
        workingMemoryBySessionRef.current.set(
          sessionId,
          latest.payload.workingMemory ?? null,
        );
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === latest.messageId);
          const next =
            idx >= 0
              ? prev.map((m, i) =>
                i === idx
                  ? {
                    ...m,
                    plan: latest.payload.plan,
                    toolTrace: latest.payload.toolTrace ?? m.toolTrace,
                    tool_calls: buildToolCallsFromPlan(latest.payload.plan),
                  }
                  : m
              )
              : [
                ...prev,
                {
                  id: latest.messageId,
                  role: "assistant",
                  content: "已从审批点恢复上一轮工作流状态。",
                  createdAt: new Date().toISOString(),
                  plan: latest.payload.plan,
                  toolTrace: latest.payload.toolTrace ?? [],
                  tool_calls: buildToolCallsFromPlan(latest.payload.plan),
                  agentId: checkpointRestoreScope.agentId,
                } satisfies ChatMessageRecord,
              ].slice(-80);
          messagesRef.current = next;
          return next;
        });
        hydrateHitlContinuationMemory(sessionId, latest.payload.continuationMemory);
        setRestoredTeamTrustPromptKey(buildWorkspaceTeamTrustPromptKey(wsPath));
        setSessionNote("已从 checkpoint 恢复审批状态");
      } catch {
        /* non-fatal */
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [
    checkpointRestoreScopeKey,
    wsPath,
  ]);

  useEffect(() => {
    if (!currentConversation) {
      setAskUserRequest(null);
      return;
    }
    syncAskUserRequestForSession(resolveScopedSessionId(currentConversation));
  }, [currentConversation, resolveScopedSessionId, syncAskUserRequestForSession]);

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
  ]);

  const continueAfterHitlIfNeeded = (
    messageId: string,
    plan: OrchestrationPlan
  ): void => {
    const targetMessage = messagesRef.current.find((m) => m.id === messageId);
    const currentTrace = targetMessage?.toolTrace ?? [];
    const sessionId = resolveScopedSessionId(currentConversation, targetMessage?.agentId);

    void advanceAfterHitl({
      sessionId,
      messageId,
      plan,
      toolTrace: currentTrace,
      workingMemorySnapshot: workingMemoryBySessionRef.current.get(sessionId) ?? undefined,
    })
      .then((decision) => {
        if (decision.kind === "stop") {
          setSessionNote(decision.reason);
          appendAssistantStatusMessage(`自动续跑已停止：${decision.reason}`);
          return;
        }

        setSessionNote("审批结果已同步，正在继续完成剩余任务…");

        const toolMessages: ChatMessageRecord[] =
          decision.toolReplayMessages.map((tool: ToolReplayMessage) => ({
            id: createMessageId("tool"),
            role: "tool",
            content: tool.content,
            createdAt: new Date().toISOString(),
            plan: null,
            tool_call_id: tool.tool_call_id,
            name: tool.name,
          }));

        setMessages((prev) => {
          const next = [...prev, ...toolMessages];
          messagesRef.current = next;
          return next;
        });

        setTimeout(
          () => {
            void runChatCycle(decision.prompt, {
              visibleUserMessage: false,
              isContinuation: true,
              internalSystemNote: decision.internalSystemNote,
              existingPlan: plan,
            }).catch((error) => {
              const message =
                error instanceof Error ? error.message : "未知错误";
              setCategorizedError(classifyError(error));
              setSessionNote(`自动续跑失败：${message}`);
              appendAssistantStatusMessage(`自动续跑失败：${message}`);
            });
          },
          100
        );
      })
      .catch((err) => {
        setSessionNote(
          `续跑状态机失败：${err instanceof Error ? err.message : "未知错误"}`
        );
        appendAssistantStatusMessage(
          `续跑状态机失败：${err instanceof Error ? err.message : "未知错误"}`,
        );
      });
  };
  continueAfterHitlIfNeededRef.current = continueAfterHitlIfNeeded;

  const runChatCycle = async (
    promptText: string,
    options: RunChatCycleOptions & { isContinuation?: boolean } = {}
  ): Promise<void> => {
    if (!promptText || isStreaming) return;
    const { settings: executionSettings, selection: executionSelection, snapshots } =
      await buildExecutionSettings(settings, activeAgent, currentConversation);

    let conversationForRun = ensureConversationAgentBinding({
      conversation: currentConversation,
      selection: executionSelection,
      snapshots,
      activeAgent,
    });
    const convBinding = conversationForRun?.agentBinding;
    if (conversationForRun && conversationForRun !== currentConversation) {
      skipNextTimestampRef.current = true;
      saveConversation(wsPath, conversationForRun);
      setCurrentConversation(conversationForRun);
      setConversations(loadConversationList(wsPath));
    }
    const streamConvId = conversationForRun?.id ?? null;
    if (!streamConvId) return;

    const visibleUserMessage = options.visibleUserMessage !== false;
    const contextAttachments = dedupeContextAttachments(
      options.contextAttachments ??
      (visibleUserMessage ? [] : getLatestUserContextAttachments()),
    );
    const controller = new AbortController();
    abortControllersRef.current.set(streamConvId, controller);
    abortControllerRef.current = controller;
    lastPromptRef.current = promptText;
    lastContextAttachmentsRef.current = contextAttachments;
    const conversationHistory = toConversationHistory(messagesRef.current);
    const existingPlanForRun = deriveCarryForwardPlan({
      records: messagesRef.current,
      prompt: promptText,
      explicitPlan: options.existingPlan,
      isContinuation: options.isContinuation === true,
    });
    const assistantMessageId = createMessageId("assistant");
    const now = new Date().toISOString();
    const chatSessionId = resolveScopedSessionId(
      conversationForRun,
      convBinding?.agentId ?? activeAgent.id,
    );
    if (visibleUserMessage && !existingPlanForRun && options.isContinuation !== true) {
      resetHitlContinuationMemory(chatSessionId);
      workingMemoryBySessionRef.current.delete(chatSessionId);
    }
    const restoredWorkingMemory =
      existingPlanForRun || options.isContinuation
        ? workingMemoryBySessionRef.current.get(chatSessionId) ?? undefined
        : undefined;
    const debugRequestId = `chatreq-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2, 8)}`;
    const assistantMsg: ChatMessageRecord = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: now,
      plan: null,
      agentId: convBinding?.agentId ?? activeAgent.id,
    };

    let localStreamBuffer = "";
    let localRafId: number | null = null;
    const isActive = () => activeConversationIdRef.current === streamConvId;

    if (visibleUserMessage && isActive()) {
      requestThreadScrollToBottom();
    }

    const guardedSetMessages = (
      updater: (prev: ChatMessageRecord[]) => ChatMessageRecord[]
    ) => {
      if (isActive()) {
        setMessages((prev) => {
          const next = updater(prev);
          messagesRef.current = next;
          return next;
        });
      } else {
        const bg = backgroundStreamsRef.current.get(streamConvId);
        if (bg) bg.messages = updater(bg.messages);
      }
    };
    const guardedSetNote = (note: string) => {
      if (isActive()) setSessionNote(note);
      else {
        const bg = backgroundStreamsRef.current.get(streamConvId);
        if (bg) bg.sessionNote = note;
      }
    };
    const guardedSetTokens = (tokens: number | null) => {
      if (isActive()) setLiveContextTokens(tokens);
      else {
        const bg = backgroundStreamsRef.current.get(streamConvId);
        if (bg) bg.tokenCount = tokens;
      }
    };
    const guardedSetToolCalls = (
      updater: LiveToolCall[] | ((prev: LiveToolCall[]) => LiveToolCall[])
    ) => {
      if (isActive()) {
        setLiveToolCalls(updater as LiveToolCall[] | ((prev: LiveToolCall[]) => LiveToolCall[]));
      } else {
        const bg = backgroundStreamsRef.current.get(streamConvId);
        if (bg)
          bg.liveToolCalls =
            typeof updater === "function" ? updater(bg.liveToolCalls) : updater;
      }
    };
    const guardedSetError = (error: CategorizedError | null) => {
      if (isActive()) setCategorizedError(error);
      else {
        const bg = backgroundStreamsRef.current.get(streamConvId);
        if (bg) bg.error = error;
      }
    };
    const guardedSetIsStreaming = (streaming: boolean) => {
      if (isActive()) setIsStreaming(streaming);
      else {
        const bg = backgroundStreamsRef.current.get(streamConvId);
        if (bg) bg.isStreaming = streaming;
      }
    };

    if (visibleUserMessage) {
      const userMsg: ChatMessageRecord = {
        id: createMessageId("user"),
        role: "user",
        content: promptText,
        createdAt: now,
        plan: null,
        contextAttachments,
      };
      setMessages((prev) => {
        const next = [...prev, userMsg, assistantMsg];
        messagesRef.current = next;
        return next;
      });
    } else {
      setMessages((prev) => {
        const next = [...prev, assistantMsg];
        messagesRef.current = next;
        return next;
      });
    }

    setIsStreaming(true);
    setCategorizedError(null);
    setFailedLlmRequestLog(null);
    setSessionNote("正在回复…");
    setLiveToolCalls([]);
    setLiveContextTokens(null);
    setSubAgentStatus([]);

    session.setWorkflowPhase("planning");
    if (settings.debugMode) {
      appendConversationDebugEntry(streamConvId, {
        id: `${debugRequestId}:started`,
        type: "llm_request_started",
        timestamp: now,
        requestId: debugRequestId,
        data: {
          prompt: truncateDebugLogText(promptText),
          visibleUserMessage,
          contextAttachments: contextAttachments.map((attachment) => ({
            id: attachment.id,
            kind: attachment.kind,
            relativePath: attachment.relativePath,
            source: attachment.source,
          })),
          historyMessageCount: conversationHistory.length,
          historyPreview: summarizeConversationHistoryForDebug(conversationHistory),
          sessionId: chatSessionId,
          conversationId: streamConvId,
          activeAgentId: activeAgent.id,
          boundAgentId: convBinding?.agentId ?? null,
          phase: options.phase ?? "default",
          isContinuation: options.isContinuation === true,
          existingPlanState: existingPlanForRun?.state ?? null,
          existingPlanActionCount: existingPlanForRun?.proposedActions.length ?? 0,
          executionSettings: {
            provider: executionSettings.provider ?? null,
            model: executionSettings.model,
            baseUrl: executionSettings.liteLLMBaseUrl,
            activeVendorId: executionSettings.activeVendorId,
            activeModelId: executionSettings.activeModelId,
            workspacePath: executionSettings.workspacePath,
          },
        },
      });
    }

    try {
      const result = await runPlanningSession({
        prompt: promptText,
        settings: executionSettings,
        agentId: convBinding ?? activeAgent.id,
        phase: options.phase,
        conversationHistory,
        contextAttachments,
        isContinuation: options.isContinuation,
        internalSystemNote: options.internalSystemNote,
        existingPlan: existingPlanForRun,
        blockedActionFingerprints: visibleUserMessage
          ? []
          : messagesRef.current.flatMap((message) =>
            message.plan ? collectBlockedActionFingerprints(message.plan) : []
          ),
        signal: controller.signal,
        onAssistantChunk: (chunk) => {
          localStreamBuffer += chunk;
          if (localRafId === null) {
            localRafId = requestAnimationFrame(() => {
              const buffered = localStreamBuffer;
              localStreamBuffer = "";
              localRafId = null;
              guardedSetMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMessageId
                    ? { ...m, content: `${m.content}${buffered}` }
                    : m
                )
              );
            });
          }
        },
        onToolCallEvent: (event: ToolCallEvent) => {
          if (event.type === "start") {
            guardedSetToolCalls((prev) => {
              const existing = prev.find((call) => call.callId === event.callId);
              const nextArgsPreview =
                event.argsPreview && event.argsPreview.trim()
                  ? event.argsPreview
                  : existing?.argsPreview;

              if (existing) {
                return prev.map((call) =>
                  call.callId === event.callId
                    ? {
                      ...call,
                      toolName: event.toolName,
                      argsPreview: nextArgsPreview,
                      status: "running",
                    }
                    : call
                );
              }

              return [
                ...prev,
                {
                  callId: event.callId,
                  toolName: event.toolName,
                  argsPreview: nextArgsPreview,
                  status: "running",
                },
              ];
            });
          } else {
            guardedSetToolCalls((prev) =>
              prev.map((call) =>
                call.callId === event.callId
                  ? {
                    ...call,
                    status: event.result ?? "failed",
                    resultPreview: event.resultPreview,
                  }
                  : call
              )
            );
          }
        },
        onContextUpdate: (estimatedTokens) => {
          guardedSetTokens(estimatedTokens);
        },
        onLoopCheckpoint: (checkpoint) => {
          const checkpointPlan = initializePlan(
            promptText,
            executionSettings,
            checkpoint.proposedActions,
            checkpoint.planState,
          );
          if (checkpoint.workingMemorySnapshot) {
            workingMemoryBySessionRef.current.set(
              chatSessionId,
              checkpoint.workingMemorySnapshot,
            );
          }
          void saveWorkflowCheckpoint(
            chatSessionId,
            assistantMessageId,
            checkpointPlan,
            checkpoint.toolTrace,
            getHitlContinuationMemory(chatSessionId),
            checkpoint.workingMemorySnapshot,
          ).catch((err) =>
            guardedSetNote(
              `增量 checkpoint 未保存：${err instanceof Error ? err.message : "未知错误"}`
            )
          );
        },
        onPlanStateUpdate: (planState, proposedActions) => {
          guardedSetMessages((prev) =>
            prev.map((m) => {
              if (m.id === assistantMessageId) {
                return {
                  ...m,
                  plan: initializePlan(
                    promptText,
                    executionSettings,
                    proposedActions,
                    planState
                  ),
                };
              }
              return m;
            })
          );
        },
        sessionId: chatSessionId,
        onAskUserRequest: (request: AskUserRequest) => {
          syncAskUserRequestForSession(request.sessionId ?? chatSessionId);
        },
        restoredWorkingMemory,
      });

      if (localRafId !== null) {
        cancelAnimationFrame(localRafId);
        localRafId = null;
      }
      localStreamBuffer = "";

      if (result.workingMemorySnapshot) {
        workingMemoryBySessionRef.current.set(
          chatSessionId,
          result.workingMemorySnapshot,
        );
      }
      guardedSetMessages((prev) =>
        prev.map((m) => {
          if (m.id === assistantMessageId) {
            return {
              ...m,
              content: result.assistantReply,
              plan: result.plan,
              toolTrace: result.toolTrace,
              tool_calls:
                result.assistantToolCalls ?? buildToolCallsFromPlan(result.plan),
            };
          }
          return m;
        })
      );

      session.updatePlan(result.assistantReply);
      session.appendToolTraces(result.toolTrace ?? []);
      session.appendRequestSummary({
        requestId: debugRequestId,
        model: activeModelLabel,
        timestamp: new Date().toISOString(),
        inputTokens: result.tokenUsage.inputTokens,
        outputTokens: result.tokenUsage.outputTokens,
        durationMs: Date.now() - new Date(now).getTime(),
      });
      if (settings.debugMode) {
        appendConversationDebugEntry(streamConvId, {
          id: `${debugRequestId}:completed`,
          type: "llm_request_completed",
          timestamp: new Date().toISOString(),
          requestId: debugRequestId,
          data: {
            durationMs: Date.now() - new Date(now).getTime(),
            assistantReplyPreview: truncateDebugLogText(
              result.assistantReply,
              2400,
            ),
            tokenUsage: result.tokenUsage,
            planState: result.plan.state,
            planStepCount: result.plan.steps.length,
            proposedActions: result.plan.proposedActions.map((action) => ({
              id: action.id,
              type: action.type,
              status: action.status,
              description: action.description,
              toolName: action.toolName ?? null,
              fingerprint: action.fingerprint ?? null,
            })),
            toolTrace: result.toolTrace ?? [],
            assistantToolCalls:
              result.assistantToolCalls ?? buildToolCallsFromPlan(result.plan),
          },
        });
      }
      guardedSetTokens(result.tokenUsage.inputTokens + result.tokenUsage.outputTokens);
      session.setWorkflowPhase(
        result.plan.state === "human_review"
          ? "human_review"
          : result.plan.state === "executing"
            ? "executing"
            : result.plan.state === "planning"
              ? "planning"
              : "done"
      );

      void saveWorkflowCheckpoint(
        chatSessionId,
        assistantMessageId,
        result.plan,
        result.toolTrace,
        getHitlContinuationMemory(chatSessionId),
        result.workingMemorySnapshot,
      ).catch((err) =>
        guardedSetNote(
          `审批点未保存：${err instanceof Error ? err.message : "未知错误"}`
        )
      );

      guardedSetNote(
        result.plan.state === "human_review"
          ? "已进入 HITL 审批阶段，请逐项审批"
          : result.plan.steps.some(
            (step) => step.status !== "completed" && step.status !== "skipped"
          )
            ? "todo 已更新"
            : "回复完成"
      );
    } catch (error) {
      if (controller.signal.aborted) {
        if (settings.debugMode) {
          appendConversationDebugEntry(streamConvId, {
            id: `${debugRequestId}:cancelled`,
            type: "llm_request_cancelled",
            timestamp: new Date().toISOString(),
            requestId: debugRequestId,
            data: {
              durationMs: Date.now() - new Date(now).getTime(),
            },
          });
        }
        guardedSetMessages((prev) =>
          prev.filter(
            (m) => m.id !== assistantMessageId || m.content.trim() !== ""
          )
        );
        guardedSetNote("已取消");
        return;
      }
      const classifiedError = classifyError(error);

      guardedSetError(classifiedError);
      let debugLog: string | null = null;
      if (isActive()) {
        if (settings.debugMode && isLlmResponseFailureCategory(classifiedError.category)) {
          debugLog = buildFailedLlmRequestLog({
            prompt: promptText,
            conversationHistory,
            contextAttachments,
            executionSettings,
            activeAgentId: activeAgent.id,
            boundAgentId: convBinding?.agentId,
            sessionId: chatSessionId,
            conversationId: streamConvId,
            startedAt: now,
            isContinuation: options.isContinuation === true,
            phase: options.phase,
            error: classifiedError,
          });
          setFailedLlmRequestLog(debugLog);
        } else {
          setFailedLlmRequestLog(null);
        }
      }
      if (settings.debugMode) {
        appendConversationDebugEntry(streamConvId, {
          id: `${debugRequestId}:failed`,
          type: "llm_request_failed",
          timestamp: new Date().toISOString(),
          requestId: debugRequestId,
          data: {
            durationMs: Date.now() - new Date(now).getTime(),
            error: {
              category: classifiedError.category,
              title: classifiedError.title,
              message: classifiedError.message,
              guidance: classifiedError.guidance,
              rawError: classifiedError.rawError ?? null,
            },
            failedRequestLog: debugLog,
          },
        });
      }
      guardedSetMessages((prev) =>
        prev.filter(
          (m) => m.id !== assistantMessageId || m.content.trim() !== ""
        )
      );
      guardedSetNote("回复失败");
    } finally {
      if (localRafId !== null) {
        cancelAnimationFrame(localRafId);
      }
      guardedSetIsStreaming(false);
      guardedSetToolCalls([]);
      abortControllersRef.current.delete(streamConvId);
      if (abortControllerRef.current === controller)
        abortControllerRef.current = null;

      if (!isActive()) {
        const bg = backgroundStreamsRef.current.get(streamConvId);
        if (bg) {
          const convData = loadConversation(wsPath, streamConvId);
          if (convData) {
            saveConversation(wsPath, {
              ...convData,
              messages: bg.messages,
              lastTokenCount: bg.tokenCount,
              updatedAt: new Date().toISOString(),
            });
          }
          backgroundStreamsRef.current.delete(streamConvId);
          setConversations(loadConversationList(wsPath));
        }
      }
    }
  };

  const handleMentionSuggestionSelect = (suggestion: MentionSuggestion): void => {
    if (!activeMention) {
      return;
    }

    const { nextText, nextCaret } = applyMentionSuggestion(prompt, activeMention);

    if (suggestion.kind === "skill" && suggestion.skillId) {
      const skill = availableSkills.find((s) => s.id === suggestion.skillId);
      if (skill && !selectedSkills.some((s) => s.id === skill.id)) {
        setSelectedSkills((prev) => [...prev, skill]);
      }
    } else {
      const attachment = createAttachmentFromSuggestion(suggestion);
      setComposerAttachments((prev) =>
        dedupeContextAttachments([...prev, attachment]),
      );
    }

    setPrompt(nextText);
    clearMentionUi();

    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
      syncActiveMention(nextText, nextCaret);
    });
  };

  const handleRemoveComposerAttachment = (attachmentId: string): void => {
    setComposerAttachments((prev) =>
      prev.filter((attachment) => attachment.id !== attachmentId),
    );
    textareaRef.current?.focus();
  };

  const handleRemoveSelectedSkill = (skillId: string): void => {
    setSelectedSkills((prev) => prev.filter((s) => s.id !== skillId));
    textareaRef.current?.focus();
  };

  const handleSubmit = async (): Promise<void> => {
    const attachments = dedupeContextAttachments(composerAttachments);
    const text = buildSubmittedPrompt(prompt, attachments, selectedSkills.length > 0);
    if ((!text && attachments.length === 0 && selectedSkills.length === 0) || isStreaming) return;

    const previousPrompt = prompt;
    const previousAttachments = composerAttachments;
    const previousSkills = selectedSkills;
    const explicitSkillIds = selectedSkills.length > 0
      ? selectedSkills.map((s) => s.id)
      : undefined;
    setPrompt("");
    setComposerAttachments([]);
    setSelectedSkills([]);
    clearMentionUi();

    try {
      await runChatCycle(text, {
        contextAttachments: attachments,
        explicitSkillIds,
      });
    } catch (error) {
      setPrompt(previousPrompt);
      setComposerAttachments(previousAttachments);
      setSelectedSkills(previousSkills);
      syncActiveMention(previousPrompt);
      setCategorizedError(classifyError(error));
    }
  };

  const handlePlanUpdate = (
    messageId: string,
    updater: (plan: OrchestrationPlan) => OrchestrationPlan,
    options?: { persist?: boolean },
  ): void => {
    const targetMessage = messagesRef.current.find((m) => m.id === messageId);
    if (!targetMessage || !targetMessage.plan) return;

    // Execute updater synchronously so callers can capture local variable side-effects
    const updatedPlan = updater(targetMessage.plan);
    const currentTrace = targetMessage.toolTrace ?? [];

    setMessages((prev) => {
      const next = prev.map((m) => {
        if (m.id !== messageId || !m.plan) return m;
        // Re-apply updater functionally for React state consistency
        return { ...m, plan: updater(m.plan) };
      });
      messagesRef.current = next;
      return next;
    });

    if (options?.persist !== false) {
      const sessionId = resolveScopedSessionId(currentConversation, targetMessage.agentId);
      void saveWorkflowCheckpoint(
        sessionId,
        messageId,
        updatedPlan,
        currentTrace,
        getHitlContinuationMemory(sessionId),
        workingMemoryBySessionRef.current.get(sessionId) ?? undefined,
      ).catch((err) =>
        setSessionNote(
          `审批点未保存：${err instanceof Error ? err.message : "未知错误"}`
        )
      );
    }
  };

  handlePlanUpdateRef.current = handlePlanUpdate;

  const markShellActionsFailed = (
    plan: OrchestrationPlan,
    actionIds: string[],
    reason: string,
  ): OrchestrationPlan => actionIds.reduce(
    (currentPlan, actionId) => markActionExecutionError(currentPlan, actionId, reason),
    plan,
  );

  const startShellJobForAction = async (params: {
    messageId: string;
    actionId: string;
    plan: OrchestrationPlan;
    approvalContext?: ManualApprovalContext;
  }): Promise<void> => {
    const action = params.plan.proposedActions.find(
      (candidate) => candidate.id === params.actionId,
    );
    if (!action || action.type !== "shell") {
      throw new Error("找不到待执行的 shell 动作。");
    }

    const executionMode = resolveShellExecutionMode(
      action.payload.shell,
      action.payload.executionMode,
    );
    const readyUrl = resolveShellReadyUrl({
      shell: action.payload.shell,
      preferredUrl: action.payload.readyUrl,
      executionMode,
    });
    const readyTimeoutMs =
      resolveShellReadyTimeoutMs(action.payload.readyTimeoutMs, executionMode) ??
      DEFAULT_BACKGROUND_READY_TIMEOUT_MS;
    const started = await startShellCommand({
      workspacePath: settings.workspacePath,
      shell: action.payload.shell,
      timeoutMs: action.payload.timeoutMs,
      detached: executionMode === "background",
      maxOutputBytes: DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
    });
    runningShellJobsRef.current.set(started.job_id, {
      messageId: params.messageId,
      actionId: params.actionId,
      workspacePath: settings.workspacePath,
      executionMode,
      readyUrl,
      readyTimeoutMs,
      approvalContext: params.approvalContext,
    });
    if (executionMode === "background") {
      void monitorBackgroundShellJobRef.current(started.job_id);
    }
  };

  startShellJobForActionRef.current = startShellJobForAction;

  const completeBackgroundShellStartup = async (jobId: string): Promise<void> => {
    const runningJob = runningShellJobsRef.current.get(jobId);
    if (
      !runningJob ||
      runningJob.executionMode !== "background" ||
      runningJob.detached
    ) {
      return;
    }

    runningShellJobsRef.current.set(jobId, {
      ...runningJob,
      detached: true,
    });
    flushShellOutputBufferRef.current(jobId);

    let nextPlan: OrchestrationPlan | null = null;
    handlePlanUpdateRef.current(runningJob.messageId, (plan) => {
      nextPlan = markShellActionBackground(
        plan,
        runningJob.actionId,
        runningJob.workspacePath,
        {
          jobId,
          readyUrl: runningJob.readyUrl,
          approvalContext: runningJob.approvalContext,
        },
      );
      return nextPlan;
    });

    if (!nextPlan) {
      return;
    }

    const resolvedPlan = nextPlan as OrchestrationPlan;
    const pendingQueue = pendingShellQueuesRef.current.get(runningJob.messageId);
    if (!pendingQueue || pendingQueue.actionIds.length === 0) {
      setSessionNote(
        `后台命令 ${runningJob.actionId} 已启动 · 状态：${resolvedPlan.state}`,
      );
      continueAfterHitlIfNeededRef.current(runningJob.messageId, resolvedPlan);
      return;
    }

    const [nextActionId, ...restActionIds] = pendingQueue.actionIds;
    if (!nextActionId) {
      pendingShellQueuesRef.current.delete(runningJob.messageId);
      continueAfterHitlIfNeededRef.current(runningJob.messageId, resolvedPlan);
      return;
    }

    if (restActionIds.length > 0) {
      pendingShellQueuesRef.current.set(runningJob.messageId, {
        messageId: runningJob.messageId,
        actionIds: restActionIds,
        approvalContext: pendingQueue.approvalContext,
      });
    } else {
      pendingShellQueuesRef.current.delete(runningJob.messageId);
    }

    const queuedPlan = markShellActionRunning(resolvedPlan, nextActionId, {
      message: "命令启动中…",
    });
    handlePlanUpdateRef.current(runningJob.messageId, () => queuedPlan);

    try {
      await startShellJobForActionRef.current({
        messageId: runningJob.messageId,
        actionId: nextActionId,
        plan: queuedPlan,
        approvalContext: pendingQueue.approvalContext,
      });
      setSessionNote(
        `后台命令 ${runningJob.actionId} 已就绪，正在执行下一个命令 (${nextActionId})`,
      );
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : String(error || "命令启动失败");
      let failedPlan = markActionExecutionError(queuedPlan, nextActionId, reason);
      if (restActionIds.length > 0) {
        failedPlan = markShellActionsFailed(
          failedPlan,
          restActionIds,
          `未执行：前序命令启动失败：${reason}`,
        );
      }
      pendingShellQueuesRef.current.delete(runningJob.messageId);
      handlePlanUpdateRef.current(runningJob.messageId, () => failedPlan);
      setCategorizedError(classifyError(error));
      continueAfterHitlIfNeededRef.current(runningJob.messageId, failedPlan);
    }
  };

  completeBackgroundShellStartupRef.current = completeBackgroundShellStartup;

  const monitorBackgroundShellJob = async (jobId: string): Promise<void> => {
    const initialJob = runningShellJobsRef.current.get(jobId);
    if (!initialJob || initialJob.executionMode !== "background") {
      return;
    }

    const readyDeadline = Date.now() + (initialJob.readyTimeoutMs ?? DEFAULT_BACKGROUND_READY_TIMEOUT_MS);
    const noProbeGraceMs = 1200;
    const startedAt = Date.now();

    while (Date.now() < readyDeadline) {
      const runningJob = runningShellJobsRef.current.get(jobId);
      if (
        !runningJob ||
        runningJob.executionMode !== "background" ||
        runningJob.detached
      ) {
        return;
      }

      const probeUrl = runningJob.readyUrl;
      if (probeUrl) {
        try {
          const response = await fetchUrl({
            url: probeUrl,
            maxSize: 512,
          });
          // Any HTTP response (even 401/404/302) means the server is listening.
          // Only treat network-level errors (response.error is set) as "not ready".
          if (!response.error) {
            await completeBackgroundShellStartupRef.current(jobId);
            return;
          }
        } catch {
          // Ignore transient readiness probe failures while the process is still starting.
        }
      } else if (Date.now() - startedAt >= noProbeGraceMs) {
        await completeBackgroundShellStartupRef.current(jobId);
        return;
      }

      await waitForDelay(probeUrl ? 500 : 250);
    }

    const runningJob = runningShellJobsRef.current.get(jobId);
    if (!runningJob || runningJob.executionMode !== "background" || runningJob.detached) {
      return;
    }

    try {
      await cancelShellCommand(jobId);
    } catch {
      // Best effort: the process may have already exited on its own.
    }

    const reason = runningJob.readyUrl
      ? `后台命令未在 ${runningJob.readyTimeoutMs ?? DEFAULT_BACKGROUND_READY_TIMEOUT_MS}ms 内就绪：${runningJob.readyUrl}`
      : `后台命令未在 ${runningJob.readyTimeoutMs ?? DEFAULT_BACKGROUND_READY_TIMEOUT_MS}ms 内进入可继续状态`;

    let nextPlan: OrchestrationPlan | null = null;
    handlePlanUpdateRef.current(runningJob.messageId, (plan) => {
      nextPlan = markActionExecutionError(plan, runningJob.actionId, reason);
      const pendingQueue = pendingShellQueuesRef.current.get(runningJob.messageId);
      if (pendingQueue && pendingQueue.actionIds.length > 0) {
        nextPlan = markShellActionsFailed(
          nextPlan,
          pendingQueue.actionIds,
          `未执行：前序后台命令未就绪：${reason}`,
        );
      }
      return nextPlan;
    });
    const buffered = shellOutputBuffersRef.current.get(jobId);
    if (buffered && buffered.timerId !== null) {
      clearTimeout(buffered.timerId);
    }
    shellOutputBuffersRef.current.delete(jobId);
    runningShellJobsRef.current.delete(jobId);
    pendingShellQueuesRef.current.delete(runningJob.messageId);
    setSessionNote(reason);
    if (nextPlan) {
      continueAfterHitlIfNeededRef.current(
        runningJob.messageId,
        nextPlan as OrchestrationPlan,
      );
    }
  };

  monitorBackgroundShellJobRef.current = monitorBackgroundShellJob;

  const flushShellOutputBuffer = (jobId: string): void => {
    const job = runningShellJobsRef.current.get(jobId);
    const buffer = shellOutputBuffersRef.current.get(jobId);
    if (!job || !buffer) {
      return;
    }

    if (buffer.timerId !== null) {
      clearTimeout(buffer.timerId);
      buffer.timerId = null;
    }

    if (!buffer.stdout && !buffer.stderr) {
      return;
    }

    const stdoutChunk = buffer.stdout;
    const stderrChunk = buffer.stderr;
    const stdoutChunkBytes = buffer.stdoutBytes;
    const stderrChunkBytes = buffer.stderrBytes;
    buffer.stdout = "";
    buffer.stderr = "";
    buffer.stdoutBytes = 0;
    buffer.stderrBytes = 0;

    handlePlanUpdate(
      job.messageId,
      (plan) => {
        let nextPlan = plan;
        if (stdoutChunk) {
          nextPlan = appendRunningShellOutput(nextPlan, job.actionId, {
            command: buffer.command,
            stream: "stdout",
            chunk: stdoutChunk,
            chunkBytes: stdoutChunkBytes,
          });
        }
        if (stderrChunk) {
          nextPlan = appendRunningShellOutput(nextPlan, job.actionId, {
            command: buffer.command,
            stream: "stderr",
            chunk: stderrChunk,
            chunkBytes: stderrChunkBytes,
          });
        }
        return nextPlan;
      },
      { persist: false },
    );
  };

  flushShellOutputBufferRef.current = flushShellOutputBuffer;

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    void listen<ShellCommandEvent>("shell-command-event", (event) => {
      if (disposed) {
        return;
      }

      const payload = event.payload;
      const runningJob = runningShellJobsRef.current.get(payload.job_id);
      if (!runningJob) {
        return;
      }

      if (
        payload.event_type === "output" &&
        payload.chunk &&
        (payload.stream === "stdout" || payload.stream === "stderr")
      ) {
        const inferredReadyUrl = extractShellReadyUrlFromText(payload.chunk);
        if (
          inferredReadyUrl &&
          runningJob.executionMode === "background" &&
          !runningJob.readyUrl
        ) {
          runningShellJobsRef.current.set(payload.job_id, {
            ...runningJob,
            readyUrl: inferredReadyUrl,
          });
        }

        const existing =
          shellOutputBuffersRef.current.get(payload.job_id) ?? {
            command: payload.command,
            stdout: "",
            stderr: "",
            stdoutBytes: 0,
            stderrBytes: 0,
            timerId: null,
          };

        existing.command = payload.command || existing.command;
        if (payload.stream === "stdout") {
          existing.stdout += payload.chunk;
          existing.stdoutBytes += measureShellChunkBytes(payload.chunk);
        } else {
          existing.stderr += payload.chunk;
          existing.stderrBytes += measureShellChunkBytes(payload.chunk);
        }
        if (existing.timerId === null) {
          existing.timerId = setTimeout(() => {
            flushShellOutputBufferRef.current(payload.job_id);
          }, DEFAULT_SHELL_OUTPUT_FLUSH_INTERVAL_MS);
        }
        shellOutputBuffersRef.current.set(payload.job_id, existing);
        return;
      }

      if (payload.event_type !== "completed") {
        return;
      }

      flushShellOutputBufferRef.current(payload.job_id);
      shellOutputBuffersRef.current.delete(payload.job_id);
      runningShellJobsRef.current.delete(payload.job_id);

      if (runningJob.executionMode === "background" && runningJob.detached) {
        handlePlanUpdateRef.current(runningJob.messageId, (plan) =>
          completeBackgroundShellAction(plan, runningJob.actionId, {
            success: Boolean(payload.success),
            command: payload.command,
            timed_out: Boolean(payload.timed_out),
            status: Number(payload.status ?? -1),
            stdout: String(payload.stdout ?? ""),
            stderr: String(payload.stderr ?? ""),
            cancelled: Boolean(payload.cancelled),
            stdout_truncated: Boolean(payload.stdout_truncated),
            stderr_truncated: Boolean(payload.stderr_truncated),
            stdout_total_bytes: Number(payload.stdout_total_bytes ?? 0),
            stderr_total_bytes: Number(payload.stderr_total_bytes ?? 0),
            output_limit_bytes: Number(
              payload.output_limit_bytes ?? DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
            ),
          }),
        );
        setSessionNote(
          payload.cancelled
            ? `后台命令 ${runningJob.actionId} 已取消`
            : `后台命令 ${runningJob.actionId} 已结束`,
        );
        return;
      }

      let nextPlan: OrchestrationPlan | null = null;
      handlePlanUpdateRef.current(runningJob.messageId, (plan) => {
        nextPlan = completeRunningShellAction(
          plan,
          runningJob.actionId,
          runningJob.workspacePath,
          {
            success: Boolean(payload.success),
            command: payload.command,
            timed_out: Boolean(payload.timed_out),
            status: Number(payload.status ?? -1),
            stdout: String(payload.stdout ?? ""),
            stderr: String(payload.stderr ?? ""),
            cancelled: Boolean(payload.cancelled),
            stdout_truncated: Boolean(payload.stdout_truncated),
            stderr_truncated: Boolean(payload.stderr_truncated),
            stdout_total_bytes: Number(payload.stdout_total_bytes ?? 0),
            stderr_total_bytes: Number(payload.stderr_total_bytes ?? 0),
            output_limit_bytes: Number(
              payload.output_limit_bytes ?? DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
            ),
          },
          runningJob.approvalContext,
        );
        return nextPlan;
      });

      if (!nextPlan) {
        return;
      }

      const resolvedPlan = nextPlan as OrchestrationPlan;
      const pendingQueue = pendingShellQueuesRef.current.get(runningJob.messageId);
      const currentSucceeded = Boolean(payload.success) && !Boolean(payload.cancelled);

      if (pendingQueue && pendingQueue.actionIds.length > 0) {
        void (async () => {
          if (!currentSucceeded) {
            pendingShellQueuesRef.current.delete(runningJob.messageId);
            const queueStopReason = payload.cancelled
              ? "未执行：前序命令已取消"
              : "未执行：前序命令失败";
            const failedQueuedPlan = markShellActionsFailed(
              resolvedPlan,
              pendingQueue.actionIds,
              queueStopReason,
            );
            handlePlanUpdateRef.current(runningJob.messageId, () => failedQueuedPlan);
            setSessionNote(
              `动作 ${runningJob.actionId} 已停止，剩余 ${pendingQueue.actionIds.length} 个命令未继续执行`,
            );
            continueAfterHitlIfNeededRef.current(runningJob.messageId, failedQueuedPlan);
          } else {
            const [nextActionId, ...restActionIds] = pendingQueue.actionIds;
            if (!nextActionId) {
              pendingShellQueuesRef.current.delete(runningJob.messageId);
              setSessionNote(
                `动作 ${runningJob.actionId} 已执行 · 状态：${resolvedPlan.state}`,
              );
              continueAfterHitlIfNeededRef.current(runningJob.messageId, resolvedPlan);
              return;
            }

            if (restActionIds.length > 0) {
              pendingShellQueuesRef.current.set(runningJob.messageId, {
                messageId: runningJob.messageId,
                actionIds: restActionIds,
                approvalContext: pendingQueue.approvalContext,
              });
            } else {
              pendingShellQueuesRef.current.delete(runningJob.messageId);
            }

            const queuedPlan = markShellActionRunning(
              resolvedPlan,
              nextActionId,
              { message: "命令启动中…" },
            );
            handlePlanUpdateRef.current(runningJob.messageId, () => queuedPlan);
            try {
              await startShellJobForActionRef.current({
                messageId: runningJob.messageId,
                actionId: nextActionId,
                plan: queuedPlan,
                approvalContext: pendingQueue.approvalContext,
              });
              setSessionNote(
                `动作 ${runningJob.actionId} 已完成，正在执行下一个命令 (${nextActionId})`,
              );
            } catch (error) {
              const reason =
                error instanceof Error
                  ? error.message
                  : String(error || "命令启动失败");
              let failedPlan = markActionExecutionError(queuedPlan, nextActionId, reason);
              if (restActionIds.length > 0) {
                failedPlan = markShellActionsFailed(
                  failedPlan,
                  restActionIds,
                  `未执行：前序命令启动失败：${reason}`,
                );
              }
              pendingShellQueuesRef.current.delete(runningJob.messageId);
              handlePlanUpdateRef.current(runningJob.messageId, () => failedPlan);
              setCategorizedError(classifyError(error));
              continueAfterHitlIfNeededRef.current(runningJob.messageId, failedPlan);
            }
          }
        })();
        return;
      }

      setSessionNote(
        `动作 ${runningJob.actionId} 已执行 · 状态：${resolvedPlan.state}`,
      );
      continueAfterHitlIfNeededRef.current(runningJob.messageId, resolvedPlan);
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      disposed = true;
      for (const buffer of shellOutputBuffersRef.current.values()) {
        if (buffer.timerId !== null) {
          clearTimeout(buffer.timerId);
        }
      }
      shellOutputBuffersRef.current.clear();
      runningShellJobsRef.current.clear();
      pendingShellQueuesRef.current.clear();
      unlisten?.();
    };
  }, []);

  const ensureApprovalInteractionAllowed = (
    messageId: string,
    plan?: OrchestrationPlan,
    options?: {
      actionIds?: string[];
      allowBackgroundBatch?: boolean;
    },
  ): boolean => {
    const targetMessage = messagesRef.current.find((message) => message.id === messageId);
    const sessionId = resolveScopedSessionId(currentConversation, targetMessage?.agentId);
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
      options?.actionIds && options.actionIds.length > 0
        ? new Set(options.actionIds)
        : null;
    const pendingActions =
      plan?.proposedActions.filter(
        (action) => action.status === "pending" && (!actionIdSet || actionIdSet.has(action.id)),
      ) ?? [];
    const hasBackgroundPendingShell = pendingActions.some(
      (action) =>
        action.type === "shell" &&
        resolveShellExecutionMode(action.payload.shell, action.payload.executionMode) === "background",
    );
    if (!options?.allowBackgroundBatch && pendingActions.length > 1 && hasBackgroundPendingShell) {
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
    const targetAction = plan.proposedActions.find((action) => action.id === actionId);
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
      setSessionNote(`动作 ${actionId} 已执行${rememberMessage} · 状态：${nextPlan.state}`);
      continueAfterHitlIfNeeded(messageId, nextPlan);
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : String(error || "动作执行失败");
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
    plan: OrchestrationPlan
  ): Promise<void> => {
    const retryPlan = retryFailedShellAction(plan, actionId);
    const retryAction = retryPlan.proposedActions.find(
      (action) => action.type === "shell" && action.payload.retryFromActionId === actionId
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

        // Defer the check so that handlePlanUpdate completes synchronously
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
    options?: {
      actionIds?: string[];
      approvalContext?: ManualApprovalContext;
      allowBackgroundBatch?: boolean;
    },
  ): Promise<void> => {
    if (
      executingActionId ||
      !ensureApprovalInteractionAllowed(messageId, plan, {
        actionIds: options?.actionIds,
        allowBackgroundBatch: options?.allowBackgroundBatch,
      })
    ) {
      return;
    }
    const actionIdSet =
      options?.actionIds && options.actionIds.length > 0
        ? new Set(options.actionIds)
        : null;
    const pendingActions = plan.proposedActions.filter(
      (action) => action.status === "pending" && (!actionIdSet || actionIdSet.has(action.id)),
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
          approvalContext: options?.approvalContext,
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
            approvalContext: options?.approvalContext,
          },
        );
        handlePlanUpdate(messageId, () => nextPlan);
        const patchFailed = nextPlan.proposedActions.some(
          (action) =>
            pendingPatchIds.includes(action.id) &&
            action.status === "failed",
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
            approvalContext: options?.approvalContext,
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
            approvalContext: options?.approvalContext,
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
        (a) => a.status === "completed"
      ).length;
      setSessionNote(
        `已批量执行 ${completedCount} 个动作 · 状态：${nextPlan.state}`
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
      setSessionNote(cancelled ? `已发送取消请求：${actionId}` : `命令已结束：${actionId}`);
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

  const handleClearHistory = (): void => {
    if (isStreaming || Boolean(executingActionId)) return;
    if (!currentConversation) return;

    resetChatSessionState({
      conversationId: currentConversation.id,
      agentId: currentConversation.agentBinding?.agentId ?? undefined,
    });
    session.resetSession();
    conversationDebugEntriesRef.current.delete(
      resolveConversationDebugKey(currentConversation.id),
    );

    const clearedConversation = createClearedConversation(currentConversation);
    saveConversation(wsPath, clearedConversation);
    setCurrentConversation(clearedConversation);
    applyChatViewState(createEmptyChatViewState());
    setConversations(loadConversationList(wsPath));
    setComposerAttachments([]);
    clearMentionUi();
  };

  const snapshotToBackground = () => {
    if (!activeConversationId) {
      return;
    }

    const backgroundStream = createBackgroundStreamState({
      isStreaming,
      messages: messagesRef.current,
      liveContextTokens,
      sessionNote,
      liveToolCalls,
      categorizedError,
      subAgentStatus,
    });
    if (backgroundStream) {
      backgroundStreamsRef.current.set(activeConversationId, backgroundStream);
    }
  };

  // Conversation management handlers
  const handleNewConversation = (): void => {
    if (Boolean(executingActionId)) return;

    snapshotToBackground();

    const previousConversationId = activeConversationIdRef.current;
    const previousConv =
      previousConversationId && wsPath
        ? loadConversation(wsPath, previousConversationId)
        : null;

    const newConv = createConversation(
      wsPath,
      [],
      createConversationAgentBinding(settings, activeAgent),
    );
    skipNextTimestampRef.current = true;
    activateConversation(newConv);
    setConversations(loadConversationList(wsPath));
    setPrompt("");
    setComposerAttachments([]);
    clearMentionUi();

    resetChatSessionState(
      previousConversationId && previousConv
        ? {
            conversationId: previousConversationId,
            agentId: previousConv.agentBinding?.agentId ?? undefined,
          }
        : undefined,
    );
    session.resetSession();
  };

  const handleSelectConversation = (conversationId: string): void => {
    if (Boolean(executingActionId)) return;
    if (conversationId === activeConversationId) return;

    snapshotToBackground();

    const previousConversationId = activeConversationIdRef.current;
    const previousConv =
      previousConversationId && wsPath
        ? loadConversation(wsPath, previousConversationId)
        : null;

    const conv = loadConversation(wsPath, conversationId);
    if (!conv) return;

    skipNextTimestampRef.current = true;
    activateConversation(conv, {
      persistActiveId: true,
      backgroundStream: takeBackgroundStream(conv.id),
      idleSessionNote: conv.messages.length ? "已切换对话" : "",
    });
    setPrompt("");
    setComposerAttachments([]);
    clearMentionUi();

    resetChatSessionState(
      previousConversationId && previousConv
        ? {
            conversationId: previousConversationId,
            agentId: previousConv.agentBinding?.agentId ?? undefined,
          }
        : undefined,
    );
    session.resetSession();
  };

  const handleDeleteConversation = (conversationId: string): void => {
    const isConvStreaming =
      (conversationId === activeConversationId && isStreaming) ||
      backgroundStreamsRef.current.get(conversationId)?.isStreaming;
    if (isConvStreaming || Boolean(executingActionId)) return;

    abortControllersRef.current.get(conversationId)?.abort();
    abortControllersRef.current.delete(conversationId);
    backgroundStreamsRef.current.delete(conversationId);
    conversationDebugEntriesRef.current.delete(
      resolveConversationDebugKey(conversationId),
    );

    const wasActiveConversation = conversationId === activeConversationId;

    const deletedConvSnapshot =
      wsPath && conversationId
        ? loadConversation(wsPath, conversationId)
        : null;

    deleteConversation(wsPath, conversationId);
    const updatedList = loadConversationList(wsPath);
    setConversations(updatedList);

    if (wasActiveConversation) {
      if (updatedList.length > 0) {
        const deletedConversationId = conversationId;
        const deletedConv = deletedConvSnapshot;
        const nextConversation = loadConversation(wsPath, updatedList[0].id);
        if (nextConversation) {
          activateConversation(nextConversation, {
            persistActiveId: true,
            backgroundStream: takeBackgroundStream(nextConversation.id),
            idleSessionNote: nextConversation.messages.length ? "已切换对话" : "",
          });
          setPrompt("");
          setComposerAttachments([]);
          clearMentionUi();

          resetChatSessionState(
            deletedConv
              ? {
                  conversationId: deletedConversationId,
                  agentId: deletedConv.agentBinding?.agentId ?? undefined,
                }
              : undefined,
          );
          session.resetSession();
        }
      } else {
        handleNewConversation();
      }
    }
  };

  const handleRenameConversation = (
    conversationId: string,
    newTitle: string
  ): void => {
    updateConversationTitle(wsPath, conversationId, newTitle);
    setConversations(loadConversationList(wsPath));

    // Update current conversation if it's the one being renamed
    if (conversationId === activeConversationId && currentConversation) {
      setCurrentConversation({
        ...currentConversation,
        title: newTitle,
      });
    }
  };

  const handleSuggestionClick = (text: string) => {
    setPrompt(text);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const caret = text.length;
      textareaRef.current?.setSelectionRange(caret, caret);
      syncActiveMention(text, caret);
    });
  };

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

  handleApproveActionThreadRef.current = handleApproveAction;
  handleRetryActionThreadRef.current = handleRetryAction;
  handleRejectActionThreadRef.current = handleRejectAction;
  handleCommentActionThreadRef.current = handleCommentAction;
  handleCancelActionThreadRef.current = handleCancelAction;
  handleApproveAllActionsThreadRef.current = handleApproveAllActions;
  handleRejectAllActionsThreadRef.current = handleRejectAllActions;
  handleSuggestionClickThreadRef.current = handleSuggestionClick;

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
      !ensureApprovalInteractionAllowed(messageAction.messageId, latestPendingPlanMessage.plan, {
        actionIds: messageAction.teamActionIds,
        allowBackgroundBatch: true,
      })
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
  ]);

  const handlePromptChange = (nextText: string, caretIndex?: number): void => {
    setPrompt(nextText);
    syncActiveMention(nextText, caretIndex);
  };

  const handleSelectNextMention = (maxIndex: number): void => {
    setMentionSelectionIndex((prev) => Math.min(prev + 1, maxIndex));
  };

  const handleSelectPreviousMention = (): void => {
    setMentionSelectionIndex((prev) => Math.max(prev - 1, 0));
  };

  const assistantDisplayName = resolveConversationAssistantDisplayName({
    conversation: currentConversation,
    messageCount: messages.length,
    activeAgentName: activeAgent.name,
  });
  const activeConversationIdentity = resolveScopedSessionId(currentConversation);
  const askUserAnchorMessageId = useMemo(
    () =>
      findLatestAskUserAnchorMessageId({
        messages: messages,
        lastVisibleMessage,
        isStreaming,
        liveToolCalls,
        hasAskUserPending,
      }),
    [
      hasAskUserPending,
      isStreaming,
      lastVisibleMessage?.id,
      liveToolCalls,
      messages,
    ],
  );
  const restoreAnchorMessageId = useMemo(
    () => findLatestRestoreAnchorMessageId(visibleMessages, hasRestoreNotice),
    [hasRestoreNotice, visibleMessages],
  );
  const derivedTopbarState = useMemo(
    () =>
      deriveConversationTopbarState({
      agentLabel: assistantDisplayName,
      isStreaming,
      liveToolCalls,
      subAgentStatus,
      activePlan,
      hasAskUserPending,
      hasRestoreNotice,
      sessionNote,
      }),
    [
      activeConversationIdentity,
      activePlan,
      assistantDisplayName,
      hasAskUserPending,
      hasRestoreNotice,
      isStreaming,
      liveToolCalls,
      sessionNote,
      subAgentStatus,
    ],
  );
  const topbarTargets = useMemo(() => {
    const targets = new Map<ConversationTopbarAction, ConversationTopbarTarget | null>();

    for (const badge of derivedTopbarState.badges) {
      if (!badge.action || targets.has(badge.action)) {
        continue;
      }
      targets.set(
        badge.action,
        resolveConversationTopbarTarget({
          action: badge.action,
          messages,
          activePlan,
          liveToolCalls,
          subAgentStatus,
          hasAskUserPending,
          askUserAnchorMessageId,
          hasRestoreNotice,
          restoreAnchorMessageId,
          sessionNote,
        }),
      );
    }

    if (derivedTopbarState.progress.visible) {
      targets.set(
        "progress",
        resolveConversationTopbarTarget({
          action: "progress",
          messages,
          activePlan,
          liveToolCalls,
          subAgentStatus,
          hasAskUserPending,
          askUserAnchorMessageId,
          hasRestoreNotice,
          restoreAnchorMessageId,
          sessionNote,
        }),
      );
    }

    if (derivedTopbarState.attention?.ctaAction) {
      targets.set(
        derivedTopbarState.attention.ctaAction,
        resolveConversationTopbarTarget({
          action: derivedTopbarState.attention.ctaAction,
          messages,
          activePlan,
          liveToolCalls,
          subAgentStatus,
          hasAskUserPending,
          askUserAnchorMessageId,
          hasRestoreNotice,
          restoreAnchorMessageId,
          sessionNote,
        }),
      );
    }

    return targets;
  }, [
    activeConversationIdentity,
    activePlan,
    askUserAnchorMessageId,
    derivedTopbarState,
    hasAskUserPending,
    hasRestoreNotice,
    liveToolCalls,
    messages,
    restoreAnchorMessageId,
    sessionNote,
    subAgentStatus,
  ]);
  const topbarState = useMemo(
    () => applyTopbarActionAvailability(derivedTopbarState, topbarTargets),
    [derivedTopbarState, topbarTargets],
  );

  useEffect(() => {
    setExpandedPlanMessageId(null);
    setExpandedPlanActionId(null);
    setExpandedPlanRequestKey(0);
  }, [activeConversationIdentity]);

  const navigateTopbarTarget = useCallback(
    (target: ConversationTopbarTarget, waitForExpansion = false): void => {
      const runNavigation = () => {
        const resolved = resolveTopbarTargetElement({
          thread: threadRef.current,
          contextAnchor: contextAnchorRef.current,
          target,
        });
        if (!resolved) {
          return;
        }

        if (threadRef.current && threadRef.current.contains(resolved)) {
          scrollThreadTargetIntoView(threadRef.current, resolved);
        } else {
          resolved.scrollIntoView?.({ block: "nearest" });
        }
        focusTopbarTarget(resolved);
      };

      window.requestAnimationFrame(() => {
        if (waitForExpansion) {
          window.requestAnimationFrame(runNavigation);
          return;
        }
        runNavigation();
      });
    },
    [],
  );

  const handleTopbarAction = useCallback(
    (action: ConversationTopbarAction): void => {
      const target = topbarTargets.get(action) ?? null;
      if (!target) {
        return;
      }

      const shouldExpandPlan =
        Boolean(target.messageId) &&
        (target.anchor === "approval" ||
          target.anchor === "plan" ||
          target.anchor === "blocked_output");
      if (shouldExpandPlan) {
        setExpandedPlanMessageId(target.messageId ?? null);
        setExpandedPlanActionId(target.actionId ?? null);
        setExpandedPlanRequestKey((current) => current + 1);
      }

      navigateTopbarTarget(target, shouldExpandPlan);
    },
    [navigateTopbarTarget, topbarTargets],
  );

  // Listen for global new-conversation shortcut
  useEffect(() => {
    const handler = () => handleNewConversation();
    window.addEventListener("cofree:new-conversation", handler);
    return () => window.removeEventListener("cofree:new-conversation", handler);
  }, []);

  return (
    <div className="chat-layout-with-sidebar">
      <ConversationSidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        collapsed={sidebarCollapsed ?? false}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onDeleteConversation={handleDeleteConversation}
        onRenameConversation={handleRenameConversation}
      />
      <div className="chat-main-area">
        <div className="page-content chat-layout">
          {/* ── Alerts ── */}
          {localOnlyBlocked && (
            <div className="chat-alert chat-alert-error">
              Local-only 模式已开启，当前 provider 不是本地模型，请前往设置页切换。
            </div>
          )}
          {noWorkspaceSelected && (
            <div className="chat-alert chat-alert-warning">
              请先在设置页选择工作区（Git 仓库文件夹）
            </div>
          )}

          {/* ── Thread ── */}
          <ChatThreadSection
            threadRef={threadRef}
            onThreadScroll={handleThreadScroll}
            messages={messages}
            assistantDisplayName={assistantDisplayName}
            assistantDescription={activeAgent.description}
            debugMode={settings.debugMode}
            isStreaming={isStreaming}
            liveToolCalls={liveToolCalls}
            subAgentStatus={subAgentStatus}
            executingActionId={executingActionId}
            getActiveShellActionIds={getActiveShellActionIdsForThread}
            onPlanUpdate={handlePlanUpdateForThread}
            onApprove={handleApproveActionForThread}
            onRetry={handleRetryActionForThread}
            onReject={handleRejectActionForThread}
            onComment={handleCommentActionForThread}
            onCancel={handleCancelActionForThread}
            onApproveAll={handleApproveAllActionsForThread}
            onRejectAll={handleRejectAllActionsForThread}
            onSuggestionClick={handleSuggestionClickForThread}
            topbarState={topbarState}
            onTopbarAction={handleTopbarAction}
            expandedPlanMessageId={expandedPlanMessageId}
            expandedPlanActionId={expandedPlanActionId}
            expandedPlanRequestKey={expandedPlanRequestKey}
            askUserAnchorMessageId={askUserAnchorMessageId}
            restoreAnchorMessageId={restoreAnchorMessageId}
          />

          {/* ── Input ── */}
          <div className="chat-input-area">
            {categorizedError && (
              <ErrorBanner
                error={categorizedError}
                onRetry={
                  categorizedError.retriable
                    ? () => {
                      setCategorizedError(null);
                      setFailedLlmRequestLog(null);
                      if (lastPromptRef.current) {
                        void runChatCycle(lastPromptRef.current, {
                          contextAttachments: lastContextAttachmentsRef.current,
                        });
                      }
                    }
                    : undefined
                }
                onCopyDebugLog={
                  settings.debugMode &&
                    failedLlmRequestLog &&
                    isLlmResponseFailureCategory(categorizedError.category)
                    ? () => {
                      void handleCopyFailedRequestLog();
                    }
                    : undefined
                }
                copyDebugLogLabel="复制本次请求日志"
                onDismiss={() => {
                  setCategorizedError(null);
                  setFailedLlmRequestLog(null);
                }}
              />
            )}
            <ChatComposer
              textareaRef={textareaRef}
              contextAnchorRef={contextAnchorRef}
              prompt={prompt}
              chatBlocked={chatBlocked}
              composerAttachments={composerAttachments}
              onRemoveComposerAttachment={handleRemoveComposerAttachment}
              selectedSkills={selectedSkills}
              onRemoveSelectedSkill={handleRemoveSelectedSkill}
              activeMention={activeMention}
              mentionSuggestions={mentionSuggestions}
              mentionSelectionIndex={mentionSelectionIndex}
              onPromptChange={handlePromptChange}
              onMentionSync={syncActiveMention}
              onMentionSuggestionSelect={handleMentionSuggestionSelect}
              onSelectNextMention={handleSelectNextMention}
              onSelectPreviousMention={handleSelectPreviousMention}
              onClearMentionUi={clearMentionUi}
              onSubmit={handleSubmit}
              liveContextTokens={liveContextTokens}
              maxContextTokens={
                settings.maxContextTokens > 0 ? settings.maxContextTokens : 128000
              }
              isStreaming={isStreaming}
              executingActionId={executingActionId}
              messagesCount={messages.length}
              onClearHistory={handleClearHistory}
              debugMode={settings.debugMode}
              isExportingDebugBundle={isExportingDebugBundle}
              hasDebugBundleTarget={Boolean(currentConversation) || messages.length > 0}
              onDownloadConversationDebugBundle={() => {
                void handleDownloadConversationDebugBundle();
              }}
              onCancel={handleCancel}
            />
          </div>
        </div>
      </div>

      <InputDialog
        open={inputDialog.open}
        title={inputDialog.title}
        placeholder={inputDialog.placeholder}
        defaultValue={inputDialog.defaultValue}
        onConfirm={inputDialog.onConfirm}
        onCancel={() => setInputDialog((prev) => ({ ...prev, open: false }))}
      />
      <WorkspaceTeamTrustDialog
        open={workspaceTeamTrustPrompt !== null}
        onChooseMode={handleChooseWorkspaceTeamTrustMode}
      />
      <AskUserDialog
        open={askUserRequest !== null}
        request={askUserRequest}
        onResponse={(response, skipped) => {
          if (!askUserRequest) return;
          const targetSessionId =
            askUserRequest.sessionId ?? resolveScopedSessionId(currentConversation);
          submitUserResponse(targetSessionId, askUserRequest.id, response, skipped);
          syncAskUserRequestForSession(targetSessionId);
        }}
        onCancel={() => {
          if (!askUserRequest) return;
          const targetSessionId =
            askUserRequest.sessionId ?? resolveScopedSessionId(currentConversation);
          cancelPendingRequest(targetSessionId);
          syncAskUserRequestForSession(targetSessionId);
        }}
      />
    </div>
  );
}
