import type { AskUserRequest } from "../../../orchestrator/askUserService";

export type ApprovalAskUserDecision = "allow" | "block_visible" | "clear_hidden";

export function resolveApprovalAskUserDecision(
  targetSessionId: string,
  pendingRequest: AskUserRequest | null,
  visibleRequest: AskUserRequest | null,
  fallbackVisibleSessionId?: string,
): ApprovalAskUserDecision {
  if (!pendingRequest) {
    return "allow";
  }

  const visibleSessionId =
    visibleRequest?.sessionId ?? fallbackVisibleSessionId ?? "";
  const isVisibleForTargetSession =
    visibleRequest?.id === pendingRequest.id &&
    visibleSessionId === targetSessionId;

  if (isVisibleForTargetSession) {
    return "block_visible";
  }

  return "clear_hidden";
}
