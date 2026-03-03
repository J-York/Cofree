import { type ReactElement, useEffect, useRef, useState } from "react";
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
  migrateGlobalToWorkspace,
  type ConversationMetadata,
  type Conversation,
} from "../../lib/conversationStore";
import { ConversationSidebar } from "../components/ConversationSidebar";
import { isLocalProvider } from "../../lib/litellm";
import type { AppSettings } from "../../lib/settingsStore";
import {
  classifyError,
  type CategorizedError,
} from "../../lib/errorClassifier";
import { ErrorBanner } from "../components/ErrorBanner";
import { ShellResultDisplay } from "../components/ShellResultDisplay";
import { DiffViewer } from "../components/DiffViewer";
import {
  formatTime,
  actionStatusBadgeClass,
  canApproveAction,
  canReviewAction,
} from "../utils/chatUtils";
import {
  approveAction,
  approveAllPendingActions,
  commentAction,
  markActionRunning,
  rejectAction,
  rejectAllPendingActions,
  updateActionPayload,
} from "../../orchestrator/hitlService";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getChatSessionId,
  loadLatestWorkflowCheckpoint,
  resetChatSessionId,
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
  actionFingerprint,
  type PlanningSessionPhase,
  type ToolExecutionTrace,
} from "../../orchestrator/planningService";
import type {
  ActionProposal,
  OrchestrationPlan,
} from "../../orchestrator/types";
import { useSession } from "../../lib/sessionContext";

interface ChatPageProps {
  settings: AppSettings;
}

interface RunChatCycleOptions {
  visibleUserMessage?: boolean;
  internalSystemNote?: string;
  phase?: PlanningSessionPhase;
}

function createMessageId(role: "user" | "assistant" | "tool"): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${role}-${crypto.randomUUID()}`;
  }
  return `${role}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function buildToolCallsFromPlan(
  plan: OrchestrationPlan | null
): any[] | undefined {
  if (
    !plan ||
    !Array.isArray(plan.proposedActions) ||
    plan.proposedActions.length === 0
  ) {
    return undefined;
  }

  return plan.proposedActions.map((action: any) => ({
    id: action.toolCallId || action.id,
    type: "function",
    function: {
      name:
        action.toolName ||
        (action.type === "shell" ? "propose_shell" : "propose_file_edit"),
      arguments: JSON.stringify(action.payload),
    },
  }));
}

function toConversationHistory(records: ChatMessageRecord[]): Array<{
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}> {
  return records
    .filter(
      (record) =>
        record.content.trim() ||
        record.role === "tool" ||
        (record.role === "assistant" &&
          record.tool_calls &&
          record.tool_calls.length > 0)
    )
    .map((record) => ({
      role: record.role,
      content: record.content.trim(),
      ...(record.tool_calls ? { tool_calls: record.tool_calls } : {}),
      ...(record.tool_call_id ? { tool_call_id: record.tool_call_id } : {}),
      ...(record.name ? { name: record.name } : {}),
    }));
}

function markActionExecutionError(
  plan: OrchestrationPlan,
  actionId: string,
  reason: string
): OrchestrationPlan {
  const timestamp = new Date().toISOString();
  const nextActions = plan.proposedActions.map((action) =>
    action.id === actionId
      ? {
          ...action,
          status: "failed" as const,
          executed: false,
          executionResult: { success: false, message: reason, timestamp },
        }
      : action
  );
  return { ...plan, state: "human_review", proposedActions: nextActions };
}

