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
  generateConversationTitle,
  type ConversationMetadata,
  type Conversation,
} from "../../lib/conversationStore";
import { ConversationSidebar } from "../components/ConversationSidebar";
import { IconTrash } from "../components/Icons";
import {
  getActiveVendor,
  getActiveManagedModel,
  isActiveModelLocal,
  loadVendorApiKey,
  resolveManagedModelSelection,
  syncRuntimeSettings,
} from "../../lib/settingsStore";
import type { AppSettings } from "../../lib/settingsStore";
import type { ModelSelection } from "../../lib/modelSelection";
import {
  classifyError,
  type CategorizedError,
} from "../../lib/errorClassifier";
import { ErrorBanner } from "../components/ErrorBanner";
import { InputDialog } from "../components/InputDialog";
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
  type ToolCallEvent,
} from "../../orchestrator/planningService";
import type {
  ActionProposal,
  OrchestrationPlan,
} from "../../orchestrator/types";
import { useSession } from "../../lib/sessionContext";
import type { ChatAgentDefinition } from "../../agents/types";
import { createAgentBinding } from "../../agents/resolveAgentRuntime";

interface ChatPageProps {
  settings: AppSettings;
  activeAgent: ChatAgentDefinition;
  isVisible?: boolean;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

interface RunChatCycleOptions {
  visibleUserMessage?: boolean;
  internalSystemNote?: string;
  phase?: PlanningSessionPhase;
}

interface BackgroundStreamState {
  messages: ChatMessageRecord[];
  isStreaming: boolean;
  tokenCount: number | null;
  sessionNote: string;
  liveToolCalls: LiveToolCall[];
  error: CategorizedError | null;
}

function resolveConversationModelSelection(
  settings: AppSettings,
  activeAgent: ChatAgentDefinition,
  currentConversation: Conversation | null,
): ModelSelection | null {
  const binding = currentConversation?.agentBinding;
  if (binding) {
    return {
      vendorId: binding.vendorId,
      modelId: binding.modelId,
    };
  }

  if (activeAgent.modelSelection) {
    return activeAgent.modelSelection;
  }

  const activeSelection = resolveManagedModelSelection(settings, {
    vendorId: settings.activeVendorId,
    modelId: settings.activeModelId,
  });
  if (!activeSelection) {
    return null;
  }

  return {
    vendorId: activeSelection.vendor.id,
    modelId: activeSelection.managedModel.id,
  };
}

async function buildExecutionSettings(
  settings: AppSettings,
  activeAgent: ChatAgentDefinition,
  currentConversation: Conversation | null,
): Promise<{
  settings: AppSettings;
  selection: ModelSelection | null;
  snapshots?: { vendorName?: string; modelName?: string };
}> {
  const selection = resolveConversationModelSelection(settings, activeAgent, currentConversation);
  const modelScopedSettings = selection
    ? syncRuntimeSettings({
        ...settings,
        activeVendorId: selection.vendorId,
        activeModelId: selection.modelId,
      })
    : settings;
  const resolvedSelection = resolveManagedModelSelection(modelScopedSettings, selection);

  let apiKey = modelScopedSettings.apiKey;
  try {
    const vendorApiKey = await loadVendorApiKey(getActiveVendor(modelScopedSettings)?.id);
    if (vendorApiKey) {
      apiKey = vendorApiKey;
    }
  } catch {
    // ignore secure storage failures and fall back to the in-memory key
  }

  return {
    selection,
    snapshots: resolvedSelection
      ? {
          vendorName: resolvedSelection.vendor.name,
          modelName: resolvedSelection.managedModel.name,
        }
      : undefined,
    settings:
      apiKey === modelScopedSettings.apiKey
        ? modelScopedSettings
        : { ...modelScopedSettings, apiKey },
  };
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

  // 兜底：非流式状态下内容为空时显示占位提示，避免空对话框
  if (!content && !isStreaming && role === "assistant") {
    return (
      <div className="chat-markdown chat-empty-reply">
        <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
          （无回复内容）
        </span>
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

/* ── Tool name friendly labels ───────────────────────────────── */
const TOOL_NAME_LABELS: Record<string, string> = {
  list_files: "浏览目录",
  read_file: "读取文件",
  git_status: "Git 状态",
  git_diff: "Git 差异",
  grep: "搜索代码",
  glob: "查找文件",
  propose_file_edit: "编辑文件",
  propose_apply_patch: "应用补丁",
  propose_shell: "执行命令",
  task: "子任务",
  diagnostics: "诊断检查",
  fetch: "获取网页",
};

function formatToolName(name: string): string {
  return TOOL_NAME_LABELS[name] || name;
}

/* ── Live Tool Status (real-time feedback) ─────────────────────── */
interface LiveToolCall {
  callId: string;
  toolName: string;
  argsPreview?: string;
  status: "running" | "success" | "failed";
  resultPreview?: string;
}

function LiveToolStatus({ calls }: { calls: LiveToolCall[] }) {
  if (calls.length === 0) return null;

  return (
    <div className="live-tool-status">
      {calls.map((call) => (
        <div
          key={call.callId}
          className={`live-tool-item ${call.status}`}
        >
          <span className="live-tool-icon">
            {call.status === "running" ? "◐" : call.status === "success" ? "✓" : "✕"}
          </span>
          <span className="live-tool-name">{formatToolName(call.toolName)}</span>
          {call.argsPreview && (
            <span className="live-tool-args">{call.argsPreview}</span>
          )}
        </div>
      ))}
    </div>
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
            fontSize: "11px",
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

  const allResolved =
    safePlan.proposedActions.length > 0 &&
    safePlan.proposedActions.every(
      (a) => a.status !== "pending" && a.status !== "running"
    );

  const [expanded, setExpanded] = useState(!allResolved);

  const prevAllResolved = useRef(allResolved);
  useEffect(() => {
    if (allResolved && !prevAllResolved.current) {
      setExpanded(false);
    }
    prevAllResolved.current = allResolved;
  }, [allResolved]);

  const approvedCount = safePlan.proposedActions.filter(
    (a) => a.status === "completed"
  ).length;
  const rejectedCount = safePlan.proposedActions.filter(
    (a) => a.status === "rejected"
  ).length;
  const failedCount = safePlan.proposedActions.filter(
    (a) => a.status === "failed"
  ).length;
  const pendingCount = safePlan.proposedActions.filter(
    (a) => a.status === "pending"
  ).length;

  const stateLabel = allResolved ? "已完成" : safePlan.state;

  return (
    <div
      className={`inline-plan${allResolved && !expanded ? " inline-plan-collapsed" : ""}`}
    >
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
            fontSize: "11px",
            transition: "transform 0.2s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            color: "var(--text-3)",
          }}
        >
          ▶
        </span>
        <p className="inline-plan-title" style={{ margin: 0 }}>
          执行计划 · {stateLabel}
        </p>
        {!expanded && safePlan.proposedActions.length > 0 && (
          <span className="plan-summary-badges">
            {approvedCount > 0 && (
              <span className="plan-badge plan-badge-approved">
                ✓ {approvedCount}
              </span>
            )}
            {rejectedCount > 0 && (
              <span className="plan-badge plan-badge-rejected">
                ✕ {rejectedCount}
              </span>
            )}
            {failedCount > 0 && (
              <span className="plan-badge plan-badge-failed">
                ! {failedCount}
              </span>
            )}
            {pendingCount > 0 && (
              <span className="plan-badge plan-badge-pending">
                {pendingCount} 待审批
              </span>
            )}
          </span>
        )}
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
              <span style={{ color: "var(--text-2)", fontSize: "14px" }}>
                {step.summary}
              </span>
            </li>
          ))}
        </ol>
      )}

      {expanded &&
        safePlan.proposedActions.length > 0 &&
        (() => {
          const pendingPatchActions = safePlan.proposedActions.filter(
            (
              a
            ): a is import("../../orchestrator/types").ApplyPatchActionProposal =>
              a.status === "pending" && a.type === "apply_patch"
          );

          const groupIdToPatchActions = new Map<
            string,
            import("../../orchestrator/types").ApplyPatchActionProposal[]
          >();
          for (const action of pendingPatchActions) {
            const groupId = action.group?.groupId;
            if (!groupId) continue;
            const list = groupIdToPatchActions.get(groupId) ?? [];
            list.push(action);
            groupIdToPatchActions.set(groupId, list);
          }

          const groupedPatchActions = Array.from(
            groupIdToPatchActions.entries()
          )
            .map(([groupId, actions]) => ({ groupId, actions }))
            .filter((g) => g.actions.length > 1);

          const ungroupedActions = safePlan.proposedActions.filter((a) => {
            if (a.type !== "apply_patch") return true;
            return (
              !a.group?.groupId ||
              !(groupIdToPatchActions.get(a.group.groupId)?.length ?? 0) ||
              (groupIdToPatchActions.get(a.group.groupId)?.length ?? 0) < 2
            );
          });

          const getAffectedFiles = (
            actions: import("../../orchestrator/types").ApplyPatchActionProposal[]
          ): string[] =>
            Array.from(
              new Set(
                actions.flatMap((a) => {
                  const matches = a.payload.patch.match(
                    /^diff --git a\/(.+?) b\//gm
                  );
                  if (matches) {
                    return matches.map((m: string) =>
                      m
                        .replace(/^diff --git a\//, "")
                        .replace(/ b\/$/, "")
                        .trim()
                    );
                  }
                  const descMatch = a.description.match(
                    /(?:编辑|创建|修改|删除)\s+(.+?)(?:\s|$)/
                  );
                  return descMatch ? [descMatch[1]] : [];
                })
              )
            );

          const renderAtomicStatus = (
            actions: import("../../orchestrator/types").ApplyPatchActionProposal[]
          ) => {
            const meta = actions[0]?.batchExec;
            if (!meta) {
              return (
                <span style={{ marginLeft: "6px", opacity: 0.7 }}>
                  (原子状态：未知)
                </span>
              );
            }
            if (meta.atomicEnabled) {
              return (
                <span style={{ marginLeft: "6px", opacity: 0.7 }}>
                  (原子保护：已启用
                  {meta.snapshotId ? ` · snapshot=${meta.snapshotId}` : ""})
                </span>
              );
            }
            return (
              <span
                style={{ marginLeft: "6px", color: "var(--color-warning)" }}
              >
                (原子保护已降级
                {meta.degradedReason ? `：${meta.degradedReason}` : ""})
              </span>
            );
          };

          return (
            <>
              {/* Grouped patch actions: show as a single batch card */}
              {groupedPatchActions.map((group) => {
                const title = group.actions[0].group?.title ?? "批量变更";
                const affectedFiles = getAffectedFiles(group.actions);
                const rollbackMeta = group.actions[0].batchExec;
                const rollbackBadge = rollbackMeta?.atomicRollbackAttempted
                  ? rollbackMeta.atomicRollbackSuccess
                    ? " · 回滚成功"
                    : " · 回滚失败"
                  : "";

                return (
                  <div key={group.groupId} style={{ marginBottom: "8px" }}>
                    <div
                      style={{
                        fontSize: "13px",
                        color: "var(--text-3)",
                        marginBottom: "6px",
                        padding: "8px 12px",
                        background: "var(--surface-2)",
                        borderRadius: "8px",
                        lineHeight: "1.6",
                        border: "1px solid var(--border-1)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: "8px",
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <strong>{title}</strong>
                          <span style={{ marginLeft: "6px", opacity: 0.7 }}>
                            ({group.actions.length} 个 patch)
                          </span>
                          {renderAtomicStatus(group.actions)}
                          {rollbackBadge && (
                            <span style={{ marginLeft: "6px", opacity: 0.8 }}>
                              {rollbackBadge}
                            </span>
                          )}
                        </div>
                        <div
                          style={{ display: "flex", gap: "8px", flexShrink: 0 }}
                        >
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={Boolean(executingActionId)}
                            onClick={() => void onApproveAll(messageId, plan)}
                            type="button"
                          >
                            ✓ 批量批准
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={Boolean(executingActionId)}
                            onClick={() => onRejectAll(messageId)}
                            type="button"
                          >
                            ✕ 批量拒绝
                          </button>
                        </div>
                      </div>

                      {affectedFiles.length > 0 && (
                        <div style={{ marginTop: "6px" }}>
                          <div style={{ marginBottom: "4px" }}>
                            涉及 {affectedFiles.length} 个文件
                          </div>
                          <div>
                            {affectedFiles.map((f) => (
                              <span
                                key={f}
                                style={{
                                  display: "inline-block",
                                  marginRight: "8px",
                                  fontFamily: "monospace",
                                  fontSize: "12px",
                                }}
                              >
                                📄 {f}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      <details style={{ marginTop: "8px" }}>
                        <summary style={{ cursor: "pointer" }}>
                          展开查看每个 patch
                        </summary>
                        <ul
                          className="action-list"
                          style={{ marginTop: "8px" }}
                        >
                          {group.actions.map((action) => (
                            <li key={action.id} className="action-item">
                              <div className="action-header">
                                <h4 className="action-title">{action.type}</h4>
                                <span
                                  className={actionStatusBadgeClass(
                                    action.status
                                  )}
                                >
                                  {action.status.toUpperCase()}
                                </span>
                              </div>
                              <ActionPayloadFields
                                action={action}
                                messageId={messageId}
                                onPlanUpdate={onPlanUpdate}
                              />
                            </li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  </div>
                );
              })}

              {pendingCount > 1 && groupedPatchActions.length === 0 && (
                <div style={{ marginBottom: "8px" }}>
                  {(() => {
                    const batchAffectedFiles =
                      getAffectedFiles(pendingPatchActions);
                    return (
                      batchAffectedFiles.length > 0 && (
                        <div
                          style={{
                            fontSize: "13px",
                            color: "var(--text-3)",
                            marginBottom: "6px",
                            padding: "6px 10px",
                            background: "var(--surface-2)",
                            borderRadius: "6px",
                            lineHeight: "1.6",
                          }}
                        >
                          <strong>
                            批量变更涉及 {batchAffectedFiles.length} 个文件
                          </strong>
                          {pendingPatchActions.length > 1 && (
                            <span style={{ marginLeft: "4px", opacity: 0.7 }}>
                              (原子执行：全部成功或全部回滚)
                            </span>
                          )}
                          <div style={{ marginTop: "2px" }}>
                            {batchAffectedFiles.map((f) => (
                              <span
                                key={f}
                                style={{
                                  display: "inline-block",
                                  marginRight: "8px",
                                  fontFamily: "monospace",
                                  fontSize: "12px",
                                }}
                              >
                                📄 {f}
                              </span>
                            ))}
                          </div>
                        </div>
                      )
                    );
                  })()}
                  <div style={{ display: "flex", gap: "8px" }}>
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
                </div>
              )}

              <ul className="action-list">
                {ungroupedActions.map((action) => (
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

/* ── Token Usage Ring ─────────────────────────────────────── */
function TokenUsageRing({
  used,
  max,
  isStreaming,
}: {
  used: number;
  max: number;
  isStreaming: boolean;
}) {
  const percentage = Math.min(100, Math.max(0, (used / max) * 100));
  const size = 16;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - percentage / 100);

  // Color based on usage level
  const getColor = () => {
    if (percentage >= 90) return "var(--color-error)";
    if (percentage >= 70) return "var(--color-warning)";
    return "var(--color-success, #10b981)";
  };

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
    return String(tokens);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "13px",
        color: "var(--text-3)",
      }}
      title={`${isStreaming ? "预估" : "已用"} ${used.toLocaleString()} / ${max.toLocaleString()} tokens (${percentage.toFixed(1)}%)`}
    >
      <svg
        width={size}
        height={size}
        style={{ transform: "rotate(-90deg)" }}
      >
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border-2, #333)"
          strokeWidth={strokeWidth}
        />
        {/* Progress circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={getColor()}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          style={{
            transition: isStreaming ? "none" : "stroke-dashoffset 0.3s ease",
          }}
        />
      </svg>
      <span>{formatTokens(used)}</span>
    </div>
  );
}

/* ── Main ChatPage ────────────────────────────────────────── */
export function ChatPage({ settings, activeAgent, isVisible, sidebarCollapsed, onToggleSidebar }: ChatPageProps): ReactElement {
  const { actions: session } = useSession();

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
  const [_sidebarOpenLegacy] = useState<boolean>(false);
  const [liveToolCalls, setLiveToolCalls] = useState<LiveToolCall[]>([]);
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
    onConfirm: () => {},
  });
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessageRecord[]>(
    currentConversation?.messages ?? []
  );
  const lastPromptRef = useRef<string>("");
  const threadRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const activeConversationIdRef = useRef<string | null>(activeConversationId);
  const backgroundStreamsRef = useRef(new Map<string, BackgroundStreamState>());
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const skipNextTimestampRef = useRef(true);

  const activeManagedModel = getActiveManagedModel(settings);
  const activeModelLabel = activeManagedModel?.name || settings.model;
  const localOnlyBlocked =
    !settings.allowCloudModels && !isActiveModelLocal(settings);
  const noWorkspaceSelected = !settings.workspacePath;
  const chatBlocked = localOnlyBlocked || noWorkspaceSelected;

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  // Recover from invalid/missing active conversation on startup.
  // Without this, the first submit may clear input but not send.
  useEffect(() => {
    if (currentConversation || conversations.length === 0) {
      return;
    }

    const preferredId =
      activeConversationId &&
      conversations.some((conversation) => conversation.id === activeConversationId)
        ? activeConversationId
        : conversations[0].id;
    const recoveredConversation = loadConversation(wsPath, preferredId);
    if (!recoveredConversation) {
      return;
    }

    skipNextTimestampRef.current = true;
    activeConversationIdRef.current = recoveredConversation.id;
    setCurrentConversation(recoveredConversation);
    setActiveConversationIdState(recoveredConversation.id);
    setActiveConversationId(wsPath, recoveredConversation.id);
    setMessages(recoveredConversation.messages);
    messagesRef.current = recoveredConversation.messages;
    setLiveContextTokens(recoveredConversation.lastTokenCount ?? null);
    setSessionNote(recoveredConversation.messages.length ? "已恢复历史会话" : "");
    setCategorizedError(null);
    setLiveToolCalls([]);
    setIsStreaming(false);
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
    const conv = activeId ? loadConversation(wsPath, activeId) : null;

    if (conv) {
      setCurrentConversation(conv);
      setActiveConversationIdState(conv.id);
      setMessages(conv.messages);
      messagesRef.current = conv.messages;
      setLiveContextTokens(conv.lastTokenCount ?? null);
      setSessionNote(conv.messages.length ? "已切换工作区" : "");
    } else if (list.length > 0) {
      const first = loadConversation(wsPath, list[0].id);
      if (first) {
        setCurrentConversation(first);
        setActiveConversationIdState(first.id);
        setActiveConversationId(wsPath, first.id);
        setMessages(first.messages);
        messagesRef.current = first.messages;
        setLiveContextTokens(first.lastTokenCount ?? null);
        setSessionNote("已切换工作区");
      }
    } else if (wsPath) {
      const newConversation = createConversation(wsPath, []);
      setConversations(loadConversationList(wsPath));
      setCurrentConversation(newConversation);
      setActiveConversationIdState(newConversation.id);
      setActiveConversationId(wsPath, newConversation.id);
      setMessages([]);
      messagesRef.current = [];
      setLiveContextTokens(null);
      setSessionNote("");
    } else {
      setCurrentConversation(null);
      setActiveConversationIdState(null);
      setMessages([]);
      messagesRef.current = [];
      setLiveContextTokens(null);
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
      for (const ctrl of abortControllersRef.current.values()) {
        ctrl.abort();
      }
    },
    []
  );

  useEffect(() => {
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
    const { settings: executionSettings, selection: executionSelection, snapshots } =
      await buildExecutionSettings(settings, activeAgent, currentConversation);

    let conversationForRun = currentConversation;
    let convBinding = conversationForRun?.agentBinding ?? null;
    if (!convBinding && conversationForRun && executionSelection) {
      convBinding = createAgentBinding(
        activeAgent.id,
        executionSelection,
        "default",
        activeAgent.name,
        snapshots,
      );
      conversationForRun = {
        ...conversationForRun,
        agentBinding: convBinding,
      };
      skipNextTimestampRef.current = true;
      saveConversation(wsPath, conversationForRun);
      setCurrentConversation(conversationForRun);
      setConversations(loadConversationList(wsPath));
    }
    const streamConvId = conversationForRun?.id ?? null;
    if (!streamConvId) return;

    const visibleUserMessage = options.visibleUserMessage !== false;
    if (visibleUserMessage) {
      resetHitlContinuationMemory(getChatSessionId());
    }
    const controller = new AbortController();
    abortControllersRef.current.set(streamConvId, controller);
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

    if (visibleUserMessage) {
      const userMsg: ChatMessageRecord = {
        id: createMessageId("user"),
        role: "user",
        content: promptText,
        createdAt: now,
        plan: null,
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
    setSessionNote("正在回复…");
    setLiveToolCalls([]);
    setLiveContextTokens(null);
    session.setWorkflowPhase("planning");

    try {
      const result = await runPlanningSession({
        prompt: promptText,
        settings: executionSettings,
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
            guardedSetToolCalls((prev) => [
              ...prev,
              {
                callId: event.callId,
                toolName: event.toolName,
                argsPreview: event.argsPreview,
                status: "running",
              },
            ]);
          } else {
            guardedSetToolCalls((prev) =>
              prev.map((call) =>
                call.callId === event.callId
                  ? {
                      ...call,
                      status: event.result === "success" ? "success" : "failed",
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
      });

      if (localRafId !== null) {
        cancelAnimationFrame(localRafId);
        localRafId = null;
      }
      localStreamBuffer = "";

      guardedSetMessages((prev) =>
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

      session.updatePlan(result.assistantReply);
      session.appendToolTraces(result.toolTrace ?? []);
      session.appendRequestSummary({
        requestId: `chat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        model: activeModelLabel,
        timestamp: new Date().toISOString(),
        inputTokens: result.tokenUsage.inputTokens,
        outputTokens: result.tokenUsage.outputTokens,
        durationMs: Date.now() - new Date(now).getTime(),
      });
      guardedSetTokens(result.tokenUsage.inputTokens + result.tokenUsage.outputTokens);
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
        guardedSetNote(
          `审批点未保存：${err instanceof Error ? err.message : "未知错误"}`
        )
      );

      guardedSetNote(
        result.plan.proposedActions.length > 0
          ? "已进入 HITL 审批阶段，请逐项审批"
          : "回复完成"
      );
    } catch (error) {
      if (controller.signal.aborted) {
        guardedSetMessages((prev) =>
          prev.filter(
            (m) => m.id !== assistantMessageId || m.content.trim() !== ""
          )
        );
        guardedSetNote("已取消");
        return;
      }
      guardedSetError(classifyError(error));
      guardedSetMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
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

    const previousSessionId = getChatSessionId();
    resetChatSessionId();
    resetHitlContinuationMemory(previousSessionId);
    resetHitlContinuationMemory(getChatSessionId());

    // Clear current conversation messages
    const clearedConversation: Conversation = {
      ...currentConversation,
      messages: [],
      lastTokenCount: null,
      updatedAt: new Date().toISOString(),
    };
    saveConversation(wsPath, clearedConversation);
    setCurrentConversation(clearedConversation);
    setMessages([]);
    setLiveContextTokens(null);
    setCategorizedError(null);
    setSessionNote("");
    setConversations(loadConversationList(wsPath));
  };

  const snapshotToBackground = () => {
    if (isStreaming && activeConversationId) {
      backgroundStreamsRef.current.set(activeConversationId, {
        messages: [...messagesRef.current],
        isStreaming: true,
        tokenCount: liveContextTokens,
        sessionNote,
        liveToolCalls: [...liveToolCalls],
        error: categorizedError,
      });
    }
  };

  const restoreConversationView = (conv: Conversation) => {
    const bg = backgroundStreamsRef.current.get(conv.id);
    if (bg) {
      setMessages(bg.messages);
      messagesRef.current = bg.messages;
      setLiveContextTokens(bg.tokenCount);
      setIsStreaming(bg.isStreaming);
      setSessionNote(bg.sessionNote);
      setLiveToolCalls(bg.liveToolCalls);
      setCategorizedError(bg.error);
      backgroundStreamsRef.current.delete(conv.id);
    } else {
      setMessages(conv.messages);
      messagesRef.current = conv.messages;
      setLiveContextTokens(conv.lastTokenCount ?? null);
      setIsStreaming(false);
      setCategorizedError(null);
      setSessionNote(conv.messages.length ? "已切换对话" : "");
      setLiveToolCalls([]);
    }
  };

  // Conversation management handlers
  const handleNewConversation = (): void => {
    if (Boolean(executingActionId)) return;

    snapshotToBackground();

    const selection = resolveConversationModelSelection(settings, activeAgent, null);
    const resolvedSelection = selection
      ? resolveManagedModelSelection(settings, selection)
      : null;
    const binding = selection
      ? createAgentBinding(activeAgent.id, selection, "default", activeAgent.name, {
          vendorName: resolvedSelection?.vendor.name,
          modelName: resolvedSelection?.managedModel.name,
        })
      : undefined;
    const newConv = createConversation(wsPath, [], binding);
    skipNextTimestampRef.current = true;
    activeConversationIdRef.current = newConv.id;
    setCurrentConversation(newConv);
    setActiveConversationIdState(newConv.id);
    setMessages([]);
    messagesRef.current = [];
    setLiveContextTokens(null);
    setIsStreaming(false);
    setCategorizedError(null);
    setSessionNote("");
    setLiveToolCalls([]);
    setConversations(loadConversationList(wsPath));

    const previousSessionId = getChatSessionId();
    resetChatSessionId();
    resetHitlContinuationMemory(previousSessionId);
    resetHitlContinuationMemory(getChatSessionId());
  };

  const handleSelectConversation = (conversationId: string): void => {
    if (Boolean(executingActionId)) return;
    if (conversationId === activeConversationId) return;

    snapshotToBackground();

    const conv = loadConversation(wsPath, conversationId);
    if (!conv) return;

    skipNextTimestampRef.current = true;
    activeConversationIdRef.current = conversationId;
    setCurrentConversation(conv);
    setActiveConversationIdState(conv.id);
    setActiveConversationId(wsPath, conv.id);

    restoreConversationView(conv);

    const previousSessionId = getChatSessionId();
    resetChatSessionId();
    resetHitlContinuationMemory(previousSessionId);
    resetHitlContinuationMemory(getChatSessionId());
  };

  const handleDeleteConversation = (conversationId: string): void => {
    const isConvStreaming =
      (conversationId === activeConversationId && isStreaming) ||
      backgroundStreamsRef.current.get(conversationId)?.isStreaming;
    if (isConvStreaming || Boolean(executingActionId)) return;

    abortControllersRef.current.get(conversationId)?.abort();
    abortControllersRef.current.delete(conversationId);
    backgroundStreamsRef.current.delete(conversationId);

    const wasActiveConversation = conversationId === activeConversationId;

    deleteConversation(wsPath, conversationId);
    const updatedList = loadConversationList(wsPath);
    setConversations(updatedList);

    if (wasActiveConversation) {
      if (updatedList.length > 0) {
        const nextConversation = loadConversation(wsPath, updatedList[0].id);
        if (nextConversation) {
          activeConversationIdRef.current = nextConversation.id;
          setCurrentConversation(nextConversation);
          setActiveConversationIdState(nextConversation.id);
          setActiveConversationId(wsPath, nextConversation.id);

          restoreConversationView(nextConversation);

          const previousSessionId = getChatSessionId();
          resetChatSessionId();
          resetHitlContinuationMemory(previousSessionId);
          resetHitlContinuationMemory(getChatSessionId());
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
    textareaRef.current?.focus();
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
                      isStreaming &&
                      message === messages[messages.length - 1] &&
                      liveToolCalls.length > 0 && (
                        <LiveToolStatus calls={liveToolCalls} />
                      )}
                    {message.role === "assistant" &&
                      (message.toolTrace?.length ?? 0) > 0 && (
                        <ToolTracePanel traces={message.toolTrace!} />
                      )}
                    {message.plan &&
                      message.plan.proposedActions.length > 0 && (
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
                      : "描述你的编码任务…  Enter 发送，Shift+Enter 换行"
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
    </div>
  );
}
