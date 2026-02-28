/**
 * Cofree - AI Programming Cafe
 * File: src/ui/pages/ChatPage.tsx
 * Milestone: 3
 * Task: 3.1
 * Status: In Progress
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Multi-turn chat page with HITL approval controls for sensitive actions.
 */

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import {
  clearChatHistory,
  loadChatHistory,
  saveChatHistory,
  type ChatMessageRecord
} from "../../lib/chatHistoryStore";
import { isLocalProvider } from "../../lib/litellm";
import type { AppSettings } from "../../lib/settingsStore";
import {
  approveAction,
  commentAction,
  markActionRunning,
  rejectAction,
  updateActionPayload
} from "../../orchestrator/hitlService";
import {
  CHAT_SESSION_ID,
  loadLatestWorkflowCheckpoint,
  saveWorkflowCheckpoint
} from "../../orchestrator/checkpointStore";
import { runPlanningSession, type ToolExecutionTrace } from "../../orchestrator/planningService";
import type { ActionProposal, OrchestrationPlan } from "../../orchestrator/types";

interface ChatPageProps {
  settings: AppSettings;
}

function createMessageId(role: "user" | "assistant"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${role}-${crypto.randomUUID()}`;
  }

  return `${role}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function canApproveAction(action: ActionProposal): boolean {
  return action.status === "pending" || action.status === "failed";
}

function canReviewAction(action: ActionProposal): boolean {
  return action.status === "pending" || action.status === "failed";
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
          executionResult: {
            success: false,
            message: reason,
            timestamp
          }
        }
      : action
  );

  return {
    ...plan,
    state: "human_review",
    proposedActions: nextActions
  };
}