/* ── Think-block + Markdown renderer ─────────────────────── */
function MessageContent({
  content,
  isStreaming,
  role,
}: {
  content: string;
  isStreaming: boolean;
  role: string;
}) {
  if (!content && isStreaming && role === "assistant") {
    return (
      <div className="chat-waiting">
        <div className="chat-waiting-dots">
          <span />
          <span />
          <span />
        </div>
        <span>正在思考…</span>
      </div>
    );
  }

  const parts: {
    type: "text" | "think";
    content: string;
    streaming: boolean;
  }[] = [];
  let remaining = content;

  // During streaming, strip trailing partial tags like "<", "<t", "<thi", etc.
  if (isStreaming && role === "assistant") {
    const partialTagMatch = remaining.match(/<\/?t(?:h(?:i(?:n(?:k)?)?)?)?$/);
    if (partialTagMatch) {
      remaining = remaining.slice(
        0,
        remaining.length - partialTagMatch[0].length
      );
    }
  }

  while (remaining.length > 0) {
    const start = remaining.indexOf("<think>");
    if (start === -1) {
      parts.push({ type: "text", content: remaining, streaming: false });
      break;
    }
    if (start > 0) {
      parts.push({
        type: "text",
        content: remaining.slice(0, start),
        streaming: false,
      });
    }
    const end = remaining.indexOf("</think>", start + 7);
    if (end === -1) {
      parts.push({
        type: "think",
        content: remaining.slice(start + 7),
        streaming: true,
      });
      break;
    }
    parts.push({
      type: "think",
      content: remaining.slice(start + 7, end),
      streaming: false,
    });
    remaining = remaining.slice(end + 8);
  }

  return (
    <>
      {parts.map((part, i) =>
        part.type === "think" ? (
          <details key={i} className="think-block" open={part.streaming}>
            <summary className="think-summary">思考过程</summary>
            <div className="think-content">
              <Markdown remarkPlugins={[remarkGfm]}>{part.content}</Markdown>
            </div>
          </details>
        ) : (
          <div key={i} className="chat-markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{part.content}</Markdown>
          </div>
        )
      )}
    </>
  );
}

