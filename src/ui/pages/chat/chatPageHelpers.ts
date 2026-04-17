import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { ChatContextAttachment } from "../../../lib/contextAttachments";
import type { CategorizedError } from "../../../lib/errorClassifier";
import type { AppSettings } from "../../../lib/settingsStore";
import type { OrchestrationPlan } from "../../../orchestrator/types";
import type { ConversationTopbarAction } from "./ConversationTopbar";
import type { ConversationTopbarTarget } from "./conversationTopbarNavigation";
import type { ConversationTopbarState } from "./conversationTopbarState";
import {
  CHECKPOINT_RESTORE_MESSAGE,
  DEBUG_LOG_HISTORY_LIMIT,
  DEBUG_LOG_MAX_CONTENT_CHARS,
  shellOutputTextEncoder,
} from "./constants";
import type { ConversationHistoryMessage } from "./helpers";
import type { LiveToolCall } from "./types";

export function hasVisibleAssistantPlan(
  message: ChatMessageRecord,
): message is ChatMessageRecord & { plan: OrchestrationPlan } {
  return (
    message.role === "assistant" &&
    message.plan !== null &&
    (message.plan.proposedActions.length > 0 || message.plan.steps.length > 0)
  );
}

export function findLatestVisibleAssistantPlanMessage(
  messages: ChatMessageRecord[],
): (ChatMessageRecord & { plan: OrchestrationPlan }) | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (hasVisibleAssistantPlan(message)) {
      return message;
    }
  }
  return null;
}

export function hasWaitingUserToolTrace(message: ChatMessageRecord): boolean {
  return message.toolTrace?.some((trace) => trace.status === "waiting_for_user") ?? false;
}

export function hasWaitingUserLiveToolCall(calls: LiveToolCall[]): boolean {
  return calls.some((call) => call.status === "waiting_for_user");
}

export function findLatestAskUserAnchorMessageId(params: {
  messages: ChatMessageRecord[];
  lastVisibleMessage: ChatMessageRecord | undefined;
  isStreaming: boolean;
  liveToolCalls: LiveToolCall[];
  hasAskUserPending: boolean;
}): string | null {
  const {
    messages,
    lastVisibleMessage,
    isStreaming,
    liveToolCalls,
    hasAskUserPending,
  } = params;
  if (!hasAskUserPending) {
    return null;
  }
  if (
    isStreaming &&
    lastVisibleMessage?.role === "assistant" &&
    hasWaitingUserLiveToolCall(liveToolCalls)
  ) {
    return lastVisibleMessage.id;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "assistant") {
      continue;
    }
    if (hasWaitingUserToolTrace(message)) {
      return message.id;
    }
  }
  return null;
}

export function findLatestRestoreAnchorMessageId(
  messages: ChatMessageRecord[],
  hasRestoreNotice: boolean,
): string | null {
  if (!hasRestoreNotice) {
    return null;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (
      message.role === "assistant" &&
      message.content.trim() === CHECKPOINT_RESTORE_MESSAGE
    ) {
      return message.id;
    }
  }
  return null;
}

export function applyTopbarActionAvailability(
  state: ConversationTopbarState,
  targets: Map<ConversationTopbarAction, ConversationTopbarTarget | null>,
): ConversationTopbarState {
  return {
    ...state,
    badges: state.badges.map((badge) =>
      badge.action
        ? {
            ...badge,
            disabled: (targets.get(badge.action) ?? null) === null,
          }
        : badge,
    ),
    progress: state.progress.visible
      ? {
          ...state.progress,
          disabled: (targets.get("progress") ?? null) === null,
        }
      : state.progress,
    attention:
      state.attention && state.attention.ctaAction
        ? {
            ...state.attention,
            ctaDisabled: (targets.get(state.attention.ctaAction) ?? null) === null,
          }
        : state.attention,
  };
}

export function truncateDebugLogText(
  text: string,
  maxChars = DEBUG_LOG_MAX_CONTENT_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

export function measureShellChunkBytes(text: string): number {
  return shellOutputTextEncoder.encode(text).length;
}

export function isLlmResponseFailureCategory(
  category: CategorizedError["category"],
): boolean {
  return (
    category === "llm_failure" ||
    category === "network_timeout" ||
    category === "auth_error"
  );
}

export function summarizeConversationHistoryForDebug(
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

export function buildFailedLlmRequestLog(params: {
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

export function waitForDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
