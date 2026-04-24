import type { ChatAgentDefinition } from "../../../agents/types";
import type { LLMAuditRecord, SensitiveActionAuditRecord } from "../../../lib/auditLog";
import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { Conversation } from "../../../lib/conversationStore";
import type { CategorizedError } from "../../../lib/errorClassifier";
import type {
  LLMRequestSummary,
  SessionState,
} from "../../../lib/sessionContext";
import type { AppSettings } from "../../../lib/settingsStore";
import type { WorkflowCheckpointPayload } from "../../../orchestrator/checkpointStore";
import type { ToolExecutionTrace } from "../../../orchestrator/toolTraceTypes";
import type { LiveToolCall } from "./types";

const FALLBACK_DEBUG_EXPORT_KEY = "__no_conversation__";

export type ConversationDebugEntryType =
  | "llm_request_started"
  | "llm_request_completed"
  | "llm_request_failed"
  | "llm_request_cancelled";

export interface ConversationDebugEntry {
  id: string;
  type: ConversationDebugEntryType;
  timestamp: string;
  requestId: string;
  data: Record<string, unknown>;
}

function toTimestamp(value: string | null | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function withinWindow(
  value: string | null | undefined,
  startedAtMs: number,
  endedAtMs: number,
): boolean {
  const timestamp = toTimestamp(value, endedAtMs);
  return timestamp >= startedAtMs && timestamp <= endedAtMs;
}

function sanitizeFileNameSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 48)
    .replace(/[-_]+$/g, "");
  return sanitized || "conversation";
}

function collectConversationToolTraces(messages: ChatMessageRecord[]): ToolExecutionTrace[] {
  return messages.flatMap((message) => message.toolTrace ?? []);
}

function collectConversationPlanSummaries(messages: ChatMessageRecord[]) {
  return messages
    .filter((message) => message.plan)
    .map((message) => ({
      messageId: message.id,
      createdAt: message.createdAt,
      state: message.plan?.state ?? null,
      stepCount: message.plan?.steps.length ?? 0,
      proposedActionCount: message.plan?.proposedActions.length ?? 0,
    }));
}

function collectConversationTimeWindow(
  conversation: Conversation | null,
  messages: ChatMessageRecord[],
  exportedAt: string,
): { startedAt: string; endedAt: string } {
  const startedCandidates = [
    conversation?.createdAt,
    messages[0]?.createdAt,
    exportedAt,
  ].filter((value): value is string => Boolean(value));
  const endedCandidates = [
    conversation?.updatedAt,
    messages[messages.length - 1]?.createdAt,
    exportedAt,
  ].filter((value): value is string => Boolean(value));
  const startedAt = startedCandidates.reduce((earliest, value) =>
    toTimestamp(value, Date.now()) < toTimestamp(earliest, Date.now())
      ? value
      : earliest,
  );
  const endedAt = endedCandidates.reduce((latest, value) =>
    toTimestamp(value, 0) > toTimestamp(latest, 0) ? value : latest,
  );
  return { startedAt, endedAt };
}

export function resolveConversationDebugKey(conversationId?: string | null): string {
  return conversationId?.trim() || FALLBACK_DEBUG_EXPORT_KEY;
}

export function sanitizeSettingsForDebugExport(settings: AppSettings) {
  return {
    provider: settings.provider ?? null,
    model: settings.model,
    liteLLMBaseUrl: settings.liteLLMBaseUrl,
    debugMode: settings.debugMode,
    allowCloudModels: settings.allowCloudModels,
    maxSnippetLines: settings.maxSnippetLines,
    maxContextTokens: settings.maxContextTokens,
    sendRelativePathOnly: settings.sendRelativePathOnly,
    workspacePath: settings.workspacePath,
    toolPermissions: settings.toolPermissions,
    activeVendorId: settings.activeVendorId,
    activeModelId: settings.activeModelId,
    proxy: {
      mode: settings.proxy.mode,
      url: settings.proxy.url,
      noProxy: settings.proxy.noProxy ?? "",
    },
  };
}

export function filterAuditRecordsForConversation(params: {
  conversation: Conversation | null;
  messages: ChatMessageRecord[];
  exportedAt: string;
  workspacePath: string;
  llmAuditRecords: LLMAuditRecord[];
  actionAuditRecords: SensitiveActionAuditRecord[];
}) {
  const window = collectConversationTimeWindow(
    params.conversation,
    params.messages,
    params.exportedAt,
  );
  const startedAtMs = toTimestamp(window.startedAt, Date.now());
  const endedAtMs = toTimestamp(window.endedAt, Date.now());

  return {
    window,
    llmRecords: params.llmAuditRecords.filter((record) =>
      withinWindow(record.timestamp, startedAtMs, endedAtMs),
    ),
    actionRecords: params.actionAuditRecords.filter(
      (record) =>
        record.workspacePath === params.workspacePath &&
        withinWindow(record.startedAt, startedAtMs, endedAtMs),
    ),
  };
}

function filterRequestSummariesForConversation(
  requestSummaries: LLMRequestSummary[],
  startedAt: string,
  endedAt: string,
): LLMRequestSummary[] {
  const startedAtMs = toTimestamp(startedAt, Date.now());
  const endedAtMs = toTimestamp(endedAt, Date.now());
  return requestSummaries.filter((summary) =>
    withinWindow(summary.timestamp, startedAtMs, endedAtMs),
  );
}

