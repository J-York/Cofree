import type { ConversationAgentBinding } from "../../../agents/types";
import type { Conversation } from "../../../lib/conversationStore";

function areAgentBindingsEqual(
  a: ConversationAgentBinding | undefined,
  b: ConversationAgentBinding | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  return (
    a.agentId === b.agentId &&
    a.vendorId === b.vendorId &&
    a.modelId === b.modelId &&
    a.bindingSource === b.bindingSource &&
    a.agentNameSnapshot === b.agentNameSnapshot &&
    a.vendorNameSnapshot === b.vendorNameSnapshot &&
    a.modelNameSnapshot === b.modelNameSnapshot
  );
}

export function resolveConversationAssistantDisplayName(params: {
  conversation: Conversation | null;
  messageCount: number;
  activeAgentName: string;
}): string {
  const { conversation, messageCount, activeAgentName } = params;
  if (messageCount === 0) {
    return activeAgentName;
  }
  return conversation?.agentBinding?.agentNameSnapshot ?? activeAgentName;
}

export function buildDraftConversationBindingUpdate(params: {
  conversation: Conversation | null;
  messageCount: number;
  nextBinding?: ConversationAgentBinding;
}): Conversation | null {
  const { conversation, messageCount, nextBinding } = params;
  if (!conversation || messageCount !== 0) {
    return null;
  }
  if (areAgentBindingsEqual(conversation.agentBinding, nextBinding)) {
    return null;
  }
  return {
    ...conversation,
    agentBinding: nextBinding,
  };
}
