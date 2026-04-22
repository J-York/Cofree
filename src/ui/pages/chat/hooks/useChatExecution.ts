import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ChatAgentDefinition } from "../../../../agents/types";
import type { ChatMessageRecord } from "../../../../lib/chatHistoryStore";
import {
  dedupeContextAttachments,
  type ChatContextAttachment,
} from "../../../../lib/contextAttachments";
import {
  loadConversation,
  loadConversationList,
  saveConversation,
  type Conversation,
  type ConversationMetadata,
} from "../../../../lib/conversationStore";
import { classifyError, type CategorizedError } from "../../../../lib/errorClassifier";
import type { AppSettings } from "../../../../lib/settingsStore";
import type { AskUserRequest } from "../../../../orchestrator/askUserService";
import { saveWorkflowCheckpoint } from "../../../../orchestrator/checkpointStore";
import {
  advanceAfterHitl,
  getHitlContinuationMemory,
  resetHitlContinuationMemory,
} from "../../../../orchestrator/hitlContinuationController";
import { type ToolReplayMessage } from "../../../../orchestrator/hitlContinuationMachine";
import {
  runPlanningSession,
  initializePlan,
  type ToolCallEvent,
} from "../../../../orchestrator/planningService";
import type { WorkingMemorySnapshot } from "../../../../orchestrator/workingMemory";
import type { OrchestrationPlan } from "../../../../orchestrator/types";
import type { SessionActions } from "../../../../lib/sessionContext";
import type { SkillEntry } from "../../../../lib/skillStore";
import {
  buildFailedLlmRequestLog,
  isLlmResponseFailureCategory,
  summarizeConversationHistoryForDebug,
  truncateDebugLogText,
} from "../chatPageHelpers";
import type { ConversationDebugEntry } from "../debugExport";
import {
  buildExecutionSettings,
  collectBlockedActionFingerprints,
  ensureConversationAgentBinding,
  type RunChatCycleOptions,
} from "../execution";
import {
  buildToolCallsFromPlan,
  createMessageId,
  deriveCarryForwardPlan,
  toConversationHistory,
} from "../helpers";
import type { BackgroundStreamState, LiveToolCall } from "../types";

interface UseChatExecutionOptions {
  wsPath: string;
  settings: AppSettings;
  activeAgent: ChatAgentDefinition;
  activeModelLabel: string;
  session: SessionActions;
  isStreaming: boolean;
  prompt: string;
  composerAttachments: ChatContextAttachment[];
  selectedSkills: SkillEntry[];
  currentConversation: Conversation | null;
  activeConversationId: string | null;
  activeConversationIdRef: MutableRefObject<string | null>;
  messagesRef: MutableRefObject<ChatMessageRecord[]>;
  abortControllerRef: MutableRefObject<AbortController | null>;
  abortControllersRef: MutableRefObject<Map<string, AbortController>>;
  backgroundStreamsRef: MutableRefObject<Map<string, BackgroundStreamState>>;
  workingMemoryBySessionRef: MutableRefObject<
    Map<string, WorkingMemorySnapshot | null>
  >;
  lastPromptRef: MutableRefObject<string>;
  lastContextAttachmentsRef: MutableRefObject<ChatContextAttachment[]>;
  skipNextTimestampRef: MutableRefObject<boolean>;
  setMessages: Dispatch<SetStateAction<ChatMessageRecord[]>>;
  setCurrentConversation: Dispatch<SetStateAction<Conversation | null>>;
  setConversations: Dispatch<SetStateAction<ConversationMetadata[]>>;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  setSessionNote: Dispatch<SetStateAction<string>>;
  setCategorizedError: Dispatch<SetStateAction<CategorizedError | null>>;
  setLiveContextTokens: Dispatch<SetStateAction<number | null>>;
  setLiveToolCalls: Dispatch<SetStateAction<LiveToolCall[]>>;
  setPrompt: Dispatch<SetStateAction<string>>;
  setComposerAttachments: Dispatch<SetStateAction<ChatContextAttachment[]>>;
  setSelectedSkills: Dispatch<SetStateAction<SkillEntry[]>>;
  setFailedLlmRequestLog: Dispatch<SetStateAction<string | null>>;
  appendConversationDebugEntry: (
    conversationId: string | null | undefined,
    entry: ConversationDebugEntry,
  ) => void;
  appendAssistantStatusMessage: (content: string) => void;
  resolveScopedSessionId: (
    conversation?: Conversation | null,
    agentId?: string | null,
  ) => string;
  syncAskUserRequestForSession: (sessionId: string) => void;
  requestThreadScrollToBottom: () => void;
  clearMentionUi: () => void;
  syncActiveMention: (nextText: string, caretIndex?: number) => void;
  getLatestUserContextAttachments: () => ChatContextAttachment[];
  buildSubmittedPrompt: (
    prompt: string,
    attachments: ChatContextAttachment[],
    hasSkills: boolean,
  ) => string;
}

