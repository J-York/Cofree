interface ConversationLike {
  id?: string | null;
  agentBinding?: { agentId?: string | null } | null;
}

export interface CheckpointRestoreScope {
  conversationId: string | null;
  agentId: string;
}

export function getCheckpointRestoreScope(
  conversation: ConversationLike | null | undefined,
  activeAgentId: string,
): CheckpointRestoreScope {
  return {
    conversationId: conversation?.id ?? null,
    agentId: conversation?.agentBinding?.agentId?.trim() || activeAgentId,
  };
}

export function buildCheckpointRestoreScopeKey(scope: CheckpointRestoreScope): string {
  return `${scope.conversationId ?? "(none)"}::${scope.agentId}`;
}

export function buildCheckpointRestoreRecord(
  sessionId: string,
  messageId: string,
): string {
  return `${sessionId}::${messageId}`;
}

export function shouldApplyCheckpointRecovery(
  lastAppliedRecord: string | null,
  nextRecord: string,
): boolean {
  return lastAppliedRecord !== nextRecord;
}
