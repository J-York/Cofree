import type { ChatMessageRecord } from "../../../lib/chatHistoryStore";
import type { Conversation, ConversationMetadata } from "../../../lib/conversationStore";
import type { CategorizedError } from "../../../lib/errorClassifier";
import {
  buildScopedSessionKey,
  getChatSessionId,
  resetChatSessionId,
} from "../../../orchestrator/checkpointStore";
import { resetHitlContinuationMemory } from "../../../orchestrator/hitlContinuationController";
import type { BackgroundStreamState, LiveToolCall, SubAgentStatusItem } from "./types";

export interface ChatViewState {
  messages: ChatMessageRecord[];
  liveContextTokens: number | null;
  isStreaming: boolean;
  sessionNote: string;
  liveToolCalls: LiveToolCall[];
  categorizedError: CategorizedError | null;
  subAgentStatus: SubAgentStatusItem[];
}

export function createEmptyChatViewState(sessionNote = ""): ChatViewState {
  return {
    messages: [],
    liveContextTokens: null,
    isStreaming: false,
    sessionNote,
    liveToolCalls: [],
    categorizedError: null,
    subAgentStatus: [],
  };
}

export function createConversationViewState(params: {
  conversation: Conversation;
  backgroundStream?: BackgroundStreamState;
  idleSessionNote?: string;
}): ChatViewState {
  const { conversation, backgroundStream, idleSessionNote = "" } = params;
  if (backgroundStream) {
    return {
      messages: [...backgroundStream.messages],
      liveContextTokens: backgroundStream.tokenCount,
      isStreaming: backgroundStream.isStreaming,
      sessionNote: backgroundStream.sessionNote,
      liveToolCalls: [...backgroundStream.liveToolCalls],
      categorizedError: backgroundStream.error,
      subAgentStatus: [...backgroundStream.subAgentStatus],
    };
  }

  return {
    messages: [...conversation.messages],
    liveContextTokens: conversation.lastTokenCount ?? null,
    isStreaming: false,
    sessionNote: idleSessionNote,
    liveToolCalls: [],
    categorizedError: null,
    subAgentStatus: [],
  };
}

export function createBackgroundStreamState(params: {
  isStreaming: boolean;
  messages: ChatMessageRecord[];
  liveContextTokens: number | null;
  sessionNote: string;
  liveToolCalls: LiveToolCall[];
  categorizedError: CategorizedError | null;
  subAgentStatus: SubAgentStatusItem[];
}): BackgroundStreamState | null {
  const {
    isStreaming,
    messages,
    liveContextTokens,
    sessionNote,
    liveToolCalls,
    categorizedError,
    subAgentStatus,
  } = params;
  if (!isStreaming) {
    return null;
  }

  return {
    messages: [...messages],
    isStreaming: true,
    tokenCount: liveContextTokens,
    sessionNote,
    liveToolCalls: [...liveToolCalls],
    error: categorizedError,
    subAgentStatus: [...subAgentStatus],
  };
}

export function createClearedConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: [],
    lastTokenCount: null,
    updatedAt: new Date().toISOString(),
  };
}

export function resolvePreferredConversationId(
  conversations: ConversationMetadata[],
  activeConversationId: string | null,
): string | null {
  if (conversations.length === 0) {
    return null;
  }

  return activeConversationId &&
    conversations.some((conversation) => conversation.id === activeConversationId)
    ? activeConversationId
    : conversations[0].id;
}

/**
 * Resets the global chat session id and clears HITL continuation memory for the
 * previous/next global ids. When `scopedSession` is set, also clears in-memory
 * HITL state for that conversation+agent scoped key (P3-3).
 */
export function resetChatSessionState(scopedSession?: {
  conversationId: string;
  agentId?: string | null;
}): string {
  if (scopedSession?.conversationId?.trim()) {
    const scopedId = buildScopedSessionKey(
      scopedSession.conversationId.trim(),
      scopedSession.agentId?.trim() || undefined,
    );
    resetHitlContinuationMemory(scopedId);
  }
  const previousSessionId = getChatSessionId();
  resetChatSessionId();
  resetHitlContinuationMemory(previousSessionId);
  const nextSessionId = getChatSessionId();
  resetHitlContinuationMemory(nextSessionId);
  return nextSessionId;
}