/**
 * Core chat execution chain — `runChatCycle`, `handleSubmit`, `handleCancel`,
 * `handlePlanUpdate`, `continueAfterHitlIfNeeded`. Extracted from ChatPage.tsx
 * (B1.7.6d, see docs/REFACTOR_PLAN.md).
 *
 * All state is passed in via options; the hook itself owns no state. That
 * keeps the refs-and-closures semantics identical to the prior inline code.
 */
export function useChatExecution(options: UseChatExecutionOptions) {
  const {
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
    setCategorizedError,
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
  } = options;

  const handleCancel = (): void => {
    if (activeConversationId) {
      abortControllersRef.current.get(activeConversationId)?.abort();
    }
  };

  const continueAfterHitlIfNeeded = (
    messageId: string,
    plan: OrchestrationPlan,
  ): void => {
    const targetMessage = messagesRef.current.find((m) => m.id === messageId);
    const currentTrace = targetMessage?.toolTrace ?? [];
    const sessionId = resolveScopedSessionId(
      currentConversation,
      targetMessage?.agentId,
    );

    void advanceAfterHitl({
      sessionId,
      messageId,
      plan,
      toolTrace: currentTrace,
      workingMemorySnapshot:
        workingMemoryBySessionRef.current.get(sessionId) ?? undefined,
    })
      .then((decision) => {
        if (decision.kind === "stop") {
          setSessionNote(decision.reason);
          appendAssistantStatusMessage(`自动续跑已停止：${decision.reason}`);
          return;
        }

        setSessionNote("审批结果已同步，正在继续完成剩余任务…");

        const toolMessages: ChatMessageRecord[] = decision.toolReplayMessages.map(
          (tool: ToolReplayMessage) => ({
            id: createMessageId("tool"),
            role: "tool",
            content: tool.content,
            createdAt: new Date().toISOString(),
            plan: null,
            tool_call_id: tool.tool_call_id,
            name: tool.name,
          }),
        );

        setMessages((prev) => {
          const next = [...prev, ...toolMessages];
          messagesRef.current = next;
          return next;
        });

        setTimeout(() => {
          void runChatCycle(decision.prompt, {
            visibleUserMessage: false,
            isContinuation: true,
            internalSystemNote: decision.internalSystemNote,
            existingPlan: plan,
          }).catch((error) => {
            const message = error instanceof Error ? error.message : "未知错误";
            setCategorizedError(classifyError(error));
            setSessionNote(`自动续跑失败：${message}`);
            appendAssistantStatusMessage(`自动续跑失败：${message}`);
          });
        }, 100);
      })
      .catch((err) => {
        setSessionNote(
          `续跑状态机失败：${err instanceof Error ? err.message : "未知错误"}`,
        );
        appendAssistantStatusMessage(
          `续跑状态机失败：${err instanceof Error ? err.message : "未知错误"}`,
        );
      });
  };

  const runChatCycle = async (
    promptText: string,
    runOptions: RunChatCycleOptions & { isContinuation?: boolean } = {},
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

    const visibleUserMessage = runOptions.visibleUserMessage !== false;
    const contextAttachments = dedupeContextAttachments(
      runOptions.contextAttachments ??
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
      explicitPlan: runOptions.existingPlan,
      isContinuation: runOptions.isContinuation === true,
    });
    const assistantMessageId = createMessageId("assistant");
    const now = new Date().toISOString();
    const chatSessionId = resolveScopedSessionId(
      conversationForRun,
      convBinding?.agentId ?? activeAgent.id,
    );
    if (visibleUserMessage && !existingPlanForRun && runOptions.isContinuation !== true) {
      resetHitlContinuationMemory(chatSessionId);
      workingMemoryBySessionRef.current.delete(chatSessionId);
    }
    const restoredWorkingMemory =
      existingPlanForRun || runOptions.isContinuation
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
      updater: (prev: ChatMessageRecord[]) => ChatMessageRecord[],
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
      updater: LiveToolCall[] | ((prev: LiveToolCall[]) => LiveToolCall[]),
    ) => {
      if (isActive()) {
        setLiveToolCalls(
          updater as LiveToolCall[] | ((prev: LiveToolCall[]) => LiveToolCall[]),
        );
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
          phase: runOptions.phase ?? "default",
          isContinuation: runOptions.isContinuation === true,
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
        phase: runOptions.phase,
        conversationHistory,
        contextAttachments,
        isContinuation: runOptions.isContinuation,
        internalSystemNote: runOptions.internalSystemNote,
        existingPlan: existingPlanForRun,
        blockedActionFingerprints: visibleUserMessage
          ? []
          : messagesRef.current.flatMap((message) =>
              message.plan ? collectBlockedActionFingerprints(message.plan) : [],
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
                    : m,
                ),
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
                    : call,
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
                  : call,
              ),
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
              `增量 checkpoint 未保存：${err instanceof Error ? err.message : "未知错误"}`,
            ),
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
                    planState,
                  ),
                };
              }
              return m;
            }),
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
        }),
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
              : "done",
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
          `审批点未保存：${err instanceof Error ? err.message : "未知错误"}`,
        ),
      );

      guardedSetNote(
        result.plan.state === "human_review"
          ? "已进入 HITL 审批阶段，请逐项审批"
          : result.plan.steps.some(
                (step) => step.status !== "completed" && step.status !== "skipped",
              )
            ? "todo 已更新"
            : "回复完成",
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
            (m) => m.id !== assistantMessageId || m.content.trim() !== "",
          ),
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
            isContinuation: runOptions.isContinuation === true,
            phase: runOptions.phase,
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
          (m) => m.id !== assistantMessageId || m.content.trim() !== "",
        ),
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

  const handleSubmit = async (): Promise<void> => {
    const attachments = dedupeContextAttachments(composerAttachments);
    const text = buildSubmittedPrompt(
      prompt,
      attachments,
      selectedSkills.length > 0,
    );
    if (
      (!text && attachments.length === 0 && selectedSkills.length === 0) ||
      isStreaming
    )
      return;

    const previousPrompt = prompt;
    const previousAttachments = composerAttachments;
    const previousSkills = selectedSkills;
    const explicitSkillIds =
      selectedSkills.length > 0
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
    planOptions?: { persist?: boolean },
  ): void => {
    const targetMessage = messagesRef.current.find((m) => m.id === messageId);
    if (!targetMessage || !targetMessage.plan) return;

    const updatedPlan = updater(targetMessage.plan);
    const currentTrace = targetMessage.toolTrace ?? [];

    setMessages((prev) => {
      const next = prev.map((m) => {
        if (m.id !== messageId || !m.plan) return m;
        return { ...m, plan: updater(m.plan) };
      });
      messagesRef.current = next;
      return next;
    });

    if (planOptions?.persist !== false) {
      const sessionId = resolveScopedSessionId(
        currentConversation,
        targetMessage.agentId,
      );
      void saveWorkflowCheckpoint(
        sessionId,
        messageId,
        updatedPlan,
        currentTrace,
        getHitlContinuationMemory(sessionId),
        workingMemoryBySessionRef.current.get(sessionId) ?? undefined,
      ).catch((err) =>
        setSessionNote(
          `审批点未保存：${err instanceof Error ? err.message : "未知错误"}`,
        ),
      );
    }
  };

  return {
    handleCancel,
    continueAfterHitlIfNeeded,
    runChatCycle,
    handleSubmit,
    handlePlanUpdate,
  };
}
