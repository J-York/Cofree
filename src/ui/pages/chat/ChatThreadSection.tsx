import { memo, type ReactElement, type RefObject } from "react";

import type { ApprovalRuleOption } from "../../../lib/approvalRuleStore";
import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { OrchestrationPlan } from "../../../orchestrator/types";
import { formatTime } from "../../utils/chatUtils";
import {
  AssistantToolCalls,
  ContextAttachmentPills,
  InlinePlan,
  MessageContent,
  MessageMeta,
  ToolTracePanel,
} from "./ChatPresentational";
import type { LiveToolCall } from "./types";

const EMPTY_LIVE_TOOL_CALLS: LiveToolCall[] = [];
const EMPTY_SHELL_ACTION_IDS: string[] = [];

const DEFAULT_CHAT_SUGGESTIONS = [
  { prompt: "帮我分析一下这个项目的代码结构", label: "分析代码结构" },
  { prompt: "帮我查找并修复代码中的问题", label: "查找问题" },
  { prompt: "帮我写一个新功能", label: "新功能开发" },
  { prompt: "帮我优化这个项目的性能", label: "性能优化" },
];


function hasVisiblePlan(message: ChatMessageRecord): message is ChatMessageRecord & {
  plan: OrchestrationPlan;
} {
  return (
    message.role === "assistant" &&
    message.plan !== null &&
    (message.plan.proposedActions.length > 0 || message.plan.steps.length > 0)
  );
}

