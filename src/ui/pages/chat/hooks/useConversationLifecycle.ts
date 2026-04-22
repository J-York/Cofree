import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ChatAgentDefinition } from "../../../../agents/types";
import type { ChatMessageRecord } from "../../../../lib/chatHistoryStore";
import { clearChatHistory, loadChatHistory } from "../../../../lib/chatHistoryStore";
import type { ChatContextAttachment } from "../../../../lib/contextAttachments";
import type { CategorizedError } from "../../../../lib/errorClassifier";
import { migrateGlobalToWorkspace } from "../../../../lib/conversationMaintenance";
import {
  createConversation,
  deleteConversation,
  generateConversationTitle,
  getActiveConversationId,
  loadConversation,
  loadConversationList,
  migrateOldChatHistory,
  saveConversation,
  setActiveConversationId,
  updateConversationTitle,
  type Conversation,
  type ConversationMetadata,
} from "../../../../lib/conversationStore";
import {
  resolveManagedModelSelection,
  type AppSettings,
} from "../../../../lib/settingsStore";
import type { SessionActions } from "../../../../lib/sessionContext";
import { buildDraftConversationBindingUpdate } from "../conversationAgentDisplay";
import { resolveConversationDebugKey, type ConversationDebugEntry } from "../debugExport";
import {
  createBackgroundStreamState,
  createClearedConversation,
  createConversationViewState,
  createEmptyChatViewState,
  resetChatSessionState,
  resolvePreferredConversationId,
  type ChatViewState,
} from "../sessionState";
import {
  createConversationAgentBinding,
} from "../execution";
import type {
  BackgroundStreamState,
  LiveToolCall,
} from "../types";

interface UseConversationLifecycleOptions {
  wsPath: string;
  settings: AppSettings;
  activeAgent: ChatAgentDefinition;
  session: SessionActions;
  /** Live values (read at handler invocation time). */
  isStreaming: boolean;
  executingActionId: string;
  liveToolCalls: LiveToolCall[];
  categorizedError: CategorizedError | null;
  /** Streaming bookkeeping — abort on wsPath switch, delete on conversation delete. */
  abortControllerRef: MutableRefObject<AbortController | null>;
  abortControllersRef: MutableRefObject<Map<string, AbortController>>;
  backgroundStreamsRef: MutableRefObject<Map<string, BackgroundStreamState>>;
  /** Debug-log buffer — cleared on clearHistory / deleteConversation. */
  conversationDebugEntriesRef: MutableRefObject<Map<string, ConversationDebugEntry[]>>;
  /** Composer/side-effect setters the lifecycle handlers must coordinate. */
  setPrompt: Dispatch<SetStateAction<string>>;
  setComposerAttachments: Dispatch<SetStateAction<ChatContextAttachment[]>>;
  clearMentionUi: () => void;
  requestThreadScrollToBottom: () => void;
  /** Chat view-state setters — driven by `applyChatViewState`. */
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  setLiveToolCalls: Dispatch<SetStateAction<LiveToolCall[]>>;
  setCategorizedError: Dispatch<SetStateAction<CategorizedError | null>>;
}

/**
 * Owns the multi-conversation state (conversations list, active id, current,
 * messages) and the CRUD handlers (new/select/delete/rename/clear). Also owns
 * the workspace-switch useEffect and the save-on-messages useEffect.
 *
 * Extracted from ChatPage.tsx (B1.7.4, see docs/REFACTOR_PLAN.md). The hook
 * accepts a large options bag because the lifecycle handlers touch many
 * ChatPage-owned side-effect setters (live streaming state, composer, mentions,
 * thread scroll). Rather than fanning out coordination logic, we funnel it
 * all through one injection point.
 */