function filterToolTracesForConversation(
  toolTraces: ToolExecutionTrace[],
  startedAt: string,
  endedAt: string,
): ToolExecutionTrace[] {
  const startedAtMs = toTimestamp(startedAt, Date.now());
  const endedAtMs = toTimestamp(endedAt, Date.now());
  return toolTraces.filter((trace) =>
    withinWindow(trace.startedAt, startedAtMs, endedAtMs),
  );
}

export function buildConversationDebugExportFileName(params: {
  conversation: Conversation | null;
  activeConversationId: string | null;
  exportedAt: string;
}): string {
  const stamp = params.exportedAt
    .replace(/[:]/g, "-")
    .replace(/\.\d{3}Z$/, "Z");
  const baseLabel = sanitizeFileNameSegment(
    params.conversation?.title || params.activeConversationId || "conversation",
  );
  return `cofree-debug-${baseLabel}-${stamp}.json`;
}

export function buildConversationDebugExport(params: {
  exportedAt: string;
  chatSessionId: string;
  activeConversationId: string | null;
  conversation: Conversation | null;
  messages: ChatMessageRecord[];
  activeAgent: ChatAgentDefinition;
  activeModelLabel: string;
  settings: AppSettings;
  sessionState: SessionState;
  categorizedError: CategorizedError | null;
  failedLlmRequestLog: string | null;
  sessionNote: string;
  isStreaming: boolean;
  executingActionId: string;
  liveContextTokens: number | null;
  liveToolCalls: LiveToolCall[];
  debugEntries: ConversationDebugEntry[];
  llmAuditRecords: LLMAuditRecord[];
  actionAuditRecords: SensitiveActionAuditRecord[];
  checkpointRecovery: { messageId: string; payload: WorkflowCheckpointPayload } | null;
  checkpointError?: string | null;
}) {
  const conversationWindow = collectConversationTimeWindow(
    params.conversation,
    params.messages,
    params.exportedAt,
  );
  const audit = filterAuditRecordsForConversation({
    conversation: params.conversation,
    messages: params.messages,
    exportedAt: params.exportedAt,
    workspacePath: params.settings.workspacePath,
    llmAuditRecords: params.llmAuditRecords,
    actionAuditRecords: params.actionAuditRecords,
  });
  const conversationToolTraces = collectConversationToolTraces(params.messages);

  return {
    exportKind: "cofree-conversation-debug",
    exportedAt: params.exportedAt,
    workspace: {
      path: params.settings.workspacePath,
      activeConversationId: params.activeConversationId,
      chatSessionId: params.chatSessionId,
      conversationDebugKey: resolveConversationDebugKey(
        params.conversation?.id ?? params.activeConversationId,
      ),
    },
    agent: {
      activeAgentId: params.activeAgent.id,
      activeAgentName: params.activeAgent.name,
      conversationBinding: params.conversation?.agentBinding ?? null,
      activeModelLabel: params.activeModelLabel,
    },
    settings: sanitizeSettingsForDebugExport(params.settings),
    conversation: {
      id: params.conversation?.id ?? params.activeConversationId,
      title: params.conversation?.title ?? "未命名对话",
      createdAt: params.conversation?.createdAt ?? conversationWindow.startedAt,
      updatedAt: params.conversation?.updatedAt ?? params.exportedAt,
      lastTokenCount: params.conversation?.lastTokenCount ?? null,
      messageCount: params.messages.length,
      window: conversationWindow,
      derived: {
        planSummaries: collectConversationPlanSummaries(params.messages),
        toolTraceCount: conversationToolTraces.length,
        toolCallMessageCount: params.messages.filter(
          (message) => (message.tool_calls?.length ?? 0) > 0,
        ).length,
        expertSpeakerMessageCount: params.messages.filter(
          (message) => Boolean(message.assistantSpeaker),
        ).length,
      },
      messages: params.messages,
    },
    requestTimeline: params.debugEntries,
    session: {
      workflowPhase: params.sessionState.workflowPhase,
      currentPlan: params.sessionState.currentPlan,
      lastError: params.sessionState.lastError,
      requestSummaries: params.sessionState.requestSummaries,
      toolTraces: params.sessionState.toolTraces,
      conversationWindowRequestSummaries: filterRequestSummariesForConversation(
        params.sessionState.requestSummaries,
        conversationWindow.startedAt,
        conversationWindow.endedAt,
      ),
      conversationWindowToolTraces: filterToolTracesForConversation(
        params.sessionState.toolTraces,
        conversationWindow.startedAt,
        conversationWindow.endedAt,
      ),
    },
    ui: {
      sessionNote: params.sessionNote,
      categorizedError: params.categorizedError,
      failedLlmRequestLog: params.failedLlmRequestLog,
      isStreaming: params.isStreaming,
      executingActionId: params.executingActionId,
      liveContextTokens: params.liveContextTokens,
      liveToolCalls: params.liveToolCalls,
    },
    audit: {
      totalCounts: {
        llm: params.llmAuditRecords.length,
        actions: params.actionAuditRecords.length,
      },
      conversationWindow: audit.window,
      llmRecords: audit.llmRecords,
      actionRecords: audit.actionRecords,
    },
    checkpoint: params.checkpointRecovery
      ? {
          found: true,
          error: params.checkpointError ?? null,
          checkpoint: params.checkpointRecovery,
        }
      : {
          found: false,
          error: params.checkpointError ?? null,
          checkpoint: null,
        },
  };
}
