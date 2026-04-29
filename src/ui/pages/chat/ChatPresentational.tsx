import { Children, memo, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark";
import { DiffViewer } from "../../components/DiffViewer";
import { FloatingMenu } from "../../components/FloatingMenu";
import { ShellResultDisplay } from "../../components/ShellResultDisplay";
import {
  actionStatusBadgeClass,
  canApproveAction,
  canCancelAction,
  canRetryAction,
  canReviewAction,
} from "../../utils/chatUtils";
import {
  buildApprovalRuleOptions,
  type ApprovalRuleOption,
} from "../../../lib/approvalRuleStore";
import type { ChatContextAttachment } from "../../../lib/contextAttachments";
import type { ToolExecutionTrace } from "../../../orchestrator/toolTraceTypes";
import type {
  ActionProposal,
  ApplyPatchActionProposal,
  OrchestrationPlan,
} from "../../../orchestrator/types";
import type { LiveToolCall } from "./types";
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
          background: "var(--bg-panel)",
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

/**
 * Renders out-of-band reasoning summary deltas (e.g. from OpenAI Responses API
 * with reasoning models). The panel is collapsed by default — readers usually
 * only want to peek when something looks off — and reuses the existing
 * `.think-block` styles so it sits visually next to inline `<think>` blocks.
 */
export function LiveThinkingPanel({ content }: { content: string }) {
  if (!content) return null;
  return (
    <details className="think-block is-live">
      <summary className="think-summary">思考中…</summary>
      <div className="think-content">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={markdownCodeBlockComponents}
        >
          {content}
        </Markdown>
      </div>
    </details>
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
    <div className="tool-rail">
      <div className="tool-rail-header" aria-hidden>
        <span className="tool-rail-chevron">·</span>
        <span className="tool-rail-label">
          模型请求 · {toolCalls.length}
        </span>
      </div>
      <ul className="tool-rail-list">
        {toolCalls.map((toolCall) => {
          const argsLine = firstLine(toolCall.function.arguments);
          return (
            <li key={toolCall.id} className="tool-rail-row tool-rail-row-success">
              <span className="tool-rail-glyph" aria-hidden>↗</span>
              <span className="tool-rail-name">
                {formatToolName(toolCall.function.name)}
              </span>
              {argsLine && (
                <span className="tool-rail-args" title={toolCall.function.arguments}>
                  {argsLine}
                </span>
              )}
              <span className="tool-rail-tag">requested</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}


type RailStatus = "running" | ToolExecutionTrace["status"];

interface RailItem {
  key: string;
  name: string;
  status: RailStatus;
  argsPreview?: string;
  tailNote?: string;
  retried?: boolean;
}

const RAIL_GLYPH: Record<RailStatus, string> = {
  running: "◐",
  success: "✓",
  failed: "✕",
  pending_approval: "⏸",
  waiting_for_user: "?",
};

function buildRailItems(
  traces: ToolExecutionTrace[],
  liveCalls: readonly LiveToolCall[],
): RailItem[] {
  const tracedIds = new Set<string>();
  const items: RailItem[] = traces.map((trace) => {
    tracedIds.add(trace.callId);
    const tailNote =
      trace.errorMessage || trace.errorCategory
        ? `${trace.errorCategory ? `[${trace.errorCategory}] ` : ""}${trace.errorMessage ?? "失败"}`
        : trace.status === "pending_approval"
          ? "仅创建了待审批动作"
          : trace.status === "waiting_for_user"
            ? "等待用户输入"
            : undefined;
    return {
      key: `${trace.callId}-${trace.startedAt}`,
      name: formatToolName(trace.name),
      status: trace.status,
      argsPreview: firstLine(trace.arguments),
      tailNote,
      retried: trace.retried,
    };
  });

  for (const call of liveCalls) {
    if (tracedIds.has(call.callId)) continue;
    items.push({
      key: `live-${call.callId}`,
      name: formatToolName(call.toolName),
      status: call.status,
      argsPreview: call.argsPreview,
      tailNote:
        call.status === "pending_approval"
          ? "待审批"
          : call.status === "waiting_for_user"
            ? "等待输入"
            : undefined,
    });
  }

  return items;
}

function firstLine(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const line = raw.split("\n", 1)[0].trim();
  if (!line) return undefined;
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

export function MessageMeta({
  name,
  time,
  model,
  tokens,
  status,
}: {
  role?: "user" | "assistant" | "tool";
  name: string;
  time?: string;
  model?: string;
  tokens?: number;
  status?: "thinking" | "running" | "done";
}) {
  return (
    <p className="chat-meta">
      <span className="chat-meta-name">{name}</span>
      {time && <span className="chat-meta-time"> · {time}</span>}
      {model && <span className="chat-meta-model"> · {model}</span>}
      {tokens !== undefined && (
        <span className="chat-meta-tokens">
          {" · "}
          {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens
        </span>
      )}
      {status && (
        <span className="chat-meta-live" aria-label={status}>
          <span className="chat-meta-live-dot" aria-hidden>
            {status === "thinking" ? "●" : status === "running" ? "◐" : "✓"}
          </span>
          <span className="chat-meta-live-text">{status}</span>
        </span>
      )}
    </p>
  );
}

export function ToolTracePanel({
  traces,
  liveToolCalls,
}: {
  traces: ToolExecutionTrace[];
  liveToolCalls?: readonly LiveToolCall[];
}) {
  const items = buildRailItems(traces, liveToolCalls ?? []);

  if (items.length === 0) return null;

  return (
    <div className="tool-rail">
      <ul className="tool-rail-list">
        {items.map((item) => (
          <li
            key={item.key}
            className={`tool-rail-row tool-rail-row-${item.status}${
              item.status === "running" ? " is-running" : ""
            }`}
            title={item.argsPreview ?? item.name}
          >
            <span className="tool-rail-glyph" aria-hidden>
              {RAIL_GLYPH[item.status]}
            </span>
            <span className="tool-rail-name">{item.name}</span>
            {item.argsPreview && (
              <span className="tool-rail-args">{item.argsPreview}</span>
            )}
            {item.tailNote && (
              <span className="tool-rail-tail">→ {item.tailNote}</span>
            )}
            {item.retried && (
              <span className="tool-rail-tag">retried</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionPayloadFields({
  action,
}: {
  action: ActionProposal;
}) {
  if (action.type === "apply_patch") {
    const stats = summarizePatchStats(action.payload.patch);
    return (
      <div className="action-grid">
        <div className="action-field action-wide">
          <details className="patch-preview-details">
            <summary className="patch-preview-summary">
              <span className="patch-preview-chevron" aria-hidden>▸</span>
              <span className="patch-preview-label">查看差异</span>
              <span className="patch-preview-stats">
                {stats.files} 文件 ·{" "}
                <span className="patch-preview-add">+{stats.adds}</span> /{" "}
                <span className="patch-preview-del">−{stats.dels}</span>
              </span>
            </summary>
            <div className="patch-preview-body">
              <DiffViewer patch={action.payload.patch} />
            </div>
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
          <details className="patch-preview-details">
            <summary className="patch-preview-summary">
              <span className="patch-preview-chevron" aria-hidden>▸</span>
              <span className="patch-preview-label">查看命令</span>
            </summary>
            <div className="patch-preview-body" style={{ marginTop: "8px" }}>
              <code className="action-command-preview">
                {action.payload.shell || "(empty command)"}
              </code>
            </div>
          </details>
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

function summarizePatchStats(patch: string): {
  files: number;
  adds: number;
  dels: number;
} {
  const files = (patch.match(/^diff --git a\//gm) ?? []).length;
  const adds = (patch.match(/^\+(?!\+\+)/gm) ?? []).length;
  const dels = (patch.match(/^-(?!--)/gm) ?? []).length;
  return { files, adds, dels };
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

      <p className="status-note" style={{ marginTop: 8, marginBottom: 0 }}>
        {action.description}
      </p>
      <ActionBatchMeta action={action} />

      <ActionPayloadFields action={action} />

      <div className="action-footer">
        {canApproveAction(action) && (
          <div className="action-approve-group">
            <button
              className="btn btn-primary btn-sm action-approve-main"
              disabled={Boolean(executingActionId)}
              onClick={() => void onApprove(messageId, action.id, plan)}
              type="button"
            >
              {executingActionId === action.id ? "执行中…" : "✓ 批准"}
            </button>
            <FloatingMenu
              className="action-approve-popover"
              trigger={
                <button
                  type="button"
                  className={`btn btn-primary btn-sm action-approve-trigger${
                    executingActionId ? " is-disabled" : ""
                  }`}
                  disabled={Boolean(executingActionId)}
                  aria-label="更多操作"
                  title="更多操作"
                >
                  <span aria-hidden>▾</span>
                </button>
              }
            >
              {(close) => (
                <>
                  {approvalOptions.map((option) => (
                    <button
                      key={option.key}
                      className="action-approve-option-btn"
                      onClick={() => {
                        close();
                        void onApprove(messageId, action.id, plan, option);
                      }}
                      type="button"
                    >
                      <span className="action-approve-option-main">批准并记住</span>
                      <span className="action-approve-option-hint">{option.label}</span>
                    </button>
                  ))}
                  {canReviewAction(action) && (
                    <>
                      {approvalOptions.length > 0 && <div className="action-approve-divider" />}
                      <button
                        className="action-approve-option-btn text-danger"
                        onClick={() => {
                          close();
                          onReject(messageId, action.id);
                        }}
                        type="button"
                      >
                        ✕ 拒绝
                      </button>
                      <button
                        className="action-approve-option-btn"
                        onClick={() => {
                          close();
                          onComment(messageId, action.id);
                        }}
                        type="button"
                      >
                        💬 备注
                      </button>
                    </>
                  )}
                </>
              )}
            </FloatingMenu>
          </div>
        )}
        {canRetryAction(action) && (
          <button
            className="btn btn-ghost btn-sm"
            disabled={Boolean(executingActionId)}
            onClick={() => void onRetry(messageId, action.id, plan)}
            type="button"
          >
            {executingActionId === action.id ? "重试中…" : "↻ 重试"}
          </button>
        )}
        {canCancelAction(action, hasActiveShellJob) && (
          <button
            className="btn btn-ghost btn-sm text-danger"
            disabled={Boolean(executingActionId)}
            onClick={() => void onCancel(messageId, action.id)}
            type="button"
          >
            {isCancelling ? "取消中…" : "■ 取消"}
          </button>
        )}
      </div>    </li>
  );
}

export function InlinePlan({
  plan,
  messageId,
  executingActionId,
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
    steps: [],
    proposedActions: Array.isArray(plan.proposedActions)
      ? plan.proposedActions
      : [],
  };

  const allResolved =
    safePlan.proposedActions.length === 0 ||
    safePlan.proposedActions.every(
      (action) => action.status !== "pending" && action.status !== "running",
    );

  const [expanded, setExpanded] = useState(!allResolved);

  const prevAllResolved = useRef(allResolved);
  useEffect(() => {
    if (allResolved && !prevAllResolved.current) {
      setExpanded(false);
    }
    prevAllResolved.current = allResolved;
  }, [allResolved]);

  if (safePlan.proposedActions.length === 1) {
    const onlyAction = safePlan.proposedActions[0];
    return (
      <ul className="action-list action-list-compact">
        <PlanActionCard
          action={onlyAction}
          plan={safePlan}
          messageId={messageId}
          executingActionId={executingActionId}
          onApprove={onApprove}
          onRetry={onRetry}
          onReject={onReject}
          onComment={onComment}
          onCancel={onCancel}
          activeShellActionIds={activeShellActionIds}
        />
      </ul>
    );
  }

  const pendingCount = safePlan.proposedActions.filter(
    (action) => action.status === "pending",
  ).length;
  const approvedCount = safePlan.proposedActions.filter(
    (action) => action.status === "completed",
  ).length;
  const failedCount = safePlan.proposedActions.filter(
    (action) => action.status === "failed" || action.status === "rejected",
  ).length;

  const pendingPatchActions = safePlan.proposedActions.filter(
    (action): action is ApplyPatchActionProposal =>
      action.status === "pending" && action.type === "apply_patch",
  );

  const headerSegments: PlanHeaderSegment[] = [];
  const totalCount = safePlan.proposedActions.length;
  headerSegments.push({ text: `${totalCount} 步` });

  if (approvedCount > 0) {
    headerSegments.push({ text: `${approvedCount} 完成`, tone: "done" });
  }
  if (pendingCount > 0) {
    headerSegments.push({ text: `${pendingCount} 待办`, tone: "pending" });
  }
  if (failedCount > 0) {
    headerSegments.push({ text: `${failedCount} 失败`, tone: "failed" });
  }

  return (
    <div className="plan-rail">
      <button
        type="button"
        className="plan-rail-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span
          className="tool-rail-chevron"
          style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
          aria-hidden
        >
          ▶
        </span>
        <span className="plan-rail-label">
          {headerSegments.map((seg, i) => (
            <span
              key={i}
              className={`plan-rail-label-seg${seg.tone ? ` is-${seg.tone}` : ""}`}
            >
              {seg.text}
            </span>
          ))}
        </span>
      </button>

      {expanded && pendingCount > 1 && (
        <PlanBatchBar
          pendingCount={pendingCount}
          pendingPatchActions={pendingPatchActions}
          executingActionId={executingActionId}
          onApproveAll={() => void onApproveAll(messageId, safePlan)}
          onRejectAll={() => onRejectAll(messageId)}
        />
      )}

      {expanded && safePlan.proposedActions.length > 0 && (
        <ul className="action-list">
          {safePlan.proposedActions.map((action) => (
            <PlanActionCard
              key={action.id}
              action={action}
              plan={safePlan}
              messageId={messageId}
              executingActionId={executingActionId}
              onApprove={onApprove}
              onRetry={onRetry}
              onReject={onReject}
              onComment={onComment}
              onCancel={onCancel}
              activeShellActionIds={activeShellActionIds}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

type PlanHeaderTone = "pending" | "failed" | "done";

interface PlanHeaderSegment {
  text: string;
  tone?: PlanHeaderTone;
}

function PlanBatchBar({
  pendingCount,
  pendingPatchActions,
  executingActionId,
  onApproveAll,
  onRejectAll,
}: {
  pendingCount: number;
  pendingPatchActions: ApplyPatchActionProposal[];
  executingActionId: string;
  onApproveAll: () => void;
  onRejectAll: () => void;
}) {
  const batchAffectedFiles = getAffectedFiles(pendingPatchActions);
  return (
    <div className="plan-batch-bar">
      {batchAffectedFiles.length > 0 && (
        <div className="plan-batch-summary">
          <span className="plan-batch-count">
            批量 · {batchAffectedFiles.length} 个文件
          </span>
          {pendingPatchActions.length > 1 && (
            <span className="plan-batch-hint">原子执行：全部成功或全部回滚</span>
          )}
          {pendingPatchActions.length > 1 && renderAtomicStatus(pendingPatchActions)}
          <span className="plan-batch-files">
            {batchAffectedFiles.map((file) => (
              <code key={file} className="plan-batch-file">
                {file}
              </code>
            ))}
          </span>
        </div>
      )}
      <div className="plan-batch-actions">
        <button
          className="btn btn-primary btn-sm"
          disabled={Boolean(executingActionId)}
          onClick={onApproveAll}
          type="button"
        >
          ✓ 全部批准 ({pendingCount})
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={Boolean(executingActionId)}
          onClick={onRejectAll}
          type="button"
        >
          ✕ 全部拒绝
        </button>
      </div>
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
    if (percentage >= 95) return "var(--color-error)";
    if (percentage >= 85) return "var(--color-warning)";
    return "var(--text-3)";
  };

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
    return String(tokens);
  };

  return (
    <div
      className="token-usage-ring"
      title={`${isStreaming ? "预估" : "已用"} ${used.toLocaleString()} / ${max.toLocaleString()} tokens (${percentage.toFixed(1)}%)`}
    >
      <svg
        width={size}
        height={size}
        className="token-usage-ring-svg"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border-subtle)"
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
          className={isStreaming ? "" : "token-usage-ring-animated"}
        />
      </svg>
      <span className="token-usage-ring-label">
        <span className="token-usage-ring-used">{formatTokens(used)}</span>
        <span className="token-usage-ring-sep">/</span>
        <span className="token-usage-ring-max">{formatTokens(max)}</span>
      </span>
    </div>
  );
}