/* ── Tool Trace ───────────────────────────────────────────── */
function ToolTracePanel({ traces }: { traces: ToolExecutionTrace[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!traces.length) return null;
  return (
    <div className="tool-trace">
      <div
        className="tool-trace-header"
        onClick={() => setExpanded(!expanded)}
        style={{
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          paddingBottom: expanded ? "8px" : "0",
        }}
      >
        <span
          style={{
            fontSize: "10px",
            transition: "transform 0.2s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          ▶
        </span>
        <p className="tool-trace-label" style={{ margin: 0 }}>
          工具调用 · {traces.length} 次
        </p>
      </div>
      {expanded && (
        <ul className="tool-trace-list">
          {traces.map((trace) => (
            <li
              key={`${trace.callId}-${trace.startedAt}`}
              className={`tool-trace-item ${trace.status}`}
            >
              <div className="tool-trace-head">
                <span className="tool-trace-name">{trace.name}</span>
                <span className={actionStatusBadgeClass(trace.status)}>
                  {trace.status.toUpperCase()}
                  {trace.retried ? " · retried" : ""}
                </span>
              </div>
              {(trace.errorCategory || trace.errorMessage) && (
                <p className="status-error">
                  {trace.errorCategory ? `[${trace.errorCategory}] ` : ""}
                  {trace.errorMessage ?? "工具调用失败"}
                </p>
              )}
              {trace.resultPreview && (
                <pre className="tool-trace-preview">{trace.resultPreview}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Action payload fields ────────────────────────────────── */
function ActionPayloadFields({
  action,
  messageId,
  onPlanUpdate,
}: {
  action: ActionProposal;
  messageId: string;
  onPlanUpdate: (
    messageId: string,
    updater: (p: OrchestrationPlan) => OrchestrationPlan
  ) => void;
}) {
  const disabled = action.status === "running";

  if (action.type === "apply_patch") {
    return (
      <div className="action-grid">
        <div className="action-field action-wide">
          <span>差异预览</span>
          <DiffViewer patch={action.payload.patch} />
        </div>

        <div className="action-field action-wide">
          <details className="patch-raw-details">
            <summary>Raw Patch（高级）</summary>
            <textarea
              className="input action-textarea"
              disabled={disabled}
              value={action.payload.patch}
              onChange={(e) =>
                onPlanUpdate(messageId, (p) =>
                  updateActionPayload(p, action.id, { patch: e.target.value })
                )
              }
            />
          </details>
        </div>
      </div>
    );
  }

  if (action.type === "shell") {
    const meta = action.executionResult?.metadata as
      | Record<string, unknown>
      | undefined;
    const hasShellOutput = action.executionResult && meta?.stdout !== undefined;
    return (
      <div className="action-grid">
        <div className="action-field action-wide">
          <span>命令</span>
          <code className="action-command-preview">
            {action.payload.shell || "(empty command)"}
          </code>
        </div>
        {hasShellOutput && (
          <div className="action-field action-wide">
            <ShellResultDisplay
              command={String(meta?.command || action.payload.shell)}
              exitCode={Number(meta?.status ?? -1)}
              stdout={String(meta?.stdout ?? "")}
              stderr={String(meta?.stderr ?? "")}
              timedOut={Boolean(meta?.timed_out)}
            />
          </div>
        )}
      </div>
    );
  }

  return null;
}

/* ── Inline Plan + HITL Actions ───────────────────────────── */
function InlinePlan({
  plan,
  messageId,
  executingActionId,
  onPlanUpdate,
  onApprove,
  onReject,
  onComment,
  onApproveAll,
  onRejectAll,
}: {
  plan: OrchestrationPlan;
  messageId: string;
  executingActionId: string;
  onPlanUpdate: (
    messageId: string,
    updater: (p: OrchestrationPlan) => OrchestrationPlan
  ) => void;
  onApprove: (
    messageId: string,
    actionId: string,
    plan: OrchestrationPlan
  ) => Promise<void>;
  onReject: (messageId: string, actionId: string) => void;
  onComment: (messageId: string, actionId: string) => void;
  onApproveAll: (messageId: string, plan: OrchestrationPlan) => Promise<void>;
  onRejectAll: (messageId: string) => void;
}) {
  const safePlan: OrchestrationPlan = {
    ...plan,
    steps: Array.isArray(plan.steps) ? plan.steps : [],
    proposedActions: Array.isArray(plan.proposedActions)
      ? plan.proposedActions
      : [],
  };

  const [expanded, setExpanded] = useState(false);
  return (
    <div className="inline-plan">
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          paddingBottom: expanded ? "8px" : "0",
        }}
      >
        <span
          style={{
            fontSize: "10px",
            transition: "transform 0.2s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            color: "var(--text-3)",
          }}
        >
          ▶
        </span>
        <p className="inline-plan-title" style={{ margin: 0 }}>
          执行计划 · {safePlan.state}
        </p>
      </div>

      {expanded && safePlan.steps.length > 0 && (
        <ol
          style={{
            margin: 0,
            paddingLeft: "1.4em",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          {safePlan.steps.map((step) => (
            <li key={step.id} className="plan-item">
              <span style={{ color: "var(--text-2)", fontSize: "13px" }}>
                {step.summary}
              </span>
            </li>
          ))}
        </ol>
      )}

      {safePlan.proposedActions.length > 0 &&
        (() => {
          const pendingCount = safePlan.proposedActions.filter(
            (a) => a.status === "pending"
          ).length;
          return (
            <>
              {pendingCount > 1 && (
                <div
                  style={{ display: "flex", gap: "8px", marginBottom: "8px" }}
                >
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={Boolean(executingActionId)}
                    onClick={() => void onApproveAll(messageId, plan)}
                    type="button"
                  >
                    ✓ 全部批准 ({pendingCount})
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={Boolean(executingActionId)}
                    onClick={() => onRejectAll(messageId)}
                    type="button"
                  >
                    ✕ 全部拒绝
                  </button>
                </div>
              )}
              <ul className="action-list">
                {safePlan.proposedActions.map((action) => (
                  <li key={action.id} className="action-item">
                    <div className="action-header">
                      <h4 className="action-title">{action.type}</h4>
                      <span className={actionStatusBadgeClass(action.status)}>
                        {action.status.toUpperCase()}
                        {action.executed ? " · Executed" : ""}
                      </span>
                    </div>

                    <ActionPayloadFields
                      action={action}
                      messageId={messageId}
                      onPlanUpdate={onPlanUpdate}
                    />

                    {action.executionResult && (
                      <p
                        className={
                          action.executionResult.success
                            ? "status-success"
                            : "status-error"
                        }
                      >
                        {action.executionResult.message}
                      </p>
                    )}

                    <div className="action-footer">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={
                          !canApproveAction(action) ||
                          Boolean(executingActionId)
                        }
                        onClick={() =>
                          void onApprove(messageId, action.id, plan)
                        }
                        type="button"
                      >
                        {executingActionId === action.id ? "执行中…" : "✓ 批准"}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={
                          !canReviewAction(action) || Boolean(executingActionId)
                        }
                        onClick={() => onReject(messageId, action.id)}
                        type="button"
                      >
                        ✕ 拒绝
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={
                          !canReviewAction(action) || Boolean(executingActionId)
                        }
                        onClick={() => onComment(messageId, action.id)}
                        type="button"
                      >
                        💬 备注
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          );
        })()}
    </div>
  );
}

/* ── Main ChatPage ────────────────────────────────────────── */
export function ChatPage({ settings }: ChatPageProps): ReactElement {
  const { actions: session } = useSession();

  const wsPath = settings.workspacePath;

  // Multi-conversation state
  const [conversations, setConversations] = useState<ConversationMetadata[]>(
    () => {
      migrateGlobalToWorkspace(wsPath);
      return loadConversationList(wsPath);
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
  const [messages, setMessages] = useState<ChatMessageRecord[]>(
    currentConversation?.messages ?? []
  );
  const [categorizedError, setCategorizedError] =
    useState<CategorizedError | null>(null);
  const [sessionNote, setSessionNote] = useState<string>(
    currentConversation?.messages.length ? "已恢复历史会话" : ""
  );
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [executingActionId, setExecutingActionId] = useState<string>("");
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessageRecord[]>(
    currentConversation?.messages ?? []
  );
  const lastPromptRef = useRef<string>("");
  const threadRef = useRef<HTMLDivElement | null>(null);
  const streamBufferRef = useRef<string>("");
  const rafIdRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const localOnlyBlocked =
    !settings.allowCloudModels && !isLocalProvider(settings.provider ?? "");
  const noWorkspaceSelected = !settings.workspacePath;
  const chatBlocked = localOnlyBlocked || noWorkspaceSelected;

  const handleCancel = (): void => {
    abortControllerRef.current?.abort();
  };

  // Save conversation when messages change
  useEffect(() => {
    messagesRef.current = messages;
    if (currentConversation) {
      const updatedConversation: Conversation = {
        ...currentConversation,
        messages,
        updatedAt: new Date().toISOString(),
      };
      saveConversation(wsPath, updatedConversation);
      setCurrentConversation(updatedConversation);

      // Update conversation list
      setConversations(loadConversationList(wsPath));
    }
  }, [messages, currentConversation?.id]);

  // React to workspace path changes: migrate, reload conversations
  const prevWsPathRef = useRef(wsPath);
  useEffect(() => {
    if (prevWsPathRef.current === wsPath) return;
    prevWsPathRef.current = wsPath;

    // Abort any in-flight stream
    abortControllerRef.current?.abort();

    // Migrate global data if needed
    migrateGlobalToWorkspace(wsPath);

    // Load workspace-scoped conversations
    const list = loadConversationList(wsPath);
    setConversations(list);

    const activeId = getActiveConversationId(wsPath);
    const conv = activeId ? loadConversation(wsPath, activeId) : null;

    if (conv) {
      setCurrentConversation(conv);
      setActiveConversationIdState(conv.id);
      setMessages(conv.messages);
      messagesRef.current = conv.messages;
      setSessionNote(conv.messages.length ? "已切换工作区" : "");
    } else if (list.length > 0) {
      const first = loadConversation(wsPath, list[0].id);
      if (first) {
        setCurrentConversation(first);
        setActiveConversationIdState(first.id);
        setActiveConversationId(wsPath, first.id);
        setMessages(first.messages);
        messagesRef.current = first.messages;
        setSessionNote("已切换工作区");
      }
    } else {
      setCurrentConversation(null);
      setActiveConversationIdState(null);
      setMessages([]);
      messagesRef.current = [];
      setSessionNote("");
    }

    setCategorizedError(null);
    setIsStreaming(false);

    // Reset session state
    const previousSessionId = getChatSessionId();
    resetChatSessionId();
    resetHitlContinuationMemory(previousSessionId);
    resetHitlContinuationMemory(getChatSessionId());
  }, [wsPath]);

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    []
  );
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages, isStreaming]);

  /* Auto-resize textarea */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [prompt]);

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

  const collectBlockedActionFingerprints = (
    plan: OrchestrationPlan
  ): string[] =>
    plan.proposedActions
      .filter(
        (action) =>
          action.status === "completed" ||
          action.status === "rejected" ||
          action.status === "failed"
      )
      .map((action) => action.fingerprint ?? actionFingerprint(action));

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
          () =>
            void runChatCycle(decision.prompt, {
              visibleUserMessage: false,
              isContinuation: true,
              internalSystemNote: decision.internalSystemNote,
            }),
          100
        );
      })
      .catch((err) => {
        setSessionNote(
          `续跑状态机失败：${err instanceof Error ? err.message : "未知错误"}`
        );
      });
  };

  const runChatCycle = async (
    promptText: string,
    options: RunChatCycleOptions & { isContinuation?: boolean } = {}
  ): Promise<void> => {
    if (!promptText || isStreaming) return;
    const visibleUserMessage = options.visibleUserMessage !== false;
    if (visibleUserMessage) {
      resetHitlContinuationMemory(getChatSessionId());
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    lastPromptRef.current = promptText;
    const conversationHistory = toConversationHistory(messagesRef.current);
    const assistantMessageId = createMessageId("assistant");
    const now = new Date().toISOString();
    const assistantMsg: ChatMessageRecord = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: now,
      plan: null,
    };

    if (visibleUserMessage) {
      const userMsg: ChatMessageRecord = {
        id: createMessageId("user"),
        role: "user",
        content: promptText,
        createdAt: now,
        plan: null,
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
    } else {
      setMessages((prev) => [...prev, assistantMsg]);
    }

    setIsStreaming(true);
    setCategorizedError(null);
    setSessionNote("正在回复…");
    session.setWorkflowPhase("planning");

    try {
      const result = await runPlanningSession({
        prompt: promptText,
        settings,
        phase: options.phase,
        conversationHistory,
        isContinuation: options.isContinuation,
        internalSystemNote: options.internalSystemNote,
        blockedActionFingerprints: visibleUserMessage
          ? []
          : messagesRef.current.flatMap((message) =>
              message.plan ? collectBlockedActionFingerprints(message.plan) : []
            ),
        signal: controller.signal,
        onAssistantChunk: (chunk) => {
          streamBufferRef.current += chunk;
          if (rafIdRef.current === null) {
            rafIdRef.current = requestAnimationFrame(() => {
              const buffered = streamBufferRef.current;
              streamBufferRef.current = "";
              rafIdRef.current = null;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMessageId
                    ? { ...m, content: `${m.content}${buffered}` }
                    : m
                )
              );
            });
          }
        },
      });

      // Cancel any pending streaming buffer before final overwrite
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      streamBufferRef.current = "";

      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === assistantMessageId) {
            let tool_calls: any[] | undefined = undefined;
            if (
              result.plan &&
              result.plan.proposedActions &&
              result.plan.proposedActions.length > 0
            ) {
              tool_calls = result.plan.proposedActions.map((action: any) => ({
                id: action.toolCallId || action.id,
                type: "function",
                function: {
                  name:
                    action.toolName ||
                    (action.type === "shell"
                      ? "propose_shell"
                      : "propose_file_edit"),
                  arguments: JSON.stringify(action.payload),
                },
              }));
            }
            return {
              ...m,
              content: result.assistantReply,
              plan: result.plan,
              toolTrace: result.toolTrace,
              tool_calls,
            };
          }
          return m;
        })
      );

      // Update session context for kitchen page
      session.updatePlan(result.assistantReply);
      session.appendToolTraces(result.toolTrace ?? []);
      if (result.plan.proposedActions.length > 0) {
        session.setWorkflowPhase("human_review");
      } else {
        session.setWorkflowPhase("done");
      }

      void saveWorkflowCheckpoint(
        getChatSessionId(),
        assistantMessageId,
        result.plan,
        result.toolTrace,
        getHitlContinuationMemory(getChatSessionId())
      ).catch((err) =>
        setSessionNote(
          `审批点未保存：${err instanceof Error ? err.message : "未知错误"}`
        )
      );

      setSessionNote(
        result.plan.proposedActions.length > 0
          ? "已进入 HITL 审批阶段，请逐项审批"
          : "回复完成"
      );
    } catch (error) {
      if (controller.signal.aborted) {
        setMessages((prev) =>
          prev.filter(
            (m) => m.id !== assistantMessageId || m.content.trim() !== ""
          )
        );
        setSessionNote("已取消");
        return;
      }
      setCategorizedError(classifyError(error));
      setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
      setSessionNote("回复失败");
    } finally {
      // Clean up any remaining stream state
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      streamBufferRef.current = "";
      if (abortControllerRef.current === controller)
        abortControllerRef.current = null;
      setIsStreaming(false);
    }
  };

  const handleSubmit = async (): Promise<void> => {
    const text = prompt.trim();
    if (!text || isStreaming) return;
    setPrompt("");
    await runChatCycle(text);
  };

  const handlePlanUpdate = (
    messageId: string,
    updater: (plan: OrchestrationPlan) => OrchestrationPlan
  ): void => {
    let updatedPlan: OrchestrationPlan | null = null;
    let currentTrace: ToolExecutionTrace[] = [];
    setMessages((prev) => {
      const next = prev.map((m) => {
        if (m.id !== messageId || !m.plan) return m;
        updatedPlan = updater(m.plan);
        currentTrace = m.toolTrace ?? [];
        return { ...m, plan: updatedPlan };
      });
      messagesRef.current = next;
      return next;
    });
    if (updatedPlan) {
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

  const handleApproveAction = async (
    messageId: string,
    actionId: string,
    plan: OrchestrationPlan
  ): Promise<void> => {
    if (executingActionId) return;
    setExecutingActionId(actionId);
    setCategorizedError(null);
    const runningPlan = markActionRunning(plan, actionId);
    handlePlanUpdate(messageId, () => runningPlan);
    try {
      const nextPlan = await approveAction(
        runningPlan,
        actionId,
        settings.workspacePath
      );
      handlePlanUpdate(messageId, () => nextPlan);
      setSessionNote(`动作 ${actionId} 已执行 · 状态：${nextPlan.state}`);
      continueAfterHitlIfNeeded(messageId, nextPlan);
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : String(error || "动作执行失败");
      const errorPlan = markActionExecutionError(plan, actionId, reason);
      handlePlanUpdate(messageId, () => errorPlan);
      setCategorizedError(classifyError(error));
      continueAfterHitlIfNeeded(messageId, errorPlan);
    } finally {
      setExecutingActionId("");
    }
  };

  const handleRejectAction = (messageId: string, actionId: string): void => {
    const reason = window.prompt("请输入 Reject 原因", "Need refinement");
    if (reason === null) return;
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
  };

  const handleCommentAction = (messageId: string, actionId: string): void => {
    const comment = window.prompt(
      "请输入 Comment",
      "Please update payload before approval"
    );
    if (comment === null) return;
    handlePlanUpdate(messageId, (p) => commentAction(p, actionId, comment));
  };

  const handleApproveAllActions = async (
    messageId: string,
    plan: OrchestrationPlan
  ): Promise<void> => {
    if (executingActionId) return;
    setExecutingActionId("batch-approve");
    setCategorizedError(null);
    try {
      const nextPlan = await approveAllPendingActions(
        plan,
        settings.workspacePath
      );
      handlePlanUpdate(messageId, () => nextPlan);
      const completedCount = nextPlan.proposedActions.filter(
        (a) => a.status === "completed"
      ).length;
      setSessionNote(
        `已批量执行 ${completedCount} 个动作 · 状态：${nextPlan.state}`
      );
      continueAfterHitlIfNeeded(messageId, nextPlan);
    } catch (error) {
      setCategorizedError(classifyError(error));
    } finally {
      setExecutingActionId("");
    }
  };

  const handleRejectAllActions = (messageId: string): void => {
    const reason = window.prompt("请输入批量拒绝原因", "Need refinement");
    if (reason === null) return;
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
  };

  const handleClearHistory = (): void => {
    if (isStreaming || Boolean(executingActionId)) return;
    if (!currentConversation) return;

    const previousSessionId = getChatSessionId();
    resetChatSessionId();
    resetHitlContinuationMemory(previousSessionId);
    resetHitlContinuationMemory(getChatSessionId());

    // Clear current conversation messages
    const clearedConversation: Conversation = {
      ...currentConversation,
      messages: [],
      updatedAt: new Date().toISOString(),
    };
    saveConversation(wsPath, clearedConversation);
    setCurrentConversation(clearedConversation);
    setMessages([]);
    setCategorizedError(null);
    setSessionNote("");
    setConversations(loadConversationList(wsPath));
  };

  // Conversation management handlers
  const handleNewConversation = (): void => {
    if (isStreaming || Boolean(executingActionId)) return;

    const newConv = createConversation(wsPath, []);
    setCurrentConversation(newConv);
    setActiveConversationIdState(newConv.id);
    setMessages([]);
    setCategorizedError(null);
    setSessionNote("");
    setConversations(loadConversationList(wsPath));

    // Reset session state
    const previousSessionId = getChatSessionId();
    resetChatSessionId();
    resetHitlContinuationMemory(previousSessionId);
    resetHitlContinuationMemory(getChatSessionId());
  };

  const handleSelectConversation = (conversationId: string): void => {
    if (isStreaming || Boolean(executingActionId)) return;
    if (conversationId === activeConversationId) return;

    const conv = loadConversation(wsPath, conversationId);
    if (!conv) return;

    setCurrentConversation(conv);
    setActiveConversationIdState(conv.id);
    setActiveConversationId(wsPath, conv.id);
    setMessages(conv.messages);
    setCategorizedError(null);
    setSessionNote(conv.messages.length ? "已切换对话" : "");

    // Reset session state for new conversation
    const previousSessionId = getChatSessionId();
    resetChatSessionId();
    resetHitlContinuationMemory(previousSessionId);
    resetHitlContinuationMemory(getChatSessionId());
  };

  const handleDeleteConversation = (conversationId: string): void => {
    if (isStreaming || Boolean(executingActionId)) return;

    console.log("[handleDeleteConversation] Deleting conversation:", {
      conversationId,
      wsPath,
      activeConversationId,
    });

    deleteConversation(wsPath, conversationId);
    const updatedList = loadConversationList(wsPath);
    console.log(
      "[handleDeleteConversation] Updated list length:",
      updatedList.length,
      "IDs:",
      updatedList.map((c) => c.id)
    );
    setConversations(updatedList);

    // If deleted current conversation, switch to another or create new
    if (conversationId === activeConversationId) {
      if (updatedList.length > 0) {
        handleSelectConversation(updatedList[0].id);
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

  return (
    <div className="chat-layout-with-sidebar">
      <ConversationSidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onDeleteConversation={handleDeleteConversation}
        onRenameConversation={handleRenameConversation}
      />
      <div className="chat-main-area">
        <div className="page-content chat-layout">
          {/* ── Top bar ── */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                minWidth: 0,
              }}
            >
              <button
                className="chat-sidebar-toggle"
                onClick={() => setSidebarOpen((v) => !v)}
                type="button"
                aria-label="对话列表"
                title="对话列表"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M2 4h12M2 8h8M2 12h10"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <span
                style={{
                  fontSize: "12px",
                  color: "var(--text-3)",
                  flexShrink: 0,
                }}
              >
                工作区
              </span>
              {settings.workspacePath ? (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "12px",
                    color: "var(--text-2)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {settings.workspacePath}
                </span>
              ) : (
                <span
                  style={{ fontSize: "12px", color: "var(--color-warning)" }}
                >
                  ⚠ 未选择工作区
                </span>
              )}
            </div>
            <div
              style={{
                display: "flex",
                gap: "8px",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              {sessionNote && (
                <span style={{ fontSize: "12px", color: "var(--text-3)" }}>
                  {sessionNote}
                </span>
              )}
              <button
                className="btn btn-ghost btn-sm"
                disabled={
                  isStreaming ||
                  Boolean(executingActionId) ||
                  messages.length === 0
                }
                onClick={handleClearHistory}
                type="button"
              >
                清空
              </button>
            </div>
          </div>

          {/* ── Alerts ── */}
          {localOnlyBlocked && (
            <div
              style={{
                padding: "10px 14px",
                background: "var(--color-error-bg)",
                border: "1px solid rgba(248,113,113,0.2)",
                borderRadius: "var(--r-md)",
                fontSize: "13px",
                color: "var(--color-error)",
              }}
            >
              Local-only 模式已开启，当前 provider
              不是本地模型，请前往设置页切换。
            </div>
          )}
          {noWorkspaceSelected && (
            <div
              style={{
                padding: "10px 14px",
                background: "var(--color-warning-bg)",
                border: "1px solid rgba(251,191,36,0.2)",
                borderRadius: "var(--r-md)",
                fontSize: "13px",
                color: "var(--color-warning)",
              }}
            >
              请先在设置页选择工作区（Git 仓库文件夹）
            </div>
          )}

          {/* ── Thread ── */}
          <div className="chat-thread" ref={threadRef}>
            {messages.length === 0 ? (
              <div className="chat-empty">
                <div className="chat-empty-icon">☕</div>
                <p className="chat-empty-text">开始你的第一条消息</p>
              </div>
            ) : (
              messages.map((message) => (
                <div key={message.id} className={`chat-row ${message.role}`}>
                  <div className={`chat-avatar ${message.role}`}>
                    {message.role === "user" ? "你" : "AI"}
                  </div>
                  <div className="chat-bubble-wrap">
                    <p className="chat-meta">
                      {message.role === "user" ? "你" : "助手"}
                      {formatTime(message.createdAt)
                        ? ` · ${formatTime(message.createdAt)}`
                        : ""}
                    </p>
                    <div className={`chat-bubble ${message.role}`}>
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
                    {message.role === "assistant" &&
                      (message.toolTrace?.length ?? 0) > 0 && (
                        <ToolTracePanel traces={message.toolTrace!} />
                      )}
                    {message.plan && (
                      <InlinePlan
                        plan={message.plan}
                        messageId={message.id}
                        executingActionId={executingActionId}
                        onPlanUpdate={handlePlanUpdate}
                        onApprove={handleApproveAction}
                        onReject={handleRejectAction}
                        onComment={handleCommentAction}
                        onApproveAll={handleApproveAllActions}
                        onRejectAll={handleRejectAllActions}
                      />
                    )}
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
                        if (lastPromptRef.current) {
                          void runChatCycle(lastPromptRef.current);
                        }
                      }
                    : undefined
                }
                onDismiss={() => setCategorizedError(null)}
              />
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSubmit();
              }}
            >
              <div className="chat-input-box">
                <textarea
                  ref={textareaRef}
                  className="chat-textarea"
                  value={prompt}
                  disabled={chatBlocked}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSubmit();
                    }
                  }}
                  placeholder={
                    chatBlocked
                      ? "请先完成设置…"
                      : "输入消息，Enter 发送，Shift+Enter 换行"
                  }
                  rows={1}
                />
                <div className="chat-input-footer">
                  <span className="chat-input-hint">
                    Enter 发送 · Shift+Enter 换行
                  </span>
                  <div className="chat-input-actions">
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
                        !prompt.trim() ||
                        chatBlocked
                      }
                      type="submit"
                    >
                      {isStreaming ? "回复中…" : "发送 ↑"}
                    </button>
                  </div>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