export function useConversationLifecycle(options: UseConversationLifecycleOptions) {
  const {
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
    setCategorizedError,
  } = options;

  const [conversations, setConversations] = useState<ConversationMetadata[]>(
    () => {
      migrateGlobalToWorkspace(wsPath);
      const list = loadConversationList(wsPath);
      if (list.length === 0 && wsPath) {
        createConversation(wsPath, []);
        return loadConversationList(wsPath);
      }
      return list;
    },
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
      const oldHistory = loadChatHistory();
      if (oldHistory.length > 0) {
        migrateOldChatHistory(wsPath, oldHistory);
        clearChatHistory();
        const newList = loadConversationList(wsPath);
        if (newList.length > 0) {
          return loadConversation(wsPath, newList[0].id);
        }
      }
      return null;
    });
  const [messages, setMessages] = useState<ChatMessageRecord[]>(
    currentConversation?.messages ?? [],
  );
  const [liveContextTokens, setLiveContextTokens] = useState<number | null>(
    () => currentConversation?.lastTokenCount ?? null,
  );
  const [sessionNote, setSessionNote] = useState<string>(
    currentConversation?.messages.length ? "已恢复历史会话" : "",
  );

  const messagesRef = useRef<ChatMessageRecord[]>(
    currentConversation?.messages ?? [],
  );
  const activeConversationIdRef = useRef<string | null>(activeConversationId);
  const skipNextTimestampRef = useRef(true);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  const applyChatViewState = (viewState: ChatViewState): void => {
    requestThreadScrollToBottom();
    setMessages(viewState.messages);
    messagesRef.current = viewState.messages;
    setLiveContextTokens(viewState.liveContextTokens);
    setIsStreaming(viewState.isStreaming);
    setSessionNote(viewState.sessionNote);
    setLiveToolCalls(viewState.liveToolCalls);
    setCategorizedError(viewState.categorizedError);
  };

  const activateConversation = (
    conversation: Conversation | null,
    activateOptions: {
      persistActiveId?: boolean;
      backgroundStream?: BackgroundStreamState;
      idleSessionNote?: string;
    } = {},
  ): void => {
    activeConversationIdRef.current = conversation?.id ?? null;
    setCurrentConversation(conversation);
    setActiveConversationIdState(conversation?.id ?? null);
    if (conversation && activateOptions.persistActiveId) {
      setActiveConversationId(wsPath, conversation.id);
    }
    applyChatViewState(
      conversation
        ? createConversationViewState({
            conversation,
            backgroundStream: activateOptions.backgroundStream,
            idleSessionNote: activateOptions.idleSessionNote,
          })
        : createEmptyChatViewState(activateOptions.idleSessionNote),
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

  const snapshotToBackground = (): void => {
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
    });
    if (backgroundStream) {
      backgroundStreamsRef.current.set(activeConversationId, backgroundStream);
    }
  };

  // Recover preferred conversation when current is null but list exists.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsPath, conversations, activeConversationId, currentConversation]);

  // Save on messages change (+ generate title for new conversations).
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, currentConversation?.id]);

  // Sync agentBinding when the user switches the global model via TitleBar.
  useEffect(() => {
    if (!currentConversation?.agentBinding) return;
    const { vendorId, modelId } = currentConversation.agentBinding;
    if (
      vendorId === settings.activeVendorId &&
      modelId === settings.activeModelId
    )
      return;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.activeModelId, settings.activeVendorId]);

  // Pre-bind draft conversation's agent when activeAgent/model change before any message.
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

  // React to workspace path changes: migrate, reload conversations, abort streams.
  const prevWsPathRef = useRef(wsPath);
  useEffect(() => {
    const leavingWorkspacePath = prevWsPathRef.current;
    if (leavingWorkspacePath === wsPath) return;
    prevWsPathRef.current = wsPath;

    const leavingConversationId = activeConversationIdRef.current;
    const leavingConv =
      leavingWorkspacePath && leavingConversationId
        ? loadConversation(leavingWorkspacePath, leavingConversationId)
        : null;

    for (const ctrl of abortControllersRef.current.values()) {
      ctrl.abort();
    }
    abortControllersRef.current.clear();
    backgroundStreamsRef.current.clear();
    abortControllerRef.current?.abort();

    migrateGlobalToWorkspace(wsPath);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsPath]);

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
    newTitle: string,
  ): void => {
    updateConversationTitle(wsPath, conversationId, newTitle);
    setConversations(loadConversationList(wsPath));

    if (conversationId === activeConversationId && currentConversation) {
      setCurrentConversation({
        ...currentConversation,
        title: newTitle,
      });
    }
  };

  return {
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
    setActiveConversationIdState,
    setCurrentConversation,
    setMessages,
    setLiveContextTokens,
    setSessionNote,
    applyChatViewState,
    activateConversation,
    takeBackgroundStream,
    snapshotToBackground,
    handleClearHistory,
    handleNewConversation,
    handleSelectConversation,
    handleDeleteConversation,
    handleRenameConversation,
  };
}
