import type { ChatContextAttachment } from "../../../lib/contextAttachments";
import type { CategorizedError } from "../../../lib/errorClassifier";
import type { AppSettings } from "../../../lib/settingsStore";
import {
  DEBUG_LOG_HISTORY_LIMIT,
  DEBUG_LOG_MAX_CONTENT_CHARS,
  shellOutputTextEncoder,
} from "./constants";
import type { ConversationHistoryMessage } from "./helpers";

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
