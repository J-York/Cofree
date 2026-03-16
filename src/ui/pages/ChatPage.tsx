import { type ReactElement, useEffect, useRef, useState } from "react";
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
import { loadCofreeRc } from "../../lib/cofreerc";
import {
  addWorkspaceApprovalRule,
  type ApprovalRuleOption,
} from "../../lib/approvalRuleStore";
import {
  dedupeContextAttachments,
  type ChatContextAttachment,
} from "../../lib/contextAttachments";
import { ConversationSidebar } from "../components/ConversationSidebar";
import { IconTrash } from "../components/Icons";
import { getActiveManagedModel, isActiveModelLocal, resolveManagedModelSelection } from "../../lib/settingsStore";
import type { AppSettings } from "../../lib/settingsStore";
import {
  cancelShellCommand,
  fetchUrl,
  gitStatusWorkspace,
  globWorkspaceFiles,
  listWorkspaceFiles,
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
import { submitUserResponse, cancelPendingRequest } from "../../orchestrator/askUserService";
import {
  readLLMAuditRecords,
  readSensitiveActionAuditRecords,
} from "../../lib/auditLog";
import {
  formatTime,
} from "../utils/chatUtils";
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
  getChatSessionId,
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
import type {
  OrchestrationPlan,
  SubAgentProgressEvent,
} from "../../orchestrator/types";
import { useSession } from "../../lib/sessionContext";
import {
  createMessageId,
  buildToolCallsFromPlan,
  deriveCarryForwardPlan,
  toConversationHistory,
  type ConversationHistoryMessage,
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
import {
  MessageContent,
  LiveToolStatus,
  AssistantToolCalls,
  ContextAttachmentPills,
  SubAgentStatusPanel,
  ToolTracePanel,
  InlinePlan,
  TokenUsageRing,
} from "./chat/ChatPresentational";
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
  buildGitModifiedSuggestions,
  buildMentionSearchPattern,
  buildRecentAttachmentSuggestions,
  buildRootDirectorySuggestions,
  buildSubmittedPrompt,
  createAttachmentFromSuggestion,
  findActiveMention,
  rankMentionSuggestions,
  type ActiveMention,
  type MentionRankingSignals,
  type MentionSuggestion,
} from "./chat/mentions";
import type { BackgroundStreamState, LiveToolCall, SubAgentStatusItem } from "./chat/types";
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
  type ShellExecutionMode,
} from "../../lib/shellCommand";

interface ChatPageProps {
  settings: AppSettings;
  activeAgent: ChatAgentDefinition;
  isVisible?: boolean;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

interface RunningShellJobMeta {
  messageId: string;
  actionId: string;
  workspacePath: string;
  executionMode: ShellExecutionMode;
  readyUrl?: string;
  readyTimeoutMs?: number;
  approvalContext?: ManualApprovalContext;
  detached?: boolean;
}

interface PendingShellQueue {
  messageId: string;
  actionIds: string[];
}

interface ShellOutputBuffer {
  command: string;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  timerId: ReturnType<typeof setTimeout> | null;
}

const DEBUG_LOG_MAX_CONTENT_CHARS = 2000;
const DEBUG_LOG_HISTORY_LIMIT = 18;
const DEBUG_EXPORT_HISTORY_LIMIT = 200;
const shellOutputTextEncoder = new TextEncoder();

function truncateDebugLogText(text: string, maxChars = DEBUG_LOG_MAX_CONTENT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function measureShellChunkBytes(text: string): number {
  return shellOutputTextEncoder.encode(text).length;
}

function isLlmResponseFailureCategory(category: CategorizedError["category"]): boolean {
  return (
    category === "llm_failure" ||
    category === "network_timeout" ||
    category === "auth_error"
  );
}

function summarizeConversationHistoryForDebug(
  history: ConversationHistoryMessage[],
): Array<Record<string, unknown>> {
  const recent = history.slice(-DEBUG_LOG_HISTORY_LIMIT);
  const baseIndex = history.length - recent.length;
  return recent.map((message, index) => ({
    index: baseIndex + index + 1,
    role: message.role,
    name: message.name ?? null,
    tool_call_id: message.tool_call_id ?? null,
    tool_calls:
      message.tool_calls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
      })) ?? [],
    content_preview: truncateDebugLogText(message.content, 1200),
  }));
}

