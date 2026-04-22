import {
  type ReactElement,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { type ChatMessageRecord } from "../../lib/chatHistoryStore";
import { type Conversation } from "../../lib/conversationStore";
import { type ApprovalRuleOption } from "../../lib/approvalRuleStore";
import {
  dedupeContextAttachments,
  type ChatContextAttachment,
} from "../../lib/contextAttachments";
import {
  buildCheckpointRestoreRecord,
  buildCheckpointRestoreScopeKey,
  getCheckpointRestoreScope,
  shouldApplyCheckpointRecovery,
} from "./chat/checkpointRecovery";
import { ConversationSidebar } from "../components/ConversationSidebar";
import { getActiveManagedModel, isActiveModelLocal } from "../../lib/settingsStore";
import type { AppSettings } from "../../lib/settingsStore";
import { globWorkspaceFiles } from "../../lib/tauriBridge";
import type { ChatAgentDefinition } from "../../agents/types";
import { type CategorizedError } from "../../lib/errorClassifier";
import { recordErrorAudit } from "../../lib/auditLog";
import { ErrorBanner } from "../components/ErrorBanner";
import { InputDialog } from "../components/InputDialog";
import { AskUserDialog } from "../components/AskUserDialog";
import type { AskUserRequest } from "../../orchestrator/askUserService";
import {
  cancelPendingRequest,
  getPendingRequest,
  submitUserResponse,
} from "../../orchestrator/askUserService";
import { type ManualApprovalContext } from "../../orchestrator/hitlService";
import {
  buildScopedSessionKey,
  loadLatestWorkflowCheckpoint,
} from "../../orchestrator/checkpointStore";
import {
  hydrateHitlContinuationMemory,
  resetHitlContinuationMemory,
} from "../../orchestrator/hitlContinuationController";
import type { WorkingMemorySnapshot } from "../../orchestrator/workingMemory";
import type {
  OrchestrationPlan,
} from "../../orchestrator/types";
import { useSession } from "../../lib/sessionContext";
import {
  createMessageId,
  buildToolCallsFromPlan,
} from "./chat/helpers";
import { ChatThreadSection } from "./chat/ChatThreadSection";
import { resolveConversationAssistantDisplayName } from "./chat/conversationAgentDisplay";
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
import { type SkillEntry } from "../../lib/skillStore";
import type {
  LiveToolCall,
} from "./chat/types";
import { CHECKPOINT_RESTORE_SESSION_NOTE } from "./chat/constants";
import {
  findLatestVisibleAssistantPlanMessage,
  isLlmResponseFailureCategory,
} from "./chat/chatPageHelpers";
import { useChatStreaming } from "./chat/hooks/useChatStreaming";
import { useApprovalQueue } from "./chat/hooks/useApprovalQueue";
import { useSkillDiscovery } from "./chat/hooks/useSkillDiscovery";
import { useMentionSuggestions } from "./chat/hooks/useMentionSuggestions";
import { useThreadAutoScroll } from "./chat/hooks/useThreadAutoScroll";
import { useConversationLifecycle } from "./chat/hooks/useConversationLifecycle";
import { useConversationDebugLog } from "./chat/hooks/useConversationDebugLog";
import { useShellJobs } from "./chat/hooks/useShellJobs";
import { useConversationTopbar } from "./chat/hooks/useConversationTopbar";
import { useApprovalActions } from "./chat/hooks/useApprovalActions";
import { useChatExecution } from "./chat/hooks/useChatExecution";
import { ChatComposer } from "./chat/composer/ChatComposer";
import { type ConversationDebugEntry } from "./chat/debugExport";

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
  const [categorizedError, setCategorizedError] =
    useState<CategorizedError | null>(null);
  const setAndAuditError = useCallback(
    (value: SetStateAction<CategorizedError | null>) => {
      const error = typeof value === "function" ? value(categorizedError) : value;
      setCategorizedError(error);
      if (error) {
        recordErrorAudit({
          category: error.category,
          title: error.title,
          message: error.message,
          retriable: error.retriable,
          guidance: error.guidance,
          rawError: error.rawError,
          timestamp: new Date().toISOString(),
        });
      }
    },
    [categorizedError],
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
  const lastPromptRef = useRef<string>("");
  const lastContextAttachmentsRef = useRef<ChatContextAttachment[]>([]);
  const {
    threadRef,
    contextAnchorRef,
    shouldStickThreadToBottomRef,
    forceThreadScrollRef,
    isThreadNearBottom: _isThreadNearBottom,
    syncThreadAutoScrollState: _syncThreadAutoScrollState,
    scrollThreadToBottom,
    requestThreadScrollToBottom,
    handleThreadScroll,
  } = useThreadAutoScroll();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const workingMemoryBySessionRef = useRef(
    new Map<string, WorkingMemorySnapshot | null>(),
  );
  const lastRestoredCheckpointRecordRef = useRef<string | null>(null);

  // Refs to keep the latest versions of callbacks used inside the shell-command-event
  // useEffect (which has an empty dependency array). Without these refs the listener
  // captures stale closures from the initial render, causing continuation after HITL
  // approval to silently fail because runChatCycle sees outdated state.
  const handlePlanUpdateRef = useRef<typeof handlePlanUpdate>(null!);
  const continueAfterHitlIfNeededRef = useRef<typeof continueAfterHitlIfNeeded>(null!);
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

  const activeManagedModel = getActiveManagedModel(settings);
  const activeModelLabel = activeManagedModel?.name || settings.model;
  const localOnlyBlocked =
    !settings.allowCloudModels && !isActiveModelLocal(settings);
  const noWorkspaceSelected = !settings.workspacePath;
  const chatBlocked = localOnlyBlocked || noWorkspaceSelected;
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

  const clearMentionUi = useCallback((): void => {
    setActiveMention(null);
    setMentionSuggestions([]);
    setMentionSelectionIndex(0);
  }, [setActiveMention, setMentionSuggestions, setMentionSelectionIndex]);

  const conversationDebugEntriesRef = useRef(
    new Map<string, ConversationDebugEntry[]>(),
  );

  const {
    conversations,
    activeConversationId,
    currentConversation,
    messages,
    liveContextTokens,
    sessionNote,
    messagesRef,
    activeConversationIdRef,
    skipNextTimestampRef,
    setConversations,
    setCurrentConversation,
    setMessages,
    setLiveContextTokens,
    setSessionNote,
    handleClearHistory,
    handleNewConversation,
    handleSelectConversation,
    handleDeleteConversation,
    handleRenameConversation,
  } = useConversationLifecycle({
    wsPath,
    settings,
    activeAgent,
    session,
    isStreaming,
    executingActionId,
    liveToolCalls,
    categorizedError,
    abortControllerRef,
    abortControllersRef,
    backgroundStreamsRef,
    conversationDebugEntriesRef,
    setPrompt,
    setComposerAttachments,
    clearMentionUi,
    requestThreadScrollToBottom,
    setIsStreaming,
    setLiveToolCalls,
    setCategorizedError: setAndAuditError,
  });

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

  const {
    failedLlmRequestLog,
    setFailedLlmRequestLog,
    isExportingDebugBundle,
    appendConversationDebugEntry,
    handleCopyFailedRequestLog,
    handleDownloadConversationDebugBundle,
  } = useConversationDebugLog({
    setSessionNote,
    activeConversationIdRef,
    conversationDebugEntriesRef,
    getDownloadSnapshot: () => ({
      settings,
      currentConversation,
      activeConversationId,
      messages: messagesRef.current,
      activeAgent,
      activeModelLabel,
      sessionState,
      categorizedError,
      sessionNote,
      isStreaming,
      executingActionId,
      liveContextTokens,
      liveToolCalls,
      chatSessionId: resolveScopedSessionId(currentConversation),
    }),
  });

  const {
    runningShellJobsRef,
    startShellJobForAction,
    markShellActionsFailed,
    getActiveShellActionIdsForThread,
  } = useShellJobs({
    settings,
    pendingShellQueuesRef,
    handlePlanUpdateRef,
    continueAfterHitlIfNeededRef,
    setSessionNote,
    setCategorizedError: setAndAuditError,
  });
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

  const {
    handleCancel,
    continueAfterHitlIfNeeded,
    runChatCycle,
    handleSubmit,
    handlePlanUpdate,
  } = useChatExecution({
    wsPath,
    settings,
    activeAgent,
    activeModelLabel,
    session,
    isStreaming,
    prompt,
    composerAttachments,
    selectedSkills,
    currentConversation,
    activeConversationId,
    activeConversationIdRef,
    messagesRef,
    abortControllerRef,
    abortControllersRef,
    backgroundStreamsRef,
    workingMemoryBySessionRef,
    lastPromptRef,
    lastContextAttachmentsRef,
    skipNextTimestampRef,
    setMessages,
    setCurrentConversation,
    setConversations,
    setIsStreaming,
    setSessionNote,
    setCategorizedError: setAndAuditError,
    setLiveContextTokens,
    setLiveToolCalls,
    setPrompt,
    setComposerAttachments,
    setSelectedSkills,
    setFailedLlmRequestLog,
    appendConversationDebugEntry,
    appendAssistantStatusMessage,
    resolveScopedSessionId,
    syncAskUserRequestForSession,
    requestThreadScrollToBottom,
    clearMentionUi,
    syncActiveMention,
    getLatestUserContextAttachments,
    buildSubmittedPrompt,
  });

  handlePlanUpdateRef.current = handlePlanUpdate;
  continueAfterHitlIfNeededRef.current = continueAfterHitlIfNeeded;

  const visibleMessages = messages.filter((message) => message.role !== "tool");
  const lastVisibleMessage = visibleMessages[visibleMessages.length - 1];
  const activePlanMessage = findLatestVisibleAssistantPlanMessage(visibleMessages);
  const activePlan = activePlanMessage?.plan ?? null;
  const hasAskUserPending = askUserRequest !== null;
  const hasRestoreNotice = sessionNote === CHECKPOINT_RESTORE_SESSION_NOTE;
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





  const handleSuggestionClick = (text: string) => {
    setPrompt(text);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const caret = text.length;
      textareaRef.current?.setSelectionRange(caret, caret);
      syncActiveMention(text, caret);
    });
  };

  const {
    handleApproveAction,
    handleRetryAction,
    handleRejectAction,
    handleCommentAction,
    handleApproveAllActions,
    handleCancelAction,
    handleRejectAllActions,
  } = useApprovalActions({
    settings,
    currentConversation,
    askUserRequest,
    executingActionId,
    messagesRef,
    runningShellJobsRef,
    pendingShellQueuesRef,
    setExecutingActionId,
    setSessionNote,
    setCategorizedError: setAndAuditError,
    setInputDialog,
    resolveScopedSessionId,
    syncAskUserRequestForSession,
    handlePlanUpdate,
    continueAfterHitlIfNeeded,
    startShellJobForAction,
    markShellActionsFailed,
  });

  handleApproveActionThreadRef.current = handleApproveAction;
  handleRetryActionThreadRef.current = handleRetryAction;
  handleRejectActionThreadRef.current = handleRejectAction;
  handleCommentActionThreadRef.current = handleCommentAction;
  handleCancelActionThreadRef.current = handleCancelAction;
  handleApproveAllActionsThreadRef.current = handleApproveAllActions;
  handleRejectAllActionsThreadRef.current = handleRejectAllActions;
  handleSuggestionClickThreadRef.current = handleSuggestionClick;

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

  const {
    expandedPlanMessageId,
    expandedPlanActionId,
    expandedPlanRequestKey,
    askUserAnchorMessageId,
    restoreAnchorMessageId,
    topbarState,
    handleTopbarAction,
  } = useConversationTopbar({
    assistantDisplayName,
    activeConversationIdentity,
    messages,
    visibleMessages,
    lastVisibleMessage,
    activePlan,
    isStreaming,
    liveToolCalls,
    hasAskUserPending,
    hasRestoreNotice,
    sessionNote,
    threadRef,
    contextAnchorRef,
  });

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
                      setAndAuditError(null);
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
                  setAndAuditError(null);
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
