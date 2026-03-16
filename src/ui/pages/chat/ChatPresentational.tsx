import { Children, memo, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark";
import { DiffViewer } from "../../components/DiffViewer";
import { ShellResultDisplay } from "../../components/ShellResultDisplay";
import {
  actionStatusBadgeClass,
  canApproveAction,
  canCancelAction,
  canRetryAction,
  canReviewAction,
} from "../../utils/chatUtils";
import { updateActionPayload } from "../../../orchestrator/hitlService";
import {
  buildApprovalRuleOptions,
  type ApprovalRuleOption,
} from "../../../lib/approvalRuleStore";
import type { ChatContextAttachment } from "../../../lib/contextAttachments";
import type { ToolExecutionTrace } from "../../../orchestrator/planningService";
import type {
  ActionProposal,
  ApplyPatchActionProposal,
  OrchestrationPlan,
} from "../../../orchestrator/types";
import type { LiveToolCall, SubAgentStatusItem } from "./types";
import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import { copyTextToClipboard } from "../../../lib/clipboard";
import { formatToolName } from "./helpers";

function CodeBlockWithCopy({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "success" | "error">("idle");

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const timer = window.setTimeout(() => setCopyState("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const copy = async () => {
    try {
      await copyTextToClipboard(code);
      setCopyState("success");
    } catch {
      setCopyState("error");
    }
  };

  const copyLabel =
    copyState === "success"
      ? "已复制"
      : copyState === "error"
        ? "复制失败"
        : "复制";

  return (
    <div className="chat-code-block-wrapper">
      <div className="chat-code-block-header">
        <span className="chat-code-block-lang">{language || "plaintext"}</span>
        <button
          type="button"
          className="chat-code-block-copy"
          onClick={copy}
          aria-label={copyLabel}
          title={copyLabel}
        >
          {copyLabel}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || "text"}
        style={oneDark}
        PreTag="div"
        codeTagProps={{ className: "chat-code-block-inner" }}
        showLineNumbers={false}
        customStyle={{
          margin: 0,
          padding: "12px 14px",
          background: "var(--surface-0)",
          borderRadius: "0 0 var(--r-sm) var(--r-sm)",
          fontSize: "13px",
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

function getMarkdownCodeBlockComponents(): import("react-markdown").Components {
  return {
    pre({ children }) {
      const child = Children.only(children) as React.ReactElement<{
        className?: string;
        children?: React.ReactNode;
      }>;
      const className = child?.props?.className ?? "";
      const match = /language-(\w+)/.exec(className);
      const language = match ? match[1] : "text";
      const code = String(child?.props?.children ?? "").replace(/\n$/, "");
      return (
        <CodeBlockWithCopy code={code} language={language} />
      );
    },
  };
}

const markdownCodeBlockComponents = getMarkdownCodeBlockComponents();

export function ContextAttachmentPills({
  attachments,
  onRemove,
  compact = false,
}: {
  attachments: ChatContextAttachment[];
  onRemove?: (attachmentId: string) => void;
  compact?: boolean;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className={`chat-context-pills${compact ? " compact" : ""}`}>
      {attachments.map((attachment) => (
        <span key={attachment.id} className="chat-context-pill">
          <span className="chat-context-pill-prefix">@</span>
          <span className="chat-context-pill-label" title={attachment.relativePath}>
            {attachment.relativePath}{attachment.kind === "folder" ? "/" : ""}
          </span>
          {onRemove && (
            <button
              type="button"
              className="chat-context-pill-remove"
              onClick={() => onRemove(attachment.id)}
              aria-label={`移除 ${attachment.relativePath}`}
              title={`移除 ${attachment.relativePath}`}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

export const MessageContent = memo(function MessageContent({
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

  if (isStreaming && role === "assistant") {
    const partialTagMatch = remaining.match(/<\/?t(?:h(?:i(?:n(?:k)?)?)?)?$/);
    if (partialTagMatch) {
      remaining = remaining.slice(
        0,
        remaining.length - partialTagMatch[0].length,
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
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={markdownCodeBlockComponents}
              >
                {part.content}
              </Markdown>
            </div>
          </details>
        ) : (
          <div key={i} className="chat-markdown">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={markdownCodeBlockComponents}
            >
              {part.content}
            </Markdown>
          </div>
        ),
      )}
    </>
  );
});

export function LiveToolStatus({ calls }: { calls: LiveToolCall[] }) {
  if (calls.length === 0) return null;

  return (
    <div className="live-tool-status">
      {calls.map((call) => {
        const icon =
          call.status === "running"
            ? "◐"
            : call.status === "success"
              ? "✓"
              : call.status === "pending_approval"
                ? "⏸"
                : call.status === "waiting_for_user"
                  ? "?"
                  : "✕";
        const label =
          call.status === "pending_approval"
            ? `${formatToolName(call.toolName)} · 待审批`
            : call.status === "waiting_for_user"
              ? `${formatToolName(call.toolName)} · 等待您的输入`
              : formatToolName(call.toolName);
        return (
          <div key={call.callId} className={`live-tool-item ${call.status}`}>
            <span className="live-tool-icon">{icon}</span>
            <span className="live-tool-name">{label}</span>
            {call.argsPreview && (
              <span className="live-tool-args">{call.argsPreview}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AssistantToolCalls({
  toolCalls,
}: {
  toolCalls?: ChatMessageRecord["tool_calls"];
}) {
  if (!toolCalls?.length) {
    return null;
  }

  return (
    <div className="tool-trace" style={{ marginTop: "8px" }}>
      <p className="tool-trace-label" style={{ margin: "0 0 8px 0" }}>
        模型工具调用 · {toolCalls.length} 次
      </p>
      <ul className="tool-trace-list">
        {toolCalls.map((toolCall) => (
          <li key={toolCall.id} className="tool-trace-item success">
            <div className="tool-trace-head">
              <span className="tool-trace-name">
                {formatToolName(toolCall.function.name)}
              </span>
              <span className={actionStatusBadgeClass("pending")}>
                REQUESTED
              </span>
            </div>
            <pre className="tool-trace-preview">{toolCall.function.arguments}</pre>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SubAgentStatusPanel({
  items,
}: {
  items: SubAgentStatusItem[];
}) {
  if (items.length === 0) return null;

  return (
    <div className="live-tool-status" style={{ marginBottom: 4 }}>
      {items.map((item) => {
        const event = item.lastEvent;
        let label = "";
        let icon = "◐";
        if (event.kind === "tool_start") {
          label = `${item.role}: ${event.toolName}...`;
        } else if (event.kind === "tool_complete") {
          label = `${item.role}: ${event.toolName} ${event.success ? "✓" : "✕"} (${event.durationMs}ms)`;
          icon = event.success ? "✓" : "✕";
        } else if (event.kind === "summary") {
          label = `${item.role}: ${event.message}`;
          icon = "ℹ";
        } else if (event.kind === "action_proposed") {
          label = `${item.role}: 提出 ${event.actionType}`;
          icon = "⚑";
        }
        return (
          <div key={item.role} className="live-tool-item running">
            <span className="live-tool-icon">{icon}</span>
            <span className="live-tool-name">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ToolTracePanel({ traces }: { traces: ToolExecutionTrace[] }) {
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
              className={`tool-trace-item ${trace.status === "pending_approval" ? "pending" : trace.status === "waiting_for_user" ? "pending" : trace.status}`}
            >
              <div className="tool-trace-head">
                <span className="tool-trace-name">{trace.name}</span>
                <span className={actionStatusBadgeClass(trace.status)}>
                  {trace.status.toUpperCase()}
                  {trace.retried ? " · retried" : ""}
                </span>
              </div>
              {trace.status === "pending_approval" && (
                <p className="status-note">
                  该工具调用仅创建了待审批动作，尚未实际执行。
                </p>
              )}
              {trace.status === "waiting_for_user" && (
                <p className="status-note">
                  正在等待用户输入，请在弹出的对话框中回答问题。
                </p>
              )}
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

function ActionPayloadFields({
  action,
  messageId,
  onPlanUpdate,
}: {
  action: ActionProposal;
  messageId: string;
  onPlanUpdate: (
    messageId: string,
    updater: (p: OrchestrationPlan) => OrchestrationPlan,
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
                  updateActionPayload(p, action.id, { patch: e.target.value }),
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
    const hasShellOutput = Boolean(
      action.executionResult &&
      (
        meta?.stdout !== undefined ||
        meta?.stderr !== undefined ||
        meta?.stdoutTotalBytes !== undefined ||
        meta?.stdout_total_bytes !== undefined ||
        meta?.stderrTotalBytes !== undefined ||
        meta?.stderr_total_bytes !== undefined
      ),
    );
    const statusLabel =
      action.status === "running"
        ? "RUNNING"
        : action.status === "background"
          ? "BACKGROUND"
          : undefined;
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
              timedOut={Boolean(meta?.timedOut ?? meta?.timed_out)}
              stdoutTruncated={Boolean(meta?.stdoutTruncated ?? meta?.stdout_truncated)}
              stderrTruncated={Boolean(meta?.stderrTruncated ?? meta?.stderr_truncated)}
              stdoutTotalBytes={Number(meta?.stdoutTotalBytes ?? meta?.stdout_total_bytes ?? 0)}
              stderrTotalBytes={Number(meta?.stderrTotalBytes ?? meta?.stderr_total_bytes ?? 0)}
              statusLabel={statusLabel}
            />
          </div>
        )}
      </div>
    );
  }

  return null;
}

function getAffectedFiles(actions: ApplyPatchActionProposal[]): string[] {
  return Array.from(
    new Set(
      actions.flatMap((action) => {
        const matches = action.payload.patch.match(/^diff --git a\/(.+?) b\//gm);
        if (matches) {
          return matches.map((match) =>
            match.replace(/^diff --git a\//, "").replace(/ b\/$/, "").trim(),
          );
        }
        const descMatch = action.description.match(
          /(?:编辑|创建|修改|删除)\s+(.+?)(?:\s|$)/,
        );
        return descMatch ? [descMatch[1]] : [];
      }),
    ),
  );
}

function renderAtomicStatus(actions: ApplyPatchActionProposal[]) {
  const meta = actions[0]?.batchExec;
  if (!meta) {
    return <span style={{ marginLeft: "6px", opacity: 0.7 }}>(原子状态：未知)</span>;
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
    <span style={{ marginLeft: "6px", color: "var(--color-warning)" }}>
      (原子保护已降级
      {meta.degradedReason ? `：${meta.degradedReason}` : ""})
    </span>
  );
}

function ActionBatchMeta({ action }: { action: ActionProposal }) {
  if (action.type !== "apply_patch" || (!action.group && !action.batchExec)) {
    return null;
  }

  return (
    <div className="plan-action-meta">
      {action.group?.title ? <span>批次：{action.group.title}</span> : null}
      {action.batchExec?.atomicEnabled ? (
        <span>原子保护已启用</span>
      ) : action.batchExec ? (
        <span>原子保护已降级</span>
      ) : null}
      {action.batchExec?.atomicRollbackAttempted ? (
        <span>
          回滚
          {action.batchExec.atomicRollbackSuccess ? "成功" : "失败"}
        </span>
      ) : null}
    </div>
  );
}

function PlanActionCard({
  action,
  plan,
  messageId,
  executingActionId,
  onPlanUpdate,
  onApprove,
  onRetry,
  onReject,
  onComment,
  onCancel,
  activeShellActionIds,
}: {
  action: ActionProposal;
  plan: OrchestrationPlan;
  messageId: string;
  executingActionId: string;
  activeShellActionIds: string[];
  onPlanUpdate: (
    messageId: string,
    updater: (p: OrchestrationPlan) => OrchestrationPlan,
  ) => void;
  onApprove: (
    messageId: string,
    actionId: string,
    plan: OrchestrationPlan,
    rememberOption?: ApprovalRuleOption,
  ) => Promise<void>;
  onRetry: (
    messageId: string,
    actionId: string,
    plan: OrchestrationPlan,
  ) => Promise<void>;
  onReject: (messageId: string, actionId: string) => void;
  onComment: (messageId: string, actionId: string) => void;
  onCancel: (messageId: string, actionId: string) => Promise<void>;
}) {
  const approvalOptions = buildApprovalRuleOptions(action);
  const [rememberOptionKey, setRememberOptionKey] = useState("");
  const selectedRememberOption = approvalOptions.find(
    (option) => option.key === rememberOptionKey,
  );
  const hasActiveShellJob = activeShellActionIds.includes(action.id);
  const isCancelling = executingActionId === `cancel:${action.id}`;

  return (
    <li className="action-item">
      <div className="action-header">
        <h4 className="action-title">{action.type}</h4>
        <span className={actionStatusBadgeClass(action.status)}>
          {action.status.toUpperCase()}
          {action.executed ? " · Executed" : ""}
        </span>
      </div>

      <ActionBatchMeta action={action} />

      <ActionPayloadFields
        action={action}
        messageId={messageId}
        onPlanUpdate={onPlanUpdate}
      />

      {action.executionResult && (
        <p
          className={
            action.status === "running" || action.status === "background"
              ? "status-note"
              : action.executionResult.success
              ? "status-success"
              : "status-error"
          }
        >
          {action.executionResult.message}
        </p>
      )}

      <div className="action-footer">
        {canApproveAction(action) && approvalOptions.length > 0 && (
          <select
            className="select action-approval-select"
            disabled={Boolean(executingActionId)}
            onChange={(event) => setRememberOptionKey(event.target.value)}
            value={rememberOptionKey}
          >
            <option value="">仅本次批准</option>
            {approvalOptions.map((option) => (
              <option key={option.key} value={option.key}>
                当前工作区始终允许：{option.label}
              </option>
            ))}
          </select>
        )}
        {canApproveAction(action) && (
          <button
            className="btn btn-primary btn-sm"
            disabled={Boolean(executingActionId)}
            onClick={() =>
              void onApprove(messageId, action.id, plan, selectedRememberOption)
            }
            type="button"
          >
            {executingActionId === action.id
              ? "执行中…"
              : selectedRememberOption
                ? "✓ 批准并记住"
                : "✓ 批准"}
          </button>
        )}
        {canRetryAction(action) && (
          <button
            className="btn btn-primary btn-sm"
            disabled={Boolean(executingActionId)}
            onClick={() => void onRetry(messageId, action.id, plan)}
            type="button"
          >
            {executingActionId === action.id ? "重试中…" : "↻ 重试命令"}
          </button>
        )}
        {canCancelAction(action, hasActiveShellJob) && (
          <button
            className="btn btn-ghost btn-sm"
            disabled={Boolean(executingActionId)}
            onClick={() => void onCancel(messageId, action.id)}
            type="button"
          >
            {isCancelling ? "取消中…" : "■ 取消命令"}
          </button>
        )}
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
  );
}

export function InlinePlan({
  plan,
  messageId,
  executingActionId,
  onPlanUpdate,
  onApprove,
  onRetry,
  onReject,
  onComment,
  onCancel,
  onApproveAll,
  onRejectAll,
  activeShellActionIds,
}: {
  plan: OrchestrationPlan;
  messageId: string;
  executingActionId: string;
  activeShellActionIds: string[];
  onPlanUpdate: (
    messageId: string,
    updater: (p: OrchestrationPlan) => OrchestrationPlan,
  ) => void;
  onApprove: (
    messageId: string,
    actionId: string,
    plan: OrchestrationPlan,
    rememberOption?: ApprovalRuleOption,
  ) => Promise<void>;
  onRetry: (
    messageId: string,
    actionId: string,
    plan: OrchestrationPlan,
  ) => Promise<void>;
  onReject: (messageId: string, actionId: string) => void;
  onComment: (messageId: string, actionId: string) => void;
  onCancel: (messageId: string, actionId: string) => Promise<void>;
  onApproveAll: (messageId: string, plan: OrchestrationPlan) => Promise<void>;
  onRejectAll: (messageId: string) => void;
}) {
  const safePlan: OrchestrationPlan = {
    ...plan,
    steps: Array.isArray(plan.steps)
      ? plan.steps.map((step, index) => ({
        ...step,
        title:
          typeof step.title === "string" && step.title.trim()
            ? step.title
            : step.summary || `步骤 ${index + 1}`,
        summary: step.summary || step.title || `步骤 ${index + 1}`,
        status: step.status || "pending",
        linkedActionIds: Array.isArray(step.linkedActionIds)
          ? step.linkedActionIds
          : [],
      }))
      : [],
    proposedActions: Array.isArray(plan.proposedActions)
      ? plan.proposedActions
      : [],
  };

  const allStepsResolved =
    safePlan.steps.length > 0 &&
    safePlan.steps.every(
      (step) =>
        step.status === "completed" ||
        step.status === "failed" ||
        step.status === "skipped",
    );
  const allResolved =
    (safePlan.proposedActions.length === 0 ||
      safePlan.proposedActions.every(
        (action) => action.status !== "pending" && action.status !== "running",
      )) &&
    (safePlan.steps.length === 0 || allStepsResolved);

  const [expanded, setExpanded] = useState(!allResolved);

  const prevAllResolved = useRef(allResolved);
  useEffect(() => {
    if (allResolved && !prevAllResolved.current) {
      setExpanded(false);
    }
    prevAllResolved.current = allResolved;
  }, [allResolved]);

  const approvedCount = safePlan.proposedActions.filter(
    (action) => action.status === "completed",
  ).length;
  const rejectedCount = safePlan.proposedActions.filter(
    (action) => action.status === "rejected",
  ).length;
  const failedCount = safePlan.proposedActions.filter(
    (action) => action.status === "failed",
  ).length;
  const pendingCount = safePlan.proposedActions.filter(
    (action) => action.status === "pending",
  ).length;
  const todoCompletedCount = safePlan.steps.filter(
    (step) => step.status === "completed" || step.status === "skipped",
  ).length;
  const todoBlockedCount = safePlan.steps.filter(
    (step) => step.status === "blocked" || step.status === "failed",
  ).length;
  const todoInProgressCount = safePlan.steps.filter(
    (step) => step.status === "in_progress",
  ).length;
  const actionsByStepId = safePlan.proposedActions.reduce((acc, action) => {
    if (!action.planStepId) {
      return acc;
    }
    const current = acc.get(action.planStepId) ?? [];
    current.push(action);
    acc.set(action.planStepId, current);
    return acc;
  }, new Map<string, ActionProposal[]>());
  const actionCountByStepId = Array.from(actionsByStepId.entries()).reduce(
    (acc, [stepId, actions]) => acc.set(stepId, actions.length),
    new Map<string, number>(),
  );

  const stateLabel = allResolved ? "已完成" : safePlan.state;
  const pendingPatchActions = safePlan.proposedActions.filter(
    (action): action is ApplyPatchActionProposal =>
      action.status === "pending" && action.type === "apply_patch",
  );
  const unlinkedActions = safePlan.proposedActions.filter(
    (action) => !action.planStepId,
  );

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
        {!expanded && (safePlan.proposedActions.length > 0 || safePlan.steps.length > 0) && (
          <span className="plan-summary-badges">
            {safePlan.steps.length > 0 && (
              <span className="plan-badge">
                {todoCompletedCount}/{safePlan.steps.length} 已完成
              </span>
            )}
            {todoInProgressCount > 0 && (
              <span className="plan-badge plan-badge-pending">{todoInProgressCount} 进行中</span>
            )}
            {todoBlockedCount > 0 && (
              <span className="plan-badge plan-badge-failed">{todoBlockedCount} 阻塞</span>
            )}
            {approvedCount > 0 && (
              <span className="plan-badge plan-badge-approved">✓ {approvedCount}</span>
            )}
            {rejectedCount > 0 && (
              <span className="plan-badge plan-badge-rejected">✕ {rejectedCount}</span>
            )}
            {failedCount > 0 && (
              <span className="plan-badge plan-badge-failed">! {failedCount}</span>
            )}
            {pendingCount > 0 && (
              <span className="plan-badge plan-badge-pending">{pendingCount} 待审批</span>
            )}
          </span>
        )}
      </div>

      {expanded && safePlan.steps.length > 0 && (
        <ol className="plan-step-list">
          {safePlan.steps.map((step) => {
            const stepActions = actionsByStepId.get(step.id) ?? [];
            return (
              <li
                key={step.id}
                className={`plan-item plan-step plan-step-${step.status}${step.id === safePlan.activeStepId ? " is-active" : ""}`}
              >
                <div className="plan-step-header">
                  <span className="plan-step-title">
                    {step.title}
                    {step.id === safePlan.activeStepId ? " · 当前" : ""}
                  </span>
                  <span className={`plan-badge plan-step-status plan-step-status-${step.status}`}>
                    {step.status}
                  </span>
                </div>
                <div className="plan-step-summary">{step.summary}</div>
                <div className="plan-step-meta">
                  <span>{step.owner}</span>
                  {actionCountByStepId.get(step.id) ? (
                    <span>{actionCountByStepId.get(step.id)} 个关联动作</span>
                  ) : null}
                  {step.dependsOn?.length ? <span>依赖 {step.dependsOn.length} 项</span> : null}
                </div>
                {step.note?.trim() && (
                  <div className="plan-step-note">{step.note.trim()}</div>
                )}
                {stepActions.length > 0 && (
                  <div className="plan-step-actions">
                    <div className="plan-section-label">
                      关联动作 · {stepActions.length}
                    </div>
                    <ul className="action-list plan-step-action-list">
                      {stepActions.map((action) => (
                        <PlanActionCard
                          key={action.id}
                          action={action}
                          plan={safePlan}
                          messageId={messageId}
                          executingActionId={executingActionId}
                          onPlanUpdate={onPlanUpdate}
                          onApprove={onApprove}
                          onRetry={onRetry}
                          onReject={onReject}
                          onComment={onComment}
                          onCancel={onCancel}
                          activeShellActionIds={activeShellActionIds}
                        />
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {expanded && safePlan.proposedActions.length > 0 && (
        <>
          {pendingCount > 1 && (
            <div style={{ marginBottom: "8px" }}>
              {(() => {
                const batchAffectedFiles = getAffectedFiles(pendingPatchActions);
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
                      {pendingPatchActions.length > 1 && renderAtomicStatus(pendingPatchActions)}
                      <div style={{ marginTop: "2px" }}>
                        {batchAffectedFiles.map((file) => (
                          <span
                            key={file}
                            style={{
                              display: "inline-block",
                              marginRight: "8px",
                              fontFamily: "monospace",
                              fontSize: "12px",
                            }}
                          >
                            📄 {file}
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
                  onClick={() => void onApproveAll(messageId, safePlan)}
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

          {unlinkedActions.length > 0 && (
            <div className="plan-action-section">
              <div className="plan-section-label">
                未关联动作 · {unlinkedActions.length}
              </div>
              <ul className="action-list">
                {unlinkedActions.map((action) => (
                  <PlanActionCard
                    key={action.id}
                    action={action}
                    plan={safePlan}
                    messageId={messageId}
                    executingActionId={executingActionId}
                    onPlanUpdate={onPlanUpdate}
                    onApprove={onApprove}
                    onRetry={onRetry}
                    onReject={onReject}
                    onComment={onComment}
                    onCancel={onCancel}
                    activeShellActionIds={activeShellActionIds}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function TokenUsageRing({
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
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border-2, #333)"
          strokeWidth={strokeWidth}
        />
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
