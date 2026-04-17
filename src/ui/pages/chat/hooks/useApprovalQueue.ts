import { useRef, useState } from "react";
import type { ManualApprovalContext } from "../../../../orchestrator/hitlService";

export interface PendingShellQueue {
  messageId: string;
  actionIds: string[];
  approvalContext?: ManualApprovalContext;
}

/**
 * Owns the approval / shell-job-queue state shared across the chat surface.
 *
 * Extracted from ChatPage.tsx (B1.3, see docs/REFACTOR_PLAN.md). Variable names
 * mirror ChatPage's originals to keep call-sites unchanged.
 *
 * Note: `continueAfterHitlIfNeededRef` stays in ChatPage for now — it closes
 * over conversation/message state that isn't yet disentangled.
 */
export function useApprovalQueue() {
  // Which approval action is currently executing (patch/shell). Empty string
  // means no action is running in the foreground.
  const [executingActionId, setExecutingActionId] = useState<string>("");

  // Per-message queued shell jobs awaiting sequential execution after batch
  // approval. Key: messageId of the assistant message carrying the proposals.
  const pendingShellQueuesRef = useRef(new Map<string, PendingShellQueue>());

  return {
    executingActionId,
    setExecutingActionId,
    pendingShellQueuesRef,
  };
}