function buildFailedLlmRequestLog(params: {
  prompt: string;
  conversationHistory: ConversationHistoryMessage[];
  contextAttachments: ChatContextAttachment[];
  executionSettings: AppSettings;
  activeAgentId: string;
  boundAgentId?: string;
  sessionId: string;
  conversationId: string | null;
  startedAt: string;
  isContinuation: boolean;
  phase?: string;
  error: CategorizedError;
}): string {
  const payload = {
    generatedAt: new Date().toISOString(),
    startedAt: params.startedAt,
    session: {
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      workspacePath: params.executionSettings.workspacePath,
      isContinuation: params.isContinuation,
      phase: params.phase ?? "default",
    },
    agent: {
      activeAgentId: params.activeAgentId,
      boundAgentId: params.boundAgentId ?? null,
    },
    model: {
      provider: params.executionSettings.provider ?? null,
      model: params.executionSettings.model,
      baseUrl: params.executionSettings.liteLLMBaseUrl,
      vendorId: params.executionSettings.activeVendorId,
      modelId: params.executionSettings.activeModelId,
    },
    request: {
      prompt: truncateDebugLogText(params.prompt),
      contextAttachments: params.contextAttachments.map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        relativePath: attachment.relativePath,
      })),
      historyMessageCount: params.conversationHistory.length,
      historyPreview: summarizeConversationHistoryForDebug(
        params.conversationHistory,
      ),
    },
    error: {
      category: params.error.category,
      title: params.error.title,
      message: params.error.message,
      guidance: params.error.guidance,
      rawError: params.error.rawError ?? null,
    },
  };

  return JSON.stringify(payload, null, 2);
}

function waitForDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/* ── Main ChatPage ────────────────────────────────────────── */
export function ChatPage({ settings, activeAgent, isVisible, sidebarCollapsed, onToggleSidebar }: ChatPageProps): ReactElement {
  const { actions: session, state: sessionState } = useSession();

  const wsPath = settings.workspacePath;

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
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<MentionSuggestion[]>([]);
  const [mentionSelectionIndex, setMentionSelectionIndex] = useState(0);
  const [mentionIgnorePatterns, setMentionIgnorePatterns] = useState<string[]>([]);
  const [rootDirectorySuggestions, setRootDirectorySuggestions] = useState<MentionSuggestion[]>([]);
  const [gitMentionSuggestions, setGitMentionSuggestions] = useState<MentionSuggestion[]>([]);
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
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [executingActionId, setExecutingActionId] = useState<string>("");
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
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessageRecord[]>(
    currentConversation?.messages ?? []
  );
  const lastPromptRef = useRef<string>("");
  const lastContextAttachmentsRef = useRef<ChatContextAttachment[]>([]);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const prevIsStreamingRef = useRef<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const activeConversationIdRef = useRef<string | null>(activeConversationId);
  const backgroundStreamsRef = useRef(new Map<string, BackgroundStreamState>());
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const skipNextTimestampRef = useRef(true);
  const runningShellJobsRef = useRef(new Map<string, RunningShellJobMeta>());
  const pendingShellQueuesRef = useRef(new Map<string, PendingShellQueue>());
  const shellOutputBuffersRef = useRef(new Map<string, ShellOutputBuffer>());

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

  const activeManagedModel = getActiveManagedModel(settings);
  const activeModelLabel = activeManagedModel?.name || settings.model;
  const localOnlyBlocked =
    !settings.allowCloudModels && !isActiveModelLocal(settings);
  const noWorkspaceSelected = !settings.workspacePath;
  const chatBlocked = localOnlyBlocked || noWorkspaceSelected;

  const handleCopyFailedRequestLog = async (): Promise<void> => {
    if (!failedLlmRequestLog) {
      return;
    }
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("当前环境不支持剪贴板写入");
      }
      await navigator.clipboard.writeText(failedLlmRequestLog);
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
    const chatSessionId = getChatSessionId();
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

  const applyChatViewState = (viewState: ChatViewState): void => {
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

  // React to workspace path changes: migrate, reload conversations
  const prevWsPathRef = useRef(wsPath);
  useEffect(() => {
    if (prevWsPathRef.current === wsPath) return;
    prevWsPathRef.current = wsPath;

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

    // Reset session state
    resetChatSessionState();
    session.resetSession();
    setPrompt("");
    setComposerAttachments([]);
    clearMentionUi();
  }, [wsPath]);

  useEffect(() => {
    let cancelled = false;

    if (!wsPath) {
      setMentionIgnorePatterns([]);
      setRootDirectorySuggestions([]);
      setGitMentionSuggestions([]);
      return () => {
        cancelled = true;
      };
    }

    void loadCofreeRc(wsPath)
      .then(async (config) => {
        const ignorePatterns = config.ignorePatterns ?? [];
        const [rootEntries, gitStatus] = await Promise.all([
          listWorkspaceFiles({
            workspacePath: wsPath,
            relativePath: "",
            ignorePatterns,
          }).catch(() => []),
          gitStatusWorkspace(wsPath).catch(() => ({
            modified: [],
            added: [],
            deleted: [],
            untracked: [],
          })),
        ]);
        if (!cancelled) {
          setMentionIgnorePatterns(ignorePatterns);
          setRootDirectorySuggestions(buildRootDirectorySuggestions(rootEntries));
          setGitMentionSuggestions(
            buildGitModifiedSuggestions([
              ...gitStatus.modified,
              ...gitStatus.added,
              ...gitStatus.untracked,
            ]),
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMentionIgnorePatterns([]);
          setRootDirectorySuggestions([]);
          setGitMentionSuggestions([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [wsPath]);

  useEffect(
    () => () => {
      for (const ctrl of abortControllersRef.current.values()) {
        ctrl.abort();
      }
    },
    []
  );

  useEffect(() => {
    const justFinished = prevIsStreamingRef.current && !isStreaming;
    prevIsStreamingRef.current = isStreaming;

    if (justFinished && threadRef.current) {
      // Streaming just ended — scroll back to the bottom of the last assistant message
      // so the user sees the response text which is now correctly at the bottom.
      const bubbles =
        threadRef.current.querySelectorAll<HTMLElement>(".chat-bubble.assistant");
      const lastBubble = bubbles[bubbles.length - 1];
      if (lastBubble) {
        lastBubble.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
    }
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages, isStreaming]);

  useEffect(() => {
    if (isVisible && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [isVisible]);

  /* Auto-resize textarea */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [prompt]);

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
      const defaults = buildDefaultMentionSuggestions({
        recentSuggestions,
        gitSuggestions: gitMentionSuggestions,
        rootDirectorySuggestions,
        signals: rankingSignals,
      }).filter(
        (entry) =>
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
          const suggestions = rankMentionSuggestions(
            mention.query,
            [
              ...fileSuggestions,
              ...folderSuggestions,
              ...rootDirectorySuggestions,
              ...recentSuggestions,
              ...gitMentionSuggestions,
            ],
            rankingSignals,
          ).filter(
            (entry) =>
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
    composerAttachments,
    gitMentionSuggestions,
    mentionIgnorePatterns,
    rootDirectorySuggestions,
    wsPath,
  ]);

  /* Restore checkpoint */
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      try {
        const sessionId = getChatSessionId();
        const latest = await loadLatestWorkflowCheckpoint(sessionId);
        if (!latest || cancelled) return;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === latest.messageId);
          if (idx >= 0) {
            return prev.map((m, i) =>
              i === idx
                ? {
                  ...m,
                  plan: latest.payload.plan,
                  toolTrace: latest.payload.toolTrace ?? m.toolTrace,
                  tool_calls: buildToolCallsFromPlan(latest.payload.plan),
                }
                : m
            );
          }
          const recovered: ChatMessageRecord = {
            id: latest.messageId,
            role: "assistant",
            content: "已从审批点恢复上一轮工作流状态。",
            createdAt: new Date().toISOString(),
            plan: latest.payload.plan,
            toolTrace: latest.payload.toolTrace ?? [],
            tool_calls: buildToolCallsFromPlan(latest.payload.plan),
          };
          return [...prev, recovered].slice(-80);
        });
        hydrateHitlContinuationMemory(
          getChatSessionId(),
          latest.payload.continuationMemory
        );
        setSessionNote("已从 checkpoint 恢复审批状态");
      } catch {
        /* non-fatal */
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const continueAfterHitlIfNeeded = (
    messageId: string,
    plan: OrchestrationPlan
  ): void => {
    const currentTrace =
      messagesRef.current.find((m) => m.id === messageId)?.toolTrace ?? [];

    void advanceAfterHitl({
      sessionId: getChatSessionId(),
      messageId,
      plan,
      toolTrace: currentTrace,
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
    if (visibleUserMessage) {
      resetHitlContinuationMemory(getChatSessionId());
    }
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
    const chatSessionId = getChatSessionId();
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
    const guardedSetSubAgentStatus = (
      updater: (prev: SubAgentStatusItem[]) => SubAgentStatusItem[],
    ) => {
      if (isActive()) {
        setSubAgentStatus(updater);
      } else {
        const bg = backgroundStreamsRef.current.get(streamConvId);
        if (bg) bg.subAgentStatus = updater(bg.subAgentStatus);
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
    guardedSetSubAgentStatus(() => []);
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
        onSubAgentProgress: (role: string, event: SubAgentProgressEvent) => {
          guardedSetSubAgentStatus((prev) => {
            const existing = prev.find((status) => status.role === role);
            if (existing) {
              return prev.map((status) =>
                status.role === role
                  ? { ...status, lastEvent: event, updatedAt: Date.now() }
                  : status
              );
            }
            return [...prev, { role, lastEvent: event, updatedAt: Date.now() }];
          });
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
          setAskUserRequest(request);
        },
      });

      if (localRafId !== null) {
        cancelAnimationFrame(localRafId);
        localRafId = null;
      }
      localStreamBuffer = "";

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
        getHitlContinuationMemory(chatSessionId)
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

    const attachment = createAttachmentFromSuggestion(suggestion);
    const { nextText, nextCaret } = applyMentionSuggestion(prompt, activeMention);

    setComposerAttachments((prev) =>
      dedupeContextAttachments([...prev, attachment]),
    );
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

  const handleSubmit = async (): Promise<void> => {
    const attachments = dedupeContextAttachments(composerAttachments);
    const text = buildSubmittedPrompt(prompt, attachments);
    if ((!text && attachments.length === 0) || isStreaming) return;

    const previousPrompt = prompt;
    const previousAttachments = composerAttachments;
    setPrompt("");
    setComposerAttachments([]);
    clearMentionUi();

    try {
      await runChatCycle(text, {
        contextAttachments: attachments,
      });
    } catch (error) {
      setPrompt(previousPrompt);
      setComposerAttachments(previousAttachments);
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
      void saveWorkflowCheckpoint(
        getChatSessionId(),
        messageId,
        updatedPlan,
        currentTrace,
        getHitlContinuationMemory(getChatSessionId())
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

  const handleApproveAction = async (
    messageId: string,
    actionId: string,
    plan: OrchestrationPlan,
    rememberOption?: ApprovalRuleOption,
  ): Promise<void> => {
    if (executingActionId) return;
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
      let approvalContext: ManualApprovalContext | undefined;
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
    plan: OrchestrationPlan
  ): Promise<void> => {
    if (executingActionId) return;
    const pendingActions = plan.proposedActions.filter(
      (action) => action.status === "pending",
    );
    if (pendingActions.length === 1 && pendingActions[0]?.type === "shell") {
      await handleApproveAction(messageId, pendingActions[0].id, plan);
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

    resetChatSessionState();
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

    resetChatSessionState();
    session.resetSession();
  };

  const handleSelectConversation = (conversationId: string): void => {
    if (Boolean(executingActionId)) return;
    if (conversationId === activeConversationId) return;

    snapshotToBackground();

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

    resetChatSessionState();
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

    deleteConversation(wsPath, conversationId);
    const updatedList = loadConversationList(wsPath);
    setConversations(updatedList);

    if (wasActiveConversation) {
      if (updatedList.length > 0) {
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

          resetChatSessionState();
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
          {/* ── Floating sidebar toggle ── */}
          <button
            className="chat-sidebar-fab"
            onClick={onToggleSidebar}
            type="button"
            aria-label="对话列表 (⌘B)"
            title="对话列表 (⌘B)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="2" width="12" height="12" rx="1" stroke="currentColor" strokeWidth="1.4" />
              <path d="M6 2v12" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>

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
          <div className="chat-thread" ref={threadRef}>
            {messages.length === 0 ? (
              <div className="chat-empty">
                <p className="chat-empty-text">你好，我是{activeAgent.name}</p>
                <p className="chat-empty-subtext">{activeAgent.description}</p>
                <div className="chat-suggestions">
                  <button className="chat-suggestion-chip" onClick={() => handleSuggestionClick("帮我分析一下这个项目的代码结构")} type="button">
                    分析代码结构
                  </button>
                  <button className="chat-suggestion-chip" onClick={() => handleSuggestionClick("帮我查找并修复代码中的问题")} type="button">
                    查找问题
                  </button>
                  <button className="chat-suggestion-chip" onClick={() => handleSuggestionClick("帮我写一个新功能")} type="button">
                    新功能开发
                  </button>
                  <button className="chat-suggestion-chip" onClick={() => handleSuggestionClick("帮我优化这个项目的性能")} type="button">
                    性能优化
                  </button>
                </div>
              </div>
            ) : (
              messages
                .filter((message) => message.role !== "tool")
                .map((message) => (
                  <div key={message.id} className={`chat-row ${message.role}`}>
                    <div className={`chat-avatar ${message.role}`}>
                      {message.role === "user" ? "U" : (currentConversation?.agentBinding?.agentNameSnapshot ?? activeAgent.name).charAt(0)}
                    </div>
                    <div className="chat-bubble-wrap">
                      <p className="chat-meta">
                        {message.role === "user" ? "你" : (currentConversation?.agentBinding?.agentNameSnapshot ?? activeAgent.name)}
                        {formatTime(message.createdAt)
                          ? ` · ${formatTime(message.createdAt)}`
                          : ""}
                      </p>
                      {message.role === "assistant" && settings.debugMode && (
                        <AssistantToolCalls toolCalls={message.tool_calls} />
                      )}
                      {message.role === "assistant" &&
                        isStreaming &&
                        message === messages[messages.length - 1] &&
                        liveToolCalls.length > 0 && (
                          <LiveToolStatus calls={liveToolCalls} />
                        )}
                      {message.role === "assistant" &&
                        isStreaming &&
                        message === messages[messages.length - 1] &&
                        subAgentStatus.length > 0 && (
                          <SubAgentStatusPanel items={subAgentStatus} />
                        )}
                      {message.role === "assistant" &&
                        (message.toolTrace?.length ?? 0) > 0 && (
                          <ToolTracePanel traces={message.toolTrace!} />
                        )}
                      {message.plan &&
                        (message.plan.proposedActions.length > 0 ||
                          message.plan.steps.length > 0) && (
                          (() => {
                            const activeShellActionIds = Array.from(
                              runningShellJobsRef.current.values(),
                            )
                              .filter((meta) => meta.messageId === message.id)
                              .map((meta) => meta.actionId);
                            return (
                              <InlinePlan
                                plan={message.plan}
                                messageId={message.id}
                                executingActionId={executingActionId}
                                activeShellActionIds={activeShellActionIds}
                                onPlanUpdate={handlePlanUpdate}
                                onApprove={handleApproveAction}
                                onRetry={handleRetryAction}
                                onReject={handleRejectAction}
                                onComment={handleCommentAction}
                                onCancel={handleCancelAction}
                                onApproveAll={handleApproveAllActions}
                                onRejectAll={handleRejectAllActions}
                              />
                            );
                          })()
                        )}
                      <div className={`chat-bubble ${message.role}`}>
                        {message.role === "user" && (
                          <ContextAttachmentPills
                            attachments={message.contextAttachments ?? []}
                            compact
                          />
                        )}
                        <MessageContent
                          content={message.content}
                          isStreaming={
                            isStreaming &&
                            message.content === "" &&
                            message.role === "assistant"
                          }
                          role={message.role}
                        />
                      </div>
                    </div>
                  </div>
                ))
            )}
          </div>

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
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSubmit();
              }}
            >
              <div className="chat-input-box">
                <ContextAttachmentPills
                  attachments={composerAttachments}
                  onRemove={handleRemoveComposerAttachment}
                />
                {activeMention && mentionSuggestions.length > 0 && (
                  <div className="chat-mention-menu" role="listbox" aria-label="@ 文件候选">
                    {mentionSuggestions.map((suggestion, index) => (
                      <button
                        key={suggestion.relativePath}
                        type="button"
                        className={`chat-mention-item${index === mentionSelectionIndex ? " active" : ""}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handleMentionSuggestionSelect(suggestion);
                        }}
                      >
                        <span className="chat-mention-item-name">
                          {suggestion.displayName}
                          {suggestion.kind === "folder" ? "/" : ""}
                        </span>
                        <span className="chat-mention-item-path">
                          {suggestion.kind === "folder" ? "目录" : "文件"} · {suggestion.relativePath}
                          {suggestion.kind === "folder" ? "/" : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  ref={textareaRef}
                  className="chat-textarea"
                  value={prompt}
                  disabled={chatBlocked}
                  onChange={(e) => {
                    const nextText = e.target.value;
                    setPrompt(nextText);
                    syncActiveMention(nextText, e.target.selectionStart ?? nextText.length);
                  }}
                  onKeyDown={(e) => {
                    if (activeMention && mentionSuggestions.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setMentionSelectionIndex((prev) =>
                          Math.min(prev + 1, mentionSuggestions.length - 1),
                        );
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setMentionSelectionIndex((prev) => Math.max(prev - 1, 0));
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        clearMentionUi();
                        return;
                      }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleMentionSuggestionSelect(
                          mentionSuggestions[mentionSelectionIndex] ?? mentionSuggestions[0],
                        );
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSubmit();
                    }
                  }}
                  onClick={(e) =>
                    syncActiveMention(
                      e.currentTarget.value,
                      e.currentTarget.selectionStart ?? e.currentTarget.value.length,
                    )
                  }
                  onKeyUp={(e) =>
                    syncActiveMention(
                      e.currentTarget.value,
                      e.currentTarget.selectionStart ?? e.currentTarget.value.length,
                    )
                  }
                  placeholder={
                    chatBlocked
                      ? "请先完成设置…"
                      : "描述你的编码任务…  输入 @ 搜索文件或目录，Enter 发送，Shift+Enter 换行"
                  }
                  rows={1}
                />
                <div className="chat-input-footer">
                  <div className="chat-input-meta">
                    {liveContextTokens !== null && (
                      <TokenUsageRing
                        used={liveContextTokens}
                        max={settings.maxContextTokens > 0 ? settings.maxContextTokens : 128000}
                        isStreaming={isStreaming}
                      />
                    )}
                    <button
                      className="btn btn-ghost"
                      style={{
                        padding: "4px",
                        height: "22px",
                        width: "22px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center"
                      }}
                      disabled={
                        isStreaming ||
                        Boolean(executingActionId) ||
                        messages.length === 0
                      }
                      onClick={handleClearHistory}
                      type="button"
                      title="清空当前对话"
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                  <div className="chat-input-actions">
                    {settings.debugMode && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={
                          isExportingDebugBundle ||
                          (!currentConversation && messages.length === 0)
                        }
                        onClick={() => {
                          void handleDownloadConversationDebugBundle();
                        }}
                        type="button"
                      >
                        {isExportingDebugBundle ? "导出中…" : "下载日志"}
                      </button>
                    )}
                    {isStreaming && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={handleCancel}
                        type="button"
                      >
                        停止
                      </button>
                    )}
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={
                        isStreaming ||
                        Boolean(executingActionId) ||
                        (!prompt.trim() && composerAttachments.length === 0) ||
                        chatBlocked
                      }
                      type="submit"
                    >
                      发送
                    </button>
                  </div>
                </div>
              </div>
            </form>
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
          const targetSessionId = askUserRequest.sessionId ?? getChatSessionId();
          submitUserResponse(targetSessionId, askUserRequest.id, response, skipped);
          setAskUserRequest(null);
        }}
        onCancel={() => {
          if (!askUserRequest) return;
          const targetSessionId = askUserRequest.sessionId ?? getChatSessionId();
          cancelPendingRequest(targetSessionId);
          setAskUserRequest(null);
        }}
      />
    </div>
  );
}