export function ChatPage({ settings }: ChatPageProps): ReactElement {
  const initialHistory = useMemo(() => loadChatHistory(), []);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessageRecord[]>(initialHistory);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [sessionNote, setSessionNote] = useState<string>(
    initialHistory.length ? "已恢复历史会话，可继续追问。" : "开始新会话。"
  );
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [executingActionId, setExecutingActionId] = useState<string>("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const localOnlyBlocked = !settings.allowCloudModels && !isLocalProvider(settings.provider);
  const noWorkspaceSelected = !settings.workspacePath;
  const chatBlocked = localOnlyBlocked || noWorkspaceSelected;

  const handleCancel = (): void => {
    abortControllerRef.current?.abort();
  };

  const safePlan = (plan: OrchestrationPlan): OrchestrationPlan => ({
    ...plan,
    steps: Array.isArray(plan.steps) ? plan.steps : [],
    proposedActions: Array.isArray(plan.proposedActions) ? plan.proposedActions : []
  });

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    saveChatHistory(messages);
  }, [messages]);

  useEffect(() => {
    if (!threadRef.current) {
      return;
    }

    threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, isStreaming]);

  useEffect(() => {
    let cancelled = false;

    const restoreCheckpoint = async (): Promise<void> => {
      try {
        const latest = await loadLatestWorkflowCheckpoint(CHAT_SESSION_ID);
        if (!latest || cancelled) {
          return;
        }

        setMessages((previous) => {
          const targetIndex = previous.findIndex((message) => message.id === latest.messageId);
          if (targetIndex >= 0) {
            return previous.map((message, index) =>
              index === targetIndex
                ? {
                    ...message,
                    plan: latest.payload.plan,
                    toolTrace: latest.payload.toolTrace ?? message.toolTrace
                  }
                : message
            );
          }

          const recoveredMessage: ChatMessageRecord = {
            id: latest.messageId,
            role: "assistant",
            content: "已从审批点恢复上一轮工作流状态。",
            createdAt: new Date().toISOString(),
            plan: latest.payload.plan,
            toolTrace: latest.payload.toolTrace ?? []
          };

          return [...previous, recoveredMessage].slice(-80);
        });
        setSessionNote("已从 SQLite checkpoint 恢复最近审批状态。");
      } catch (_error) {
        // Non-fatal: chat still works even when checkpoint recovery fails.
      }
    };

    void restoreCheckpoint();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (): Promise<void> => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt || isStreaming) {
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const historyForModel = messages.map((message) => ({
      role: message.role,
      content: message.content
    }));
    const userMessage: ChatMessageRecord = {
      id: createMessageId("user"),
      role: "user",
      content: normalizedPrompt,
      createdAt: new Date().toISOString(),
      plan: null
    };
    const assistantMessageId = createMessageId("assistant");
    const assistantPlaceholder: ChatMessageRecord = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      plan: null
    };

    setIsStreaming(true);
    setPrompt("");
    setMessages((previous) => [...previous, userMessage, assistantPlaceholder]);
    setErrorMessage("");
    setSessionNote("服务员正在回复...");

    try {
      const result = await runPlanningSession({
        prompt: normalizedPrompt,
        settings,
        conversationHistory: historyForModel,
        signal: controller.signal,
        onAssistantChunk: (chunk) => {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessageId
                ? { ...message, content: `${message.content}${chunk}` }
                : message
            )
          );
        }
      });

      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                content: result.assistantReply,
                plan: result.plan,
                toolTrace: result.toolTrace
              }
            : message
        )
      );
      const hasSensitiveActions = result.plan.proposedActions.length > 0;
      void saveWorkflowCheckpoint(
        CHAT_SESSION_ID,
        assistantMessageId,
        result.plan,
        result.toolTrace
      ).catch((error) => {
        const message = error instanceof Error ? error.message : "审批点持久化失败";
        setSessionNote(`审批点未保存：${message}`);
      });
      setSessionNote(
        hasSensitiveActions
          ? "本轮完成：已进入 HITL 审批阶段，可逐项 Approve / Reject / Comment。"
          : "本轮完成：无敏感动作，已直接返回只读结果。"
      );
    } catch (error) {
      if (controller.signal.aborted) {
        setMessages((previous) =>
          previous.filter((message) => message.id !== assistantMessageId || message.content.trim())
        );
        setSessionNote("已取消本轮会话。");
        return;
      }

      const message =
        error instanceof Error ? error.message : "请求失败，请检查网络与 LiteLLM 配置后重试。";
      setErrorMessage(message);
      setMessages((previous) =>
        previous.filter((chatMessage) => chatMessage.id !== assistantMessageId)
      );
      setSessionNote("服务员回复失败。");
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsStreaming(false);
    }
  };

  const handlePlanUpdate = (
    messageId: string,
    updater: (plan: OrchestrationPlan) => OrchestrationPlan
  ): void => {
    let updatedPlan: OrchestrationPlan | null = null;
    let currentTrace: ToolExecutionTrace[] = [];
    setMessages((previous) =>
      previous.map((message) => {
        if (message.id !== messageId || !message.plan) {
          return message;
        }

        updatedPlan = updater(message.plan);
        currentTrace = message.toolTrace ?? [];
        return {
          ...message,
          plan: updatedPlan
        };
      })
    );

    if (updatedPlan) {
      void saveWorkflowCheckpoint(CHAT_SESSION_ID, messageId, updatedPlan, currentTrace).catch(
        (error) => {
          const message = error instanceof Error ? error.message : "审批点持久化失败";
          setSessionNote(`审批点未保存：${message}`);
        }
      );
    }
  };

  const handleApproveAction = async (
    messageId: string,
    actionId: string,
    plan: OrchestrationPlan
  ): Promise<void> => {
    if (executingActionId) {
      return;
    }

    setExecutingActionId(actionId);
    setErrorMessage("");

    const runningPlan = markActionRunning(plan, actionId);
    handlePlanUpdate(messageId, () => runningPlan);

    try {
      const nextPlan = await approveAction(runningPlan, actionId, settings.workspacePath);
      handlePlanUpdate(messageId, () => nextPlan);
      setSessionNote(`动作 ${actionId} 已执行，当前状态：${nextPlan.state}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "动作执行失败";
      handlePlanUpdate(messageId, (currentPlan) => markActionExecutionError(currentPlan, actionId, reason));
      setErrorMessage(reason);
    } finally {
      setExecutingActionId("");
    }
  };

  const handleRejectAction = (messageId: string, actionId: string): void => {
    const reason = window.prompt("请输入 Reject 原因", "Need refinement");
    if (reason === null) {
      return;
    }

    handlePlanUpdate(messageId, (plan) => rejectAction(plan, actionId, reason));
    setSessionNote(`动作 ${actionId} 已拒绝。`);
  };

  const handleCommentAction = (messageId: string, actionId: string): void => {
    const comment = window.prompt("请输入 Comment", "Please update payload before approval");
    if (comment === null) {
      return;
    }

    handlePlanUpdate(messageId, (plan) => commentAction(plan, actionId, comment));
  };

  const handleClearHistory = (): void => {
    if (isStreaming || Boolean(executingActionId)) {
      return;
    }

    clearChatHistory();
    setMessages([]);
    setErrorMessage("");
    setSessionNote("会话历史已清空。");
  };

  const formatWorkspacePath = (path: string): string => {
    if (!path) return "";
    return path;
  };

  const formatTime = (isoTime: string): string => {
    const timestamp = new Date(isoTime);
    if (Number.isNaN(timestamp.getTime())) {
      return "";
    }

    return timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const traceStatus = (trace: ToolExecutionTrace): string =>
    trace.status === "success" ? "SUCCESS" : "FAILED";

  return (
    <div className="page-stack">
      <div className="workspace-status">
        <div className="workspace-info">
          <span className="workspace-label">当前工作区:</span>
          {settings.workspacePath ? (
            <span className="workspace-path">{formatWorkspacePath(settings.workspacePath)}</span>
          ) : (
            <span className="workspace-warning">未选择工作区</span>
          )}
        </div>
        <button
          className="button secondary"
          disabled={isStreaming || Boolean(executingActionId) || messages.length === 0}
          onClick={handleClearHistory}
          type="button"
        >
          清空历史
        </button>
      </div>

      <article className="panel-card">
        <h2>对话区</h2>
        {/* Removed status-note for minimal UI */}
        {localOnlyBlocked ? (
          <p className="status-error">
            Local-only 已开启，当前 provider 不是本地模型。请到设置页切换。
          </p>
        ) : null}
        {noWorkspaceSelected ? (
          <p className="status-error">
            请先在设置页选择工作区（Git 仓库文件夹）
          </p>
        ) : null}

        <div className="chat-thread" ref={threadRef}>
          {messages.length ? (
            messages.map((message) => (
              <div key={message.id} className={`chat-row ${message.role}`}>
                <div className={`chat-bubble ${message.role}`}>
                  <p className="chat-meta">
                    {message.role === "user" ? "你" : "服务员"}
                    {formatTime(message.createdAt) ? ` · ${formatTime(message.createdAt)}` : ""}
                  </p>
                  <p className="chat-text">
                    {message.content ||
                      (isStreaming && message.role === "assistant" ? "正在等待首个 token..." : "")}
                  </p>
                  {message.role === "assistant" && message.toolTrace?.length ? (
                    <div className="tool-trace">
                      <p className="status-note">Tool Calls: {message.toolTrace.length}</p>
                      <ul className="tool-trace-list">
                        {message.toolTrace.map((trace) => (
                          <li
                            key={`${trace.callId}-${trace.startedAt}`}
                            className={`tool-trace-item ${trace.status}`}
                          >
                            <p className="tool-trace-head">
                              <span className="tool-trace-name">{trace.name}</span>
                              <span className="pending-pill">
                                {traceStatus(trace)} / attempts {trace.attempts}
                                {trace.retried ? " / retried" : ""}
                              </span>
                            </p>
                            {trace.errorCategory || trace.errorMessage ? (
                              <p className="status-error">
                                {trace.errorCategory ? `[${trace.errorCategory}] ` : ""}
                                {trace.errorMessage ?? "工具调用失败"}
                              </p>
                            ) : null}
                            {trace.resultPreview ? (
                              <pre className="tool-trace-preview">{trace.resultPreview}</pre>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {message.plan ? (
                    <div className="inline-plan">
                      {(() => {
                        const plan = safePlan(message.plan);
                        const hasSensitiveActions = plan.proposedActions.length > 0;
                        return (
                          <>
                      <p className="status-note">State: {plan.state}</p>
                      <ol>
                        {plan.steps.map((step) => (
                          <li key={step.id} className="plan-item">
                            {step.summary} ({step.owner})
                          </li>
                        ))}
                      </ol>
                      <p className="status-note">
                        {hasSensitiveActions ? "待审批动作（按需生成）：" : "本轮未触发审批流。"}
                      </p>
                      {hasSensitiveActions ? (
                      <ul className="action-list">
                        {plan.proposedActions.map((action) => (
                          <li key={action.id} className="action-item">
                            <div className="action-main">
                              <p className="action-title">
                                {action.type}: {action.description}
                              </p>

                              {action.type === "apply_patch" ? (
                                <label className="action-field">
                                  Patch
                                  <textarea
                                    className="textarea action-textarea"
                                    disabled={action.status === "running"}
                                    placeholder="粘贴 unified diff patch"
                                    value={action.payload.patch}
                                    onChange={(event) => {
                                      handlePlanUpdate(message.id, (plan) =>
                                        updateActionPayload(plan, action.id, {
                                          patch: event.target.value
                                        })
                                      );
                                    }}
                                  />
                                </label>
                              ) : null}

                              {action.type === "run_command" ? (
                                <div className="action-grid">
                                  <label className="action-field">
                                    Command
                                    <input
                                      className="input"
                                      disabled={action.status === "running"}
                                      value={action.payload.command}
                                      onChange={(event) => {
                                        handlePlanUpdate(message.id, (plan) =>
                                          updateActionPayload(plan, action.id, {
                                            command: event.target.value
                                          })
                                        );
                                      }}
                                    />
                                  </label>
                                  <label className="action-field">
                                    Timeout (ms)
                                    <input
                                      className="input"
                                      disabled={action.status === "running"}
                                      min={1000}
                                      step={1000}
                                      type="number"
                                      value={action.payload.timeoutMs}
                                      onChange={(event) => {
                                        handlePlanUpdate(message.id, (plan) =>
                                          updateActionPayload(plan, action.id, {
                                            timeoutMs: Number(event.target.value) || 120000
                                          })
                                        );
                                      }}
                                    />
                                  </label>
                                </div>
                              ) : null}

                              {action.type === "git_write" ? (
                                <div className="action-grid">
                                  <label className="action-field">
                                    Operation
                                    <select
                                      className="select"
                                      disabled={action.status === "running"}
                                      value={action.payload.operation}
                                      onChange={(event) => {
                                        handlePlanUpdate(message.id, (plan) =>
                                          updateActionPayload(plan, action.id, {
                                            operation: event.target.value
                                          })
                                        );
                                      }}
                                    >
                                      <option value="stage">stage</option>
                                      <option value="commit">commit</option>
                                      <option value="checkout_branch">checkout_branch</option>
                                    </select>
                                  </label>
                                  <label className="action-field">
                                    Branch
                                    <input
                                      className="input"
                                      disabled={action.status === "running"}
                                      value={action.payload.branchName}
                                      onChange={(event) => {
                                        handlePlanUpdate(message.id, (plan) =>
                                          updateActionPayload(plan, action.id, {
                                            branchName: event.target.value
                                          })
                                        );
                                      }}
                                    />
                                  </label>
                                  <label className="action-field action-wide">
                                    Message
                                    <input
                                      className="input"
                                      disabled={action.status === "running"}
                                      value={action.payload.message}
                                      onChange={(event) => {
                                        handlePlanUpdate(message.id, (plan) =>
                                          updateActionPayload(plan, action.id, {
                                            message: event.target.value
                                          })
                                        );
                                      }}
                                    />
                                  </label>
                                </div>
                              ) : null}

                              {action.executionResult ? (
                                <p
                                  className={
                                    action.executionResult.success ? "status-note" : "status-error"
                                  }
                                >
                                  {action.executionResult.message}
                                </p>
                              ) : null}

                              <div className="actions action-inline">
                                <button
                                  className="button"
                                  disabled={!canApproveAction(action) || Boolean(executingActionId)}
                                  onClick={() => {
                                    void handleApproveAction(message.id, action.id, plan);
                                  }}
                                  type="button"
                                >
                                  {executingActionId === action.id ? "Executing..." : "Approve"}
                                </button>
                                <button
                                  className="button secondary"
                                  disabled={!canReviewAction(action) || Boolean(executingActionId)}
                                  onClick={() => handleRejectAction(message.id, action.id)}
                                  type="button"
                                >
                                  Reject
                                </button>
                                <button
                                  className="button secondary"
                                  disabled={!canReviewAction(action) || Boolean(executingActionId)}
                                  onClick={() => handleCommentAction(message.id, action.id)}
                                  type="button"
                                >
                                  Comment
                                </button>
                              </div>
                            </div>

                            <span className="pending-pill">
                              {action.status.toUpperCase()} / {action.executed ? "Executed" : "Not Executed"}
                            </span>
                          </li>
                        ))}
                      </ul>
                      ) : null}
                          </>
                        );
                      })()}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <p className="status-note">暂无会话历史，输入第一条消息开始。</p>
          )}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <textarea
            className="textarea"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="继续对服务员补充需求、约束或追问"
          />
          <div className="actions">
            <button
              className="button"
              disabled={isStreaming || Boolean(executingActionId) || !prompt.trim() || chatBlocked}
              type="submit"
            >
              {isStreaming ? "回复中..." : "发送消息"}
            </button>
            <button
              className="button secondary"
              disabled={!isStreaming}
              onClick={handleCancel}
              type="button"
            >
              取消
            </button>
          </div>
        </form>

        <p className="status-note">{sessionNote}</p>
        {errorMessage ? <p className="status-error">{errorMessage}</p> : null}
      </article>

    </div>
  );
}