interface ChatMessageRowProps {
  message: ChatMessageRecord;
  assistantDisplayName: string;
  debugMode: boolean;
  showStreamingStatus: boolean;
  liveToolCalls: LiveToolCall[];
  executingActionId: string;
  getActiveShellActionIds: (messageId: string) => string[];
  onPlanUpdate: (
    messageId: string,
    updater: (plan: OrchestrationPlan) => OrchestrationPlan,
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
}

const ChatMessageRow = memo(function ChatMessageRow({
  message,
  assistantDisplayName,
  debugMode,
  showStreamingStatus,
  liveToolCalls,
  executingActionId,
  getActiveShellActionIds,
  onPlanUpdate,
  onApprove,
  onRetry,
  onReject,
  onComment,
  onCancel,
  onApproveAll,
  onRejectAll,
}: ChatMessageRowProps): ReactElement {
  const activeShellActionIds = message.plan
    ? getActiveShellActionIds(message.id)
    : EMPTY_SHELL_ACTION_IDS;
  const hasPlan = hasVisiblePlan(message);

  const isExpertStageTurn =
    message.role === "assistant" && Boolean(message.assistantSpeaker);

  const assistantMetaLabel =
    message.role === "assistant" && message.assistantSpeaker?.label
      ? message.assistantSpeaker.label
      : assistantDisplayName;
  const avatarGlyph = "✦";
  const avatarTooltip = isExpertStageTurn
    ? (message.assistantSpeaker?.label ?? assistantDisplayName)
    : assistantDisplayName;

  const timeSuffix = formatTime(message.createdAt)
    ? ` · ${formatTime(message.createdAt)}`
    : "";

  return (
    <div
      className={`chat-row ${message.role}${
        message.assistantSpeaker ? " chat-row-expert-turn" : ""
      }`}
      data-chat-message-id={message.id}
    >
      {message.role !== "user" && (
        <div
          className={`chat-avatar ${message.role}`}
          title={avatarTooltip}
          aria-hidden
        >
          {avatarGlyph}
        </div>
      )}
      <div className="chat-bubble-wrap">
        {isExpertStageTurn && message.assistantSpeaker ? (
          <details className="chat-expert-stage-details">
            <summary className="chat-expert-stage-summary">
              <span className="chat-expert-stage-summary-main">
                {message.assistantSpeaker.label}
                {timeSuffix}
              </span>
              <span className="chat-expert-stage-summary-action" aria-hidden>
                <span className="chat-expert-stage-expand-label">展开</span>
                <span className="chat-expert-stage-collapse-label">收起</span>
              </span>
            </summary>
            <div className="chat-bubble assistant chat-expert-stage-body">
              <MessageContent
                content={message.content}
                isStreaming={false}
                role="assistant"
              />
            </div>
          </details>
        ) : (
          <>
            <MessageMeta
              role={message.role}
              name={message.role === "user" ? "你" : assistantMetaLabel}
              time={formatTime(message.createdAt)}
              status={
                message.role === "assistant" && showStreamingStatus
                  ? liveToolCalls.length > 0
                    ? "running"
                    : "thinking"
                  : undefined
              }
            />
            {message.role === "assistant" && debugMode && (
              <AssistantToolCalls toolCalls={message.tool_calls} />
            )}
            {message.role === "assistant" &&
              ((message.toolTrace?.length ?? 0) > 0 ||
                (showStreamingStatus && liveToolCalls.length > 0)) && (
                <ToolTracePanel
                  traces={message.toolTrace ?? []}
                  liveToolCalls={
                    showStreamingStatus ? liveToolCalls : undefined
                  }
                />
              )}
            {hasPlan && (
              <InlinePlan
                plan={message.plan}
                messageId={message.id}
                executingActionId={executingActionId}
                activeShellActionIds={activeShellActionIds}
                onPlanUpdate={onPlanUpdate}
                onApprove={onApprove}
                onRetry={onRetry}
                onReject={onReject}
                onComment={onComment}
                onCancel={onCancel}
                onApproveAll={onApproveAll}
                onRejectAll={onRejectAll}
              />
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
                  showStreamingStatus &&
                  message.content === "" &&
                  message.role === "assistant"
                }
                role={message.role}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
});

export interface ChatThreadSectionProps {
  threadRef: RefObject<HTMLDivElement | null>;
  onThreadScroll: () => void;
  messages: ChatMessageRecord[];
  assistantDisplayName: string;
  assistantDescription: string;
  debugMode: boolean;
  isStreaming: boolean;
  liveToolCalls: LiveToolCall[];
  executingActionId: string;
  getActiveShellActionIds: (messageId: string) => string[];
  onPlanUpdate: (
    messageId: string,
    updater: (plan: OrchestrationPlan) => OrchestrationPlan,
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
  onSuggestionClick: (text: string) => void;
}

export const ChatThreadSection = memo(function ChatThreadSection({
  threadRef,
  onThreadScroll,
  messages,
  assistantDisplayName,
  assistantDescription,
  debugMode,
  isStreaming,
  liveToolCalls,
  executingActionId,
  getActiveShellActionIds,
  onPlanUpdate,
  onApprove,
  onRetry,
  onReject,
  onComment,
  onCancel,
  onApproveAll,
  onRejectAll,
  onSuggestionClick,
}: ChatThreadSectionProps): ReactElement {
  const visibleMessages = messages.filter((message) => message.role !== "tool");
  const lastMessage = messages[messages.length - 1];

  return (
    <div className="chat-thread" ref={threadRef} onScroll={onThreadScroll}>
      {visibleMessages.length === 0 ? (
        <div className="chat-empty">
          <p className="chat-empty-text">你好，我是{assistantDisplayName}</p>
          <p className="chat-empty-subtext">{assistantDescription}</p>
          <div className="chat-suggestions">
            {DEFAULT_CHAT_SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion.prompt}
                className="chat-suggestion-chip"
                onClick={() => onSuggestionClick(suggestion.prompt)}
                type="button"
              >
                {suggestion.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        visibleMessages.map((message) => {
          const showStreamingStatus =
            isStreaming &&
            message.role === "assistant" &&
            message === lastMessage;

          return (
            <ChatMessageRow
              key={message.id}
              message={message}
              assistantDisplayName={assistantDisplayName}
              debugMode={debugMode}
              showStreamingStatus={showStreamingStatus}
              liveToolCalls={showStreamingStatus ? liveToolCalls : EMPTY_LIVE_TOOL_CALLS}
              executingActionId={message.plan ? executingActionId : ""}
              getActiveShellActionIds={getActiveShellActionIds}
              onPlanUpdate={onPlanUpdate}
              onApprove={onApprove}
              onRetry={onRetry}
              onReject={onReject}
              onComment={onComment}
              onCancel={onCancel}
              onApproveAll={onApproveAll}
              onRejectAll={onRejectAll}
            />
          );
        })
      )}
    </div>
  );
});
